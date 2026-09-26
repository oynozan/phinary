// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FixedPointMathLib as S} from "./FixedPointMathLib.sol";

/// @notice Variance-matched Student-t CDF/PDF in WAD for integer nu in {4, 5, 6} (research prototype, NOT audited).
/// @dev Input d is the same standardized argument as BS d2: d = (ln(S/K) - w/2)/sqrt(w), w = sigma^2 * tau.
///      The kernel is F_vm(d) = T_nu(d * sqrt(nu/(nu-2))) (unit variance). With that substitution
///      t/sqrt(t^2+nu) = d/sqrt(d^2+nu-2), which gives the closed forms (verified symbolically in derive.py):
///        nu=4: F = 1/2 + d (y+1) / (2 y^{3/2}),                     y = d^2 + 2      f = 3 / y^{5/2}
///        nu=5: F = 1/2 + [atan(d/sqrt3) + sqrt3 d (y+2)/y^2] / pi,  y = d^2 + 3      f = 24 sqrt3 / (pi y^3)
///        nu=6: F = 1/2 + d (1 + 2/y + 6/y^2) / (2 sqrt y),          y = d^2 + 4      f = 60 / y^{7/2}
///      All are computed as 1/2 +- g(|d|), so F(d) + F(-d) == 1e18 exactly. Intermediates at 1e36 scale.
library StudentTCdf {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant E36 = 1e36;
    /// @dev |d| >= 1e6: 1-F <= 7.5e-25 (nu=4), 1.1e-29 (nu=5), 1e-35 (nu=6) -> saturate. Also bounds all intermediates.
    uint256 internal constant DSAT = 1e24;
    /// @dev CDF saturation where the true tail drops below ~0.5 wei: 0.75/d^4 (nu=4), 2.646/d^5 (nu=5), 10/d^6 (nu=6).
    ///      Saturating here (not at 1e6) keeps the output monotone at the boundary: beyond it the computed g could
    ///      round up to exactly 1/2 (upward bias of the floored sqrt ~1e-15 wei) while the true tail is < 1e-15 wei.
    uint256 internal constant DSAT4 = 34_000e18;
    uint256 internal constant DSAT5 = 5_500e18;
    uint256 internal constant DSAT6 = 1_600e18;

    uint256 internal constant SQRT3_36 = 1732050807568877293527446341505872367;
    int256 internal constant PI_2_36 = 1570796326794896619231321691639751442;
    int256 internal constant PI_6_36 = 523598775598298873077107230546583814;
    uint256 internal constant TAN15_36 = 267949192431122706472553658494127633;
    uint256 internal constant INV_PI_36 = 318309886183790671537767526745028724;
    uint256 internal constant F5PDF_36 = 13231893490123009188271835959511266594; // 24 sqrt3 / pi

    // atan Taylor coefficients (-1)^k / (2k+1) at 1e36, k = 0..14 (|c| <= tan(15deg): remainder < 0.268^31/31 = 8.6e-20)
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
        return d < 0 ? uint256(-d) : uint256(d);
    }

    function _half(int256 d, uint256 g) private pure returns (uint256) {
        unchecked {
            return d < 0 ? WAD / 2 - g : WAD / 2 + g;
        }
    }

    // ------------------------------------------------------------------ nu = 4 (algebraic)
    function cdf4(int256 d) internal pure returns (uint256) {
        uint256 u = _abs(d);
        if (u >= DSAT4) return d < 0 ? 0 : WAD;
        unchecked {
            uint256 Y = u * u + 2 * E36; // y at 1e36, <= 1e48
            uint256 s = S.sqrt(Y); // sqrt(y) in WAD, floor
            // g = d (y + 1) / (2 y sqrt y): u*(Y+E36) <= 1e72, 2*Y*s <= 2e72, 512-bit mulDiv
            uint256 g = S.fullMulDiv(u * (Y + E36), WAD, 2 * Y * s);
            return _half(d, g);
        }
    }

    // ------------------------------------------------------------------ nu = 6 (algebraic)
    function cdf6(int256 d) internal pure returns (uint256) {
        uint256 u = _abs(d);
        if (u >= DSAT6) return d < 0 ? 0 : WAD;
        unchecked {
            uint256 Y = u * u + 4 * E36; // y at 1e36, <= 1e48
            uint256 q = E36 * E36 / Y; // 1/y at 1e36 (<= 0.25e36)
            uint256 A = E36 + 2 * q + 6 * (q * q / E36); // 1 + 2/y + 6/y^2 at 1e36
            uint256 s = S.sqrt(Y); // sqrt(y) in WAD (Y/WAD = y in WAD)
            uint256 g = S.fullMulDiv(u, A, 2 * s * WAD); // u*A/(2 s) -> WAD
            return _half(d, g);
        }
    }

    // ------------------------------------------------------------------ nu = 5 (needs atan)
    /// @dev atan(a) for a >= 0 given at 1e36; returns radians at 1e36. Reductions: a > 1 -> pi/2 - atan(1/a);
    ///      b > tan15 -> pi/6 + atan((b sqrt3 - 1)/(b + sqrt3)); then |c| <= tan15 and a 15-term Taylor series.
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

    function cdf5(int256 d) internal pure returns (uint256) {
        uint256 u = _abs(d);
        if (u >= DSAT5) return d < 0 ? 0 : WAD;
        unchecked {
            uint256 a = S.fullMulDiv(u, 1e54, SQRT3_36); // d/sqrt3 at 1e36
            int256 theta = atan36(a);
            uint256 Y = u * u + 3 * E36; // y at 1e36
            uint256 t1 = S.fullMulDiv(u * WAD, Y + 2 * E36, Y); // d (1 + 2/y) at 1e36
            uint256 t2 = S.fullMulDiv(t1, E36, Y); // d (1+2/y)/y at 1e36
            uint256 h = t2 * SQRT3_36 / E36; // sqrt3 d (y+2)/y^2 at 1e36
            uint256 g = S.fullMulDiv(uint256(theta) + h, INV_PI_36, 1e54); // (theta + h)/pi in WAD
            return _half(d, g);
        }
    }

    // ------------------------------------------------------------------ densities (for the gamma spread k * f(d))
    function pdf4(int256 d) internal pure returns (uint256) {
        uint256 u = _abs(d);
        if (u >= DSAT) return 0;
        unchecked {
            uint256 Y = u * u + 2 * E36;
            uint256 q = E36 * E36 / Y; // 1/y
            uint256 s = S.sqrt(Y);
            return 3 * (q * q / E36) / s; // 3/(y^2 sqrt y) in WAD
        }
    }

    function pdf5(int256 d) internal pure returns (uint256) {
        uint256 u = _abs(d);
        if (u >= DSAT) return 0;
        unchecked {
            uint256 Y = u * u + 3 * E36;
            uint256 q = E36 * E36 / Y;
            uint256 q3 = (q * q / E36) * q / E36;
            return S.fullMulDiv(q3, F5PDF_36, 1e54);
        }
    }

    function pdf6(int256 d) internal pure returns (uint256) {
        uint256 u = _abs(d);
        if (u >= DSAT) return 0;
        unchecked {
            uint256 Y = u * u + 4 * E36;
            uint256 q = E36 * E36 / Y;
            uint256 q3 = (q * q / E36) * q / E36;
            uint256 s = S.sqrt(Y);
            return 60 * q3 / s; // 60/(y^3 sqrt y) in WAD
        }
    }

    // ------------------------------------------------------------------ higher-precision variants (sqrt at 1e27)
    /// @dev Same closed forms; the sqrt is taken at 1e27 and the numerator kept at 1e36, so the only WAD rounding
    ///      is the final floor. Removes the 1-wei adjacent-input non-monotonicity of cdf4/cdf6 (see tests).
    function cdf4hp(int256 d) internal pure returns (uint256) {
        uint256 u = _abs(d);
        if (u >= DSAT4) return d < 0 ? 0 : WAD;
        unchecked {
            uint256 Y = u * u + 2 * E36; // y at 1e36
            uint256 v = S.fullMulDiv(u * WAD, Y + E36, Y); // d (1 + 1/y) at 1e36
            uint256 s27 = S.sqrt(Y * WAD); // sqrt(y) at 1e27 (Y*1e18 <= 1e66)
            return _half(d, S.fullMulDiv(v, 1e9, 2 * s27));
        }
    }

    function cdf6hp(int256 d) internal pure returns (uint256) {
        uint256 u = _abs(d);
        if (u >= DSAT6) return d < 0 ? 0 : WAD;
        unchecked {
            uint256 Y = u * u + 4 * E36;
            uint256 q = E36 * E36 / Y;
            uint256 A = E36 + 2 * q + 6 * (q * q / E36);
            uint256 v = u * A / WAD; // d * A at 1e36 (u*A <= 1.5e60)
            uint256 s27 = S.sqrt(Y * WAD);
            return _half(d, S.fullMulDiv(v, 1e9, 2 * s27));
        }
    }
}
