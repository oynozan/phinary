// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {StudentTCdf} from "../../src/math/StudentTCdf.sol";
import {NormalCdf} from "../../src/math/NormalCdf.sol";

/// @notice Variance-matched Student-t nu = 5: differential vs an independent mpmath incomplete-beta reference,
///         bit-exactness vs sim/evm.py, exact symmetry, monotonicity (incl. 1-wei scans), saturation, extremes.
contract StudentTCdfTest is Test {
    uint256 constant WAD = 1e18;
    /// @dev 5e-18 absolute at 1e36 scale
    uint256 constant TOL_E36 = 5e18;
    int256 constant DSAT5 = int256(StudentTCdf.DSAT5);

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function test_vectors_vsMpmathAndBits() public view {
        string memory j = vm.readFile("test/vectors/student_t5.json");
        int256[] memory d = vm.parseJsonIntArray(j, ".d");
        uint256[] memory cRef = vm.parseJsonUintArray(j, ".cdfRefE36");
        uint256[] memory pRef = vm.parseJsonUintArray(j, ".pdfRefE36");
        uint256[] memory cBits = vm.parseJsonUintArray(j, ".cdfBits");
        uint256[] memory pBits = vm.parseJsonUintArray(j, ".pdfBits");
        uint256 wc;
        uint256 wp;
        for (uint256 i; i < d.length; ++i) {
            uint256 c = StudentTCdf.cdf5(d[i]);
            uint256 p = StudentTCdf.pdf5(d[i]);
            assertEq(c, cBits[i], "cdf5 bits");
            assertEq(p, pBits[i], "pdf5 bits");
            uint256 ec = _absDiff(c * 1e18, cRef[i]);
            uint256 ep = _absDiff(p * 1e18, pRef[i]);
            if (ec > wc) wc = ec;
            if (ep > wp) wp = ep;
        }
        console2.log("vectors", d.length);
        console2.log("max |cdf5 - F| (1e-36)", wc);
        console2.log("max |pdf5 - f| (1e-36)", wp);
        assertLe(wc, TOL_E36);
        assertLe(wp, TOL_E36);
    }

    function testFuzz_symmetryExact(int256 d) public pure {
        vm.assume(d != type(int256).min);
        assertEq(StudentTCdf.cdf5(d) + StudentTCdf.cdf5(-d), WAD);
        assertEq(StudentTCdf.pdf5(d), StudentTCdf.pdf5(-d));
    }

    function testFuzz_monotonePairs(int256 a, int256 b) public pure {
        if (a > b) (a, b) = (b, a);
        assertLe(StudentTCdf.cdf5(a), StudentTCdf.cdf5(b));
        assertLe(StudentTCdf.cdf5(b), WAD);
    }

    function testFuzz_monotoneAdjacent(int256 d, uint256 step) public pure {
        d = bound(d, -6_000e18, 6_000e18);
        step = bound(step, 1, 1000);
        assertLe(StudentTCdf.cdf5(d), StudentTCdf.cdf5(d + int256(step)));
    }

    function _scan(int256 base, uint256 steps) internal pure returns (uint256 bad) {
        uint256 prev = StudentTCdf.cdf5(base);
        for (uint256 k = 1; k <= steps; ++k) {
            uint256 cur = StudentTCdf.cdf5(base + int256(k));
            if (cur < prev) ++bad;
            prev = cur;
        }
    }

    function test_monotone_scans() public pure {
        uint256 seed = 42;
        uint256 bad;
        for (uint256 b; b < 150; ++b) {
            seed = uint256(keccak256(abi.encode(seed)));
            bad += _scan(int256(seed % 24e18) - 12e18, 1000);
        }
        // atan range-reduction seams: |d|/sqrt3 = tan15 and 1
        int256[6] memory seams = [int256(0), 464101615137754587, 1732050807568877293, 6464101615137754587, DSAT5, 1e21];
        for (uint256 i; i < seams.length; ++i) {
            bad += _scan(seams[i] - 1000, 2000);
            bad += _scan(-seams[i] - 1000, 2000);
        }
        assertEq(bad, 0);
    }

    function test_saturationAndExtremes() public pure {
        assertEq(StudentTCdf.cdf5(DSAT5), WAD);
        assertEq(StudentTCdf.cdf5(-DSAT5), 0);
        assertLe(StudentTCdf.cdf5(-DSAT5 + 1), 1);
        assertGe(StudentTCdf.cdf5(DSAT5 - 1), WAD - 1);
        assertGt(StudentTCdf.cdf5(-100e18), 0);
        assertEq(StudentTCdf.cdf5(0), WAD / 2);
        assertEq(StudentTCdf.cdf5(type(int256).min), 0);
        assertEq(StudentTCdf.cdf5(type(int256).max), WAD);
        assertEq(StudentTCdf.pdf5(type(int256).min), 0);
        assertEq(StudentTCdf.pdf5(type(int256).max), 0);
        assertEq(StudentTCdf.pdf5(1e24), 0);
        assertGt(StudentTCdf.pdf5(100e18), 0);
    }

    function testFuzz_fatterTailsThanNormal(int256 d) public pure {
        d = bound(d, -60e18, -2.5e18);
        assertGt(StudentTCdf.cdf5(d), NormalCdf.cdf(d));
        assertLt(StudentTCdf.cdf5(-d), NormalCdf.cdf(-d));
    }

    function test_gas() public view {
        int256[3] memory ds = [int256(-3e17), 1.3e18, 4.2e18];
        for (uint256 i; i < ds.length; ++i) {
            uint256 g = gasleft();
            StudentTCdf.cdf5(ds[i]);
            console2.log("cdf5 gas", g - gasleft());
        }
    }
}
