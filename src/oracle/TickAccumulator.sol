// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {IUnderlyingOracle} from "../interfaces/IUnderlyingOracle.sol";

/// @title TickAccumulator
/// @notice The observation ring, grid checkpoints and TWAP-return realised-variance estimator of UnderlyingOracleHook,
///         fed normalised ticks by the inheriting oracle instead of reading slot0.
/// @dev _accrue(t, k) credits k over (lastTime, t], as the hook's write at t credits the start-of-block tick. Reads never
///      extrapolate past the last accrual. The first credited tick is treated as prevailing before the first
///      observation, as the hook treats its init tick, so the first window difference is not a spurious jump.
///      Grid window g covers ((g-1)H, gH]. D_g = cum(gH) - cum((g-1)H). wsq(g) is the sum of
///      min(|D_x - D_{x-1}|, winsorTicks*H)^2 over x <= g. Each accrual that crosses grid boundaries appends one segment
///      to a ring of nWindows+1 segments, so accruals are O(1) even after long gaps. All parameters are immutable.
abstract contract TickAccumulator {
    /// ln(1.0001)^2 * 1e36, rounded to nearest
    uint256 internal constant LN_TICK_SQ_E36 = 9999000091658334094374450926;

    error InvalidParams();
    error CheckpointUnavailable(uint32 grid);

    struct Observation {
        uint32 time;
        int56 tickCumulative; // normalised, untruncated
    }

    /// @dev Last accrual time plus the observation ring cursor (one slot)
    struct Cursor {
        uint32 time;
        uint16 index;
        uint16 count;
        bool primed; // the pre-history tick is set
    }

    /// @dev Grid state as of lastGrid = cursor.time / H (one slot)
    struct Feed {
        int56 cumAtLastGrid;
        int64 lastWindowSum; // D_{lastGrid}
        uint32 gInit;
        uint16 segIndex;
        uint16 segCount;
    }

    /// @dev Grids gFirst..gLast completed by one accrual, wsq(gFirst) = wFirst and wsq(g) = wLast for g in (gFirst, gLast]
    struct Segment {
        uint32 gFirst;
        uint32 gLast;
        uint96 wFirst;
        uint96 wLast;
    }

    uint32 public immutable gridSeconds;
    uint16 public immutable nWindows;
    uint16 public immutable minWindows;
    uint32 public immutable winsorTicks;
    uint16 public immutable cardinality;
    uint128 public immutable varMinE36;
    uint128 public immutable varMaxE36;
    uint256 public immutable fallbackVarE36;
    uint256 internal immutable segRing;
    int256 internal immutable capD;

    Cursor internal _cursor;
    Feed internal _feed;
    Observation[65535] internal _obs;
    Segment[65535] internal _seg;

    /// @param h_ grid length H in seconds
    /// @param nWindows_ window differences used by the estimator (it looks back nWindows * H seconds)
    /// @param minWindows_ below this many completed differences the estimator returns fallbackVarE36
    /// @param winsorTicks_ cap on |mean-to-mean tick move| per window difference
    /// @param cardinality_ observation ring size (the cumulative history spans this many accruals)
    constructor(
        uint32 h_,
        uint16 nWindows_,
        uint16 minWindows_,
        uint32 winsorTicks_,
        uint256 varMinE36_,
        uint256 varMaxE36_,
        uint256 fallbackVarE36_,
        uint16 cardinality_
    ) {
        if (
            h_ == 0 || nWindows_ == 0 || nWindows_ == type(uint16).max || minWindows_ == 0 || minWindows_ > nWindows_
                || winsorTicks_ == 0 || uint256(winsorTicks_) * h_ >= 2 ** 32 || cardinality_ == 0 || varMinE36_ == 0
                || varMinE36_ > fallbackVarE36_ || fallbackVarE36_ > varMaxE36_ || varMaxE36_ > type(uint128).max
        ) revert InvalidParams();
        gridSeconds = h_;
        nWindows = nWindows_;
        minWindows = minWindows_;
        winsorTicks = winsorTicks_;
        cardinality = cardinality_;
        varMinE36 = uint128(varMinE36_);
        varMaxE36 = uint128(varMaxE36_);
        fallbackVarE36 = fallbackVarE36_;
        segRing = uint256(nWindows_) + 1;
        capD = int256(uint256(winsorTicks_) * h_);
    }

    /// @dev The first observation (t, 0), the grid pre-history is set by the first accrual
    function _init(uint32 t) internal {
        uint32 g = t / gridSeconds;
        _feed = Feed({cumAtLastGrid: 0, lastWindowSum: 0, gInit: g, segIndex: 0, segCount: 1});
        _seg[0] = Segment(g, g, 0, 0);
        _obs[0] = Observation(t, 0);
        _cursor = Cursor(t, 0, 1, false);
    }

    /// @dev Credits normTick over (lastTime, t], an empty interval (t <= lastTime) credits nothing
    function _accrue(uint32 t, int256 normTick) internal {
        Cursor memory s = _cursor;
        if (t <= s.time) return;
        int256 k = normTick;
        Observation memory last = _obs[s.index];
        uint32 h = gridSeconds;
        uint32 lastGrid = s.time / h;
        uint32 g = t / h;
        if (!s.primed) {
            Feed storage fs = _feed;
            fs.cumAtLastGrid = int56(-k * int256(uint256(s.time - lastGrid * h)));
            fs.lastWindowSum = int64(k * int256(uint256(h)));
        }
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
        _cursor = Cursor(t, idx, count, true);
    }

    function _lastTime() internal view returns (uint32) {
        return _cursor.time;
    }

    /// @dev v3 observe semantics for oldest <= t <= lastTime, never extrapolated
    function _cumulativeAt(uint32 t) internal view returns (int56) {
        Cursor memory s = _cursor;
        Observation memory hi = _obs[s.index];
        if (t >= hi.time) {
            if (t == hi.time) return hi.tickCumulative;
            revert IUnderlyingOracle.ObservationUnavailable(t);
        }
        uint256 card = cardinality;
        uint256 oldest = s.count < card ? 0 : (uint256(s.index) + 1) % card;
        Observation memory lo = _obs[oldest];
        if (t < lo.time) revert IUnderlyingOracle.ObservationUnavailable(t);
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

    /// @dev The hook's varianceE36 as of now_, over the grids completed by then
    function _variance(uint32 now_) internal view returns (uint256 varPerSecE36, bool warm) {
        uint32 lastTime = _cursor.time;
        if (now_ > lastTime) revert IUnderlyingOracle.ObservationUnavailable(now_);
        Feed memory f = _feed;
        uint32 h = gridSeconds;
        uint32 gEnd = now_ / h;
        uint32 lastGrid = lastTime / h;
        uint256 n = gEnd > f.gInit ? gEnd - f.gInit : 0;
        if (n > nWindows) n = nWindows;
        if (n < minWindows) return (fallbackVarE36, false);
        uint32 gStart = gEnd - uint32(n);
        Segment memory cur = _seg[f.segIndex];
        uint256 wEnd = _wsqAt(f, cur, lastGrid, gEnd);
        uint256 wStart = _wsqAt(f, cur, lastGrid, gStart);
        uint256 hh = uint256(h);
        varPerSecE36 = F.fullMulDiv(3 * (wEnd - wStart), LN_TICK_SQ_E36, 2 * hh * hh * hh * n);
        if (varPerSecE36 < varMinE36) varPerSecE36 = varMinE36;
        else if (varPerSecE36 > varMaxE36) varPerSecE36 = varMaxE36;
        warm = true;
    }

    function _oldestTime() internal view returns (uint32) {
        Cursor memory s = _cursor;
        uint256 card = cardinality;
        return _obs[s.count < card ? 0 : (uint256(s.index) + 1) % card].time;
    }

    /// @dev Window statistics for grids lastGrid+1..g when tick `k` prevailed since `last` (constant between accruals)
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

    /// @dev wsq at a stored grid g <= lastGrid, O(1) when every accrual crossed at most one boundary
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
}
