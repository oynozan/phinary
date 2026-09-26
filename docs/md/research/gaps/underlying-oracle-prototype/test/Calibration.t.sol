// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {VolOracleV2} from "../src/VolOracleV2.sol";
import {SigmaPolicy} from "../src/SigmaPolicy.sol";

/// Statistical calibration of the on-chain estimator. Paths (3 days, 12 s blocks, sigma = 50%) are produced by
/// ../py/calib.py, which also computes the expected accumulator increment with an independent vectorized integer
/// implementation. Here every path is replayed through the real library (one write per block with a swap, pre-swap
/// tick), then: (1) bit-exactness vs Python, (2) per-path chi-square CI, (3) pooled chi-square CI.
contract CalibrationTest is Test {
    using VolOracleV2 for VolOracleV2.Oracle;

    VolOracleV2.Oracle internal o;
    uint256 constant YEAR = 31_536_000;
    uint256 constant SIGMA2_WAD = 0.25e18; // sigma = 0.5
    VolOracleV2.Params P = VolOracleV2.Params({H: 300, blockCap: 9116, windowCap: 400, maxCatchUp: 12, ringSize: 4096});

    function _sqrtWad(uint256 x) internal pure returns (uint256 y) {
        // sqrt of a WAD number, result WAD
        uint256 z = x * 1e18;
        y = z;
        uint256 r = (z + 1) / 2;
        while (r < y) {
            y = r;
            r = (z / r + r) / 2;
        }
    }

    /// Wilson-Hilferty chi-square quantile / nu, WAD. zWad signed.
    function _whWad(uint256 nuWad, int256 zWad) internal pure returns (uint256) {
        uint256 a = 2e36 / (9 * nuWad); // 2/(9nu) WAD
        int256 base = 1e18 - int256(a) + zWad * int256(_sqrtWad(a)) / 1e18;
        uint256 b = uint256(base);
        return b * b / 1e18 * b / 1e18;
    }

    function _replay(string memory file) internal returns (uint256 ratioWad, uint256 nuWad, uint256 dN, uint256 varE36) {
        bytes memory raw = vm.readFileBinary(file);
        (uint256 t0, uint256 gA, uint256 gB, uint256 dq, uint256 n, int256[] memory times, int256[] memory ticks) =
            abi.decode(raw, (uint256, uint256, uint256, uint256, uint256, int256[], int256[]));
        delete o.st;
        o.initialize(uint32(t0), int24(ticks[0]), P);
        for (uint256 i = 1; i < times.length; i++) {
            o.write(uint32(uint256(times[i])), int24(ticks[i]), P);
        }
        uint32 tLast = uint32(uint256(times[times.length - 1]));
        VolOracleV2.Checkpoint memory a = o.checkpointAt(uint32(gA), tLast, 0, P);
        VolOracleV2.Checkpoint memory b = o.checkpointAt(uint32(gB), tLast, 0, P);
        assertEq(uint256(b.wsq - a.wsq), dq, "bit-exact vs python");
        assertEq(uint256(b.nWin - a.nWin), n, "window count");
        dN = n;
        varE36 = VolOracleV2.mulDiv(dq * 3, VolOracleV2.LN_TICK_SQ_E36, 2 * uint256(P.H) ** 3 * n);
        ratioWad = varE36 * YEAR / 1e18 * 1e18 / SIGMA2_WAD; // sigma_hat^2 / sigma^2, WAD
        nuWad = n * 1e18 * 8 / 9; // effective dof n / 1.125 (lag-1 autocorrelation 1/4 of TWAP differences)
    }

    function test_calibration_gbm_exactFollower() public {
        uint256 sumRatioNu;
        uint256 sumNu;
        for (uint256 i; i < 6; i++) {
            (uint256 r, uint256 nu,,) = _replay(string.concat("data/exact_", vm.toString(i), ".bin"));
            uint256 lo = _whWad(nu, -3.2905e18); // 99.9% two-sided
            uint256 hi = _whWad(nu, 3.2905e18);
            emit log_named_decimal_uint("sigma_hat^2/sigma^2", r, 18);
            assertGe(r, lo, "per-path lower 99.9%");
            assertLe(r, hi, "per-path upper 99.9%");
            sumRatioNu += r * nu / 1e18;
            sumNu += nu;
        }
        uint256 pooled = sumRatioNu * 1e18 / sumNu;
        emit log_named_decimal_uint("pooled ratio", pooled, 18);
        assertGe(pooled, _whWad(sumNu, -2.5758e18), "pooled lower 99%");
        assertLe(pooled, _whWad(sumNu, 2.5758e18), "pooled upper 99%");
    }

    function test_calibration_bandFollower_withFeeBandCorrection() public {
        // band gamma = 5 bp (v3 5 bp pool), c = 0.5  ->  bias add = 0.5 * gamma^2 / H
        uint256 bias = SigmaPolicy.feeBandBiasE36(500, P.H, 0.5e18);
        for (uint256 i; i < 3; i++) {
            (uint256 r, uint256 nu,, uint256 v) = _replay(string.concat("data/band_", vm.toString(i), ".bin"));
            uint256 rc = (v + bias) * YEAR / 1e18 * 1e18 / SIGMA2_WAD;
            emit log_named_decimal_uint("raw ratio", r, 18);
            emit log_named_decimal_uint("corrected ratio", rc, 18);
            assertLt(r, 1e18, "band model biases RV down");
            assertGe(rc, _whWad(nu, -3.2905e18));
            assertLe(rc, _whWad(nu, 3.2905e18));
        }
    }

    function test_whQuantilesSanity() public pure {
        // chi2.ppf(0.0005, 767.1)/767.1 = 0.8405..., chi2.ppf(0.9995, 767.1)/767.1 = 1.1776... (scipy)
        uint256 n = 863; uint256 nu = n * 1e18 * 8 / 9;
        uint256 lo = _whWadPure(nu, -3.2905e18);
        uint256 hi = _whWadPure(nu, 3.2905e18);
        require(lo > 0.838e18 && lo < 0.843e18, "lo");
        require(hi > 1.174e18 && hi < 1.180e18, "hi");
    }

    function _whWadPure(uint256 nuWad, int256 zWad) internal pure returns (uint256) {
        return _whWad(nuWad, zWad);
    }
}
