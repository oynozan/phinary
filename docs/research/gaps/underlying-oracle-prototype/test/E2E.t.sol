// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {VolOracleHookV2} from "../src/VolOracleHookV2.sol";
import {VolOracleV2} from "../src/VolOracleV2.sol";
import {IUnderlyingOracle} from "../src/IUnderlyingOracle.sol";

/// Reads the oracle the way the PredictionHook would (external call, cold), measuring gas of each read.
contract Reader {
    function gasOf(address target, bytes calldata data) external view returns (uint256 used, bytes memory ret) {
        uint256 g = gasleft();
        bool ok;
        (ok, ret) = target.staticcall(data);
        used = g - gasleft();
        require(ok, "read reverted");
    }
}

contract E2ETest is Test, Deployers {
    using StateLibrary for IPoolManager;

    VolOracleHookV2 hook;

    PoolKey keyNone;
    bytes32 feed;
    Reader reader;
    uint32 constant H = 300;

    function setUp() public {
        vm.warp(1_790_000_100);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        address a = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) | (uint160(0x4444) << 144));
        deployCodeTo("VolOracleHookV2.sol:VolOracleHookV2", abi.encode(manager, H, int24(400), uint16(4096), uint16(12)), a);
        hook = VolOracleHookV2(a);
        (key,) = initPool(currency0, currency1, IHooks(a), 500, SQRT_PRICE_1_1);
        (keyNone,) = initPool(currency0, currency1, IHooks(address(0)), 500, SQRT_PRICE_1_1);
        ModifyLiquidityParams memory lp = ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 1e24, salt: 0});
        modifyLiquidityRouter.modifyLiquidity(key, lp, ZERO_BYTES);
        modifyLiquidityRouter.modifyLiquidity(keyNone, lp, ZERO_BYTES);
        feed = PoolId.unwrap(key.toId());
        reader = new Reader();
    }

    function _swapTo(PoolKey memory k, int24 target) internal {
        (uint160 sp,,,) = manager.getSlot0(k.toId());
        uint160 tp = TickMath.getSqrtPriceAtTick(target);
        if (tp == sp) return;
        bool zf1 = tp < sp;
        swapRouter.swap(
            k,
            SwapParams({zeroForOne: zf1, amountSpecified: -1e30, sqrtPriceLimitX96: tp}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    function _gauss(uint256 seed) internal pure returns (int256 z) {
        // Irwin-Hall(12) - 6 : mean 0, variance 1 (WAD)
        for (uint256 i; i < 12; i++) z += int256(uint256(keccak256(abi.encode(seed, i))) % 1e18);
        z -= 6e18;
    }

    function _reads() internal view returns (bytes memory) {
        (int24 sob,) = hook.sobTick(feed); // lastWriteTime is metadata and legitimately changes
        (uint160 sobP,) = hook.sobSqrtPriceX96(feed);
        int56 cn = hook.cumulativeNow(feed);
        uint32 g = uint32(vm.getBlockTimestamp()) / H;
        int56 cg = hook.cumulativeAtGrid(feed, g);
        (uint256 v,,, uint32 dn) = g >= (1_790_000_100 / H) + 3 ? hook.varianceE36(feed, 2) : (uint256(0), uint32(0), uint32(0), uint32(0));
        return abi.encode(sob, sobP, cn, cg, v, dn);
    }

    /// 1 day of 12 s blocks, sigma = 50%: the pool is driven along a random tick path through the real PoolManager.
    /// Every 25th block an attacker pushes the pool 500 ticks and back inside the block: all oracle reads unchanged.
    function test_e2e_gbmThroughPoolManager_sameBlockInvariance() public {
        uint256 nb = 7200;
        uint256 boundaryCases;
        int256 xWad; // log-price in ticks, WAD
        int24[] memory path = new int24[](nb + 1);
        path[0] = 0;
        int256 sdTicksWad = 3.0849e18; // 0.5*sqrt(12/31536000)/ln(1.0001)
        for (uint256 b = 1; b <= nb; b++) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 12);
            if (b % 25 == 0) {
                bytes memory r0 = _reads();
                (, int24 cur,,) = manager.getSlot0(key.toId());
                _swapTo(key, cur + 500); // manipulation (first swap in block -> oracle records pre-swap tick)
                bytes memory r1 = _reads();
                _swapTo(key, cur - 500);
                bytes memory r2 = _reads();
                _swapTo(key, cur);
                assertEq(keccak256(r0), keccak256(r1), "reads moved by same-block swap (up)");
                assertEq(keccak256(r0), keccak256(r2), "reads moved by same-block swap (down)");
            }
            xWad += sdTicksWad * _gauss(b) / 1e18;
            int24 target = int24(xWad / 1e18);
            _swapTo(key, target);
            // record the pool's actual tick: a zeroForOne swap ending exactly on a word-boundary tick leaves
            // slot0.tick = target - 1 (v4-core Pool.sol:431), and the oracle must follow the pool, not the intent
            (, int24 actual,,) = manager.getSlot0(key.toId());
            if (actual != target) boundaryCases++;
            path[b] = actual;
        }
        // reference: prevailing tick in block b is path[b-1]; blocks are 12 s apart starting at t0
        uint32 t0 = 1_790_000_100;
        (VolOracleV2.Observation memory last,) = hook.latest(key.toId());
        int256 refCum;
        for (uint256 b = 1; b <= nb; b++) refCum += int256(path[b - 1]) * 12;
        // last write happened in block nb (swap) or earlier if the target equalled the current price
        assertEq(int256(hook.cumulativeNow(feed)), refCum, "cumulative == reference");
        assertEq(last.blockTimestamp <= uint32(vm.getBlockTimestamp()), true);
        // window statistics, independent integration
        uint32 gA = t0 / H + 1;
        uint32 gB = uint32(vm.getBlockTimestamp()) / H;
        uint256 dq;
        int256 prevD;
        for (uint32 g = gA; g <= gB; g++) {
            int256 D;
            for (uint256 b = (g * H - t0) / 12 - 24; b <= (g * H - t0) / 12; b++) D += int256(path[b - 1]) * 12;
            if (g > gA) {
                int256 d = D - prevD;
                if (d > 400 * 300) d = 400 * 300;
                if (d < -400 * 300) d = -400 * 300;
                dq += uint256(d * d);
            }
            prevD = D;
        }
        (uint256 v, uint32 s, uint32 e, uint32 dN) = hook.varianceE36(feed, gB - gA);
        assertEq(s, gA);
        assertEq(e, gB);
        assertEq(v, VolOracleV2.mulDiv(dq * 3, VolOracleV2.LN_TICK_SQ_E36, 2 * uint256(H) ** 3 * dN), "variance bit-exact");
        uint256 ratio = v * 31_536_000 / 0.25e18; // WAD
        emit log_named_decimal_uint("sigma_hat^2 / sigma^2 (1 day, through PoolManager)", ratio, 18);
        emit log_named_uint("blocks where slot0.tick = target - 1 (Pool.sol:431 edge)", boundaryCases);
        // slightly inside the 99.9% chi2 band for n = 287, nu = n/1.125 (scipy: 0.734, 1.317); Irwin-Hall shocks ~Gaussian
        assertGt(ratio, 0.735e18);
        assertLt(ratio, 1.307e18);
    }

    // ------------------------------------------------------------------------------------ gas
    function _g(bytes memory data) internal returns (uint256 used) {
        vm.cool(address(hook));
        vm.cool(address(manager));
        (used,) = reader.gasOf(address(hook), data);
    }

    function test_gas_reads() public {
        // build 2 hours of history with one swap per block
        for (uint256 b = 1; b <= 600; b++) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + 12);
            _swapTo(key, int24(int256(b % 13)) - 6);
        }
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 12);
        uint32 g = uint32(vm.getBlockTimestamp()) / H;
        (, VolOracleV2.State memory st) = hook.latest(key.toId());
        bool virtualEnd = g > st.lastGrid;
        emit log_named_uint("[no write yet in block] sobTick", _g(abi.encodeCall(hook.sobTick, (feed))));
        emit log_named_uint("[no write yet in block] sobSqrtPriceX96", _g(abi.encodeCall(hook.sobSqrtPriceX96, (feed))));
        emit log_named_uint("[no write yet in block] cumulativeNow", _g(abi.encodeCall(hook.cumulativeNow, (feed))));
        emit log_named_uint("[no write yet in block] cumulativeAtGrid(ring)", _g(abi.encodeCall(hook.cumulativeAtGrid, (feed, st.lastGrid - 3))));
        emit log_named_uint(virtualEnd ? "[no write yet] varianceE36(12) virtual end" : "[no write yet] varianceE36(12) ring end", _g(abi.encodeCall(hook.varianceE36, (feed, 12))));
        _swapTo(key, 3);
        emit log_named_uint("[written this block] sobTick", _g(abi.encodeCall(hook.sobTick, (feed))));
        emit log_named_uint("[written this block] sobSqrtPriceX96", _g(abi.encodeCall(hook.sobSqrtPriceX96, (feed))));
        emit log_named_uint("[written this block] cumulativeNow", _g(abi.encodeCall(hook.cumulativeNow, (feed))));
        emit log_named_uint("[written this block] varianceE36(12)", _g(abi.encodeCall(hook.varianceE36, (feed, 12))));
        emit log_named_uint("[written this block] varianceE36(24)", _g(abi.encodeCall(hook.varianceE36, (feed, 24))));
    }
}
