// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {IUnderlyingOracle} from "../interfaces/IUnderlyingOracle.sol";

/// @title UnderlyingOracleHook
/// @notice Oracle-only v4 hook on one ETH/USDC pool (flags AFTER_INITIALIZE | BEFORE_SWAP). See docs/md/SPEC.md §2.
/// @dev On the first swap of each block.timestamp, beforeSwap records the pre-swap (start-of-block) sqrtPrice and tick,
///      a v3-semantics observation {time, tickCumulative} and the TWAP-return variance accumulator on an H-second grid.
///      Reads in a block with no write yet use slot0 (virtual-write rule): every swap runs beforeSwap first, so slot0
///      is still the start-of-block state. Ticks are normalised with floor semantics in both orientations:
///      normTick = rawTick if sign = +1 and -rawTick - 1 if sign = -1 (USDC is currency0), i.e. floor of the normalised
///      log price except exactly on a tick boundary, so the SPEC §3.5 half-tick threshold is unbiased for either
///      ordering. Only the owner may initialise the bound pool, which must pair `underlying` with USDC.
///      Grid window g covers ((g-1)H, gH]; D_g = cum(gH) - cum((g-1)H); wsq(g) = sum of
///      min(|D_x - D_{x-1}|, winsorTicks*H)^2 over x <= g. Each write that crosses grid boundaries appends one segment
///      to a ring of nWindows+1 segments, so writes are O(1) even after long gaps.
contract UnderlyingOracleHook is BaseHook, Ownable, IUnderlyingOracle {
    using StateLibrary for IPoolManager;

    /// ln(1.0001)^2 * 1e36, rounded to nearest
    uint256 internal constant LN_TICK_SQ_E36 = 9999000091658334094374450926;
    int256 internal constant LN10_WAD = 2302585092994045684;
    /// (18 ln10 - 96 ln2) * 1e18, so ln(sqrtPriceX96 / 2^96) = lnWad(sqrtPriceX96) + LN_WAD_TO_Q96
    int256 internal constant LN_WAD_TO_Q96 = -25095597659861927392;

    error NotBound();
    error AlreadyBound();
    error WrongPool();
    error InvalidParams();
    error FutureTime(uint32 t);
    error CheckpointUnavailable(uint32 grid);

    event PoolBound(PoolId indexed poolId, int8 sign, int16 decimalsShift);
    event VarianceBoundsSet(uint256 varMinE36, uint256 varMaxE36, uint256 fallbackVarE36);

    struct Observation {
        uint32 time;
        int56 tickCumulative; // normalised, untruncated
    }

    /// @dev Start-of-block state of the last written timestamp plus the observation ring cursor (one slot).
    struct Sob {
        uint160 sqrtPriceX96; // raw orientation
        int24 tick; // normalised
        uint32 time; // last write; 0 until the pool is bound
        uint16 index;
        uint16 count;
        int8 sign;
    }

    /// @dev Grid state as of lastGrid = sob.time / H (one slot).
    struct Feed {
        int56 cumAtLastGrid;
        int64 lastWindowSum; // D_{lastGrid}
        uint32 gInit;
        int16 decimalsShift;
        uint16 segIndex;
        uint16 segCount;
    }

    /// @dev Grids gFirst..gLast completed by one write: wsq(gFirst) = wFirst, wsq(g) = wLast for g in (gFirst, gLast].
    struct Segment {
        uint32 gFirst;
        uint32 gLast;
        uint96 wFirst;
        uint96 wLast;
    }

    struct FeedInfo {
        PoolId poolId;
        int8 sign;
        int16 decimalsShift;
        uint32 gridSeconds;
        uint16 nWindows;
        uint16 minWindows;
        uint32 winsorTicks;
        uint16 cardinality;
        uint16 observationCount;
        uint32 lastWriteTime;
    }

    address public immutable usdc;
    Currency public immutable underlying;
    uint32 public immutable gridSeconds;
    uint16 public immutable nWindows;
    uint16 public immutable minWindows;
    uint32 public immutable winsorTicks;
    uint16 public immutable cardinality;
    uint256 internal immutable segRing;
    int256 internal immutable capD;

    uint128 public varMinE36;
    uint128 public varMaxE36;
    uint256 public fallbackVarE36;

    PoolId public poolId;
    PoolKey internal _poolKey;
    Sob internal _sob;
    Feed internal _feed;
    Observation[65535] internal _obs;
    Segment[65535] internal _seg;

    /// @param underlying_ the ETH-side currency of the pool (address(0) for native ETH)
    /// @param h_ grid length H in seconds
    /// @param nWindows_ window differences used by varianceE36 (the estimator looks back nWindows * H seconds)
    /// @param minWindows_ below this many completed differences varianceE36 returns fallbackVarE36
    /// @param winsorTicks_ cap on |mean-to-mean tick move| per window difference
    /// @param cardinality_ observation ring size (the cumulativeAt history spans this many writes)
    constructor(
        IPoolManager poolManager_,
        address usdc_,
        Currency underlying_,
        uint32 h_,
        uint16 nWindows_,
        uint16 minWindows_,
        uint32 winsorTicks_,
        uint256 varMinE36_,
        uint256 varMaxE36_,
        uint256 fallbackVarE36_,
        uint16 cardinality_,
        address owner_
    ) BaseHook(poolManager_) {
        if (
            usdc_ == address(0) || Currency.unwrap(underlying_) == usdc_ || owner_ == address(0) || h_ == 0 || nWindows_ == 0 || nWindows_ == type(uint16).max
                || minWindows_ == 0 || minWindows_ > nWindows_ || winsorTicks_ == 0
                || uint256(winsorTicks_) * h_ >= 2 ** 32 || cardinality_ == 0
        ) revert InvalidParams();
        usdc = usdc_;
        underlying = underlying_;
        gridSeconds = h_;
        nWindows = nWindows_;
        minWindows = minWindows_;
        winsorTicks = winsorTicks_;
        cardinality = cardinality_;
        segRing = uint256(nWindows_) + 1;
        capD = int256(uint256(winsorTicks_) * h_);
        _setVarianceBounds(varMinE36_, varMaxE36_, fallbackVarE36_);
        _initializeOwner(owner_);
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.afterInitialize = true;
        p.beforeSwap = true;
    }

    /// @notice Owner-only update of the variance clamps and warm-up fallback (per-second, 1e36).
    function setVarianceBounds(uint256 varMinE36_, uint256 varMaxE36_, uint256 fallbackVarE36_) external onlyOwner {
        _setVarianceBounds(varMinE36_, varMaxE36_, fallbackVarE36_);
    }

    /* Hook callbacks */

    /// @dev Call PoolManager.initialize directly from the owner (routers such as PositionManager appear as sender).
    function _afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick)
        internal
        override
        returns (bytes4)
    {
        if (sender != owner()) revert Unauthorized();
        if (_sob.time != 0) revert AlreadyBound();
        int8 sign;
        Currency eth = underlying;
        if (Currency.unwrap(key.currency0) == usdc && key.currency1 == eth) sign = -1;
        else if (Currency.unwrap(key.currency1) == usdc && key.currency0 == eth) sign = 1;
        else revert WrongPool();
        int16 shift = int16(uint16(_decimals(eth))) - int16(uint16(IERC20Metadata(usdc).decimals()));
        uint32 t = uint32(block.timestamp);
        int256 k = _norm(sign, tick);
        uint32 g = t / gridSeconds;
        // The init tick is treated as prevailing before t, so the first window difference is not a spurious jump
        _feed = Feed({
            cumAtLastGrid: int56(-k * int256(uint256(t - g * gridSeconds))),
            lastWindowSum: int64(k * int256(uint256(gridSeconds))),
            gInit: g,
            decimalsShift: shift,
            segIndex: 0,
            segCount: 1
        });
        _seg[0] = Segment(g, g, 0, 0);
        _obs[0] = Observation(t, 0);
        _sob = Sob(sqrtPriceX96, int24(k), t, 0, 1, sign);
        PoolId id = key.toId();
        poolId = id;
        _poolKey = key;
        emit PoolBound(id, sign, shift);
        return this.afterInitialize.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        Sob memory s = _sob;
        uint32 t = uint32(block.timestamp);
        if (s.time != t) _write(s, t, key.toId());
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /* IUnderlyingOracle */

    function lnSpotSoBWad() external view returns (int256) {
        Sob memory s = _boundSob();
        uint160 sp = s.sqrtPriceX96;
        if (s.time != uint32(block.timestamp)) (sp,,,) = poolManager.getSlot0(poolId);
        int256 lnRaw = 2 * (F.lnWad(int256(uint256(sp))) + LN_WAD_TO_Q96);
        return int256(s.sign) * lnRaw + int256(_feed.decimalsShift) * LN10_WAD;
    }

    function sobTick() external view returns (int24 normTick, uint32 lastWriteTime) {
        Sob memory s = _boundSob();
        if (s.time == uint32(block.timestamp)) return (s.tick, s.time);
        return (int24(_liveTick(s.sign)), s.time);
    }

    function cumulativeAt(uint32 t) external view returns (int56) {
        if (t > block.timestamp) revert FutureTime(t);
        Sob memory s = _boundSob();
        Observation memory hi = _obs[s.index];
        if (t >= hi.time) {
            if (t == hi.time) return hi.tickCumulative;
            // No write since hi.time, so slot0's tick has prevailed over (hi.time, now]
            return int56(int256(hi.tickCumulative) + _liveTick(s.sign) * int256(uint256(t - hi.time)));
        }
        uint256 card = cardinality;
        uint256 oldest = s.count < card ? 0 : (uint256(s.index) + 1) % card;
        Observation memory lo = _obs[oldest];
        if (t < lo.time) revert ObservationUnavailable(t);
        uint256 l;
        uint256 r = uint256(s.count) - 1;
        while (r - l > 1) {
            uint256 m = (l + r) >> 1;
            Observation memory o = _obs[(oldest + m) % card];
            if (o.time <= t) (l, lo) = (m, o);
            else (r, hi) = (m, o);
        }
        if (t == lo.time) return lo.tickCumulative;
        int256 perSec = (int256(hi.tickCumulative) - lo.tickCumulative) / int256(uint256(hi.time - lo.time));
        return int56(int256(lo.tickCumulative) + perSec * int256(uint256(t - lo.time)));
    }

    function varianceE36() external view returns (uint256 varPerSecE36, bool warm) {
        Sob memory s = _boundSob();
        Feed memory f = _feed;
        uint32 h = gridSeconds;
        uint32 gEnd = uint32(block.timestamp) / h;
        uint32 lastGrid = s.time / h;
        uint256 n = gEnd - f.gInit;
        if (n > nWindows) n = nWindows;
        if (n < minWindows) return (fallbackVarE36, false);
        uint32 gStart = gEnd - uint32(n);
        Segment memory cur = _seg[f.segIndex];
        uint256 wEnd = cur.wLast;
        uint256 wStart;
        if (gEnd > lastGrid) {
            // Grids completed since the last write, computed from the start-of-block tick
            (uint256 sq1, uint256 sq2,,) = _cross(f, _obs[s.index], _liveTick(s.sign), lastGrid, gEnd);
            uint256 w1 = wEnd + sq1;
            wEnd = w1 + sq2;
            if (gStart > lastGrid) wStart = gStart == lastGrid + 1 ? w1 : wEnd;
            else wStart = _wsqAt(f, cur, lastGrid, gStart);
        } else {
            wStart = _wsqAt(f, cur, lastGrid, gStart);
        }
        uint256 hh = uint256(h);
        varPerSecE36 = F.fullMulDiv(3 * (wEnd - wStart), LN_TICK_SQ_E36, 2 * hh * hh * hh * n);
        if (varPerSecE36 < varMinE36) varPerSecE36 = varMinE36;
        else if (varPerSecE36 > varMaxE36) varPerSecE36 = varMaxE36;
        warm = true;
    }

    function decimalsShift() external view returns (int16) {
        _boundSob();
        return _feed.decimalsShift;
    }

    function oldestObservationTime() external view returns (uint32) {
        Sob memory s = _boundSob();
        uint256 card = cardinality;
        return _obs[s.count < card ? 0 : (uint256(s.index) + 1) % card].time;
    }

    /* Auxiliary views */

    function feedInfo() external view returns (FeedInfo memory i) {
        Sob memory s = _boundSob();
        Feed memory f = _feed;
        i = FeedInfo({
            poolId: poolId,
            sign: s.sign,
            decimalsShift: f.decimalsShift,
            gridSeconds: gridSeconds,
            nWindows: nWindows,
            minWindows: minWindows,
            winsorTicks: winsorTicks,
            cardinality: cardinality,
            observationCount: s.count,
            lastWriteTime: s.time
        });
    }

    function poolKey() external view returns (PoolKey memory) {
        _boundSob();
        return _poolKey;
    }

    /* Internals */

    function _write(Sob memory s, uint32 t, PoolId id) internal {
        (uint160 sp, int24 rawTick,,) = poolManager.getSlot0(id);
        int256 k = _norm(s.sign, rawTick);
        Observation memory last = _obs[s.index];
        uint32 h = gridSeconds;
        uint32 lastGrid = s.time / h;
        uint32 g = t / h;
        if (g > lastGrid) {
            Feed memory f = _feed;
            (uint256 sq1, uint256 sq2, int256 dLast, int256 cumAtG) = _cross(f, last, k, lastGrid, g);
            uint256 w1 = uint256(_seg[f.segIndex].wLast) + sq1;
            uint16 si = uint16((uint256(f.segIndex) + 1) % segRing);
            _seg[si] = Segment(lastGrid + 1, g, uint96(w1), uint96(w1 + sq2));
            f.segIndex = si;
            if (f.segCount < segRing) ++f.segCount;
            f.cumAtLastGrid = int56(cumAtG);
            f.lastWindowSum = int64(dLast);
            _feed = f;
        }
        uint16 idx;
        uint16 count = s.count;
        if (count < cardinality) idx = count++;
        else idx = uint16((uint256(s.index) + 1) % cardinality);
        _obs[idx] = Observation(t, int56(int256(last.tickCumulative) + k * int256(uint256(t - last.time))));
        _sob = Sob(sp, int24(k), t, idx, count, s.sign);
    }

    /// @dev Window statistics for grids lastGrid+1..g when tick `k` prevailed since `last` (constant between writes).
    function _cross(Feed memory f, Observation memory last, int256 k, uint32 lastGrid, uint32 g)
        internal
        view
        returns (uint256 sq1, uint256 sq2, int256 dLast, int256 cumAtG)
    {
        uint256 h = gridSeconds;
        uint256 g1 = uint256(lastGrid) + 1;
        int256 d1 = int256(last.tickCumulative) + k * int256(g1 * h - last.time) - f.cumAtLastGrid;
        sq1 = _sqClamp(d1 - f.lastWindowSum);
        dLast = d1;
        if (g > g1) {
            dLast = k * int256(h);
            sq2 = _sqClamp(dLast - d1);
        }
        cumAtG = int256(last.tickCumulative) + k * int256(uint256(g) * h - last.time);
    }

    /// @dev wsq at a stored grid g <= lastGrid. O(1) when every write crossed at most one boundary.
    function _wsqAt(Feed memory f, Segment memory cur, uint32 lastGrid, uint32 g) internal view returns (uint256) {
        if (g >= cur.gFirst) return g == cur.gFirst ? cur.wFirst : cur.wLast;
        uint256 count = f.segCount;
        uint256 back = lastGrid - g;
        // Every later segment covers at least one grid, so the target is no older than this position
        uint256 l = back >= count - 1 ? 0 : count - 1 - back;
        Segment memory sg = _segAt(f, l);
        if (sg.gFirst > g) revert CheckpointUnavailable(g);
        if (g > sg.gLast) {
            uint256 r = count - 1;
            while (r - l > 1) {
                uint256 m = (l + r) >> 1;
                Segment memory o = _segAt(f, m);
                if (o.gFirst <= g) (l, sg) = (m, o);
                else r = m;
            }
        }
        return g == sg.gFirst ? sg.wFirst : sg.wLast;
    }

    function _segAt(Feed memory f, uint256 pos) internal view returns (Segment memory) {
        uint256 ring = segRing;
        return _seg[(uint256(f.segIndex) + ring - (uint256(f.segCount) - 1 - pos)) % ring];
    }

    function _sqClamp(int256 d) internal view returns (uint256) {
        int256 c = capD;
        if (d > c) d = c;
        else if (d < -c) d = -c;
        return uint256(d * d);
    }

    function _liveTick(int8 sign) internal view returns (int256) {
        (, int24 rawTick,,) = poolManager.getSlot0(poolId);
        return _norm(sign, rawTick);
    }

    /// @dev floor(sign * L_raw) from rawTick = floor(L_raw); off by one only when L_raw is an exact integer
    function _norm(int8 sign, int24 rawTick) internal pure returns (int256) {
        return sign > 0 ? int256(rawTick) : -int256(rawTick) - 1;
    }

    function _boundSob() internal view returns (Sob memory s) {
        s = _sob;
        if (s.time == 0) revert NotBound();
    }

    function _decimals(Currency c) internal view returns (uint8) {
        return c.isAddressZero() ? 18 : IERC20Metadata(Currency.unwrap(c)).decimals();
    }

    function _setVarianceBounds(uint256 varMin, uint256 varMax, uint256 fallbackVar) internal {
        if (varMin == 0 || varMin > fallbackVar || fallbackVar > varMax || varMax > type(uint128).max) {
            revert InvalidParams();
        }
        varMinE36 = uint128(varMin);
        varMaxE36 = uint128(varMax);
        fallbackVarE36 = fallbackVar;
        emit VarianceBoundsSet(varMin, varMax, fallbackVar);
    }
}
