// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// @title QuoteMath
/// @notice Exact-integer amount solvers for a linear-impact quote curve (docs/md/SPEC.md §3.3).
/// @dev Units: amounts in 1e-6 token units (USDC and outcome tokens both have 6 decimals); prices WAD per whole
///      token; `lam` = WAD marginal-price change per whole token (1e6 units) of flow; `i0` = signed flow already
///      executed this epoch (1e-6 units) in the pool's mirrored coordinate.
///      Marginal price at flow x: p(x) = price + lam * x / 1e6. Cost of q units starting at i0:
///      (lam*q^2 + beta*q) / D with beta = 2e6*price + 2*lam*i0 and D = 2e24.
///      Rounding: the trader always gets the worse side (vault-favourable). Lemma S (research, z3-proved):
///      floor-isqrt of the exact integer discriminant is exact for buys; sells need 2*lam*q <= beta (band precondition).
///      Domain: amounts and |i0| <= MAX_AMOUNT, lam <= MAX_LAM, price <= MAX_PRICE, beta <= MAX_BETA, else `Band`;
///      inside it no intermediate exceeds 1.01e76, so every failure is a custom error.
library QuoteMath {
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant D = 2e24; // 2 * UNIT * WAD
    uint256 internal constant MAX_AMOUNT = 1e24;
    uint256 internal constant MAX_LAM = 1e24;
    uint256 internal constant MAX_PRICE = 1e30;
    uint256 internal constant MAX_BETA = 1e38;

    error Band();
    error Unreachable();

    function beta(uint256 price, uint256 lam, int256 i0) internal pure returns (uint256) {
        if (price > MAX_PRICE || lam > MAX_LAM || i0 > int256(MAX_AMOUNT) || i0 < -int256(MAX_AMOUNT)) revert Band();
        int256 b = int256(2 * UNIT * price) + 2 * int256(lam) * i0;
        if (b <= 0 || b > int256(MAX_BETA)) revert Band();
        return uint256(b);
    }

    function _beta(uint256 price, uint256 lam, int256 i0, uint256 amt) private pure returns (uint256) {
        if (amt > MAX_AMOUNT) revert Band();
        return beta(price, lam, i0);
    }

    /// @notice USDC the trader pays for exactly q tokens (ceil).
    function buyExactOut(uint256 a, uint256 lam, int256 i0, uint256 q) internal pure returns (uint256) {
        uint256 b = _beta(a, lam, i0, q);
        return FixedPointMathLib.divUp(lam * q * q + b * q, D);
    }

    /// @notice Max tokens q with cost(q) <= amtIn.
    function buyExactIn(uint256 a, uint256 lam, int256 i0, uint256 amtIn) internal pure returns (uint256 q) {
        uint256 b = _beta(a, lam, i0, amtIn);
        uint256 r = amtIn * D;
        if (lam == 0) return r / b;
        q = (FixedPointMathLib.sqrt(b * b + 4 * lam * r) - b) / (2 * lam);
    }

    /// @notice USDC the trader receives for selling exactly q tokens (floor). Requires the increasing branch.
    function sellExactIn(uint256 bPrice, uint256 lam, int256 i0, uint256 q) internal pure returns (uint256) {
        uint256 b = _beta(bPrice, lam, i0, q);
        if (2 * lam * q > b) revert Band(); // stay on the increasing branch of M(q) = b*q - lam*q^2
        return (b * q - lam * q * q) / D;
    }

    /// @notice Min tokens q with proceeds(q) >= amtOut, on the increasing branch.
    function sellExactOut(uint256 bPrice, uint256 lam, int256 i0, uint256 amtOut) internal pure returns (uint256 q) {
        uint256 b = _beta(bPrice, lam, i0, amtOut);
        uint256 r = amtOut * D;
        if (lam == 0) return FixedPointMathLib.divUp(r, b);
        uint256 bb = b * b;
        uint256 f = 4 * lam * r;
        if (f > bb) revert Unreachable();
        q = FixedPointMathLib.divUp(b - FixedPointMathLib.sqrt(bb - f), 2 * lam);
        if (2 * lam * q > b) revert Band();
    }
}
