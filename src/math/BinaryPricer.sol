// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {NormalCdf} from "./NormalCdf.sol";

/// @title BinaryPricer
/// @notice Black-Scholes price of a cash-or-nothing binary settled on a discrete geometric TWAP over the final
///         `window` seconds (r = 0). European N(d2) is the window -> 0 limit. See docs/SPEC.md §3.3.
/// @dev x = ln(S/K) WAD; varE36 = per-second variance * 1e36; tau, window in seconds; n = samples in the window
///      (0 = continuous averaging). With Delta = window/n:
///        mu = x - var/2 * (tau - w + (n-1)*Delta/2)
///        v  = var * [(tau - w) + Delta*(n-1)*(2n-1)/(6n)]
///      Requires tau > window.
library BinaryPricer {
    int256 internal constant WAD = 1e18;

    error TooLate();
    error ZeroVariance();

    struct Result {
        int256 d; // mu / sqrt(v), WAD
        uint256 sqrtV; // sqrt(v), WAD
        uint256 mid; // Phi(d), WAD
        uint256 pdf; // phi(d), WAD
    }

    /// @return tDriftE18 effective drift time (seconds * 1e18); tVarE18 effective variance time (seconds * 1e18)
    function effectiveTimes(uint256 tau, uint256 window, uint256 n)
        internal
        pure
        returns (uint256 tDriftE18, uint256 tVarE18)
    {
        if (tau <= window) revert TooLate();
        uint256 base = (tau - window) * 1e18;
        if (n == 0) {
            tDriftE18 = base + window * 1e18 / 2;
            tVarE18 = base + window * 1e18 / 3;
        } else {
            // (n-1)*Delta/2 = w*(n-1)/(2n) ; Delta*(n-1)*(2n-1)/(6n) = w*(n-1)*(2n-1)/(6n^2)
            tDriftE18 = base + window * 1e18 * (n - 1) / (2 * n);
            tVarE18 = base + F.fullMulDiv(window * 1e18, (n - 1) * (2 * n - 1), 6 * n * n);
        }
    }

    function price(int256 x, uint256 varE36, uint256 tau, uint256 window, uint256 n)
        internal
        pure
        returns (Result memory r)
    {
        (uint256 tDrift, uint256 tVar) = effectiveTimes(tau, window, n);
        uint256 v = F.fullMulDiv(varE36, tVar, 1e36); // WAD, dimensionless variance
        if (v == 0) revert ZeroVariance();
        uint256 halfDrift = F.fullMulDiv(varE36, tDrift, 2e36); // WAD
        int256 mu = x - int256(halfDrift);
        r.sqrtV = F.sqrt(v * 1e18);
        if (r.sqrtV == 0) revert ZeroVariance();
        r.d = mu * WAD / int256(r.sqrtV);
        r.mid = NormalCdf.cdf(r.d);
        r.pdf = NormalCdf.pdf(r.d);
    }

    /// @notice YES ask/bid (WAD) around the mid: ask = ceil(Phi + k*phi) + h0, bid = floor(Phi - k*phi) - h0,
    ///         with k = gammaS / sqrt(v). bid saturates at 0 (the caller's band check then halts that side).
    function askBid(Result memory r, uint256 gammaSWad, uint256 h0Wad) internal pure returns (uint256 ask, uint256 bid) {
        uint256 gUp = F.fullMulDivUp(gammaSWad, r.pdf, r.sqrtV);
        uint256 gDn = F.fullMulDiv(gammaSWad, r.pdf, r.sqrtV);
        ask = r.mid + gUp + h0Wad;
        uint256 sub = gDn + h0Wad;
        bid = r.mid > sub ? r.mid - sub : 0;
    }
}
