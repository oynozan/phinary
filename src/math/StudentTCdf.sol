// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";

/// @title StudentTCdf
/// @notice Variance-matched Student-t (nu = 5) CDF and PDF in WAD, the optional fat-tailed pricing kernel.
/// @dev F(d) = T_5(d * sqrt(5/3)) has unit variance and takes the same d as Black-Scholes. Closed form with y = d^2 + 3:
///        F = 1/2 + [atan(d/sqrt3) + sqrt3 * d * (y + 2) / y^2] / pi,   f = 24 * sqrt3 / (pi * y^3)
///      Computed as 1/2 +/- g(|d|), so cdf5(d) + cdf5(-d) == 1e18 exactly. Intermediates at 1e36.
///      Port of docs/research/gaps/kernel-sufficiency-scripts/solidity/src/StudentTCdf.sol; max abs error vs mpmath ~1e-18.
library StudentTCdf {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant E36 = 1e36;
    /// @dev Past 5500 the true tail is below 0.5 wei; saturating there keeps the output monotone
    uint256 internal constant DSAT5 = 5_500e18;
    uint256 internal constant DSAT_PDF = 1e24;

    uint256 internal constant SQRT3_36 = 1732050807568877293527446341505872367;
    int256 internal constant PI_2_36 = 1570796326794896619231321691639751442;
    int256 internal constant PI_6_36 = 523598775598298873077107230546583814;
    uint256 internal constant TAN15_36 = 267949192431122706472553658494127633;
    uint256 internal constant INV_PI_36 = 318309886183790671537767526745028724;
    uint256 internal constant F5PDF_36 = 13231893490123009188271835959511266594; // 24 sqrt3 / pi

    // atan Taylor coefficients (-1)^k / (2k+1) at 1e36, |c| <= tan(15deg) keeps the remainder below 8.6e-20
    int256 internal constant C1 = -333333333333333333333333333333333333;
    int256 internal constant C2 = 200000000000000000000000000000000000;
    int256 internal constant C3 = -142857142857142857142857142857142857;
    int256 internal constant C4 = 111111111111111111111111111111111111;
    int256 internal constant C5 = -90909090909090909090909090909090909;
    int256 internal constant C6 = 76923076923076923076923076923076923;
    int256 internal constant C7 = -66666666666666666666666666666666667;
    int256 internal constant C8 = 58823529411764705882352941176470588;
    int256 internal constant C9 = -52631578947368421052631578947368421;
    int256 internal constant C10 = 47619047619047619047619047619047619;
    int256 internal constant C11 = -43478260869565217391304347826086957;
    int256 internal constant C12 = 40000000000000000000000000000000000;
    int256 internal constant C13 = -37037037037037037037037037037037037;
    int256 internal constant C14 = 34482758620689655172413793103448276;

    function _abs(int256 d) private pure returns (uint256) {
        unchecked {
            return d < 0 ? uint256(-(d + 1)) + 1 : uint256(d);
        }
    }

    /// @notice atan(a) for a >= 0 at 1e36 in radians at 1e36, reduced to |c| <= tan(15deg) before a 15-term series
    function atan36(uint256 a) internal pure returns (int256 theta) {
        unchecked {
            bool inv = a > E36;
            uint256 b = inv ? E36 * E36 / a : a;
            int256 off;
            int256 c;
            if (b > TAN15_36) {
                off = PI_6_36;
                c = (int256(b * SQRT3_36 / E36) - int256(E36)) * int256(E36) / int256(b + SQRT3_36);
            } else {
                c = int256(b);
            }
            int256 z = c * c / int256(E36);
            int256 p = C14;
            p = C13 + p * z / 1e36;
            p = C12 + p * z / 1e36;
            p = C11 + p * z / 1e36;
            p = C10 + p * z / 1e36;
            p = C9 + p * z / 1e36;
            p = C8 + p * z / 1e36;
            p = C7 + p * z / 1e36;
            p = C6 + p * z / 1e36;
            p = C5 + p * z / 1e36;
            p = C4 + p * z / 1e36;
            p = C3 + p * z / 1e36;
            p = C2 + p * z / 1e36;
            p = C1 + p * z / 1e36;
            p = 1e36 + p * z / 1e36;
            theta = off + c * p / 1e36;
            if (inv) theta = PI_2_36 - theta;
        }
    }

    /// @notice F(d) in WAD for any int256 d (saturates at |d| >= 5500).
    function cdf5(int256 d) internal pure returns (uint256) {
        uint256 u = _abs(d);
        if (u >= DSAT5) return d < 0 ? 0 : WAD;
        unchecked {
            int256 theta = atan36(F.fullMulDiv(u, 1e54, SQRT3_36));
            uint256 y = u * u + 3 * E36;
            uint256 t1 = F.fullMulDiv(u * WAD, y + 2 * E36, y); // d (1 + 2/y) at 1e36
            uint256 t2 = F.fullMulDiv(t1, E36, y); // d (1 + 2/y) / y at 1e36
            uint256 h = t2 * SQRT3_36 / E36;
            uint256 g = F.fullMulDiv(uint256(theta) + h, INV_PI_36, 1e54);
            return d < 0 ? WAD / 2 - g : WAD / 2 + g;
        }
    }

    /// @notice f(d) in WAD for any int256 d.
    function pdf5(int256 d) internal pure returns (uint256) {
        uint256 u = _abs(d);
        if (u >= DSAT_PDF) return 0;
        unchecked {
            uint256 y = u * u + 3 * E36;
            uint256 q = E36 * E36 / y;
            uint256 q3 = (q * q / E36) * q / E36;
            return F.fullMulDiv(q3, F5PDF_36, 1e54);
        }
    }
}
