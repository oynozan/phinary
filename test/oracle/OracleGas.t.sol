// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {UnderlyingOracleHook} from "../../src/oracle/UnderlyingOracleHook.sol";
import {OracleTestBase} from "./OracleTestBase.sol";

/// @notice Swap gas on the oracle pool minus the same swap on an identical hookless pool. Accounts are cooled before
///         every measured swap to approximate a fresh transaction; rings are warmed past wrap-around (steady state).
contract OracleGasTest is OracleTestBase {
    UnderlyingOracleHook internal hook;
    PoolKey internal hooked;
    PoolKey internal plain;

    function usdcIsCurrency0() internal pure override returns (bool) {
        return false;
    }

    function setUp() public {
        _setUpEnv();
        HookParams memory p = _defaultParams();
        (p.nWindows, p.cardinality) = (60, 64);
        hook = _deployHook(p);
        hooked = _initPool(address(hook), 2700e18);
        plain = _initPool(address(0), 2700e18);
        for (uint256 i; i < 400; i++) {
            _nextBlock(12);
            _sw(hooked, i % 2 == 0);
            _sw(plain, i % 2 == 0);
        }
        assertEq(hook.feedInfo().observationCount, 64);
    }

    function test_gasFirstSwapInBlockOverhead() public {
        if (_now() % 60 >= 45) _warpTo((_now() / 60 + 1) * 60 + 1);
        _swBoth(true);
        _nextBlock(12);
        (uint256 a, uint256 b) = _swBoth(false);
        (uint256 a2, uint256 b2) = _swBoth(true);
        emit log_named_uint("first swap in block, hookless", a);
        emit log_named_uint("first swap in block, oracle hook", b);
        emit log_named_uint("overhead: first swap in block, no grid boundary", b - a);
        emit log_named_uint("overhead: later swap in the same block", b2 - a2);
        assertLt(b - a, 25_000);
        assertLt(b2 - a2, 10_000);

        _warpTo((_now() / 60 + 1) * 60 + 1);
        (a, b) = _swBoth(false);
        emit log_named_uint("overhead: first swap in block, crosses a grid boundary", b - a);
        assertLt(b - a, 40_000);

        _nextBlock(1 days);
        (a, b) = _swBoth(true);
        emit log_named_uint("overhead: first swap after a 1-day gap", b - a);
        assertLt(b - a, 40_000);
    }

    function _swBoth(bool zeroForOne) internal returns (uint256 plainGas, uint256 hookedGas) {
        plainGas = _sw(plain, zeroForOne);
        hookedGas = _sw(hooked, zeroForOne);
    }

    function _sw(PoolKey memory k, bool zeroForOne) internal returns (uint256 used) {
        vm.cool(address(manager));
        vm.cool(address(hook));
        vm.cool(address(weth));
        vm.cool(address(usdcToken));
        vm.cool(address(swapRouter));
        // WETH is currency0: 0.01 WETH in, or 27 USDC in
        SwapParams memory sp = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: zeroForOne ? -1e16 : -27e6,
            sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
        PoolSwapTest.TestSettings memory ts = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        uint256 g = gasleft();
        swapRouter.swap(k, sp, ts, ZERO_BYTES);
        used = g - gasleft();
    }
}
