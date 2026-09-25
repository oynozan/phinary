// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";

/// @title NormalCdf
/// @notice Standard normal CDF and PDF in WAD fixed point.
/// @dev Hart (1968) / West (2005) rational approximation with 36-decimal Horner accumulators ("HartX36").
///      Monotonicity of the tail on [0, inf) is certified in docs/research/gaps/formal-verification-integer-proofs.md.
///      Measured max abs error vs mpmath ~4.2e-17. Symmetric by construction: cdf(x) + cdf(-x) == 1e18.
library NormalCdf {
    int256 internal constant WAD = 1e18;
    int256 internal constant SPLIT = 7071067811865470000; // 10/sqrt(2)
    int256 internal constant SQRT_2PI_WAD = 2506628274631000502;
    int256 internal constant SATURATE = 37 * WAD;

    function _num(int256 z) private pure returns (int256 n) {
        unchecked {
            n = 35262496599891100000000000000000000;
            n = n * z / WAD + 700383064443688000000000000000000000;
            n = n * z / WAD + 6373962203531650000000000000000000000;
            n = n * z / WAD + 33912866078383000000000000000000000000;
            n = n * z / WAD + 112079291497871000000000000000000000000;
            n = n * z / WAD + 221213596169931000000000000000000000000;
            n = n * z / WAD + 220206867912376000000000000000000000000;
        }
    }

    function _den(int256 z) private pure returns (int256 d) {
        unchecked {
            d = 88388347648318400000000000000000000;
            d = d * z / WAD + 1755667163182640000000000000000000000;
            d = d * z / WAD + 16064177579207000000000000000000000000;
            d = d * z / WAD + 86780732202946100000000000000000000000;
            d = d * z / WAD + 296564248779674000000000000000000000000;
            d = d * z / WAD + 637333633378831000000000000000000000000;
            d = d * z / WAD + 793826512519948000000000000000000000000;
            d = d * z / WAD + 440413735824752000000000000000000000000;
        }
    }

    /// @notice Upper tail 1 - Phi(z) for z >= 0, WAD. Clamped to <= 0.5.
    function tail(int256 z) internal pure returns (int256 c) {
        if (z < 0) z = 0; // callers pass |x|; defensive
        if (z > SATURATE) return 0;
        unchecked {
            int256 e = F.expWad(-(z * z / WAD / 2));
            if (z < SPLIT) {
                c = e * _num(z) / _den(z);
            } else {
                int256 f = z
                    + WAD * WAD
                        / (z + 2 * WAD * WAD / (z + 3 * WAD * WAD / (z + 4 * WAD * WAD / (z + 65 * WAD / 100))));
                c = e * WAD / (f * SQRT_2PI_WAD / WAD);
            }
        }
        if (c > WAD / 2) c = WAD / 2;
    }

    /// @notice Phi(x) in WAD, for any int256 x (saturates beyond |x| >= 37).
    function cdf(int256 x) internal pure returns (uint256) {
        if (x <= 0) {
            // -x overflows only for type(int256).min, which saturates.
            if (x < -SATURATE) return 0;
            return uint256(tail(-x));
        }
        if (x > SATURATE) return uint256(WAD);
        return uint256(WAD - tail(x));
    }

    /// @notice phi(x) = exp(-x^2/2)/sqrt(2*pi) in WAD.
    function pdf(int256 x) internal pure returns (uint256) {
        if (x > SATURATE || x < -SATURATE) return 0;
        int256 e = F.expWad(-(x * x / WAD / 2));
        return uint256(e * WAD / SQRT_2PI_WAD);
    }
}
