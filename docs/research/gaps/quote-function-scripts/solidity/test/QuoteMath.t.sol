// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {QuoteMath} from "../src/QuoteMath.sol";

contract H {
    function buyIn(uint256 a, uint256 l, int256 i, uint256 x) external pure returns (uint256) { return QuoteMath.buyExactIn(a, l, i, x); }
    function buyOut(uint256 a, uint256 l, int256 i, uint256 x) external pure returns (uint256) { return QuoteMath.buyExactOut(a, l, i, x); }
    function sellIn(uint256 a, uint256 l, int256 i, uint256 x) external pure returns (uint256) { return QuoteMath.sellExactIn(a, l, i, x); }
    function sellOut(uint256 a, uint256 l, int256 i, uint256 x) external pure returns (uint256) { return QuoteMath.sellExactOut(a, l, i, x); }
}

contract QuoteMathTest is Test {
    H h = new H();

    function _bound(uint256 a, uint256 lam, int256 i0) internal pure returns (uint256, uint256, int256) {
        a = bound(a, 1e16, 0.99e18);
        lam = bound(lam, 0, 1e16);           // up to 0.01 USDC per token per token
        i0 = bound(i0, -1e13, 1e13);
        return (a, lam, i0);
    }

    function _ok(uint256 a, uint256 lam, int256 i0) internal pure returns (bool) {
        return int256(2e6 * a) + 2 * int256(lam) * i0 > 0;
    }

    function testFuzz_buyExactIn_maximal(uint256 a, uint256 lam, int256 i0, uint256 amt) public view {
        (a, lam, i0) = _bound(a, lam, i0);
        vm.assume(_ok(a, lam, i0));
        amt = bound(amt, 1, 1e15);
        uint256 q = h.buyIn(a, lam, i0, amt);
        assertLe(h.buyOut(a, lam, i0, q), amt, "over-delivers");
        assertGt(h.buyOut(a, lam, i0, q + 1), amt, "not maximal");
    }

    function testFuzz_sellExactOut_minimal(uint256 b, uint256 lam, int256 i0, uint256 amt) public view {
        (b, lam, i0) = _bound(b, lam, i0);
        vm.assume(_ok(b, lam, i0));
        amt = bound(amt, 1, 1e13);
        try h.sellOut(b, lam, i0, amt) returns (uint256 q) {
            // stay on increasing branch (the hook's band check guarantees this in production)
            vm.assume(int256(1e6 * b) + int256(lam) * (i0 - int256(q)) > 0);
            assertGe(h.sellIn(b, lam, i0, q), amt, "under-pays trader");
            if (q > 0) assertLt(h.sellIn(b, lam, i0, q - 1), amt, "not minimal");
        } catch {}
    }

    function testFuzz_noSplit_buyExactIn(uint256 a, uint256 lam, int256 i0, uint256 a1, uint256 a2) public view {
        (a, lam, i0) = _bound(a, lam, i0);
        vm.assume(_ok(a, lam, i0));
        a1 = bound(a1, 1, 1e14); a2 = bound(a2, 1, 1e14);
        uint256 q1 = h.buyIn(a, lam, i0, a1);
        uint256 q2 = h.buyIn(a, lam, i0 + int256(q1), a2);
        assertLe(q1 + q2, h.buyIn(a, lam, i0, a1 + a2));
    }

    function testFuzz_noSplit_sellExactIn(uint256 b, uint256 lam, int256 i0, uint256 q1, uint256 q2) public view {
        (b, lam, i0) = _bound(b, lam, i0);
        q1 = bound(q1, 1, 1e12); q2 = bound(q2, 1, 1e12);
        vm.assume(int256(1e6 * b) + int256(lam) * (i0 - int256(q1 + q2)) > 0);
        uint256 p1 = h.sellIn(b, lam, i0, q1);
        uint256 p2 = h.sellIn(b, lam, i0 - int256(q1), q2);
        assertLe(p1 + p2, h.sellIn(b, lam, i0, q1 + q2));
    }

    function testFuzz_roundTrip(uint256 a, uint256 spreadWad, uint256 lam, int256 i0, uint256 q) public view {
        (a, lam, i0) = _bound(a, lam, i0);
        spreadWad = bound(spreadWad, 0, a - 1);
        uint256 b = a - spreadWad;
        q = bound(q, 1, 1e12);
        vm.assume(_ok(b, lam, i0));
        uint256 cost = h.buyOut(a, lam, i0, q);
        uint256 back = h.sellIn(b, lam, i0 + int256(q), q);
        assertLe(back, cost);
    }

    function test_gas() public {
        uint256 g = gasleft(); h.buyIn(0.41e18, 1e13, 1234e6, 100e6); uint256 g1 = g - gasleft();
        g = gasleft(); h.sellOut(0.39e18, 1e13, -555e6, 100e6); uint256 g2 = g - gasleft();
        g = gasleft(); h.buyOut(0.41e18, 1e13, 1234e6, 100e6); uint256 g3 = g - gasleft();
        emit log_named_uint("buyExactIn (incl. external call)", g1);
        emit log_named_uint("sellExactOut (incl. external call)", g2);
        emit log_named_uint("buyExactOut (incl. external call)", g3);
        // worked example from 01 1.8 case A (lam = 0): 100 USDC at 0.41 -> 243,902,439 YES
        assertEq(h.buyIn(0.41e18, 0, 0, 100e6), 243_902_439);
    }
}
