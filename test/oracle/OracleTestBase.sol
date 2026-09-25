// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {UnderlyingOracleHook} from "../../src/oracle/UnderlyingOracleHook.sol";

/// @notice Demo WETH (18 dec) / USDC (6 dec) pool through the real PoolManager, hook deployment at flagged addresses
///         and an independent brute-force reference of the oracle's statistics.
abstract contract OracleTestBase is Test, Deployers {
    using StateLibrary for IPoolManager;

    struct HookParams {
        uint32 h;
        uint16 nWindows;
        uint16 minWindows;
        uint32 winsorTicks;
        uint256 varMin;
        uint256 varMax;
        uint256 fallbackVar;
        uint16 cardinality;
    }

    uint256 internal constant YEAR = 31_557_600;
    uint256 internal constant LN_TICK_SQ_E36 = 9999000091658334094374450926;
    int256 internal constant LN_TICK_WAD = 99995000333308;
    int256 internal constant LN10_WAD = 2302585092994045684;
    uint32 internal constant T0 = 1_790_000_017;
    uint160 internal constant FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
    uint24 internal constant FEE = 500;
    int24 internal constant SPACING = 10;
    // About 1,000 WETH and 2.7M USDC full range at $2,700 in either orientation
    int256 internal constant LIQUIDITY = 5.2e16;

    MockERC20 internal weth;
    MockERC20 internal usdcToken;
    int256 internal sign;
    uint160 internal hookSalt;

    uint32[] internal refT;
    int256[] internal refK;
    uint160 internal refSobSqrtP;

    function usdcIsCurrency0() internal pure virtual returns (bool);

    function _setUpEnv() internal {
        vm.warp(T0);
        deployFreshManagerAndRouters();
        bool usdc0 = usdcIsCurrency0();
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usdcToken = new MockERC20("USD Coin", "USDC", 6);
        while ((address(usdcToken) < address(weth)) != usdc0) {
            usdcToken = new MockERC20("USD Coin", "USDC", 6);
        }
        sign = usdc0 ? int256(-1) : int256(1);
        MockERC20[2] memory toks = [weth, usdcToken];
        for (uint256 i; i < 2; i++) {
            toks[i].mint(address(this), 1e45);
            toks[i].approve(address(swapRouter), type(uint256).max);
            toks[i].approve(address(modifyLiquidityRouter), type(uint256).max);
        }
    }

    function _defaultParams() internal pure returns (HookParams memory) {
        return HookParams({
            h: 60,
            nWindows: 60,
            minWindows: 3,
            winsorTicks: 400,
            varMin: _annualToE36(0.2e18),
            varMax: _annualToE36(2.5e18),
            fallbackVar: _annualToE36(0.6e18),
            cardinality: 4096
        });
    }

    function _exactParams(uint32 h, uint16 nWindows, uint32 winsorTicks, uint16 cardinality)
        internal
        pure
        returns (HookParams memory)
    {
        return HookParams({
            h: h,
            nWindows: nWindows,
            minWindows: 1,
            winsorTicks: winsorTicks,
            varMin: 1,
            varMax: type(uint128).max,
            fallbackVar: 1,
            cardinality: cardinality
        });
    }

    function _annualToE36(uint256 sigmaWad) internal pure returns (uint256) {
        return sigmaWad * sigmaWad / YEAR;
    }

    function _deployHook(HookParams memory p) internal returns (UnderlyingOracleHook) {
        return _deployHookFor(p, address(weth));
    }

    function _deployHookFor(HookParams memory p, address underlying) internal returns (UnderlyingOracleHook) {
        address a = address(FLAGS | (uint160(0x4444 + ++hookSalt) << 144));
        deployCodeTo(
            "UnderlyingOracleHook.sol:UnderlyingOracleHook",
            abi.encode(
                manager,
                address(usdcToken),
                underlying,
                p.h,
                p.nWindows,
                p.minWindows,
                p.winsorTicks,
                p.varMin,
                p.varMax,
                p.fallbackVar,
                p.cardinality,
                address(this)
            ),
            a
        );
        return UnderlyingOracleHook(a);
    }

    function _key(address hooks) internal view returns (PoolKey memory k) {
        (address c0, address c1) =
            usdcIsCurrency0() ? (address(usdcToken), address(weth)) : (address(weth), address(usdcToken));
        k = PoolKey(Currency.wrap(c0), Currency.wrap(c1), FEE, SPACING, IHooks(hooks));
    }

    /// @dev Initialises the WETH/USDC pool on `hooks` at `usdWad` dollars per ETH, adds full-range liquidity.
    function _initPool(address hooks, uint256 usdWad) internal returns (PoolKey memory k) {
        k = _key(hooks);
        manager.initialize(k, _sqrtPriceForUsd(usdWad));
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams(TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING), LIQUIDITY, 0),
            ZERO_BYTES
        );
    }

    /// @dev Raw sqrtPriceX96 for a USD/ETH price: raw = usdWad/1e30 (ETH is currency0) or 1e30/usdWad (USDC is).
    function _sqrtPriceForUsd(uint256 usdWad) internal pure returns (uint160) {
        if (usdcIsCurrency0()) return uint160(F.sqrt(F.fullMulDiv(1e30, 1 << 192, usdWad)));
        return uint160(F.sqrt(F.fullMulDiv(usdWad, 1 << 192, 1e30)));
    }

    function _swapToSqrtPrice(PoolKey memory k, uint160 target) internal returns (bool) {
        (uint160 sp,,,) = manager.getSlot0(k.toId());
        if (target == sp) return false;
        swapRouter.swap(
            k,
            SwapParams({zeroForOne: target < sp, amountSpecified: -1e36, sqrtPriceLimitX96: target}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        return true;
    }

    function _swapToNormTick(PoolKey memory k, int256 normTarget) internal returns (bool) {
        return _swapToSqrtPrice(k, TickMath.getSqrtPriceAtTick(int24(sign > 0 ? normTarget : -normTarget - 1)));
    }

    /// @dev Floor-semantics normalisation: rawTick, or -rawTick - 1 when USDC is currency0
    function _normTick(PoolKey memory k) internal view returns (int256) {
        (, int24 raw,,) = manager.getSlot0(k.toId());
        return sign > 0 ? int256(raw) : -int256(raw) - 1;
    }

    function _sqrtP(PoolKey memory k) internal view returns (uint160 sp) {
        (sp,,,) = manager.getSlot0(k.toId());
    }

    /// @dev ln(USD per ETH) via the human price (independent of the hook's sqrtPrice formula)
    function _lnUsd(uint160 sp) internal pure returns (int256) {
        uint256 usdWad = usdcIsCurrency0()
            ? F.fullMulDiv(F.fullMulDiv(1e30, 1 << 96, sp), 1 << 96, sp)
            : F.fullMulDiv(uint256(sp) * 1e15, uint256(sp) * 1e15, 1 << 192);
        return F.lnWad(int256(usdWad));
    }

    /// @dev Swaps toward `normTarget` and records the pre-swap state if this is the first swap of the timestamp
    function _swapAndRecord(PoolKey memory k, int256 normTarget) internal returns (bool wrote) {
        int256 pre = _normTick(k);
        uint160 preSp = _sqrtP(k);
        uint32 t = _now();
        if (_swapToNormTick(k, normTarget) && refT[refT.length - 1] != t) {
            _refPush(t, pre);
            refSobSqrtP = preSp;
            wrote = true;
        }
    }

    function _warpTo(uint256 ts) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(ts);
    }

    function _nextBlock(uint256 dt) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    function _now() internal view returns (uint32) {
        return uint32(vm.getBlockTimestamp());
    }

    /* Reference model: refK[i] is the normalised tick over (refT[i-1], refT[i]], refK[0] the init tick */

    function _refInit(PoolKey memory k) internal {
        delete refT;
        delete refK;
        refT.push(_now());
        refK.push(_normTick(k));
        refSobSqrtP = _sqrtP(k);
    }

    function _refPush(uint32 t, int256 k) internal {
        refT.push(t);
        refK.push(k);
    }

    function _refCum(uint32 at, int256 curK) internal view returns (int256 c) {
        uint256 n = refT.length;
        if (at <= refT[0]) return -refK[0] * int256(uint256(refT[0] - at));
        for (uint256 i = 1; i < n; i++) {
            uint32 a = refT[i - 1];
            if (at <= a) return c;
            uint32 b = refT[i];
            c += refK[i] * int256(uint256((at < b ? at : b) - a));
        }
        if (at > refT[n - 1]) c += curK * int256(uint256(at - refT[n - 1]));
    }

    function _refSqClamp(int256 d, int256 cap) internal pure returns (uint256) {
        if (d > cap) d = cap;
        if (d < -cap) d = -cap;
        return uint256(d * d);
    }

    /// @dev sum over windows x in (gA, gB] of min(|D_x - D_{x-1}|, cap)^2, every D integrated from scratch
    function _refWsq(uint32 gA, uint32 gB, uint32 h, int256 cap, int256 curK) internal view returns (uint256 w) {
        int256 prev = _refCum(gA * h, curK) - _refCum(gA * h - h, curK);
        for (uint32 x = gA + 1; x <= gB; x++) {
            int256 d = _refCum(x * h, curK) - _refCum(x * h - h, curK);
            w += _refSqClamp(d - prev, cap);
            prev = d;
        }
    }

    function _refVariance(HookParams memory p, int256 curK) internal view returns (uint256 v, bool warm) {
        uint32 gInit = refT[0] / p.h;
        uint32 gEnd = _now() / p.h;
        uint256 n = gEnd - gInit;
        if (n > p.nWindows) n = p.nWindows;
        if (n < p.minWindows) return (p.fallbackVar, false);
        uint256 w = _refWsq(gEnd - uint32(n), gEnd, p.h, int256(uint256(p.winsorTicks) * p.h), curK);
        v = F.fullMulDiv(3 * w, LN_TICK_SQ_E36, 2 * uint256(p.h) ** 3 * n);
        if (v < p.varMin) v = p.varMin;
        if (v > p.varMax) v = p.varMax;
        warm = true;
    }

    function _rand(uint256 seed, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i)));
    }
}
