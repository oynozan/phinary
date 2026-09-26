// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IUnderlyingOracle} from "../../src/interfaces/IUnderlyingOracle.sol";
import {TickAccumulator} from "../../src/oracle/TickAccumulator.sol";
import {UnderlyingOracleHook} from "../../src/oracle/UnderlyingOracleHook.sol";
import {OracleTestBase} from "./OracleTestBase.sol";

contract TickAccumulatorHarness is TickAccumulator {
    constructor(OracleTestBase.HookParams memory p)
        TickAccumulator(p.h, p.nWindows, p.minWindows, p.winsorTicks, p.varMin, p.varMax, p.fallbackVar, p.cardinality)
    {}

    function init(uint32 t) external {
        _init(t);
    }

    function accrue(uint32 t, int256 normTick) external {
        _accrue(t, normTick);
    }

    function lastTime() external view returns (uint32) {
        return _lastTime();
    }

    function cumulativeAt(uint32 t) external view returns (int56) {
        return _cumulativeAt(t);
    }

    function variance(uint32 now_) external view returns (uint256, bool) {
        return _variance(now_);
    }

    function oldestTime() external view returns (uint32) {
        return _oldestTime();
    }
}

/// @notice UnderlyingOracleHook and a TickAccumulator fed its writes must agree at every write along a seeded path
abstract contract TickAccumulatorDiffTest is OracleTestBase {
    uint256 internal constant CP_COLD = 1;
    uint256 internal constant CP_WARM = 2;
    uint256 internal constant CP_OBS_WRAP = 4;
    uint256 internal constant CP_SEG_WRAP = 8;
    uint256 internal constant CP_ALL = 15;
    uint256 internal constant CP_FINAL = 16;
    uint256 internal constant MIN_BLOCKS = 40;
    uint256 internal constant MAX_BLOCKS = 160;
    uint256 internal constant CUM_SAMPLES = 200;

    UnderlyingOracleHook internal hook;
    TickAccumulatorHarness internal acc;
    PoolKey internal pk;
    HookParams internal cfg;
    uint32 internal t0;
    uint32[] internal wT;
    uint256[] internal wVar;
    bool[] internal wWarm;
    uint256 internal crossings;
    uint256 internal hit;
    uint256 internal pastWarmMatched;
    uint256 internal fullChecks;

    function setUp() public {
        _setUpEnv();
    }

    function testFuzz_matchesHook(uint256 seed) public {
        _runDiff(_diffParams(), seed, 60, false);
    }

    function testFuzz_matchesHookWithLongGapsAndClamps(uint256 seed) public {
        _runDiff(_policyParams(), seed, 4, true);
    }

    function test_matchesHookFixedSeed() public {
        _runDiff(_diffParams(), 0xC0FFEE, 60, false);
    }

    /// @dev Winsorisation binds often and the clamps never do, so the raw estimator is compared
    function _diffParams() internal pure returns (HookParams memory) {
        return HookParams({
            h: 10,
            nWindows: 8,
            minWindows: 4,
            winsorTicks: 40,
            varMin: 1,
            varMax: type(uint128).max,
            fallbackVar: 12_345,
            cardinality: 16
        });
    }

    /// @dev Production-like clamps that bind on some paths and not on others
    function _policyParams() internal pure returns (HookParams memory p) {
        p = _defaultParams();
        (p.h, p.nWindows, p.minWindows, p.cardinality) = (12, 10, 3, 16);
    }

    function _runDiff(HookParams memory p, uint256 seed, int256 maxStep, bool longGaps) internal {
        cfg = p;
        hook = _deployHook(p);
        pk = _initPool(address(hook), 2700e18);
        acc = new TickAccumulatorHarness(p);
        t0 = _now();
        acc.init(t0);
        for (uint256 b; b < MAX_BLOCKS && (b < MIN_BLOCKS || hit != CP_ALL); b++) {
            uint256 x = _rand(seed, b);
            uint256 gap = 1 + x % 30;
            if (longGaps && b > 0 && (x >> 128) % 6 == 0) gap = 31 + (x >> 136) % (3 * uint256(p.h) * p.nWindows);
            _nextBlock(gap);
            uint256 swaps = 1 + (x >> 64) % 3;
            for (uint256 j; j < swaps; j++) {
                uint256 y = _rand(x, j);
                int256 step = int256(y % uint256(2 * maxStep + 1)) - maxStep;
                if ((y >> 128) % 10 == 0) step *= 8;
                _swapAndMirror(_normTick(pk) + step, seed);
            }
        }
        assertEq(hit, CP_ALL, "every checkpoint reached");
        // A nonzero step always moves the price, so this block ends with a write
        _nextBlock(1 + seed % 30);
        _swapAndMirror(_normTick(pk) + 7, seed);
        assertEq(acc.lastTime(), _now(), "final write");
        _fullCheck(seed, CP_FINAL);
        assertEq(fullChecks, 5, "five full checkpoints");
        assertGt(pastWarmMatched, 0, "a warm variance from an earlier grid was compared");
    }

    /// @dev Swaps toward `normTarget` and mirrors the hook's write, if any, into the accumulator
    function _swapAndMirror(int256 normTarget, uint256 seed) internal {
        int256 sobK = _normTick(pk);
        (, uint32 before) = hook.sobTick();
        _swapToNormTick(pk, normTarget);
        (, uint32 t) = hook.sobTick();
        if (t == before) return;
        assertEq(t, _now(), "hook writes at block time");
        acc.accrue(t, sobK);
        if (t / cfg.h > before / cfg.h) crossings++;
        _checkWrite(seed);
    }

    function _checkWrite(uint256 seed) internal {
        uint32 t = _now();
        assertEq(acc.lastTime(), t, "lastTime");
        assertEq(acc.oldestTime(), hook.oldestObservationTime(), "oldest");
        assertEq(int256(acc.cumulativeAt(t)), int256(hook.cumulativeAt(t)), "cum(lastTime)");
        (uint256 v, bool w) = hook.varianceE36();
        (uint256 av, bool aw) = acc.variance(t);
        assertEq(av, v, "variance");
        assertEq(aw, w, "warm");
        if (wT.length > 0) _checkPastVariance(wT.length - 1);
        wT.push(t);
        wVar.push(v);
        wWarm.push(w);
        uint256 due;
        if (wT.length == 1) {
            assertFalse(w, "first write is before minWindows");
            due = CP_COLD;
        }
        if (w) due |= CP_WARM;
        if (wT.length >= cfg.cardinality) {
            assertGt(hook.oldestObservationTime(), t0, "observation ring wrapped");
            due |= CP_OBS_WRAP;
        }
        if (crossings > cfg.nWindows) due |= CP_SEG_WRAP;
        due &= ~hit;
        if (due == 0) return;
        // One checkpoint per write keeps the five distinct, every condition stays true once met
        uint256 cp = due & (~due + 1);
        hit |= cp;
        _fullCheck(seed, cp);
    }

    function _fullCheck(uint256 seed, uint256 salt) internal {
        fullChecks++;
        uint32 last = acc.lastTime();
        uint32 oldest = acc.oldestTime();
        assertEq(last, _now(), "checkpoint right after a write");
        assertEq(oldest, hook.oldestObservationTime(), "oldest");
        for (uint256 i; i < CUM_SAMPLES; i++) {
            uint32 at = oldest + uint32(_rand(seed, (salt << 128) | i) % (last - oldest + 1));
            assertEq(int256(acc.cumulativeAt(at)), int256(hook.cumulativeAt(at)), "cum(t)");
        }
        assertEq(int256(acc.cumulativeAt(oldest)), int256(hook.cumulativeAt(oldest)), "cum(oldest)");
        bytes memory before = abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, oldest - 1);
        vm.expectRevert(before);
        acc.cumulativeAt(oldest - 1);
        vm.expectRevert(before);
        hook.cumulativeAt(oldest - 1);
        bytes memory beyond = abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, last + 1);
        vm.expectRevert(beyond);
        acc.cumulativeAt(last + 1);
        vm.expectRevert(beyond);
        acc.variance(last + 1);
        for (uint256 i; i + 1 < wT.length; i++) {
            _checkPastVariance(i);
        }
    }

    /// @dev The estimator at an earlier write time equals what the hook returned right after that write
    function _checkPastVariance(uint256 i) internal {
        try acc.variance(wT[i]) returns (uint256 v, bool w) {
            assertEq(v, wVar[i], "past variance");
            assertEq(w, wWarm[i], "past warm");
            if (w && wT[i] / cfg.h < acc.lastTime() / cfg.h) pastWarmMatched++;
        } catch (bytes memory err) {
            assertEq(bytes4(err), TickAccumulator.CheckpointUnavailable.selector, "past variance evicted");
        }
    }
}

