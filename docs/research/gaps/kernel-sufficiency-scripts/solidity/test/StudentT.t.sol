// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {StudentTCdf as T} from "../src/StudentTCdf.sol";
import {NormalCdf} from "../src/NormalCdf.sol";

/// Differential accuracy (vs 60-digit mpmath incomplete-beta reference), gas, symmetry and monotonicity.
contract StudentTTest is Test {
    int256[] ds;

    function setUp() public {
        ds = abi.decode(vm.readFileBinary("vectors/d.bin"), (int256[]));
    }

    function _ref(string memory n) internal view returns (int256[] memory) {
        return abi.decode(vm.readFileBinary(string.concat("vectors/", n, ".bin")), (int256[]));
    }

    function _abs(int256 v) internal pure returns (uint256) {
        return v < 0 ? uint256(-v) : uint256(v);
    }

    function _id(int256 x) internal pure returns (uint256) {
        return uint256(x);
    }

    function _hart(int256 x) internal pure returns (uint256) {
        return NormalCdf.hartWest(x);
    }

    function _run(string memory label, function(int256) internal pure returns (uint256) f, string memory refName)
        internal
        view
        returns (uint256 maxErr)
    {
        int256[] memory r = bytes(refName).length > 0 ? _ref(refName) : new int256[](0);
        uint256 gmin = type(uint256).max;
        uint256 gmax;
        uint256 gsum;
        int256 at;
        for (uint256 i; i < ds.length; ++i) {
            uint256 g0 = gasleft();
            uint256 y = f(ds[i]);
            uint256 g = g0 - gasleft();
            gsum += g;
            if (g < gmin) gmin = g;
            if (g > gmax) gmax = g;
            if (r.length > 0) {
                uint256 e = _abs(int256(y) * 1e6 - r[i]);
                if (e > maxErr) {
                    maxErr = e;
                    at = ds[i];
                }
            }
        }
        console2.log("==", label);
        console2.log("   n / max abs err (1e-24 units):", ds.length, maxErr);
        console2.log("   at d (WAD):", at);
        console2.log("   gas min/avg/max:", gmin, gsum / ds.length, gmax);
    }

    function test_diff_overhead() public view {
        _run("identity (harness overhead)", _id, "");
    }

    function test_diff_hart() public view {
        _run("normal Phi, Hart/West (reference point)", _hart, "ncdf");
    }

    function test_diff_cdf4() public view {
        uint256 e = _run("t nu=4 variance-matched CDF", T.cdf4, "cdf4");
        assertLe(e, 5e6); // <= 5e-18
    }

    function test_diff_cdf5() public view {
        uint256 e = _run("t nu=5 variance-matched CDF (atan)", T.cdf5, "cdf5");
        assertLe(e, 5e6);
    }

    function test_diff_cdf6() public view {
        uint256 e = _run("t nu=6 variance-matched CDF", T.cdf6, "cdf6");
        assertLe(e, 5e6);
    }

    function test_diff_pdf4() public view {
        _run("t nu=4 density", T.pdf4, "pdf4");
    }

    function test_diff_pdf5() public view {
        _run("t nu=5 density", T.pdf5, "pdf5");
    }

    function test_diff_pdf6() public view {
        _run("t nu=6 density", T.pdf6, "pdf6");
    }

    // ---------------- symmetry: F(d) + F(-d) == 1e18 exactly
    function testFuzz_symmetry(int256 d) public pure {
        d = bound(d, -2e24, 2e24);
        assertEq(T.cdf4(d) + T.cdf4(-d), 1e18);
        assertEq(T.cdf5(d) + T.cdf5(-d), 1e18);
        assertEq(T.cdf6(d) + T.cdf6(-d), 1e18);
    }

    // ---------------- monotonicity: random pairs
    function testFuzz_monotone(int256 a, int256 b) public pure {
        a = bound(a, -2e24, 2e24);
        b = bound(b, -2e24, 2e24);
        if (a > b) (a, b) = (b, a);
        assertLe(T.cdf4(a), T.cdf4(b));
        assertLe(T.cdf5(a), T.cdf5(b));
        assertLe(T.cdf6(a), T.cdf6(b));
        assertLe(T.cdf4(b), 1e18);
        assertLe(T.cdf5(b), 1e18);
        assertLe(T.cdf6(b), 1e18);
    }

    // ---------------- monotonicity: consecutive-wei scan (the strictest test; true increment < 1 wei per step)
    function _scan(function(int256) internal pure returns (uint256) f, string memory label, int256 span)
        internal
        pure
        returns (uint256 violations)
    {
        uint256 worst;
        int256 at;
        uint256 seed = 42;
        for (uint256 b; b < 400; ++b) {
            seed = uint256(keccak256(abi.encode(seed)));
            int256 base = int256(seed % uint256(2 * span)) - span;
            uint256 prev = f(base);
            for (int256 k = 1; k <= 2000; ++k) {
                uint256 cur = f(base + k);
                if (cur < prev) {
                    violations++;
                    if (prev - cur > worst) {
                        worst = prev - cur;
                        at = base + k;
                    }
                }
                prev = cur;
            }
        }
        console2.log(label);
        console2.log("  consecutive-wei pairs 800000, violations / worst decrease (wei):", violations, worst);
        console2.log("  at d:", at);
    }

    function test_scan_cdf4() public pure {
        _scan(T.cdf4, "scan cdf4 on [-12,12]", 12e18);
    }

    function test_scan_cdf5() public pure {
        _scan(T.cdf5, "scan cdf5 on [-12,12]", 12e18);
    }

    function test_scan_cdf6() public pure {
        _scan(T.cdf6, "scan cdf6 on [-12,12]", 12e18);
    }

    function test_scan_cdf4hp() public pure {
        _scan(T.cdf4hp, "scan cdf4hp on [-12,12]", 12e18);
    }

    function test_scan_cdf6hp() public pure {
        _scan(T.cdf6hp, "scan cdf6hp on [-12,12]", 12e18);
    }

    function test_diff_cdf4hp() public view {
        uint256 e = _run("t nu=4 CDF, hp variant", T.cdf4hp, "cdf4");
        assertLe(e, 5e6);
    }

    function test_diff_cdf6hp() public view {
        uint256 e = _run("t nu=6 CDF, hp variant", T.cdf6hp, "cdf6");
        assertLe(e, 5e6);
    }

    function testFuzz_monotone_hp(int256 a, int256 b) public pure {
        a = bound(a, -2e24, 2e24);
        b = bound(b, -2e24, 2e24);
        if (a > b) (a, b) = (b, a);
        assertLe(T.cdf4hp(a), T.cdf4hp(b));
        assertLe(T.cdf6hp(a), T.cdf6hp(b));
        assertEq(T.cdf4hp(a) + T.cdf4hp(-a), 1e18);
        assertEq(T.cdf6hp(a) + T.cdf6hp(-a), 1e18);
    }

    function test_scan_wide() public pure {
        _scan(T.cdf4hp, "scan cdf4hp on [-4e4,4e4]", 40_000e18);
        _scan(T.cdf5, "scan cdf5 on [-6e3,6e3]", 6_000e18);
        _scan(T.cdf6hp, "scan cdf6hp on [-2e3,2e3]", 2_000e18);
    }

    function test_saturation_edges() public pure {
        int256[3] memory sat = [int256(34_000e18), int256(5_500e18), int256(1_600e18)];
        for (uint256 i; i < 3; ++i) {
            for (int256 k = -3; k <= 3; ++k) {
                int256 d = sat[i] + k;
                uint256 hi;
                uint256 lo;
                if (i == 0) (hi, lo) = (T.cdf4hp(d), T.cdf4hp(-d));
                if (i == 1) (hi, lo) = (T.cdf5(d), T.cdf5(-d));
                if (i == 2) (hi, lo) = (T.cdf6hp(d), T.cdf6hp(-d));
                console2.log(i, uint256(d), hi, lo);
            }
        }
    }

    function test_scan_hart() public pure {
        _scan(_hart, "scan Hart Phi on [-12,12]", 12e18);
    }

    // ---------------- monotonicity on a grid whose true step exceeds the error bound (1e-6 steps over [-12,12])
    function test_grid_monotone() public pure {
        uint256 v4;
        uint256 v5;
        uint256 v6;
        uint256 p4 = T.cdf4(-12e18);
        uint256 p5 = T.cdf5(-12e18);
        uint256 p6 = T.cdf6(-12e18);
        for (int256 d = -12e18 + 1e14; d <= 12e18; d += 1e14) {
            uint256 c4 = T.cdf4(d);
            uint256 c5 = T.cdf5(d);
            uint256 c6 = T.cdf6(d);
            if (c4 < p4) v4++;
            if (c5 < p5) v5++;
            if (c6 < p6) v6++;
            (p4, p5, p6) = (c4, c5, c6);
        }
        console2.log("grid 1e-4 on [-12,12], 240000 steps; violations nu4/5/6:", v4, v5, v6);
        assertEq(v4 + v5 + v6, 0);
    }
}
