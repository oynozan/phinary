// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {IUnderlyingOracle} from "../../src/interfaces/IUnderlyingOracle.sol";
import {UnderlyingOracleHook} from "../../src/oracle/UnderlyingOracleHook.sol";
import {OracleTestBase} from "./OracleTestBase.sol";

abstract contract UnderlyingOracleHookTest is OracleTestBase {
    using StateLibrary for IPoolManager;

    int256 internal constant LN_2700_WAD = 7901007051992420442;
    uint256 internal constant LN_TOL = 30;

    UnderlyingOracleHook internal hook;
    PoolKey internal poolKey;
    address internal underlyingArg;

    function setUp() public {
        _setUpEnv();
        hook = _deployHook(_defaultParams());
        poolKey = _initPool(address(hook), 2700e18);
    }

    /* Binding and orientation */

    function test_bindsPoolAndOrientation() public view {
        UnderlyingOracleHook.FeedInfo memory i = hook.feedInfo();
        assertEq(PoolId.unwrap(i.poolId), PoolId.unwrap(poolKey.toId()));
        assertEq(PoolId.unwrap(hook.poolId()), PoolId.unwrap(poolKey.toId()));
        assertEq(int256(i.sign), sign);
        assertEq(i.decimalsShift, 12);
        assertEq(hook.decimalsShift(), 12);
        assertEq(i.observationCount, 1);
        assertEq(i.lastWriteTime, T0);
        assertEq(hook.oldestObservationTime(), T0);
        (int24 t, uint32 lw) = hook.sobTick();
        assertEq(int256(t), _normTick(poolKey));
        assertEq(lw, T0);
        PoolKey memory pk = hook.poolKey();
        assertEq(Currency.unwrap(pk.currency0), Currency.unwrap(poolKey.currency0));
        assertEq(address(pk.hooks), address(hook));
    }

    function test_lnSpotIsLnUsdPrice() public {
        assertApproxEqAbs(hook.lnSpotSoBWad(), LN_2700_WAD, LN_TOL);
        _swapToSqrtPrice(poolKey, _sqrtPriceForUsd(3141.59e18));
        assertApproxEqAbs(hook.lnSpotSoBWad(), LN_2700_WAD, LN_TOL, "start-of-block price in the same block");
        _nextBlock(1);
        assertApproxEqAbs(hook.lnSpotSoBWad(), F.lnWad(3141.59e18), LN_TOL);
    }

    function testFuzz_lnSpotIsLnUsdPrice(uint256 usdSeed) public {
        uint256 usd = bound(usdSeed, 300e18, 30_000e18);
        _nextBlock(12);
        _swapToSqrtPrice(poolKey, _sqrtPriceForUsd(usd));
        _nextBlock(12);
        int256 ln = hook.lnSpotSoBWad();
        assertApproxEqAbs(ln, F.lnWad(int256(usd)), LN_TOL);
        // The normalised tick is the floor of the exact normalised log price in both orientations
        int256 xWad = (ln - 12 * LN10_WAD) * 1e18 / LN_TICK_WAD;
        (int24 t,) = hook.sobTick();
        assertLe(int256(t) * 1e18, xWad + 1e9, "floor: not above");
        assertGt(int256(t) * 1e18 + 1e18, xWad - 1e9, "floor: within one tick");
        assertEq(int256(t), _normTick(poolKey));
    }

    function test_nativeEthPoolBinds() public {
        UnderlyingOracleHook h = _deployHookFor(_defaultParams(), address(0));
        PoolKey memory k =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdcToken)), FEE, SPACING, IHooks(address(h)));
        manager.initialize(k, uint160(F.sqrt(F.fullMulDiv(2700e18, 1 << 192, 1e30))));
        assertEq(h.decimalsShift(), 12);
        assertEq(h.feedInfo().sign, 1);
        assertApproxEqAbs(h.lnSpotSoBWad(), LN_2700_WAD, LN_TOL);
    }

    function test_revertsOnSecondPool() public {
        PoolKey memory k2 = _key(address(hook));
        k2.fee = 3000;
        k2.tickSpacing = 60;
        vm.expectRevert(_wrapped(address(hook), UnderlyingOracleHook.AlreadyBound.selector));
        manager.initialize(k2, _sqrtPriceForUsd(2700e18));
    }

    function test_revertsOnWrongPoolAndReadsNeedBinding() public {
        UnderlyingOracleHook h = _deployHook(_defaultParams());
        vm.expectRevert(UnderlyingOracleHook.NotBound.selector);
        h.lnSpotSoBWad();
        vm.expectRevert(UnderlyingOracleHook.NotBound.selector);
        h.varianceE36();
        vm.expectRevert(UnderlyingOracleHook.NotBound.selector);
        h.cumulativeAt(T0);
        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        (address a, address b) =
            address(dai) < address(weth) ? (address(dai), address(weth)) : (address(weth), address(dai));
        PoolKey memory k = PoolKey(Currency.wrap(a), Currency.wrap(b), FEE, SPACING, IHooks(address(h)));
        vm.expectRevert(_wrapped(address(h), UnderlyingOracleHook.WrongPool.selector));
        manager.initialize(k, 1 << 96);
        MockERC20 junk = new MockERC20("Junk", "JUNK", 18);
        (a, b) = address(junk) < address(usdcToken)
            ? (address(junk), address(usdcToken))
            : (address(usdcToken), address(junk));
        k = PoolKey(Currency.wrap(a), Currency.wrap(b), 3000, 60, IHooks(address(h)));
        vm.expectRevert(_wrapped(address(h), UnderlyingOracleHook.WrongPool.selector));
        manager.initialize(k, 1 << 96);
        k = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdcToken)), FEE, SPACING, IHooks(address(h)));
        vm.expectRevert(_wrapped(address(h), UnderlyingOracleHook.WrongPool.selector));
        manager.initialize(k, 1 << 96);
    }

    function test_onlyOwnerBindsPool() public {
        UnderlyingOracleHook h = _deployHook(_defaultParams());
        PoolKey memory k = _key(address(h));
        MockERC20 junk = new MockERC20("Junk", "JUNK", 18);
        (address a, address b) = address(junk) < address(usdcToken)
            ? (address(junk), address(usdcToken))
            : (address(usdcToken), address(junk));
        PoolKey memory kJunk = PoolKey(Currency.wrap(a), Currency.wrap(b), 3000, 60, IHooks(address(h)));
        vm.startPrank(address(0xBAD));
        vm.expectRevert(_wrapped(address(h), Ownable.Unauthorized.selector));
        manager.initialize(kJunk, 1 << 96);
        vm.expectRevert(_wrapped(address(h), Ownable.Unauthorized.selector));
        manager.initialize(k, _sqrtPriceForUsd(1e18));
        vm.stopPrank();
        vm.expectRevert(UnderlyingOracleHook.NotBound.selector);
        h.feedInfo();
        _initPool(address(h), 2700e18);
        assertEq(PoolId.unwrap(h.poolId()), PoolId.unwrap(k.toId()));
        assertApproxEqAbs(h.lnSpotSoBWad(), LN_2700_WAD, LN_TOL);
    }

    function test_callbacksOnlyFromPoolManager() public {
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), poolKey, SwapParams(true, -1, 0), ZERO_BYTES);
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.afterInitialize(address(this), poolKey, 1 << 96, 0);
    }

    function test_constructorValidation() public {
        HookParams memory ok = _defaultParams();
        underlyingArg = address(weth);
        (bool success,) = _tryDeploy(ok, address(usdcToken), address(this));
        assertTrue(success);
        HookParams[] memory bad = new HookParams[](11);
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
        for (uint256 i; i < bad.length; i++) {
            _assertInvalid(bad[i], address(usdcToken), address(this));
        }
        _assertInvalid(ok, address(0), address(this));
        _assertInvalid(ok, address(usdcToken), address(0));
        address u = underlyingArg;
        underlyingArg = address(usdcToken);
        _assertInvalid(ok, address(usdcToken), address(this));
        underlyingArg = u;
    }

    /* Manipulation resistance */

    function test_sameBlockManipulationInvariance() public {
        HookParams memory p = _defaultParams();
        (p.nWindows, p.varMin, p.varMax) = (120, 1, type(uint128).max);
        hook = _deployHook(p);
        poolKey = _initPool(address(hook), 2700e18);
        for (uint256 b = 1; b <= 40; b++) {
            _nextBlock(13);
            _swapToNormTick(poolKey, _normTick(poolKey) + int256(_rand(1, b) % 81) - 40);
        }
        _manipulateAndCompare(60 - _now() % 60 + 7);
        _manipulateAndCompare(5);
        _manipulateAndCompare(3600);
    }

    function _manipulateAndCompare(uint256 dt) internal {
        _nextBlock(dt);
        (uint256 v, bool w) = hook.varianceE36();
        assertTrue(w);
        assertGt(v, hook.varMinE36(), "variance not clamped");
        assertLt(v, hook.varMaxE36(), "variance not clamped");
        bytes memory r0 = _reads(hook);
        int256 k0 = _normTick(poolKey);
        int256 lnNaive0 = _lnUsd(_sqrtP(poolKey));
        _swapToNormTick(poolKey, k0 + 3000);
        assertGt(_lnUsd(_sqrtP(poolKey)) - lnNaive0, 0.25e18, "slot0 moved (negative control)");
        assertEq(keccak256(_reads(hook)), keccak256(r0), "reads moved by an up push");
        _swapToNormTick(poolKey, k0 - 3000);
        assertEq(keccak256(_reads(hook)), keccak256(r0), "reads moved by a down push");
        vm.roll(vm.getBlockNumber() + 1);
        _swapToNormTick(poolKey, k0 + 1500);
        assertEq(keccak256(_reads(hook)), keccak256(r0), "reads moved in a later block with the same timestamp");
        _swapToNormTick(poolKey, k0);
    }

    function _reads(UnderlyingOracleHook h) internal view returns (bytes memory) {
        uint32 t = _now();
        uint32 oldest = h.oldestObservationTime();
        (int24 sob,) = h.sobTick();
        (uint256 v, bool w) = h.varianceE36();
        bytes32 cums;
        for (uint32 at = t - 700 > oldest ? t - 700 : oldest; at <= t; at++) {
            cums = keccak256(abi.encode(cums, h.cumulativeAt(at)));
        }
        return abi.encode(h.lnSpotSoBWad(), sob, v, w, oldest, h.decimalsShift(), cums);
    }

    /* Settlement (SPEC §3.5) */

    /// @dev Price held at 1.0001^offset times the strike for the whole window; YES iff offset > 0 in both orientations.
    ///      $2,700 sits 0.005 tick above an integer normalised tick, so |offset| in [0.1, 0.9] resolves exactly.
    function test_settlementThresholdMatchesPrice() public {
        int256[8] memory offs = [int256(-0.9e18), -0.7e18, -0.3e18, -0.1e18, 0.1e18, 0.3e18, 0.7e18, 0.9e18];
        for (uint256 i; i < offs.length; i++) {
            assertEq(_settlesYes(LN_2700_WAD, offs[i], 600), offs[i] > 0);
        }
    }

    /// @dev For any strike and a constant price, the half-tick rule errs only within one tick of the strike.
    function testFuzz_settlementThresholdBothOrientations(uint256 strikeSeed, int256 offSeed) public {
        int256 lnStrike = F.lnWad(int256(bound(strikeSeed, 500e18, 20_000e18)));
        int256 off = bound(offSeed, -40e18, 40e18);
        bool yes = _settlesYes(lnStrike, off, 300);
        if (off >= 1e18) assertTrue(yes);
        if (off <= -1e18) assertFalse(yes);
        // Exact criterion with a floored average tick
        int256 strikeTickWad = (lnStrike - 12 * LN10_WAD) * 1e18 / LN_TICK_WAD;
        int256 lWad = strikeTickWad + off;
        int256 fl = lWad >= 0 ? lWad / 1e18 : -((-lWad + 1e18 - 1) / 1e18);
        if (_abs(lWad - fl * 1e18) > 1e9 && _abs(lWad - fl * 1e18 - 1e18) > 1e9) {
            assertEq(yes, fl * 1e18 > strikeTickWad - 0.5e18);
        }
    }

    function _settlesYes(int256 lnStrikeWad, int256 offTicksWad, uint32 window) internal returns (bool) {
        _nextBlock(12);
        int256 usd = F.expWad(lnStrikeWad + offTicksWad * LN_TICK_WAD / 1e18);
        _swapToSqrtPrice(poolKey, _sqrtPriceForUsd(uint256(usd)));
        uint32 start = _now();
        _nextBlock(window);
        int256 d = int256(hook.cumulativeAt(start + window)) - hook.cumulativeAt(start);
        int256 strikeTickWad = (lnStrikeWad - int256(hook.decimalsShift()) * LN10_WAD) * 1e18 / LN_TICK_WAD;
        return d * 1e18 > int256(uint256(window)) * (strikeTickWad - 0.5e18);
    }

    /* Accumulators vs brute-force reference */

    function testFuzz_pathMatchesReference(uint256 seed) public {
        HookParams memory p = _exactParams(60, 5, 25, 12);
        UnderlyingOracleHook h = _deployHook(p);
        PoolKey memory k = _initPool(address(h), 2700e18);
        _refInit(k);
        uint256 nw = 30 + seed % 20;
        for (uint256 i; i < nw; i++) {
            uint256 x = _rand(seed, i);
            uint256 kind = x % 10;
            uint256 gap;
            if (kind < 2) gap = 0;
            else if (kind < 6) gap = 1 + (x >> 8) % 30;
            else if (kind < 8) gap = 30 + (x >> 8) % 400;
            else if (kind < 9) gap = 400 + (x >> 8) % 3000;
            else gap = p.h - _now() % p.h;
            _nextBlock(gap);
            uint256 swaps = 1 + (x >> 40) % 3;
            for (uint256 j; j < swaps; j++) {
                uint256 y = _rand(x, j);
                int256 step = int256(y % 121) - 60;
                if ((y >> 8) % 7 == 0) step = int256((y >> 16) % 1001) - 500;
                _swapAndRecord(k, _normTick(k) + step);
            }
            _checkAgainstRef(h, k, p, x);
        }
        _nextBlock(1 + seed % 700);
        _checkAgainstRef(h, k, p, seed);
    }

    function _checkAgainstRef(UnderlyingOracleHook h, PoolKey memory k, HookParams memory p, uint256 seed) internal {
        uint32 t = _now();
        int256 curK = _normTick(k);
        uint256 nObs = refT.length;
        uint32 lastW = refT[nObs - 1];
        uint32 oldest = refT[nObs > p.cardinality ? nObs - p.cardinality : 0];
        assertEq(h.oldestObservationTime(), oldest, "oldest");
        (int24 sob, uint32 lw) = h.sobTick();
        assertEq(lw, lastW, "lastWriteTime");
        assertEq(int256(sob), lastW == t ? refK[nObs - 1] : curK, "sobTick");
        assertApproxEqAbs(h.lnSpotSoBWad(), _lnUsd(lastW == t ? refSobSqrtP : _sqrtP(k)), LN_TOL, "lnSpot");
        assertEq(int256(h.cumulativeAt(t)), _refCum(t, curK), "cum(now)");
        assertEq(int256(h.cumulativeAt(oldest)), _refCum(oldest, curK), "cum(oldest)");
        assertEq(int256(h.cumulativeAt(lastW)), _refCum(lastW, curK), "cum(lastWrite)");
        for (uint256 j; j < 4; j++) {
            uint32 at = oldest + uint32(_rand(seed, 100 + j) % (t - oldest + 1));
            assertEq(int256(h.cumulativeAt(at)), _refCum(at, curK), "cum(t)");
        }
        vm.expectRevert(abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, oldest - 1));
        h.cumulativeAt(oldest - 1);
        vm.expectRevert(abi.encodeWithSelector(UnderlyingOracleHook.FutureTime.selector, t + 1));
        h.cumulativeAt(t + 1);
        (uint256 v, bool w) = h.varianceE36();
        (uint256 ev, bool ew) = _refVariance(p, curK);
        assertEq(v, ev, "variance");
        assertEq(w, ew, "warm");
    }

    function test_observationRingWrapAround() public {
        HookParams memory p = _exactParams(60, 5, 400, 4);
        UnderlyingOracleHook h = _deployHook(p);
        PoolKey memory k = _initPool(address(h), 2700e18);
        _refInit(k);
        uint32[7] memory dts = [uint32(10), 15, 22, 33, 1, 49, 70];
        for (uint256 i; i < dts.length; i++) {
            _nextBlock(dts[i]);
            assertTrue(_swapAndRecord(k, _normTick(k) + (i % 2 == 0 ? int256(25) : int256(-40)) * int256(i + 1)));
        }
        assertEq(refT.length, 8);
        uint32 oldest = refT[4];
        assertEq(h.oldestObservationTime(), oldest);
        assertEq(h.feedInfo().observationCount, 4);
        vm.expectRevert(abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, oldest - 1));
        h.cumulativeAt(oldest - 1);
        _nextBlock(17);
        int256 curK = _normTick(k);
        for (uint32 at = oldest; at <= _now(); at++) {
            assertEq(int256(h.cumulativeAt(at)), _refCum(at, curK));
        }
    }

    function test_observationUnavailableAndFuture() public {
        vm.expectRevert(abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, T0 - 1));
        hook.cumulativeAt(T0 - 1);
        assertEq(hook.cumulativeAt(T0), 0);
        _nextBlock(100);
        assertEq(int256(hook.cumulativeAt(T0 + 50)), _normTick(poolKey) * 50);
        vm.expectRevert(abi.encodeWithSelector(UnderlyingOracleHook.FutureTime.selector, _now() + 1));
        hook.cumulativeAt(_now() + 1);
    }

    /* Variance policy */

    function test_warmUpFallbackThenLive() public {
        HookParams memory p = _defaultParams();
        (p.nWindows, p.minWindows) = (10, 4);
        UnderlyingOracleHook h = _deployHook(p);
        PoolKey memory k = _initPool(address(h), 2700e18);
        _refInit(k);
        (uint256 v, bool w) = h.varianceE36();
        assertEq(v, p.fallbackVar);
        assertFalse(w);
        uint256 cold;
        uint256 live;
        for (uint256 i; i < 60; i++) {
            _nextBlock(15);
            _swapAndRecord(k, _normTick(k) + int256(_rand(7, i) % 11) - 5);
            (v, w) = h.varianceE36();
            (uint256 ev, bool ew) = _refVariance(p, _normTick(k));
            assertEq(v, ev);
            assertEq(w, ew);
            if (w) {
                live++;
                assertGt(v, p.varMin);
                assertLt(v, p.varMax);
            } else {
                cold++;
                assertEq(v, p.fallbackVar);
            }
        }
        assertGt(cold, 0);
        assertGt(live, 0);
    }

    function test_winsorClampBinds() public {
        HookParams memory p = _exactParams(60, 20, 50, 4096);
        UnderlyingOracleHook h = _deployHook(p);
        PoolKey memory k = _initPool(address(h), 2700e18);
        _refInit(k);
        uint32 gInit = T0 / 60;
        _warpTo(uint256(gInit + 2) * 60 + 30);
        assertTrue(_swapAndRecord(k, _normTick(k) + 1000));
        _warpTo(uint256(gInit + 6) * 60 + 5);
        (uint256 v, bool w) = h.varianceE36();
        assertTrue(w);
        // The jump lands mid-window, so two consecutive mean-to-mean moves of 500 ticks both clamp to 50 ticks
        uint256 capD = 50 * 60;
        uint256 expected = F.fullMulDiv(3 * 2 * capD * capD, LN_TICK_SQ_E36, 2 * 60 ** 3 * 6);
        assertEq(v, expected);
        (uint256 ev,) = _refVariance(p, _normTick(k));
        assertEq(v, ev);
        uint256 unclamped = F.fullMulDiv(3 * 2 * 30_000 ** 2, LN_TICK_SQ_E36, 2 * 60 ** 3 * 6);
        assertGt(unclamped, 99 * v);
    }

    function test_varianceClampsBind() public {
        HookParams memory p = _defaultParams();
        (p.nWindows, p.minWindows) = (10, 2);
        UnderlyingOracleHook h = _deployHook(p);
        PoolKey memory k = _initPool(address(h), 2700e18);
        _nextBlock(600);
        (uint256 v, bool w) = h.varianceE36();
        assertTrue(w);
        assertEq(v, p.varMin, "flat path clamps to varMin");
        for (uint256 i; i < 40; i++) {
            _nextBlock(15);
            _swapToNormTick(k, _normTick(k) + 300);
        }
        (v, w) = h.varianceE36();
        assertTrue(w);
        assertEq(v, p.varMax, "trending path clamps to varMax");
    }

    function test_ownerUpdatesVarianceBounds() public {
        (uint256 v, bool w) = hook.varianceE36();
        assertEq(v, _defaultParams().fallbackVar);
        assertFalse(w);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vm.prank(address(0xBEEF));
        hook.setVarianceBounds(1, 3, 2);
        vm.expectRevert(UnderlyingOracleHook.InvalidParams.selector);
        hook.setVarianceBounds(0, 3, 2);
        vm.expectRevert(UnderlyingOracleHook.InvalidParams.selector);
        hook.setVarianceBounds(3, 5, 2);
        vm.expectRevert(UnderlyingOracleHook.InvalidParams.selector);
        hook.setVarianceBounds(1, 2, 3);
        vm.expectRevert(UnderlyingOracleHook.InvalidParams.selector);
        hook.setVarianceBounds(1, uint256(type(uint128).max) + 1, 2);
        vm.expectEmit(address(hook));
        emit UnderlyingOracleHook.VarianceBoundsSet(5e26, 9e29, 7e27);
        hook.setVarianceBounds(5e26, 9e29, 7e27);
        assertEq(hook.varMinE36(), 5e26);
        assertEq(hook.varMaxE36(), 9e29);
        assertEq(hook.fallbackVarE36(), 7e27);
        (v, w) = hook.varianceE36();
        assertEq(v, 7e27);
        assertFalse(w);
        _nextBlock(600);
        (v, w) = hook.varianceE36();
        assertEq(v, 5e26);
        assertTrue(w);
    }

    function test_longGapWriteIsBoundedAndExact() public {
        HookParams memory p = _exactParams(60, 30, 400, 64);
        UnderlyingOracleHook h = _deployHook(p);
        PoolKey memory k = _initPool(address(h), 2700e18);
        _refInit(k);
        for (uint256 i; i < 20; i++) {
            _nextBlock(20);
            _swapAndRecord(k, _normTick(k) + int256(_rand(3, i) % 41) - 20);
        }
        _nextBlock(3 days);
        _checkAgainstRef(h, k, p, 1);
        uint256 g0 = gasleft();
        assertTrue(_swapAndRecord(k, _normTick(k) + 50));
        assertLt(g0 - gasleft(), 300_000, "one segment per write, whatever the gap");
        _checkAgainstRef(h, k, p, 2);
        for (uint256 i; i < 12; i++) {
            _nextBlock(20);
            _swapAndRecord(k, _normTick(k) + int256(_rand(4, i) % 41) - 20);
            _checkAgainstRef(h, k, p, i);
        }
    }

    /* Helpers */

    function _wrapped(address h, bytes4 reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            h,
            IHooks.afterInitialize.selector,
            abi.encodeWithSelector(reason),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _tryDeploy(HookParams memory p, address usdc_, address owner_) internal returns (bool, bytes memory) {
        address a = address(FLAGS | (uint160(0x5555 + ++hookSalt) << 144));
        bytes memory args = abi.encode(
            manager,
            usdc_,
            underlyingArg,
            p.h,
            p.nWindows,
            p.minWindows,
            p.winsorTicks,
            p.varMin,
            p.varMax,
            p.fallbackVar,
            p.cardinality,
            owner_
        );
        vm.etch(a, abi.encodePacked(vm.getCode("UnderlyingOracleHook.sol:UnderlyingOracleHook"), args));
        return a.call("");
    }

    function _assertInvalid(HookParams memory p, address usdc_, address owner_) internal {
        (bool success, bytes memory ret) = _tryDeploy(p, usdc_, owner_);
        assertFalse(success);
        assertEq(bytes4(ret), UnderlyingOracleHook.InvalidParams.selector);
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }
}

contract UnderlyingOracleHookEthIs0Test is UnderlyingOracleHookTest {
    function usdcIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

contract UnderlyingOracleHookUsdcIs0Test is UnderlyingOracleHookTest {
    function usdcIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}
