// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title VolOracleV2 (research prototype, NOT audited)
/// @notice v3-semantics tick oracle + TWAP-return realized-variance accumulator + O(1) grid checkpoint ring.
/// @dev Semantics (identical to Uniswap v3 Oracle.sol / OZ BaseOracleHook):
///  - at most one observation per block, written on the first interaction of the block;
///  - the observation records the tick *before* that interaction = the end-of-previous-block ("SoB") tick,
///    which is the tick that prevailed over (previous.blockTimestamp, blockTimestamp].
///  TWAP-return RV: the time axis is cut into grid windows ((g-1)H, gH]. D_g = sum_{t in window g} tick_t (tick-seconds)
///  = cum(gH) - cum((g-1)H). Every write that crosses grid boundaries adds min(|D_g - D_{g-1}|, capD)^2 for each newly
///  completed window; at most two of these can be non-zero (tick is constant between writes), so a write is O(1)
///  apart from the bounded checkpoint catch-up loop.
///  Checkpoint ring: for every grid boundary g crossed (bounded by maxCatchUp per write) we store
///  (g, nWin(g), cum(gH), wsq(g)) at slot g % ringSize, so any window [gA, gB] is read with two SLOADs, no search.
library VolOracleV2 {
    error NotInitialized();
    error CheckpointUnavailable(uint32 grid);
    error FutureGrid(uint32 grid);
    error EmptyWindow();

    uint256 internal constant MAX_RING = 4096;
    /// ln(1.0001)^2 * 1e36, rounded to nearest (exact value ...925.98)
    uint256 internal constant LN_TICK_SQ_E36 = 9999000091658334094374450926;

    struct Observation {
        uint32 blockTimestamp;
        int24 tick; // tick that prevailed over (prev.blockTimestamp, blockTimestamp]
        int56 tickCumulative; // sum tick*dt (untruncated)
        uint64 blockSqCumulative; // sum min(|tick_i - tick_{i-1}|, blockCap)^2 (diagnostic per-observation RV)
        uint72 windowSqCumulative; // sum min(|D_g - D_{g-1}|, windowCap*H)^2 (tick^2 * s^2)
        bool initialized;
    } // 256 bits

    struct State {
        uint16 index;
        uint16 cardinality;
        uint16 cardinalityNext;
        uint32 lastGrid; // floor(lastWrite / H)
        uint32 nWin; // number of window differences accumulated up to lastGrid
        int56 cumAtLastGrid; // cum(lastGrid * H)
        int48 lastWindowSum; // D_{lastGrid}
    } // 216 bits

    struct Checkpoint {
        uint32 grid;
        uint32 nWin;
        int56 cum;
        uint72 wsq;
    } // 192 bits

    struct Params {
        uint32 H; // grid length in seconds
        int24 blockCap; // clamp for the diagnostic per-observation accumulator
        int24 windowCap; // winsorization of |D_g - D_{g-1}| / H, in ticks
        uint16 maxCatchUp; // max checkpoints written by one write (older skipped grids stay unavailable)
        uint16 ringSize; // <= MAX_RING
    }

    struct Oracle {
        Observation[65535] obs;
        Checkpoint[MAX_RING] ckpt;
        State st;
    }

    function _sqClamp(int256 d, int256 cap) private pure returns (uint256) {
        if (d > cap) d = cap;
        else if (d < -cap) d = -cap;
        return uint256(d * d);
    }

    function initialize(Oracle storage self, uint32 time, int24 tick, Params memory p) internal {
        self.obs[0] = Observation(time, tick, 0, 0, 0, true);
        uint32 g = time / p.H;
        // pretend `tick` prevailed before initialization so the first window difference is not a spurious jump
        int56 cumG = -int56(tick) * int56(uint56(time - g * p.H));
        self.st = State(0, 1, 1, g, 0, cumG, int48(int56(tick) * int56(uint56(p.H))));
        self.ckpt[g % p.ringSize] = Checkpoint(g, 0, cumG, 0);
    }

    /// @dev Pure state transition shared by write() and the views. Returns the would-be newest observation.
    struct Step {
        Observation next;
        State st;
        uint32 g1; // first newly completed grid
        uint256 sq1; // contribution of window g1
        uint256 sq2; // contribution of window g1+1 (0 if not completed)
        uint72 wsqBefore;
        uint32 nWinBefore;
        uint32 lastGridBefore;
        int56 lastCum;
        uint32 lastTs;
    }

    function _step(Observation memory last, State memory st, uint32 time, int24 tick, Params memory p)
        private
        pure
        returns (Step memory s)
    {
        int56 k = int56(tick);
        s.lastCum = last.tickCumulative;
        s.lastTs = last.blockTimestamp;
        s.wsqBefore = last.windowSqCumulative;
        s.nWinBefore = st.nWin;
        s.lastGridBefore = st.lastGrid;
        int56 cum = last.tickCumulative + k * int56(uint56(time - last.blockTimestamp));
        uint64 bsq = last.blockSqCumulative + uint64(_sqClamp(int256(k) - int256(last.tick), p.blockCap));
        uint72 wsq = last.windowSqCumulative;
        uint32 g = time / p.H;
        if (g > st.lastGrid) {
            int256 capD = int256(p.windowCap) * int256(uint256(p.H));
            uint32 g1 = st.lastGrid + 1;
            s.g1 = g1;
            int56 d1 = last.tickCumulative + k * int56(uint56(g1 * p.H - last.blockTimestamp)) - st.cumAtLastGrid;
            s.sq1 = _sqClamp(int256(d1) - int256(st.lastWindowSum), capD);
            int56 dLast = d1;
            if (g > g1) {
                int56 d2 = k * int56(uint56(p.H));
                s.sq2 = _sqClamp(int256(d2) - int256(d1), capD);
                dLast = d2;
            }
            wsq += uint72(s.sq1 + s.sq2);
            st.nWin += g - st.lastGrid;
            st.lastGrid = g;
            st.cumAtLastGrid = last.tickCumulative + k * int56(uint56(g * p.H - last.blockTimestamp));
            st.lastWindowSum = int48(dLast);
        }
        s.next = Observation(time, tick, cum, bsq, wsq, true);
        s.st = st;
    }

    /// @dev Checkpoint value for grid gg in (lastGridBefore, st.lastGrid] implied by a step (tick constant = s.next.tick).
    function _ckptFromStep(Step memory s, uint32 gg, Params memory p) private pure returns (Checkpoint memory c) {
        c.grid = gg;
        c.nWin = s.nWinBefore + (gg - s.lastGridBefore);
        c.cum = s.lastCum + int56(s.next.tick) * int56(uint56(gg * p.H - s.lastTs));
        c.wsq = s.wsqBefore + uint72(s.sq1 + (gg > s.g1 ? s.sq2 : 0));
    }

    /// @param tick the pool's tick read *before* the interaction (end-of-previous-block tick)
    function write(Oracle storage self, uint32 time, int24 tick, Params memory p) internal returns (bool) {
        State memory st = self.st;
        if (st.cardinality == 0) revert NotInitialized();
        Observation memory last = self.obs[st.index];
        if (last.blockTimestamp == time) return false;
        Step memory s = _step(last, st, time, tick, p);
        st = s.st;
        if (st.lastGrid > s.lastGridBefore) {
            uint32 g = st.lastGrid;
            uint32 from = s.g1;
            if (g - s.g1 + 1 > p.maxCatchUp) from = g - p.maxCatchUp + 1;
            for (uint32 gg = from; gg <= g; gg++) {
                self.ckpt[gg % p.ringSize] = _ckptFromStep(s, gg, p);
            }
        }
        uint16 card = st.cardinality;
        if (st.cardinalityNext > card && st.index == (card - 1)) card = st.cardinalityNext;
        uint16 idx = uint16((uint256(st.index) + 1) % card);
        self.obs[idx] = s.next;
        st.index = idx;
        st.cardinality = card;
        self.st = st;
        return true;
    }

    function grow(Oracle storage self, uint16 next) internal {
        uint16 current = self.st.cardinalityNext;
        if (next <= current) return;
        for (uint16 i = current; i < next; i++) {
            self.obs[i].blockTimestamp = 1;
        }
        self.st.cardinalityNext = next;
    }

    // ------------------------------------------------------------------ views (O(1))

    /// @notice Start-of-block tick. `currentTick` must be the pool's live tick; it is used only if no write happened
    ///         in this block, in which case no swap has happened in this block either (every swap writes first).
    function sobTick(Oracle storage self, uint32 time, int24 currentTick) internal view returns (int24 tick, uint32 lastWrite) {
        State memory st = self.st;
        if (st.cardinality == 0) revert NotInitialized();
        Observation memory last = self.obs[st.index];
        return (last.blockTimestamp == time ? last.tick : currentTick, last.blockTimestamp);
    }

    function cumulativeNow(Oracle storage self, uint32 time, int24 currentTick) internal view returns (int56) {
        State memory st = self.st;
        Observation memory last = self.obs[st.index];
        if (last.blockTimestamp == time) return last.tickCumulative;
        return last.tickCumulative + int56(currentTick) * int56(uint56(time - last.blockTimestamp));
    }

    /// @notice Checkpoint for grid g (cum at g*H, accumulated window stats). O(1): one ring SLOAD, or a virtual
    ///         step for grids completed since the last write.
    function checkpointAt(Oracle storage self, uint32 g, uint32 time, int24 currentTick, Params memory p)
        internal
        view
        returns (Checkpoint memory c)
    {
        if (g > time / p.H) revert FutureGrid(g);
        State memory st = self.st;
        if (g <= st.lastGrid) {
            c = self.ckpt[g % p.ringSize];
            // slot holds another grid (overwritten by wrap-around, skipped by the catch-up bound, or never written)
            if (c.grid != g) revert CheckpointUnavailable(g);
            return c;
        }
        Observation memory last = self.obs[st.index];
        // no write in (lastWrite, now]: tick constant = currentTick (== SoB tick)
        Step memory s = _step(last, st, time, currentTick, p);
        return _ckptFromStep(s, g, p);
    }

    /// @notice Per-second variance (1e36 scale) of ln price from TWAP-return RV over the last nWindows complete windows.
    /// @dev var = (3/2) * ln(1.0001)^2 * dWsq / (H^3 * dN). Brownian-averaging factor 3/2 (Var of consecutive
    ///      window-mean differences = (2/3) sigma^2 H).
    function varianceE36(Oracle storage self, uint32 nWindows, uint32 time, int24 currentTick, Params memory p)
        internal
        view
        returns (uint256 varE36, uint32 gStart, uint32 gEnd, uint32 dN)
    {
        gEnd = time / p.H;
        gStart = gEnd - nWindows;
        Checkpoint memory a = checkpointAt(self, gStart, time, currentTick, p);
        Checkpoint memory b = checkpointAt(self, gEnd, time, currentTick, p);
        dN = b.nWin - a.nWin;
        if (dN == 0) revert EmptyWindow();
        uint256 dq = uint256(b.wsq - a.wsq);
        uint256 h3 = uint256(p.H) * uint256(p.H) * uint256(p.H);
        varE36 = mulDiv(dq * 3, LN_TICK_SQ_E36, 2 * h3 * uint256(dN));
    }

    /// @dev Remco Bloemen / Solady-style full-precision mulDiv (floor). Reverts on overflow of the result.
    function mulDiv(uint256 x, uint256 y, uint256 d) internal pure returns (uint256 z) {
        unchecked {
            uint256 prod0 = x * y;
            uint256 prod1;
            assembly {
                let mm := mulmod(x, y, not(0))
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) return prod0 / d;
            require(d > prod1, "mulDiv overflow");
            uint256 remainder;
            assembly {
                remainder := mulmod(x, y, d)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = d & (~d + 1);
            assembly {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            z = prod0 * inv;
        }
    }
}
