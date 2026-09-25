// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {UnderlyingOracleHook} from "../../src/oracle/UnderlyingOracleHook.sol";
import {OracleTestBase} from "./OracleTestBase.sol";

/// @notice sigma = 60% GBM (seeded Irwin-Hall shocks) driven through the real PoolManager, one swap per 12 s block,
///         with same-block push-and-restore attacks. varianceE36 over 600 windows of H = 120 s must equal the
///         brute-force estimator on the realised tick path and lie in the 99.9% chi-square band for nu = n / 1.125.
///         Coverage of that band across seeds is measured off-chain by test/oracle/sigma_coverage.py.
abstract contract OracleCalibrationTest is OracleTestBase {
    uint32 internal constant H = 120;
    uint16 internal constant N = 600;
    uint256 internal constant DT = 12;
    uint256 internal constant SIGMA2_WAD = 0.36e18;
    int256 internal constant CAP_TICKS = 400;

    function test_calibrationGbmSigma60() public {
        _setUpEnv();
        UnderlyingOracleHook h = _deployHook(
            HookParams({
                h: H,
                nWindows: N,
                minWindows: 100,
                winsorTicks: uint32(uint256(CAP_TICKS)),
                varMin: 1,
                varMax: type(uint128).max,
                fallbackVar: 1,
                cardinality: 4096
            })
        );
        PoolKey memory k = _initPool(address(h), 2700e18);
        uint256 nb = (uint256(N) + 2) * H / DT;
        int256[] memory path = new int256[](nb + 1);
        path[0] = _normTick(k);
        int256 sdTicksWad = int256(F.sqrt(SIGMA2_WAD * 1e18 * DT / YEAR)) * 1e18 / LN_TICK_WAD;
        int256 xWad = path[0] * 1e18;
        uint256 seed = usdcIsCurrency0() ? 1 << 128 : 0;
        for (uint256 b = 1; b <= nb; b++) {
            _nextBlock(DT);
            if (b % 97 == 0) {
                _swapToNormTick(k, path[b - 1] + 800);
                _swapToNormTick(k, path[b - 1] - 800);
            }
            xWad += sdTicksWad * _gauss(seed + b) / 1e18;
            _swapToNormTick(k, xWad / 1e18);
            path[b] = _normTick(k);
        }

        int256[] memory pre = new int256[](nb + 1);
        for (uint256 b = 1; b <= nb; b++) {
            pre[b] = pre[b - 1] + path[b - 1] * int256(DT);
        }
        uint32 gEnd = _now() / H;
        assertGe(gEnd - T0 / H, N);
        uint256 wsq;
        int256 prev = _pathCum(path, pre, (gEnd - N) * H) - _pathCum(path, pre, (gEnd - N - 1) * H);
        for (uint32 g = gEnd - N + 1; g <= gEnd; g++) {
            int256 d = _pathCum(path, pre, g * H) - _pathCum(path, pre, (g - 1) * H);
            wsq += _refSqClamp(d - prev, CAP_TICKS * int256(uint256(H)));
            prev = d;
        }
        (uint256 v, bool warm) = h.varianceE36();
        assertTrue(warm);
        assertEq(v, F.fullMulDiv(3 * wsq, LN_TICK_SQ_E36, 2 * uint256(H) ** 3 * N), "bit-exact vs brute force");

        uint256 ratio = v * YEAR / SIGMA2_WAD;
        uint256 nu = uint256(N) * 1e18 * 8 / 9;
        emit log_named_decimal_uint("sigma_hat (annual)", F.sqrt(v * YEAR), 18);
        emit log_named_decimal_uint("sigma_hat^2 / sigma^2", ratio, 18);
        assertGe(ratio, _whWad(nu, -3.2905e18), "99.9% lower");
        assertLe(ratio, _whWad(nu, 3.2905e18), "99.9% upper");
        assertApproxEqRel(F.sqrt(v * YEAR), 0.6e18, 0.1e18, "sigma within 10% of 60%");
    }

    /// @dev Cumulative normalised tick at `at`, path[b - 1] prevailing over the DT seconds before block b
    function _pathCum(int256[] memory path, int256[] memory pre, uint256 at) internal pure returns (int256) {
        if (at <= T0) return -path[0] * int256(T0 - at);
        uint256 j = (at - T0) / DT;
        return pre[j] + path[j] * int256(at - T0 - j * DT);
    }

    /// @dev Irwin-Hall(12) - 6: mean 0, variance 1, WAD
    function _gauss(uint256 seed) internal pure returns (int256 z) {
        for (uint256 i; i < 12; i++) {
            z += int256(uint256(keccak256(abi.encode(seed, i))) % 1e18);
        }
        z -= 6e18;
    }

    /// @dev Wilson-Hilferty chi-square quantile divided by nu, WAD
    function _whWad(uint256 nuWad, int256 zWad) internal pure returns (uint256) {
        uint256 a = 2e36 / (9 * nuWad);
        uint256 b = uint256(1e18 - int256(a) + zWad * int256(F.sqrt(a * 1e18)) / 1e18);
        return b * b / 1e18 * b / 1e18;
    }
}

contract OracleCalibrationEthIs0Test is OracleCalibrationTest {
    function usdcIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

contract OracleCalibrationUsdcIs0Test is OracleCalibrationTest {
    function usdcIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}
