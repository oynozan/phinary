// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {QuoteMath} from "../../src/math/QuoteMath.sol";

contract QuoteHarness {
    function buyOut(uint256 a, uint256 l, int256 i, uint256 x) external pure returns (uint256) {
        return QuoteMath.buyExactOut(a, l, i, x);
    }

    function buyIn(uint256 a, uint256 l, int256 i, uint256 x) external pure returns (uint256) {
        return QuoteMath.buyExactIn(a, l, i, x);
    }

    function sellIn(uint256 a, uint256 l, int256 i, uint256 x) external pure returns (uint256) {
        return QuoteMath.sellExactIn(a, l, i, x);
    }

    function sellOut(uint256 a, uint256 l, int256 i, uint256 x) external pure returns (uint256) {
        return QuoteMath.sellExactOut(a, l, i, x);
    }

    function call(uint256 fn, uint256 a, uint256 l, int256 i, uint256 x) external view returns (uint256) {
        if (fn == 0) return this.buyOut(a, l, i, x);
        if (fn == 1) return this.buyIn(a, l, i, x);
        if (fn == 2) return this.sellIn(a, l, i, x);
        return this.sellOut(a, l, i, x);
    }
}

/// @notice Exact-integer solvers (Lemma S, E1, E2, Theorem N of docs/md/research/gaps/formal-verification-integer-proofs.md
///         §4.1) against their defining inequalities, plus bit-exact vectors vs the search-based Python definitions.
contract QuoteMathTest is Test {
    uint256 constant W = 1e18;
    uint256 constant D = 2e24;

    QuoteHarness h = new QuoteHarness();

    function _bound(uint256 p, uint256 lam, int256 i0) internal pure returns (uint256, uint256, int256) {
        p = bound(p, 1e15, 0.999e18);
        lam = bound(lam, 0, 1e16);
        i0 = bound(i0, -1e13, 1e13);
        return (p, lam, i0);
    }

    function _beta(uint256 p, uint256 lam, int256 i0) internal pure returns (int256) {
        return int256(2e6 * p) + 2 * int256(lam) * i0;
    }

    function _N(uint256 p, uint256 lam, int256 i0, uint256 q) internal pure returns (uint256) {
        return uint256(int256(lam * q * q) + _beta(p, lam, i0) * int256(q));
    }

    function _M(uint256 p, uint256 lam, int256 i0, uint256 q) internal pure returns (int256) {
        return _beta(p, lam, i0) * int256(q) - int256(lam * q * q);
    }

    /// @dev q in [1, cap] on the increasing branch 2*lam*q <= beta of a sell at (p, lam, i0)
    function _qOnBranch(uint256 q, uint256 p, uint256 lam, int256 i0, uint256 cap) internal pure returns (uint256) {
        int256 beta = _beta(p, lam, i0);
        vm.assume(beta >= 2 * int256(lam) && beta > 0);
        uint256 hi = lam == 0 ? cap : uint256(beta) / (2 * lam);
        return bound(q, 1, hi < cap ? hi : cap);
    }

    function _try(uint256 fn, uint256 a, uint256 l, int256 i, uint256 x) internal view returns (bool ok, uint256 r) {
        try h.call(fn, a, l, i, x) returns (uint256 v) {
            return (true, v);
        } catch {
            return (false, 0);
        }
    }

    /* Vectors */

    function test_vectors_bitExact() public view {
        string memory j = vm.readFile("test/vectors/quote_math.json");
        uint256[] memory fn = vm.parseJsonUintArray(j, ".fn");
        uint256[] memory p = vm.parseJsonUintArray(j, ".price");
        uint256[] memory lam = vm.parseJsonUintArray(j, ".lam");
        int256[] memory i0 = vm.parseJsonIntArray(j, ".i0");
        uint256[] memory amt = vm.parseJsonUintArray(j, ".amt");
        uint256[] memory out = vm.parseJsonUintArray(j, ".out");
        uint256[] memory err = vm.parseJsonUintArray(j, ".err");
        uint256[3] memory counts;
        for (uint256 k; k < fn.length; ++k) {
            try h.call(fn[k], p[k], lam[k], i0[k], amt[k]) returns (uint256 r) {
                assertEq(err[k], 0, "expected revert");
                assertEq(r, out[k], "amount");
            } catch (bytes memory reason) {
                bytes4 sel = bytes4(reason);
                if (err[k] == 1) assertEq(sel, QuoteMath.Band.selector, "expected Band");
                else if (err[k] == 2) assertEq(sel, QuoteMath.Unreachable.selector, "expected Unreachable");
                else revert("unexpected revert");
            }
            ++counts[err[k]];
        }
        console2.log("vectors ok / Band / Unreachable", counts[0], counts[1], counts[2]);
    }

    /* Lemma S and rounding direction */

    function testFuzz_buyExactIn_maximalFeasible(uint256 a, uint256 lam, int256 i0, uint256 amt) public view {
        (a, lam, i0) = _bound(a, lam, i0);
        vm.assume(_beta(a, lam, i0) > 0);
        amt = bound(amt, 0, 1e15);
        uint256 q = h.buyIn(a, lam, i0, amt);
        assertLe(h.buyOut(a, lam, i0, q), amt, "infeasible: costs more than paid");
        assertGt(h.buyOut(a, lam, i0, q + 1), amt, "not maximal");
    }

    function testFuzz_buyExactOut_ceil(uint256 a, uint256 lam, int256 i0, uint256 q) public view {
        (a, lam, i0) = _bound(a, lam, i0);
        vm.assume(_beta(a, lam, i0) > 0);
        q = bound(q, 0, 1e13);
        uint256 cost = h.buyOut(a, lam, i0, q);
        uint256 n = _N(a, lam, i0, q);
        assertGe(cost * D, n, "rounded down");
        if (n > 0) assertLt((cost - 1) * D, n, "not the ceiling");
        else assertEq(cost, 0);
    }

    function testFuzz_sellExactIn_floorAndBranch(uint256 b, uint256 lam, int256 i0, uint256 q) public view {
        (b, lam, i0) = _bound(b, lam, i0);
        int256 beta = _beta(b, lam, i0);
        vm.assume(beta > 0);
        q = bound(q, 0, lam == 0 ? 1e13 : uint256(beta) / (2 * lam) + 2);
        (bool ok, uint256 p) = _try(2, b, lam, i0, q);
        if (2 * lam * q > uint256(beta)) {
            assertFalse(ok, "off the increasing branch must revert");
            return;
        }
        assertTrue(ok);
        int256 m = _M(b, lam, i0, q);
        assertLe(int256(p * D), m, "rounded up");
        assertGt(int256((p + 1) * D), m, "not the floor");
    }

    function testFuzz_sellExactIn_bandRevert(uint256 b, uint256 lam, int256 i0, uint256 q) public {
        (b, lam, i0) = _bound(b, lam, i0);
        lam = bound(lam, 1, 1e16);
        int256 beta = _beta(b, lam, i0);
        vm.assume(beta > 0);
        uint256 vertex = uint256(beta) / (2 * lam);
        q = bound(q, vertex + 1, vertex + 1e12);
        vm.expectRevert(QuoteMath.Band.selector);
        h.sellIn(b, lam, i0, q);
    }

    function testFuzz_sellExactOut_minimalSufficient(uint256 b, uint256 lam, int256 i0, uint256 amt) public view {
        (b, lam, i0) = _bound(b, lam, i0);
        int256 beta = _beta(b, lam, i0);
        vm.assume(beta > 0);
        amt = bound(amt, 0, 1e13);
        (bool ok, uint256 q) = _try(3, b, lam, i0, amt);
        if (!ok) {
            // unreachable on the increasing branch: even its vertex pays less than amt
            if (lam > 0) assertLt(h.sellIn(b, lam, i0, uint256(beta) / (2 * lam)), amt);
            return;
        }
        assertLe(2 * lam * q, uint256(beta), "left the increasing branch");
        assertGe(h.sellIn(b, lam, i0, q), amt, "insufficient");
        if (q > 0) assertLt(h.sellIn(b, lam, i0, q - 1), amt, "not minimal");
    }

    /// @dev Research counterexample to Lemma S without the band hypothesis: q lands one unit past the vertex
    function test_lemmaS_sellCounterexampleReverts() public {
        vm.expectRevert(QuoteMath.Band.selector);
        h.sellOut(10_020_000_000_000_000, 55_778, 0, 9e14);
    }

    function test_workedExamples() public view {
        assertEq(h.buyIn(0.41e18, 0, 0, 100e6), 243_902_439);
        assertEq(h.buyOut(0.41e18, 0, 0, 243_902_439), 100e6);
        assertEq(h.sellOut(0.39e18, 0, 0, 39e6), 100e6);
        assertEq(h.sellIn(0.39e18, 0, 0, 100e6), 39e6);
        assertEq(h.buyOut(0.5e18, 1e13, 0, 1e6), 500_005);
    }

    function test_betaReverts() public {
        vm.expectRevert(QuoteMath.Band.selector);
        h.buyOut(0.1e18, 1e13, -10_000e6 - 1, 1);
        vm.expectRevert(QuoteMath.Band.selector);
        h.buyIn(0, 0, 0, 1);
        vm.expectRevert(QuoteMath.Band.selector);
        h.buyOut(uint256(2 ** 255) / 2e6 + 1, 0, 0, 1);
        vm.expectRevert(QuoteMath.Band.selector);
        h.buyOut(0.5e18, 2 ** 255, 0, 1);
        vm.expectRevert(QuoteMath.Band.selector);
        h.buyOut(0.5e18, 1e16, 0, 1e31);
        vm.expectRevert(QuoteMath.Unreachable.selector);
        h.sellOut(0.5e18, 1e13, 0, 1e12);
    }

    /// @dev Outside the domain every function reverts Band, inside it none panics (worst case: every bound at its max)
    function testFuzz_domain_noPanic(uint256 fn, uint256 p, uint256 lam, int256 i0, uint256 amt) public {
        fn = bound(fn, 0, 3);
        uint256 sel = bound(p, 0, 3);
        if (sel == 0) p = bound(p, 0, QuoteMath.MAX_PRICE);
        if (sel == 1) lam = bound(lam, 0, QuoteMath.MAX_LAM);
        if (sel == 2) i0 = bound(i0, -int256(QuoteMath.MAX_AMOUNT), int256(QuoteMath.MAX_AMOUNT));
        if (sel == 3) amt = bound(amt, 0, QuoteMath.MAX_AMOUNT);
        try h.call(fn, p, lam, i0, amt) {}
        catch (bytes memory reason) {
            bytes4 e = bytes4(reason);
            assertTrue(e == QuoteMath.Band.selector || e == QuoteMath.Unreachable.selector, "not a custom error");
        }
        bool inDomain = p <= QuoteMath.MAX_PRICE && lam <= QuoteMath.MAX_LAM && amt <= QuoteMath.MAX_AMOUNT
            && i0 <= int256(QuoteMath.MAX_AMOUNT) && i0 >= -int256(QuoteMath.MAX_AMOUNT);
        if (!inDomain) {
            vm.expectRevert(QuoteMath.Band.selector);
            h.call(fn, p, lam, i0, amt);
        }
    }

    function test_domain_extremes() public view {
        uint256 mp = QuoteMath.MAX_PRICE;
        uint256 ml = QuoteMath.MAX_LAM;
        uint256 ma = QuoteMath.MAX_AMOUNT;
        int256 iBeta = 49e12; // beta == MAX_BETA exactly
        assertEq(h.buyOut(mp, ml, iBeta, ma), 500_000_000_050_000_000_000_000_000_000_000_000_000_000_000_000);
        assertEq(h.buyIn(mp, ml, iBeta, ma), 19_996_001_599);
        assertEq(h.sellOut(mp, ml, iBeta, ma), 20_004_001_601);
        for (uint256 fn; fn < 4; ++fn) {
            (bool ok,) = _try(fn, mp, ml, iBeta + 1, 1);
            assertFalse(ok);
        }
    }

    /* T4(g): one epoch against fair value F extracts at most ((F - a)+)^2 / (2 lam), a the quoted ask (or bid) */

    /// @dev profit (USDC units) <= (F - a)^2 / (2 lam 1e12), compared exactly as profit * 2 lam 1e30 <= (F - a)^2 1e18
    function _assertExtraction(int256 profitE18, uint256 edge, uint256 lam) internal pure {
        if (profitE18 <= 0) return;
        assertGt(edge, 0, "profit without an edge");
        assertLe(uint256(profitE18) * 2 * lam * 1e12, edge * edge * 1e18, "extraction above ((F-a)+)^2/(2 lam)");
    }

    function testFuzz_extraction_buyExactOut(uint256 a, uint256 lam, uint256 fair, uint256 q1, uint256 q2)
        public
        view
    {
        a = bound(a, 1e15, 0.999e18);
        lam = bound(lam, 1, 1e18);
        fair = bound(fair, 0, 1e18);
        q1 = bound(q1, 0, 1e14);
        q2 = bound(q2, 0, 1e14);
        uint256 c = h.buyOut(a, lam, 0, q1) + h.buyOut(a, lam, int256(q1), q2);
        int256 profit = int256(fair * (q1 + q2)) - int256(c * W);
        _assertExtraction(profit, fair > a ? fair - a : 0, lam);
    }

    function testFuzz_extraction_buyExactIn(uint256 a, uint256 lam, uint256 fair, uint256 a1, uint256 a2)
        public
        view
    {
        a = bound(a, 1e15, 0.999e18);
        lam = bound(lam, 1, 1e18);
        fair = bound(fair, 0, 1e18);
        a1 = bound(a1, 0, 1e14);
        a2 = bound(a2, 0, 1e14);
        uint256 q1 = h.buyIn(a, lam, 0, a1);
        uint256 q2 = h.buyIn(a, lam, int256(q1), a2);
        int256 profit = int256(fair * (q1 + q2)) - int256((a1 + a2) * W);
        _assertExtraction(profit, fair > a ? fair - a : 0, lam);
    }

    function testFuzz_extraction_sellExactIn(uint256 b, uint256 lam, uint256 fair, uint256 q1, uint256 q2)
        public
        view
    {
        b = bound(b, 1e15, 0.999e18);
        lam = bound(lam, 1, 1e18);
        fair = bound(fair, 0, 1e18);
        q1 = bound(q1, 0, 1e14);
        q2 = bound(q2, 0, 1e14);
        (bool ok1, uint256 p1) = _try(2, b, lam, 0, q1);
        (bool ok2, uint256 p2) = _try(2, b, lam, -int256(q1), q2);
        vm.assume(ok1 && ok2);
        int256 profit = int256((p1 + p2) * W) - int256(fair * (q1 + q2));
        _assertExtraction(profit, b > fair ? b - fair : 0, lam);
    }

    function testFuzz_extraction_sellExactOut(uint256 b, uint256 lam, uint256 fair, uint256 a1, uint256 a2)
        public
        view
    {
        b = bound(b, 1e15, 0.999e18);
        lam = bound(lam, 1, 1e18);
        fair = bound(fair, 0, 1e18);
        a1 = bound(a1, 0, 1e14);
        a2 = bound(a2, 0, 1e14);
        (bool ok1, uint256 q1) = _try(3, b, lam, 0, a1);
        vm.assume(ok1);
        (bool ok2, uint256 q2) = _try(3, b, lam, -int256(q1), a2);
        vm.assume(ok2);
        int256 profit = int256((a1 + a2) * W) - int256(fair * (q1 + q2));
        _assertExtraction(profit, b > fair ? b - fair : 0, lam);
    }

    /* E2: round trips never profit, and lose at least the spread */

    function testFuzz_roundTrip_buyThenSell(uint256 a, uint256 spread, uint256 lam, int256 i0, uint256 q)
        public
        view
    {
        (a, lam, i0) = _bound(a, lam, i0);
        spread = bound(spread, 0, a - 1);
        uint256 b = a - spread;
        q = bound(q, 1, 1e12);
        vm.assume(_beta(a, lam, i0) > 0);
        uint256 cost = h.buyOut(a, lam, i0, q);
        (bool ok, uint256 back) = _try(2, b, lam, i0 + int256(q), q);
        vm.assume(ok);
        assertLe(back, cost);
        assertGe(cost - back, spread * q / W, "lost less than the spread");
    }

    function testFuzz_roundTrip_sellThenBuy(uint256 a, uint256 spread, uint256 lam, int256 i0, uint256 q)
        public
        view
    {
        (a, lam, i0) = _bound(a, lam, i0);
        spread = bound(spread, 0, a - 1);
        uint256 b = a - spread;
        q = _qOnBranch(q, b, lam, i0, 1e12);
        (bool ok, uint256 got) = _try(2, b, lam, i0, q);
        assertTrue(ok);
        (bool ok2, uint256 cost) = _try(0, a, lam, i0 - int256(q), q);
        vm.assume(ok2);
        assertLe(got, cost);
        assertGe(cost - got, spread * q / W);
    }

    function testFuzz_roundTrip_exactIn(uint256 a, uint256 spread, uint256 lam, int256 i0, uint256 amt) public view {
        (a, lam, i0) = _bound(a, lam, i0);
        spread = bound(spread, 0, a - 1);
        amt = bound(amt, 1, 1e14);
        vm.assume(_beta(a, lam, i0) > 0);
        uint256 q = h.buyIn(a, lam, i0, amt);
        (bool ok, uint256 back) = _try(2, a - spread, lam, i0 + int256(q), q);
        vm.assume(ok);
        assertLe(back, amt);
    }

    /* E1: complete sets through the NO mirror (price 1 - bid / 1 - ask, state -I) never beat par */

    function _quotes(uint256 a, uint256 spread) internal pure returns (uint256 ask, uint256 bid) {
        ask = bound(a, 2e15, 0.998e18);
        bid = ask - bound(spread, 0, ask - 1e15);
    }

    function testFuzz_completeSet_buyExactOut(uint256 a, uint256 spread, uint256 lam, int256 i0, uint256 q)
        public
        view
    {
        (uint256 ask, uint256 bid) = _quotes(a, spread);
        (, lam, i0) = _bound(0.5e18, lam, i0);
        q = bound(q, 1, 1e12);
        (bool ok1, uint256 cY) = _try(0, ask, lam, i0, q);
        (bool ok2, uint256 cN) = _try(0, W - bid, lam, -i0, q);
        (bool ok3, uint256 cNseq) = _try(0, W - bid, lam, -(i0 + int256(q)), q);
        vm.assume(ok1 && (ok2 || ok3));
        if (ok2) assertGe(cY + cN, q, "YES + NO bought below par (same state)");
        if (ok3) assertGe(cY + cNseq, q, "YES + NO bought below par (sequential)");
    }

    function testFuzz_completeSet_sellExactIn(uint256 a, uint256 spread, uint256 lam, int256 i0, uint256 q)
        public
        view
    {
        (uint256 ask, uint256 bid) = _quotes(a, spread);
        (, lam, i0) = _bound(0.5e18, lam, i0);
        q = _qOnBranch(q, bid, lam, i0, 1e12);
        (bool ok1, uint256 pY) = _try(2, bid, lam, i0, q);
        (bool ok2, uint256 pN) = _try(2, W - ask, lam, -i0, q);
        (bool ok3, uint256 pNseq) = _try(2, W - ask, lam, -(i0 - int256(q)), q);
        vm.assume(ok1 && (ok2 || ok3));
        if (ok2) assertLe(pY + pN, q, "YES + NO sold above par (same state)");
        if (ok3) assertLe(pY + pNseq, q, "YES + NO sold above par (sequential)");
    }

    function testFuzz_completeSet_buyExactIn(
        uint256 a,
        uint256 spread,
        uint256 lam,
        int256 i0,
        uint256 amtY,
        uint256 amtN
    ) public view {
        (uint256 ask, uint256 bid) = _quotes(a, spread);
        (, lam, i0) = _bound(0.5e18, lam, i0);
        amtY = bound(amtY, 0, 1e14);
        amtN = bound(amtN, 0, 1e14);
        (bool ok1, uint256 qY) = _try(1, ask, lam, i0, amtY);
        (bool ok2, uint256 qN) = _try(1, W - bid, lam, -i0, amtN);
        vm.assume(ok1 && ok2);
        assertLe(qY < qN ? qY : qN, amtY + amtN, "complete sets below par");
    }

    /* Theorem N: splitting a trade gains nothing */

    function testFuzz_noSplit_buyExactIn(uint256 a, uint256 lam, int256 i0, uint256 a1, uint256 a2) public view {
        (a, lam, i0) = _bound(a, lam, i0);
        vm.assume(_beta(a, lam, i0) > 0);
        a1 = bound(a1, 0, 1e14);
        a2 = bound(a2, 0, 1e14);
        uint256 q1 = h.buyIn(a, lam, i0, a1);
        uint256 q2 = h.buyIn(a, lam, i0 + int256(q1), a2);
        assertLe(q1 + q2, h.buyIn(a, lam, i0, a1 + a2));
    }

    function testFuzz_noSplit_buyExactOut(uint256 a, uint256 lam, int256 i0, uint256 q1, uint256 q2) public view {
        (a, lam, i0) = _bound(a, lam, i0);
        vm.assume(_beta(a, lam, i0) > 0);
        q1 = bound(q1, 0, 1e12);
        q2 = bound(q2, 0, 1e12);
        uint256 c1 = h.buyOut(a, lam, i0, q1);
        uint256 c2 = h.buyOut(a, lam, i0 + int256(q1), q2);
        assertGe(c1 + c2, h.buyOut(a, lam, i0, q1 + q2));
    }

    function testFuzz_noSplit_sellExactIn(uint256 b, uint256 lam, int256 i0, uint256 q1, uint256 q2) public view {
        (b, lam, i0) = _bound(b, lam, i0);
        uint256 qq = _qOnBranch(q1, b, lam, i0, 2e12);
        q1 = bound(q2, 0, qq);
        q2 = qq - q1;
        (bool ok, uint256 whole) = _try(2, b, lam, i0, q1 + q2);
        vm.assume(ok);
        uint256 p1 = h.sellIn(b, lam, i0, q1);
        (bool ok2, uint256 p2) = _try(2, b, lam, i0 - int256(q1), q2);
        vm.assume(ok2);
        assertLe(p1 + p2, whole);
    }

    function testFuzz_noSplit_sellExactOut(uint256 b, uint256 lam, int256 i0, uint256 a1, uint256 a2) public view {
        (b, lam, i0) = _bound(b, lam, i0);
        a1 = bound(a1, 0, 1e12);
        a2 = bound(a2, 0, 1e12);
        (bool ok, uint256 whole) = _try(3, b, lam, i0, a1 + a2);
        vm.assume(ok);
        uint256 q1 = h.sellOut(b, lam, i0, a1);
        (bool ok2, uint256 q2) = _try(3, b, lam, i0 - int256(q1), a2);
        vm.assume(ok2);
        assertGe(q1 + q2, whole);
    }

    function test_gas() public view {
        uint256 g = gasleft();
        h.buyIn(0.41e18, 1e13, 1234e6, 100e6);
        uint256 g1 = g - gasleft();
        g = gasleft();
        h.sellOut(0.39e18, 1e13, -555e6, 100e6);
        uint256 g2 = g - gasleft();
        console2.log("gas buyExactIn / sellExactOut (incl. external call)", g1, g2);
    }
}
