// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {NormalCdf} from "../../src/math/NormalCdf.sol";

/// @notice Phi/phi (HartX36) and the factored spread band: differential vs mpmath (test/vectors, sim/gen_vectors.py),
///         bit-exactness vs the Python integer spec (sim/evm.py), symmetry, monotonicity, saturation, extremes.
contract NormalCdfTest is Test {
    int256 constant WAD = 1e18;
    uint256 constant E36 = 1e36;
    /// @dev 1e-16 absolute at 1e36 scale
    uint256 constant TOL_E36 = 1e20;
    int256 constant SPLIT = NormalCdf.SPLIT;
    int256 constant SATURATE = NormalCdf.SATURATE;
    /// @dev smallest z with expWad(-(z^2/W/2)) == 0, so the tail is exactly 0 from here on
    int256 constant EXP_CUTOFF = 9104562776310878106;

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    /* Differential and bit-exact vectors */

    function test_cdfPdf_vsMpmath() public view {
        string memory j = vm.readFile("test/vectors/normal_cdf.json");
        int256[] memory x = vm.parseJsonIntArray(j, ".x");
        uint256[] memory cRef = vm.parseJsonUintArray(j, ".cdfRefE36");
        uint256[] memory pRef = vm.parseJsonUintArray(j, ".pdfRefE36");
        uint256 worstC;
        uint256 worstP;
        int256 at;
        for (uint256 i; i < x.length; ++i) {
            uint256 ec = _absDiff(NormalCdf.cdf(x[i]) * 1e18, cRef[i]);
            uint256 ep = _absDiff(NormalCdf.pdf(x[i]) * 1e18, pRef[i]);
            if (ec > worstC) (worstC, at) = (ec, x[i]);
            if (ep > worstP) worstP = ep;
        }
        console2.log("vectors", x.length);
        console2.log("max |cdf - Phi| (1e-36 units)", worstC);
        console2.log("  at x", at);
        console2.log("max |pdf - phi| (1e-36 units)", worstP);
        assertLe(worstC, TOL_E36, "cdf error > 1e-16");
        assertLe(worstP, TOL_E36, "pdf error > 1e-16");
    }

    function test_cdfPdf_bitExactVsPythonSpec() public view {
        string memory j = vm.readFile("test/vectors/normal_cdf.json");
        int256[] memory x = vm.parseJsonIntArray(j, ".x");
        uint256[] memory cBits = vm.parseJsonUintArray(j, ".cdfBits");
        uint256[] memory pBits = vm.parseJsonUintArray(j, ".pdfBits");
        for (uint256 i; i < x.length; ++i) {
            assertEq(NormalCdf.cdf(x[i]), cBits[i], "cdf bits");
            assertEq(NormalCdf.pdf(x[i]), pBits[i], "pdf bits");
        }
    }

    function test_band_vectors() public view {
        string memory j = vm.readFile("test/vectors/normal_band.json");
        int256[] memory x = vm.parseJsonIntArray(j, ".x");
        uint256[] memory kap = vm.parseJsonUintArray(j, ".kappaE27");
        uint256[] memory upBits = vm.parseJsonUintArray(j, ".upBits");
        uint256[] memory dnBits = vm.parseJsonUintArray(j, ".dnBits");
        uint256[] memory upRef = vm.parseJsonUintArray(j, ".upRefE36");
        uint256[] memory dnRef = vm.parseJsonUintArray(j, ".dnRefE36");
        uint256 worst;
        for (uint256 i; i < x.length; ++i) {
            (uint256 up, uint256 dn) = NormalCdf.band(x[i], kap[i]);
            assertEq(up, upBits[i], "up bits");
            assertEq(dn, dnBits[i], "dn bits");
            if (kap[i] > NormalCdf.KAPPA_MAX) continue;
            // e carries ~1 wei of expWad error, amplified by kappa
            uint256 tol = TOL_E36 + kap[i] / 1e8;
            uint256 eu = _absDiff(up * 1e18, upRef[i]);
            uint256 ed = _absDiff(dn * 1e18, dnRef[i]);
            assertLe(eu, tol, "up vs mpmath");
            assertLe(ed, tol, "dn vs mpmath");
            if (kap[i] <= 1e28) worst = F.max(worst, F.max(eu, ed));
        }
        console2.log("band vectors", x.length);
        console2.log("max band error for kappa <= 10 (1e-36 units)", worst);
    }

    /* Symmetry */

    function testFuzz_symmetryExact(int256 x) public pure {
        vm.assume(x != type(int256).min);
        assertEq(NormalCdf.cdf(x) + NormalCdf.cdf(-x), uint256(WAD));
    }

    function testFuzz_symmetryExact_domain(int256 x) public pure {
        x = bound(x, -40 * WAD, 40 * WAD);
        assertEq(NormalCdf.cdf(x) + NormalCdf.cdf(-x), uint256(WAD));
        assertEq(NormalCdf.pdf(x), NormalCdf.pdf(-x));
    }

    function test_symmetryAtZero() public pure {
        assertEq(NormalCdf.cdf(0), uint256(WAD / 2));
        assertEq(NormalCdf.tail(0), WAD / 2);
    }

    /* Monotonicity */

    function testFuzz_monotoneAdjacent(int256 x) public pure {
        vm.assume(x != type(int256).max);
        assertLe(NormalCdf.cdf(x), NormalCdf.cdf(x + 1));
    }

    function testFuzz_monotoneAdjacent_domain(int256 x, uint256 step) public pure {
        x = bound(x, -40 * WAD, 40 * WAD);
        step = bound(step, 1, 1000);
        assertLe(NormalCdf.cdf(x), NormalCdf.cdf(x + int256(step)));
        if (x >= 0) assertGe(NormalCdf.pdf(x), NormalCdf.pdf(x + int256(step)));
        else if (x + int256(step) <= 0) assertLe(NormalCdf.pdf(x), NormalCdf.pdf(x + int256(step)));
    }

    function testFuzz_monotonePairs(int256 a, int256 b) public pure {
        if (a > b) (a, b) = (b, a);
        assertLe(NormalCdf.cdf(a), NormalCdf.cdf(b));
    }

    function _scan(int256 base, uint256 steps) internal pure returns (uint256 bad) {
        uint256 prev = NormalCdf.cdf(base);
        for (uint256 k = 1; k <= steps; ++k) {
            uint256 cur = NormalCdf.cdf(base + int256(k));
            if (cur < prev) ++bad;
            prev = cur;
        }
    }

    /// @dev 1-wei scans across every seam and at the 54 EVM-confirmed up-ticks of the plain-WAD Hart port
    function test_monotone_seamScans() public pure {
        int256[8] memory seams = [int256(0), SPLIT, SATURATE, EXP_CUTOFF, 1_414_213_562, 4.47e18, 5.05e18, 7.03e18];
        uint256 bad;
        for (uint256 i; i < seams.length; ++i) {
            bad += _scan(seams[i] - 1000, 2000);
            bad += _scan(-seams[i] - 1000, 2000);
        }
        int256[54] memory cex = [
            int256(6202233335529410195), 6303079096165091875, 6027786722934775865, 5286460121124371423,
            6661458662939610403, 6440060383440821730, 6187948572333097328, 6872358835780745878,
            6708725881521969668, 5699734168296885338, 6861540423837912252, 6261417537473808714,
            6586946719950138967, 7033987578397241766, 6287807734453241216, 6866251872966935580,
            6269369559929890963, 7018639873943999809, 6521026490074892365, 5522234626869426889,
            6961247426627469447, 6472486661021418114, 5346810820153643763, 6122979636497310445,
            5816209346199876760, 5737320250332275286, 5542473309140766945, 6428588690145350153,
            6873274956246548227, 6402247417246185363, 5436802834143626541, 5739864034497744388,
            6170555127200533908, 5517256551338532797, 6304276255718248057, 6836054508481123237,
            6801063959607372407, 6786239988578995128, 6801882007148922120, 7014738756134657494,
            5284307399387502956, 5859223291689422138, 5828138772452585824, 5050085068442036099,
            6204407000511264393, 6741120820358182155, 5377058072789453700, 5807661220352765048,
            5905284558499070212, 5946034498939224035, 5261241198012984400, 6561247593932007152,
            6712243007923218722, 6103744821760623262
        ];
        for (uint256 i; i < cex.length; ++i) {
            assertLe(NormalCdf.tail(cex[i] + 1), NormalCdf.tail(cex[i]));
            bad += _scan(cex[i] - 50, 100);
            bad += _scan(-cex[i] - 50, 100);
        }
        assertEq(bad, 0);
    }

    function test_monotone_randomScans() public pure {
        uint256 seed = 7;
        uint256 bad;
        for (uint256 b; b < 200; ++b) {
            seed = uint256(keccak256(abi.encode(seed)));
            int256 base = int256(seed % uint256(24e18)) - 12e18;
            bad += _scan(base, 1000);
        }
        assertEq(bad, 0, "1-wei decrease found");
    }

    /* Saturation and extremes */

    function test_saturation() public pure {
        for (int256 k = -3; k <= 3; ++k) {
            assertEq(NormalCdf.cdf(SATURATE + 1 + k * k), uint256(WAD));
            assertEq(NormalCdf.cdf(-SATURATE - 1 - k * k), 0);
            assertEq(NormalCdf.pdf(SATURATE + 1 + k * k), 0);
            assertEq(NormalCdf.cdf(EXP_CUTOFF + k * k), uint256(WAD));
            assertEq(NormalCdf.cdf(-EXP_CUTOFF - k * k), 0);
        }
        assertEq(NormalCdf.cdf(SATURATE), uint256(WAD));
        assertEq(NormalCdf.cdf(-SATURATE), 0);
        assertEq(NormalCdf.tail(SATURATE + 1), 0);
        assertGt(NormalCdf.cdf(-8e18), 0);
    }

    function test_extremeInputs() public pure {
        assertEq(NormalCdf.cdf(type(int256).min), 0);
        assertEq(NormalCdf.cdf(type(int256).min + 1), 0);
        assertEq(NormalCdf.cdf(type(int256).max), uint256(WAD));
        assertEq(NormalCdf.cdf(type(int256).min + 1) + NormalCdf.cdf(type(int256).max), uint256(WAD));
        assertEq(NormalCdf.pdf(type(int256).min), 0);
        assertEq(NormalCdf.pdf(type(int256).max), 0);
        assertEq(NormalCdf.tail(type(int256).max), 0);
        assertEq(NormalCdf.tail(type(int256).min), WAD / 2);
        (uint256 up, uint256 dn) = NormalCdf.band(type(int256).min, 1e27);
        assertEq(up + dn, 0);
        (up, dn) = NormalCdf.band(type(int256).max, type(uint256).max);
        assertEq(up, uint256(WAD));
        assertEq(dn, 0);
        (up, dn) = NormalCdf.band(type(int256).max, 0);
        assertEq(up + dn, 2 * uint256(WAD));
    }

    function testFuzz_range(int256 x) public pure {
        assertLe(NormalCdf.cdf(x), uint256(WAD));
        assertLe(NormalCdf.pdf(x), NormalCdf.pdf(0));
    }

    /* Factored band: Phi +/- k*phi with one rounding */

    function _kappa(uint256 k, uint256 sel) internal pure returns (uint256) {
        if (sel % 8 == 0) return bound(k, 0, NormalCdf.KAPPA_MAX + 10);
        if (sel % 8 == 1) return bound(k, 0, 1e24);
        return bound(k, 0, 1e30);
    }

    function testFuzz_band_orderingAndMid(int256 x, uint256 k, uint256 sel) public pure {
        k = _kappa(k, sel);
        (uint256 up, uint256 dn) = NormalCdf.band(x, k);
        uint256 mid = NormalCdf.cdf(x);
        assertLe(dn, mid);
        assertLe(mid, up);
        assertLe(up, uint256(WAD));
        (uint256 up0, uint256 dn0) = NormalCdf.band(x, 0);
        assertEq(x > 0 ? up0 : dn0, mid, "kappa = 0 reproduces Phi");
        assertLe(up0 - dn0, 1);
    }

    function testFuzz_band_monotoneAdjacent(int256 x, uint256 step, uint256 k, uint256 sel) public pure {
        x = sel % 4 == 0 ? x : bound(x, -12 * WAD, 12 * WAD);
        vm.assume(x < type(int256).max - 1000);
        step = bound(step, 1, 1000);
        k = _kappa(k, sel);
        (uint256 up1, uint256 dn1) = NormalCdf.band(x, k);
        (uint256 up2, uint256 dn2) = NormalCdf.band(x + int256(step), k);
        assertLe(up1, up2, "up decreased");
        assertLe(dn1, dn2, "dn decreased");
    }

    function testFuzz_band_monotoneInKappa(int256 x, uint256 k1, uint256 k2) public pure {
        k1 = bound(k1, 0, NormalCdf.KAPPA_MAX + 10);
        k2 = bound(k2, 0, NormalCdf.KAPPA_MAX + 10);
        if (k1 > k2) (k1, k2) = (k2, k1);
        (uint256 up1, uint256 dn1) = NormalCdf.band(x, k1);
        (uint256 up2, uint256 dn2) = NormalCdf.band(x, k2);
        assertLe(up1, up2);
        assertGe(dn1, dn2);
    }

    /// @dev YES ask at x and YES bid at -x are exact complements: the NO mirror of the band
    function testFuzz_band_mirror(int256 x, uint256 k, uint256 sel) public pure {
        vm.assume(x != type(int256).min);
        k = _kappa(k, sel);
        (uint256 up, uint256 dn) = NormalCdf.band(x, k);
        (uint256 upM, uint256 dnM) = NormalCdf.band(-x, k);
        assertEq(up + dnM, uint256(WAD));
        assertEq(dn + upM, uint256(WAD));
    }

    function _naiveUp(int256 x, uint256 k) internal pure returns (uint256) {
        uint256 kWad = F.fullMulDivUp(k, uint256(NormalCdf.SQRT_2PI_WAD), 1e27);
        return NormalCdf.cdf(x) + F.fullMulDivUp(kWad, NormalCdf.pdf(x), 1e18);
    }

    /// @dev 1-wei scans of the band; the naive two-rounding Phi + k*phi is the negative control and does decrease
    function test_band_scans() public pure {
        uint256[4] memory ks = [uint256(4e25), 2e26, 8e26, 3e27];
        uint256 seed = 11;
        uint256 badF;
        uint256 badNaive;
        for (uint256 kk; kk < ks.length; ++kk) {
            for (uint256 b; b < 30; ++b) {
                seed = uint256(keccak256(abi.encode(seed)));
                int256 base = int256(seed % uint256(8e18)) - 4e18;
                (uint256 pu, uint256 pd) = NormalCdf.band(base, ks[kk]);
                uint256 pn = _naiveUp(base, ks[kk]);
                for (int256 s = 1; s <= 300; ++s) {
                    (uint256 cu, uint256 cd) = NormalCdf.band(base + s, ks[kk]);
                    uint256 cn = _naiveUp(base + s, ks[kk]);
                    if (cu < pu || cd < pd) ++badF;
                    if (cn < pn) ++badNaive;
                    (pu, pd, pn) = (cu, cd, cn);
                }
            }
        }
        console2.log("1-wei steps 36000; factored decreases / naive decreases:", badF, badNaive);
        assertEq(badF, 0);
        assertGt(badNaive, 0, "negative control lost its teeth");
    }

    function test_band_seams() public pure {
        int256[4] memory seams = [int256(0), SPLIT, EXP_CUTOFF, SATURATE];
        uint256[5] memory ks = [uint256(0), 1, 3e26, 5e26 + 1, NormalCdf.KAPPA_MAX];
        for (uint256 i; i < seams.length; ++i) {
            for (uint256 kk; kk < ks.length; ++kk) {
                for (int256 sgn = -1; sgn <= 1; sgn += 2) {
                    int256 c = sgn * seams[i];
                    (uint256 pu, uint256 pd) = NormalCdf.band(c - 200, ks[kk]);
                    for (int256 s = -199; s <= 200; ++s) {
                        (uint256 cu, uint256 cd) = NormalCdf.band(c + s, ks[kk]);
                        assertLe(pu, cu);
                        assertLe(pd, cd);
                        (pu, pd) = (cu, cd);
                    }
                }
            }
        }
    }

    function test_gas() public view {
        int256[4] memory xs = [int256(-3e17), 1.3e18, 4.2e18, 7.6e18];
        for (uint256 i; i < xs.length; ++i) {
            uint256 g = gasleft();
            NormalCdf.cdf(xs[i]);
            uint256 gc = g - gasleft();
            g = gasleft();
            NormalCdf.band(xs[i], 2e26);
            uint256 gb = g - gasleft();
            console2.log("x / cdf gas / band gas", uint256(xs[i] < 0 ? -xs[i] : xs[i]), gc, gb);
        }
    }
}
