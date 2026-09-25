// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./E2E.t.sol";

/// Run with --isolate: each swap is its own transaction (cold accesses as in production).
contract GasWriteTest is E2ETest {
    function _sw(PoolKey memory k, bool zf1) internal returns (uint256) {
        swapRouter.swap(
            k,
            SwapParams({zeroForOne: zf1, amountSpecified: -1e17, sqrtPriceLimitX96: zf1 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        return vm.lastCallGas().gasTotalUsed;
    }

    function _blk(uint256 dt) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    function test_gas_writes() public {
        hook.increaseObservationCardinalityNext(key.toId(), 64);
        // warm-up: fill ring slots and checkpoints once so later writes are nonzero->nonzero (steady state)
        for (uint256 i; i < 200; i++) {
            _blk(12);
            _sw(key, i % 2 == 0);
            _sw(keyNone, i % 2 == 0);
        }
        // align to a grid boundary: next block lands inside the same window
        uint256 t = vm.getBlockTimestamp();
        uint256 toBoundary = H - (t % H);
        if (toBoundary <= 24) {
            _blk(toBoundary + 1);
            _sw(key, true);
            _sw(keyNone, true);
        }
        _blk(12);
        uint256 a = _sw(keyNone, true);
        uint256 b = _sw(key, true);
        uint256 a2 = _sw(keyNone, false);
        uint256 b2 = _sw(key, false);
        emit log_named_uint("hookless first swap", a);
        emit log_named_uint("VolOracleV2 first swap, no grid crossing", b);
        emit log_named_uint("hookless second swap same block", a2);
        emit log_named_uint("VolOracleV2 second swap same block", b2);
        // first swap that crosses exactly one grid boundary (1 checkpoint SSTORE, overwrite of a used ring slot)
        t = vm.getBlockTimestamp();
        _blk(H - (t % H) + 1);
        a = _sw(keyNone, true);
        b = _sw(key, true);
        emit log_named_uint("hookless first swap (boundary block)", a);
        emit log_named_uint("VolOracleV2 first swap, crosses 1 boundary", b);
        // 1-hour quiet gap: 12 windows -> 12 checkpoints (maxCatchUp = 12), fresh ring slots
        _blk(3600);
        a = _sw(keyNone, false);
        b = _sw(key, false);
        emit log_named_uint("hookless first swap after 1h gap", a);
        emit log_named_uint("VolOracleV2 first swap after 1h gap (12 checkpoints)", b);
    }
}
