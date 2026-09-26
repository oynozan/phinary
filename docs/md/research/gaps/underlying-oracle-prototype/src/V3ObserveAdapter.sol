// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUnderlyingOracle} from "./IUnderlyingOracle.sol";
import {VolOracleV2} from "./VolOracleV2.sol";
import {TickMath as TickMathLite} from "v4-core/src/libraries/TickMath.sol";

interface IUniswapV3PoolOracle {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function observations(uint256) external view returns (uint32, int56, uint160, bool);
    function observe(uint32[] calldata) external view returns (int56[] memory, uint160[] memory);
    function fee() external view returns (uint24);
}

/// @title V3ObserveAdapter (research prototype, NOT audited)
/// @notice Exposes a Uniswap v3 pool's built-in oracle (e.g. mainnet USDC/WETH 5 bp) through IUnderlyingOracle.
///         v3 already has SoB semantics (writes the pre-change tick once per block). v3 has no RV accumulator and a
///         short ring (723 slots ~ 7-8 h on L1), so a permissionless poke() copies cum(gH) for every grid g into an
///         own O(1) checkpoint ring and accumulates the same TWAP-return statistic as VolOracleV2. Pokes more than
///         `maxCatchUp` windows apart (or older than the v3 ring) break the chain; broken windows are excluded
///         (nWin counts only the differences actually measured), so the estimator stays unbiased.
contract V3ObserveAdapter is IUnderlyingOracle {
    error WrongFeed();
    error SobUnavailable();

    struct AState {
        uint32 lastGrid;
        uint32 nWin;
        bool haveCum;
        bool haveD;
        int56 cumAtLastGrid; // normalized
        int48 lastWindowSum; // normalized
        uint72 wsq;
    }

    IUniswapV3PoolOracle public immutable pool;
    int8 public immutable SIGN;
    int16 public immutable DEC_SHIFT;
    uint32 public immutable H;
    int24 public immutable WINDOW_CAP;
    uint16 public immutable RING;
    uint16 public immutable MAX_CATCHUP;
    bytes32 public immutable FEED;

    AState public st;
    VolOracleV2.Checkpoint[4096] internal ckpt;

    constructor(address pool_, bool usdcIsToken0, int16 decShift, uint32 h, int24 windowCap, uint16 ring, uint16 maxCatchUp) {
        pool = IUniswapV3PoolOracle(pool_);
        SIGN = usdcIsToken0 ? int8(-1) : int8(1);
        DEC_SHIFT = decShift;
        H = h;
        WINDOW_CAP = windowCap;
        RING = ring;
        MAX_CATCHUP = maxCatchUp;
        FEED = bytes32(uint256(uint160(pool_)));
    }

    modifier onlyFeed(bytes32 f) {
        if (f != FEED) revert WrongFeed();
        _;
    }

    function _sqClamp(int256 d, int256 cap) private pure returns (uint256) {
        if (d > cap) d = cap;
        else if (d < -cap) d = -cap;
        return uint256(d * d);
    }

    function _oldestTs() internal view returns (uint32) {
        (, , uint16 idx, uint16 card,,,) = pool.slot0();
        (uint32 ts,,, bool init) = pool.observations((uint256(idx) + 1) % card);
        if (!init) (ts,,,) = pool.observations(0);
        return ts;
    }

    /// @notice Record checkpoints for all grids completed since the last poke (at most MAX_CATCHUP). O(k) with k small;
    ///         the PredictionHook's read path never calls this. Returns number of checkpoints written.
    function poke() public returns (uint32 written) {
        uint32 nowTs = uint32(block.timestamp);
        uint32 g = nowTs / H;
        AState memory s = st;
        if (s.haveCum && g <= s.lastGrid) return 0;
        uint32 from = s.haveCum ? s.lastGrid + 1 : g - MAX_CATCHUP + 1; // bootstrap: backfill from the v3 ring
        if (g - from + 1 > MAX_CATCHUP) from = g - MAX_CATCHUP + 1;
        uint32 oldest = _oldestTs();
        if (from * H < oldest) from = (oldest + H - 1) / H;
        if (from > g) return 0;
        if (!s.haveCum || from != s.lastGrid + 1) {
            s.haveCum = false; // chain break
            s.haveD = false;
        }
        uint32 n = g - from + 1;
        uint32[] memory ago = new uint32[](n);
        for (uint32 i; i < n; i++) ago[i] = nowTs - (from + i) * H;
        (int56[] memory cums,) = pool.observe(ago);
        int256 capD = int256(WINDOW_CAP) * int256(uint256(H));
        for (uint32 i; i < n; i++) {
            int56 c = int56(SIGN) * cums[i];
            if (s.haveCum) {
                int56 D = c - s.cumAtLastGrid;
                if (s.haveD) {
                    s.wsq += uint72(_sqClamp(int256(D) - int256(s.lastWindowSum), capD));
                    s.nWin += 1;
                }
                s.lastWindowSum = int48(D);
                s.haveD = true;
            }
            s.cumAtLastGrid = c;
            s.haveCum = true;
            s.lastGrid = from + i;
            ckpt[(from + i) % RING] = VolOracleV2.Checkpoint(from + i, s.nWin, c, s.wsq);
        }
        st = s;
        return n;
    }

    // ---------------------------------------------------------------- IUnderlyingOracle
    function feedInfo(bytes32 f) external view onlyFeed(f) returns (FeedInfo memory) {
        return FeedInfo(H, SIGN, DEC_SHIFT, pool.fee(), RING);
    }

    /// @dev v3 writes an observation (with the PRE-change tick) whenever the tick changes, at most once per block,
    ///      and on in-range mint/burn. So: if the newest observation is from this block, SoB tick =
    ///      (cum_new - cum_prev)/(t_new - t_prev) exactly; otherwise the tick has not changed in this block and
    ///      slot0.tick == SoB tick.
    function sobTick(bytes32 f) public view onlyFeed(f) returns (int24, uint32) {
        (, int24 tick, uint16 idx, uint16 card,,,) = pool.slot0();
        (uint32 ts, int56 cum,,) = pool.observations(idx);
        if (ts != uint32(block.timestamp)) return (int24(SIGN) * tick, ts);
        if (card < 2) revert SobUnavailable();
        (uint32 tsP, int56 cumP,, bool initP) = pool.observations((uint256(idx) + card - 1) % card);
        if (!initP || tsP >= ts) revert SobUnavailable();
        int56 raw = (cum - cumP) / int56(uint56(ts - tsP));
        return (int24(SIGN) * int24(raw), ts);
    }

    function sobSqrtPriceX96(bytes32 f) external view onlyFeed(f) returns (uint160, bool) {
        (uint160 sp,, uint16 idx,,,,) = pool.slot0();
        (uint32 ts,,,) = pool.observations(idx);
        if (ts != uint32(block.timestamp)) return (sp, true);
        (int24 nt,) = sobTick(f);
        int24 rawTick = int24(SIGN) * nt;
        // half-tick midpoint: 1.0001^(1/4) = 1.000024999062...; Q96 multiply
        uint256 lo = _sqrtAtTick(rawTick);
        return (uint160(lo * 1000024999062554684 / 1e18), false);
    }

    function _sqrtAtTick(int24 t) internal pure returns (uint256) {
        // TickMath.getSqrtPriceAtTick (copied constants would bloat the prototype); use v4-core library
        return uint256(TickMathLite.getSqrtPriceAtTick(t));
    }

    function cumulativeNow(bytes32 f) external view onlyFeed(f) returns (int56) {
        // observe([0]) is manipulation-safe for the same reason as sobTick (uses the newest observation if written
        // this block, otherwise the unchanged live tick)
        uint32[] memory ago = new uint32[](1);
        (int56[] memory c,) = pool.observe(ago);
        return int56(SIGN) * c[0];
    }

    function cumulativeAtGrid(bytes32 f, uint32 grid) public view onlyFeed(f) returns (int56) {
        VolOracleV2.Checkpoint memory c = ckpt[grid % RING];
        if (c.grid != grid) revert VolOracleV2.CheckpointUnavailable(grid);
        return c.cum;
    }

    function varianceE36(bytes32 f, uint32 nWindows) external view onlyFeed(f) returns (uint256, uint32, uint32, uint32) {
        uint32 gEnd = st.lastGrid; // requires poke() to be current; callers check gEnd freshness
        uint32 gStart = gEnd - nWindows;
        VolOracleV2.Checkpoint memory a = ckpt[gStart % RING];
        VolOracleV2.Checkpoint memory b = ckpt[gEnd % RING];
        if (a.grid != gStart) revert VolOracleV2.CheckpointUnavailable(gStart);
        if (b.grid != gEnd) revert VolOracleV2.CheckpointUnavailable(gEnd);
        uint32 dN = b.nWin - a.nWin;
        if (dN == 0) revert VolOracleV2.EmptyWindow();
        uint256 h3 = uint256(H) * uint256(H) * uint256(H);
        uint256 v = VolOracleV2.mulDiv(uint256(b.wsq - a.wsq) * 3, VolOracleV2.LN_TICK_SQ_E36, 2 * h3 * uint256(dN));
        return (v, gStart, gEnd, dN);
    }
}