contract TickAccumulatorDiffEthIs0Test is TickAccumulatorDiffTest {
    function usdcIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

contract TickAccumulatorDiffUsdcIs0Test is TickAccumulatorDiffTest {
    function usdcIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

/// @notice Validation, no extrapolation, empty intervals and the pre-history rule of the accumulator alone
contract TickAccumulatorTest is OracleTestBase {
    uint32 internal constant T = 1_790_000_017;

    TickAccumulatorHarness internal acc;

    function usdcIsCurrency0() internal pure override returns (bool) {
        return false;
    }

    function setUp() public {
        acc = new TickAccumulatorHarness(_unitParams());
        acc.init(T);
    }

    function _unitParams() internal pure returns (HookParams memory) {
        return HookParams({
            h: 10,
            nWindows: 8,
            minWindows: 2,
            winsorTicks: 40,
            varMin: 1,
            varMax: type(uint128).max,
            fallbackVar: 5,
            cardinality: 4
        });
    }

    function test_constructorValidation() public {
        HookParams memory ok = _defaultParams();
        TickAccumulatorHarness a = new TickAccumulatorHarness(ok);
        assertEq(a.gridSeconds(), ok.h);
        assertEq(a.nWindows(), ok.nWindows);
        assertEq(a.minWindows(), ok.minWindows);
        assertEq(a.winsorTicks(), ok.winsorTicks);
        assertEq(a.cardinality(), ok.cardinality);
        assertEq(a.varMinE36(), ok.varMin);
        assertEq(a.varMaxE36(), ok.varMax);
        assertEq(a.fallbackVarE36(), ok.fallbackVar);
        HookParams[] memory bad = new HookParams[](12);
        for (uint256 i; i < bad.length; i++) {
            bad[i] = _defaultParams();
        }
        bad[0].h = 0;
        bad[1].nWindows = 0;
        bad[2].nWindows = type(uint16).max;
        bad[3].minWindows = 0;
        bad[4].minWindows = bad[4].nWindows + 1;
        bad[5].winsorTicks = 0;
        (bad[6].h, bad[6].winsorTicks) = (65536, 65536);
        bad[7].cardinality = 0;
        bad[8].varMin = 0;
        bad[9].varMin = bad[9].fallbackVar + 1;
        bad[10].varMax = bad[10].fallbackVar - 1;
        bad[11].varMax = uint256(type(uint128).max) + 1;
        for (uint256 i; i < bad.length; i++) {
            vm.expectRevert(TickAccumulator.InvalidParams.selector);
            new TickAccumulatorHarness(bad[i]);
        }
    }

    function test_initIsFirstObservation() public view {
        assertEq(acc.lastTime(), T);
        assertEq(acc.oldestTime(), T);
        assertEq(int256(acc.cumulativeAt(T)), 0);
        (uint256 v, bool w) = acc.variance(T);
        assertEq(v, 5);
        assertFalse(w);
        (v, w) = acc.variance(T - 1000);
        assertEq(v, 5);
        assertFalse(w);
    }

    function test_cumulativeNeverExtrapolates() public {
        _expectUnavailable(T + 1);
        acc.cumulativeAt(T + 1);
        acc.accrue(T + 10, -7);
        assertEq(int256(acc.cumulativeAt(T + 4)), -28);
        assertEq(int256(acc.cumulativeAt(T + 10)), -70);
        _expectUnavailable(T + 11);
        acc.cumulativeAt(T + 11);
        _expectUnavailable(T - 1);
        acc.cumulativeAt(T - 1);
        _expectUnavailable(T + 11);
        acc.variance(T + 11);
    }

    function test_emptyIntervalCreditsNothing() public {
        acc.accrue(T + 10, 3);
        acc.accrue(T + 10, 1000);
        acc.accrue(T + 5, 1000);
        assertEq(acc.lastTime(), T + 10);
        assertEq(int256(acc.cumulativeAt(T + 5)), 15);
        assertEq(int256(acc.cumulativeAt(T + 10)), 30);
        acc.accrue(T + 12, 4);
        acc.accrue(T + 13, 4);
        assertEq(int256(acc.cumulativeAt(T + 12)), 38);
        assertEq(acc.oldestTime(), T, "no observation spent on an empty interval");
    }

    /// @dev The first credited tick stands in for the history before init, so a flat path has no first jump
    function test_flatPathHasNoSpuriousFirstJump() public {
        for (uint32 i = 1; i <= 12; i++) {
            acc.accrue(T + 7 * i, 200_000);
        }
        (uint256 v, bool w) = acc.variance(acc.lastTime());
        assertTrue(w);
        assertEq(v, 1);
    }

    function _expectUnavailable(uint32 t) internal {
        vm.expectRevert(abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, t));
    }
}
