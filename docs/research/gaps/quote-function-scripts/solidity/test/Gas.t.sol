// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {QuoteMath} from "../src/QuoteMath.sol";
contract GasTest is Test {
    function test_gasInternal() public {
        uint256 a = vm.randomUint(0.4e18, 0.42e18); uint256 lam = vm.randomUint(1e13, 2e13);
        int256 i0 = int256(vm.randomUint(1e9, 2e9)); uint256 x = vm.randomUint(1e8, 2e8);
        uint256 g = gasleft(); uint256 r1 = QuoteMath.buyExactIn(a, lam, i0, x); uint256 g1 = g - gasleft();
        g = gasleft(); uint256 r2 = QuoteMath.sellExactOut(a - 2e16, lam, -i0, x); uint256 g2 = g - gasleft();
        g = gasleft(); uint256 r3 = QuoteMath.buyExactOut(a, lam, i0, x); uint256 g3 = g - gasleft();
        g = gasleft(); uint256 r4 = QuoteMath.sellExactIn(a - 2e16, lam, -i0, x); uint256 g4 = g - gasleft();
        emit log_named_uint("buyExactIn", g1); emit log_named_uint("sellExactOut", g2);
        emit log_named_uint("buyExactOut", g3); emit log_named_uint("sellExactIn", g4);
        assertGt(r1 + r2 + r3 + r4, 0);
    }
}
