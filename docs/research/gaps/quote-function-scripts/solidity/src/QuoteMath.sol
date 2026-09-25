// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// Size/impact amount functions of the PredictionHook quote spec (research prototype, not audited).
/// Units: amounts in 1e-6 token units; prices WAD; lam = WAD of marginal price per whole token (1e6 units);
/// i0 = signed net YES-equivalent sold in the current epoch, in the mirrored coordinate of the pool.
library QuoteMath {
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant D = 2e24; // 2 * UNIT * WAD

    error Band();
    error Unreachable();

    function _beta(uint256 price, uint256 lam, int256 i0) private pure returns (uint256) {
        int256 beta = int256(2 * UNIT * price) + 2 * int256(lam) * i0;
        if (beta <= 0) revert Band();
        return uint256(beta);
    }

    /// cost numerator N(q) = lam*q^2 + beta*q ; trader pays ceil(N/D)
    function buyExactOut(uint256 a, uint256 lam, int256 i0, uint256 q) internal pure returns (uint256) {
        uint256 beta = _beta(a, lam, i0);
        return FixedPointMathLib.divUp(lam * q * q + beta * q, D);
    }

    /// max q with lam*q^2 + beta*q <= A*D.  floor-isqrt of the exact integer discriminant is exact.
    function buyExactIn(uint256 a, uint256 lam, int256 i0, uint256 amtIn) internal pure returns (uint256 q) {
        uint256 beta = _beta(a, lam, i0);
        uint256 r = amtIn * D;
        if (lam == 0) return r / beta;
        q = (FixedPointMathLib.sqrt(beta * beta + 4 * lam * r) - beta) / (2 * lam);
    }

    /// proceeds numerator M(q) = -lam*q^2 + beta*q ; trader receives floor(M/D)
    function sellExactIn(uint256 b, uint256 lam, int256 i0, uint256 q) internal pure returns (uint256) {
        uint256 beta = _beta(b, lam, i0);
        uint256 lq2 = lam * q * q;
        uint256 bq = beta * q;
        if (lq2 > bq) revert Band();
        return (bq - lq2) / D;
    }

    /// min q with -lam*q^2 + beta*q >= A*D on the increasing branch.
    function sellExactOut(uint256 b, uint256 lam, int256 i0, uint256 amtOut) internal pure returns (uint256 q) {
        uint256 beta = _beta(b, lam, i0);
        uint256 r = amtOut * D;
        if (lam == 0) return FixedPointMathLib.divUp(r, beta);
        uint256 bb = beta * beta;
        uint256 f = 4 * lam * r;
        if (f > bb) revert Unreachable();
        q = FixedPointMathLib.divUp(beta - FixedPointMathLib.sqrt(bb - f), 2 * lam);
    }
}
