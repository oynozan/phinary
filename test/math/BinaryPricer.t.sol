// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {BinaryPricer} from "../../src/math/BinaryPricer.sol";
import {NormalCdf} from "../../src/math/NormalCdf.sol";
import {StudentTCdf} from "../../src/math/StudentTCdf.sol";
import {PricingEngine} from "../../src/math/PricingEngine.sol";

contract PricerHarness {
    function price(int256 x, uint256 v, uint256 tau, uint256 w, uint256 n)
        external
        pure
        returns (BinaryPricer.Result memory)
    {
        return BinaryPricer.price(x, v, tau, w, n);
    }

    function priceKernel(int256 x, uint256 v, uint256 tau, uint256 w, uint256 n, uint8 k)
        external
        pure
        returns (BinaryPricer.Result memory)
    {
        return BinaryPricer.priceKernel(x, v, tau, w, n, k);
    }
}

/// @notice Discrete geometric-Asian binary: differential vs mpmath (claim C2: |mid err| <= 1e-12), bit-exactness vs
///         sim/evm.py, monotonicity in x, NO parity, European and continuous limits, reverts, quote ordering for both
///         kernels, delta vs finite differences.
contract BinaryPricerTest is Test {
    int256 constant WAD = 1e18;
    uint256 constant YEAR = 31_557_600;
    /// @dev 1e-12 absolute at 1e36 scale
    uint256 constant TOL_E36 = 1e24;

    PricerHarness h = new PricerHarness();

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function _var(uint256 sigmaWad) internal pure returns (uint256) {
        return sigmaWad * sigmaWad / YEAR;
    }

    /// @dev per-second variance at 1e36 for sigma in [5%, 500%] per year, tau and window in a demo-to-weekly range
    function _inputs(uint256 v, uint256 tau, uint256 w, uint256 n)
        internal
        pure
        returns (uint256, uint256, uint256, uint256)
    {
        v = bound(v, _var(0.05e18), _var(5e18));
        w = bound(w, 0, 86_400);
        tau = bound(tau, w + 1, w + 30 days);
        n = bound(n, 0, 100_000);
        return (v, tau, w, n);
    }

    /// @dev x with d(x) = dTarget, x = drift + dTarget * sqrtV with the drift read off the x = 0 Result
    function _xAtD(int256 dTarget, uint256 v, uint256 tau, uint256 w, uint256 n) internal pure returns (int256) {
        BinaryPricer.Result memory r0 = BinaryPricer.price(0, v, tau, w, n);
        return (dTarget - r0.d) * int256(r0.sqrtV) / WAD;
    }

    /// @dev mid +/- k*phi with two roundings, askBid's kernel != 0 branch and the non-monotone Gaussian control
    function _outward(BinaryPricer.Result memory r, uint256 g, uint256 h0) internal pure returns (uint256 a, uint256 b) {
        a = r.mid + F.fullMulDivUp(g, r.pdf, r.sqrtV) + h0;
        uint256 sub = F.fullMulDiv(g, r.pdf, r.sqrtV) + h0;
        b = r.mid > sub ? r.mid - sub : 0;
    }

    /* Vectors */

    struct Vec {
        int256[] x;
        uint256[] v;
        uint256[] tau;
        uint256[] w;
        uint256[] n;
        uint256[] g;
        uint256[] h0;
    }

    function _load() internal view returns (string memory j, Vec memory a) {
        j = vm.readFile("test/vectors/binary_pricer.json");
        a.x = vm.parseJsonIntArray(j, ".x");
        a.v = vm.parseJsonUintArray(j, ".varE36");
        a.tau = vm.parseJsonUintArray(j, ".tau");
        a.w = vm.parseJsonUintArray(j, ".window");
        a.n = vm.parseJsonUintArray(j, ".n");
        a.g = vm.parseJsonUintArray(j, ".gammaS");
        a.h0 = vm.parseJsonUintArray(j, ".h0");
    }

    function test_vectors_vsMpmath() public view {
        (string memory j, Vec memory a) = _load();
        uint256[] memory midRef = vm.parseJsonUintArray(j, ".midRefE36");
        uint256[] memory pdfRef = vm.parseJsonUintArray(j, ".pdfRefE36");
        uint256[] memory askRef = vm.parseJsonUintArray(j, ".askRefE36");
        uint256[] memory bidRef = vm.parseJsonUintArray(j, ".bidRefE36");
        uint256[4] memory worst;
        for (uint256 i; i < a.x.length; ++i) {
            BinaryPricer.Result memory r = BinaryPricer.price(a.x[i], a.v[i], a.tau[i], a.w[i], a.n[i]);
            (uint256 ask, uint256 bid) = BinaryPricer.askBid(r, a.g[i], a.h0[i]);
            worst[0] = F.max(worst[0], _absDiff(r.mid * 1e18, midRef[i]));
            worst[1] = F.max(worst[1], _absDiff(r.pdf * 1e18, pdfRef[i]));
            worst[2] = F.max(worst[2], _absDiff(ask * 1e18, askRef[i]));
            worst[3] = F.max(worst[3], _absDiff(bid * 1e18, bidRef[i]));
        }
        console2.log("vectors", a.x.length);
        console2.log("max |mid - Phi(d)|        (1e-36)", worst[0]);
        console2.log("max |pdf - phi(d)|        (1e-36)", worst[1]);
        console2.log("max |ask - spec ask|      (1e-36)", worst[2]);
        console2.log("max |bid - spec bid|      (1e-36)", worst[3]);
        for (uint256 k; k < 4; ++k) {
            assertLe(worst[k], TOL_E36, "error > 1e-12");
        }
    }

    function test_vectors_vsMpmath_t5() public view {
        (string memory j, Vec memory a) = _load();
        uint256[] memory mid5Ref = vm.parseJsonUintArray(j, ".mid5RefE36");
        uint256[] memory ask5Ref = vm.parseJsonUintArray(j, ".ask5RefE36");
        uint256[] memory bid5Ref = vm.parseJsonUintArray(j, ".bid5RefE36");
        uint256[3] memory worst;
        for (uint256 i; i < a.x.length; ++i) {
            BinaryPricer.Result memory r5 = BinaryPricer.priceKernel(a.x[i], a.v[i], a.tau[i], a.w[i], a.n[i], 1);
            (uint256 ask5, uint256 bid5) = BinaryPricer.askBid(r5, a.g[i], a.h0[i]);
            worst[0] = F.max(worst[0], _absDiff(r5.mid * 1e18, mid5Ref[i]));
            // above 1 + h0 the band check halts that side, and ask5 carries sqrtV's relative rounding times k*pdf
            if (ask5Ref[i] <= (1e18 + a.h0[i]) * 1e18) worst[1] = F.max(worst[1], _absDiff(ask5 * 1e18, ask5Ref[i]));
            worst[2] = F.max(worst[2], _absDiff(bid5 * 1e18, bid5Ref[i]));
        }
        console2.log("max |mid_t5 - F_t5(d)|    (1e-36)", worst[0]);
        console2.log("max |ask_t5 - spec ask_t5|(1e-36)", worst[1]);
        console2.log("max |bid_t5 - spec bid_t5|(1e-36)", worst[2]);
        for (uint256 k; k < 3; ++k) {
            assertLe(worst[k], TOL_E36, "error > 1e-12");
        }
    }

    function test_vectors_bitExact() public view {
        (string memory j, Vec memory a) = _load();
        uint256[] memory td = vm.parseJsonUintArray(j, ".tDriftE18");
        uint256[] memory tv = vm.parseJsonUintArray(j, ".tVarE18");
        uint256[] memory sv = vm.parseJsonUintArray(j, ".sqrtVBits");
        int256[] memory d = vm.parseJsonIntArray(j, ".dBits");
        uint256[] memory mid = vm.parseJsonUintArray(j, ".midBits");
        uint256[] memory pdf = vm.parseJsonUintArray(j, ".pdfBits");
        for (uint256 i; i < a.x.length; ++i) {
            (uint256 t1, uint256 t2) = BinaryPricer.effectiveTimes(a.tau[i], a.w[i], a.n[i]);
            assertEq(t1, td[i], "tDrift");
            assertEq(t2, tv[i], "tVar");
            BinaryPricer.Result memory r = BinaryPricer.price(a.x[i], a.v[i], a.tau[i], a.w[i], a.n[i]);
            assertEq(r.sqrtV, sv[i], "sqrtV");
            assertEq(r.d, d[i], "d");
            assertEq(r.mid, mid[i], "mid");
            assertEq(r.pdf, pdf[i], "pdf");
        }
    }

    function test_vectors_bitExactQuotes() public view {
        (string memory j, Vec memory a) = _load();
        uint256[] memory ask = vm.parseJsonUintArray(j, ".askBits");
        uint256[] memory bid = vm.parseJsonUintArray(j, ".bidBits");
        uint256[] memory mid5 = vm.parseJsonUintArray(j, ".mid5Bits");
        uint256[] memory pdf5 = vm.parseJsonUintArray(j, ".pdf5Bits");
        uint256[] memory ask5 = vm.parseJsonUintArray(j, ".ask5Bits");
        uint256[] memory bid5 = vm.parseJsonUintArray(j, ".bid5Bits");
        for (uint256 i; i < a.x.length; ++i) {
            BinaryPricer.Result memory r = BinaryPricer.price(a.x[i], a.v[i], a.tau[i], a.w[i], a.n[i]);
            assertEq(r.kernel, 0);
            (uint256 as_, uint256 bs) = BinaryPricer.askBid(r, a.g[i], a.h0[i]);
            (uint256 af, uint256 bf) = BinaryPricer.askBidFactored(r, a.g[i], a.h0[i]);
            assertEq(as_, ask[i], "ask");
            assertEq(bs, bid[i], "bid");
            assertEq(af, as_, "alias ask");
            assertEq(bf, bs, "alias bid");
            BinaryPricer.Result memory r5 = BinaryPricer.priceKernel(a.x[i], a.v[i], a.tau[i], a.w[i], a.n[i], 1);
            assertEq(r5.kernel, 1);
            assertEq(r5.mid, mid5[i], "mid t5");
            assertEq(r5.pdf, pdf5[i], "pdf t5");
            assertEq(r5.d, r.d);
            assertEq(r5.sqrtV, r.sqrtV);
            (as_, bs) = BinaryPricer.askBid(r5, a.g[i], a.h0[i]);
            assertEq(as_, ask5[i], "ask t5");
            assertEq(bs, bid5[i], "bid t5");
        }
    }

    /* Model properties */

    function testFuzz_monotoneInX(int256 x1, int256 x2, uint256 v, uint256 tau, uint256 w, uint256 n, uint256 g)
        public
        pure
    {
        (v, tau, w, n) = _inputs(v, tau, w, n);
        x1 = bound(x1, -5 * WAD, 5 * WAD);
        x2 = bound(x2, -5 * WAD, 5 * WAD);
        if (x1 > x2) (x1, x2) = (x2, x1);
        g = bound(g, 0, 0.05e18);
        BinaryPricer.Result memory r1 = BinaryPricer.price(x1, v, tau, w, n);
        BinaryPricer.Result memory r2 = BinaryPricer.price(x2, v, tau, w, n);
        assertLe(r1.d, r2.d);
        assertLe(r1.mid, r2.mid);
        (uint256 a1, uint256 b1) = BinaryPricer.askBid(r1, g, 0.02e18);
        (uint256 a2, uint256 b2) = BinaryPricer.askBid(r2, g, 0.02e18);
        assertLe(a1, a2, "ask not monotone");
        assertLe(b1, b2, "bid not monotone");
        assertLe(
            BinaryPricer.priceKernel(x1, v, tau, w, n, 1).mid, BinaryPricer.priceKernel(x2, v, tau, w, n, 1).mid
        );
    }

    function testFuzz_monotoneInX_adjacentWei(int256 x, uint256 v, uint256 tau, uint256 w, uint256 n, uint256 g)
        public
        pure
    {
        (v, tau, w, n) = _inputs(v, tau, w, n);
        x = bound(x, -2 * WAD, 2 * WAD);
        g = bound(g, 0, 0.05e18);
        BinaryPricer.Result memory r1 = BinaryPricer.price(x, v, tau, w, n);
        BinaryPricer.Result memory r2 = BinaryPricer.price(x + 1, v, tau, w, n);
        (uint256 a1, uint256 b1) = BinaryPricer.askBid(r1, g, 0);
        (uint256 a2, uint256 b2) = BinaryPricer.askBid(r2, g, 0);
        assertLe(r1.mid, r2.mid);
        assertLe(a1, a2);
        assertLe(b1, b2);
    }

    /// @dev NO = 1 - YES exactly: 1e18 - mid is the kernel evaluated at -d, and the NO quotes mirror the YES quotes
    function testFuzz_noParity(int256 dT, uint256 v, uint256 tau, uint256 w, uint256 n, uint256 g, uint256 h0)
        public
        pure
    {
        (v, tau, w, n) = _inputs(v, tau, w, n);
        int256 x = _xAtD(bound(dT, -6 * WAD, 6 * WAD), v, tau, w, n);
        g = bound(g, 0, 0.05e18);
        h0 = bound(h0, 0, 0.05e18);
        BinaryPricer.Result memory r = BinaryPricer.price(x, v, tau, w, n);
        assertEq(1e18 - r.mid, NormalCdf.cdf(-r.d));
        BinaryPricer.Result memory r5 = BinaryPricer.priceKernel(x, v, tau, w, n, 1);
        assertEq(1e18 - r5.mid, StudentTCdf.cdf5(-r5.d));
        (uint256 ask, uint256 bid) = BinaryPricer.askBid(r, g, h0);
        vm.assume(ask <= 1e18);
        uint256 askNo = 1e18 - bid;
        uint256 bidNo = 1e18 - ask;
        assertLe(bidNo, 1e18 - r.mid);
        assertLe(1e18 - r.mid, askNo);
        assertLe(bid + bidNo, 1e18);
        assertGe(ask + askNo, 1e18);
        if (bid > 0) assertGe(askNo - bidNo, 2 * h0);
    }

    /// @dev T4(a) for both kernels, ask >= mid + h0 and bid <= mid - h0 (or 0), Gaussian within k wei of two roundings
    function testFuzz_askBidOrdering(int256 dT, uint256 v, uint256 tau, uint256 w, uint256 n, uint256 g, uint256 h0)
        public
        pure
    {
        (v, tau, w, n) = _inputs(v, tau, w, n);
        int256 x = _xAtD(bound(dT, -8 * WAD, 8 * WAD), v, tau, w, n);
        g = bound(g, 0, 1e18);
        h0 = bound(h0, 0, 0.2e18);
        BinaryPricer.Result memory r = BinaryPricer.price(x, v, tau, w, n);
        (uint256 ask, uint256 bid) = BinaryPricer.askBid(r, g, h0);
        assertLe(bid, r.mid);
        assertGe(ask, r.mid + h0);
        if (bid > 0) assertLe(bid + h0, r.mid);
        (uint256 askN, uint256 bidN) = _outward(r, g, h0);
        uint256 kWei = g / r.sqrtV + 3;
        if (ask < 1e18 + h0) assertApproxEqAbs(ask, askN, kWei);
        if (bid > 0 && bidN > 0) assertApproxEqAbs(bid, bidN, kWei);
        BinaryPricer.Result memory r5 = BinaryPricer.priceKernel(x, v, tau, w, n, 1);
        (uint256 ask5, uint256 bid5) = BinaryPricer.askBid(r5, g, h0);
        assertGe(ask5, r5.mid + h0, "t5 ask below mid + h0");
        assertLe(bid5, r5.mid);
        if (bid5 > 0) assertLe(bid5 + h0, r5.mid, "t5 bid above mid - h0");
        (askN, bidN) = _outward(r5, g, h0);
        assertEq(ask5, askN);
        assertEq(bid5, bidN);
    }

    /// @dev A Student-t Result is never quoted with the Gaussian band (review case d = -2.5, sqrtV = 0.01)
    function test_kernelSelectsBand() public pure {
        BinaryPricer.Result memory r5;
        r5.d = -2.5e18;
        r5.sqrtV = 0.01e18;
        r5.mid = StudentTCdf.cdf5(r5.d);
        r5.pdf = StudentTCdf.pdf5(r5.d);
        r5.kernel = 1;
        (uint256 ask, uint256 bid) = BinaryPricer.askBid(r5, 5e14, 0.02e18);
        assertApproxEqAbs(r5.mid, 0.011635e18, 1e12);
        assertGe(ask, r5.mid + 0.02e18);
        assertApproxEqAbs(ask, 0.032471e18, 1e12);
        assertEq(bid, 0);
        r5.kernel = 0;
        (uint256 askG,) = BinaryPricer.askBid(r5, 5e14, 0.02e18);
        assertLt(askG, r5.mid + 0.02e18, "Gaussian band under-quotes the t5 mid");
    }

    /// @dev T1 delta, dP/dx = phi(d)/sqrt(v), against a central difference of the on-chain mid with h = 1e-6
    function testFuzz_deltaMatchesFiniteDifference(int256 dT, uint256 v, uint256 tau, uint256 w, uint256 n)
        public
        pure
    {
        (v, tau, w, n) = _inputs(v, tau, w, n);
        int256 x = _xAtD(bound(dT, -4 * WAD, 4 * WAD), v, tau, w, n);
        int256 hx = 1e12;
        BinaryPricer.Result memory r = BinaryPricer.price(x, v, tau, w, n);
        vm.assume(r.sqrtV >= 1e15);
        uint256 up = BinaryPricer.price(x + hx, v, tau, w, n).mid;
        uint256 dn = BinaryPricer.price(x - hx, v, tau, w, n).mid;
        uint256 fd = (up - dn) * 1e18 / uint256(2 * hx);
        uint256 delta = r.pdf * 1e18 / r.sqrtV;
        // truncation h^2 |P3|/6 is about 1e-12 / sqrtV^3, rounding about 1e-17 / h
        uint256 tol = 1e24 / r.sqrtV * 1e24 / r.sqrtV * 1e18 / r.sqrtV / 1e6 + 1e8;
        assertApproxEqAbs(fd, delta, tol);
    }

    function test_europeanLimit() public pure {
        uint256 v = _var(0.6e18);
        int256[5] memory xs = [int256(-0.3e18), -0.05e18, 0, 0.01e18, 0.2e18];
        uint256[3] memory taus = [uint256(60), 3600, 86_400];
        for (uint256 i; i < xs.length; ++i) {
            for (uint256 t; t < taus.length; ++t) {
                // closed form N(d2) computed independently of effectiveTimes
                int256 d2 = (xs[i] - int256(v * taus[t] / 2e18)) * WAD / int256(F.sqrt(v * taus[t]));
                uint256 euro = NormalCdf.cdf(d2);
                for (uint256 n; n < 3; ++n) {
                    BinaryPricer.Result memory r = BinaryPricer.price(xs[i], v, taus[t], 0, n * 7);
                    assertApproxEqAbs(r.mid, euro, 1e6);
                }
                // n = 1 samples one point at T - w: exactly European with tau - w
                BinaryPricer.Result memory a = BinaryPricer.price(xs[i], v, taus[t] + 600, 600, 1);
                BinaryPricer.Result memory b = BinaryPricer.price(xs[i], v, taus[t], 0, 0);
                assertEq(a.d, b.d);
                assertEq(a.mid, b.mid);
                // window -> 0: the Asian price converges to the European one, gap O(w/tau)
                uint256[4] memory ws = [uint256(40), 10, 3, 1];
                for (uint256 k; k < ws.length; ++k) {
                    uint256 gap = _absDiff(BinaryPricer.price(xs[i], v, taus[t], ws[k] * taus[t] / 100, 0).mid, euro);
                    assertLe(gap, ws[k] * 0.01e18);
                }
            }
        }
    }

    function test_discreteConvergesToContinuous() public pure {
        uint256 v = _var(0.8e18);
        uint256 w = 14_400;
        uint256 tau = w + 1800;
        (uint256 tD0, uint256 tV0) = BinaryPricer.effectiveTimes(tau, w, 0);
        BinaryPricer.Result memory c = BinaryPricer.price(-0.02e18, v, tau, w, 0);
        uint256 prevGap = type(uint256).max;
        uint256[6] memory ns = [uint256(1), 10, 100, 1000, 1e6, 1e9];
        for (uint256 i; i < ns.length; ++i) {
            (uint256 tD, uint256 tV) = BinaryPricer.effectiveTimes(tau, w, ns[i]);
            // exact limits: tDrift = tau - w/2 - w/(2n), tVar = tau - 2w/3 - w/(2n) + w/(6n^2)
            assertApproxEqAbs(tD, tD0 - w * 1e18 / (2 * ns[i]), 1);
            assertApproxEqAbs(tV, tV0 + w * 1e18 / (6 * ns[i] * ns[i]) - w * 1e18 / (2 * ns[i]), 2);
            uint256 gap = _absDiff(BinaryPricer.price(-0.02e18, v, tau, w, ns[i]).mid, c.mid);
            assertLe(gap, prevGap);
            assertLe(gap, 0.1e18 / ns[i] + 1e3, "gap not O(1/n)");
            prevGap = gap;
        }
    }

    function testFuzz_effectiveTimes(uint256 tau, uint256 w, uint256 n) public pure {
        w = bound(w, 0, 1e9);
        tau = bound(tau, w + 1, w + 1e9);
        n = bound(n, 1, 1e12);
        (uint256 tD, uint256 tV) = BinaryPricer.effectiveTimes(tau, w, n);
        (uint256 tD1, uint256 tV1) = BinaryPricer.effectiveTimes(tau, w, n + 1);
        (uint256 tDc, uint256 tVc) = BinaryPricer.effectiveTimes(tau, w, 0);
        uint256 base = (tau - w) * 1e18;
        assertGe(tV, base);
        assertLe(tV, tD);
        assertLe(tD, tD1);
        assertLe(tV, tV1);
        assertLe(tD1, tDc);
        assertLe(tV1, tVc + 1);
    }

    function test_reverts() public {
        vm.expectRevert(BinaryPricer.TooLate.selector);
        h.price(0, _var(0.6e18), 100, 100, 0);
        vm.expectRevert(BinaryPricer.TooLate.selector);
        h.price(0, _var(0.6e18), 99, 100, 10);
        vm.expectRevert(BinaryPricer.TooLate.selector);
        h.price(0, _var(0.6e18), 0, 0, 0);
        vm.expectRevert(BinaryPricer.ZeroVariance.selector);
        h.price(0, 0, 100, 10, 0);
        vm.expectRevert(BinaryPricer.ZeroVariance.selector);
        h.priceKernel(0, 0, 100, 10, 0, 1);
        vm.expectRevert(BinaryPricer.UnknownKernel.selector);
        h.priceKernel(0, _var(0.6e18), 100, 10, 0, 2);
        BinaryPricer.Result memory r = h.price(0, 1, 101, 100, 1);
        assertEq(r.sqrtV, 1);
    }

    function testFuzz_kernelZeroIsPrice(int256 x, uint256 v, uint256 tau, uint256 w, uint256 n) public view {
        (v, tau, w, n) = _inputs(v, tau, w, n);
        x = bound(x, -40 * WAD, 40 * WAD);
        assertEq(abi.encode(h.priceKernel(x, v, tau, w, n, 0)), abi.encode(h.price(x, v, tau, w, n)));
    }

    /// @dev The linked library returns exactly priceKernel and askBid, kernel tag included
    function testFuzz_pricingEngineMatchesInternal(
        int256 x,
        uint256 v,
        uint256 tau,
        uint256 w,
        uint256 n,
        uint256 g,
        uint256 h0,
        bool t5
    ) public view {
        (v, tau, w, n) = _inputs(v, tau, w, n);
        x = bound(x, -5 * WAD, 5 * WAD);
        g = bound(g, 0, 0.05e18);
        h0 = bound(h0, 0, 0.05e18);
        uint8 k = t5 ? 1 : 0;
        BinaryPricer.Result memory r = h.priceKernel(x, v, tau, w, n, k);
        assertEq(abi.encode(PricingEngine.price(x, v, tau, w, n, k)), abi.encode(r));
        (BinaryPricer.Result memory re, uint256 ask, uint256 bid) = PricingEngine.quote(x, v, tau, w, n, k, g, h0);
        assertEq(re.kernel, k);
        assertEq(abi.encode(re), abi.encode(r));
        (uint256 a2, uint256 b2) = BinaryPricer.askBid(r, g, h0);
        assertEq(ask, a2);
        assertEq(bid, b2);
    }

    function testFuzz_noRevertOnExtremeX(int256 x, uint256 v, uint256 tau, uint256 w, uint256 n) public pure {
        (v, tau, w, n) = _inputs(v, tau, w, n);
        x = bound(x, -1e40, 1e40);
        BinaryPricer.Result memory r = BinaryPricer.price(x, v, tau, w, n);
        assertLe(r.mid, 1e18);
        BinaryPricer.askBid(r, 0.01e18, 0.02e18);
        BinaryPricer.askBid(BinaryPricer.priceKernel(x, v, tau, w, n, 1), 0.01e18, 0.02e18);
    }

    function test_gas() public view {
        uint256 g = gasleft();
        BinaryPricer.Result memory r = BinaryPricer.price(-0.036e18, _var(0.6e18), 86_400, 14_400, 1440);
        uint256 gp = g - gasleft();
        g = gasleft();
        BinaryPricer.askBid(r, 0.00055e18, 0.02e18);
        uint256 ga = g - gasleft();
        g = gasleft();
        BinaryPricer.Result memory r5 = BinaryPricer.priceKernel(-0.036e18, _var(0.6e18), 86_400, 14_400, 1440, 1);
        uint256 g5 = g - gasleft();
        g = gasleft();
        BinaryPricer.askBid(r5, 0.00055e18, 0.02e18);
        uint256 ga5 = g - gasleft();
        console2.log("gas price / askBid (Gaussian)", gp, ga);
        console2.log("gas priceKernel / askBid (t5)", g5, ga5);
    }
}
