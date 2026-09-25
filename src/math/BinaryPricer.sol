// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {NormalCdf} from "./NormalCdf.sol";
import {StudentTCdf} from "./StudentTCdf.sol";

/// @title BinaryPricer
/// @notice Black-Scholes price of a cash-or-nothing binary settled on a discrete geometric TWAP over the final
///         `window` seconds (r = 0). European N(d2) is the window -> 0 limit. See docs/SPEC.md §3.3.
/// @dev x = ln(S/K) WAD; varE36 = per-second variance * 1e36; tau, window in seconds; n = samples in the window
///      (0 = continuous averaging). With Delta = window/n:
///        mu = x - var/2 * (tau - w + (n-1)*Delta/2)
///        v  = var * [(tau - w) + Delta*(n-1)*(2n-1)/(6n)]
///      Requires tau > window. sqrt(v) is taken from v at 1e36 so tiny variances keep full precision
///      (|mid - Phi(d)| <= 7e-15 on test/vectors/binary_pricer.json).
library BinaryPricer {
    int256 internal constant WAD = 1e18;
    /// @dev gammaS above this saturates the factored spread (kappa > KAPPA_MAX for any sqrtV)
    uint256 internal constant GAMMA_MAX = 1e30;

    error TooLate();
    error ZeroVariance();
    error UnknownKernel();

    struct Result {
        int256 d; // mu / sqrt(v), WAD
        uint256 sqrtV; // sqrt(v), WAD
        uint256 mid; // kernel CDF at d (Phi for kernel 0), WAD
        uint256 pdf; // kernel density at d, WAD
        uint8 kernel; // 0 = Gaussian, 1 = Student-t nu = 5; selects the band in `askBid`
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

    function _moments(int256 x, uint256 varE36, uint256 tau, uint256 window, uint256 n)
        private
        pure
        returns (Result memory r)
    {
        (uint256 tDrift, uint256 tVar) = effectiveTimes(tau, window, n);
        r.sqrtV = F.sqrt(F.fullMulDiv(varE36, tVar, 1e18));
        if (r.sqrtV == 0) revert ZeroVariance();
        int256 mu = x - SafeCastLib.toInt256(F.fullMulDiv(varE36, tDrift, 2e36));
        r.d = mu * WAD / int256(r.sqrtV);
    }

    function price(int256 x, uint256 varE36, uint256 tau, uint256 window, uint256 n)
        internal
        pure
        returns (Result memory r)
    {
        r = _moments(x, varE36, tau, window, n);
        r.mid = NormalCdf.cdf(r.d);
        r.pdf = NormalCdf.pdf(r.d);
    }

    /// @notice `price` with a selectable kernel: 0 = Gaussian (Black-Scholes), 1 = variance-matched Student-t nu = 5.
    function priceKernel(int256 x, uint256 varE36, uint256 tau, uint256 window, uint256 n, uint8 kernel)
        internal
        pure
        returns (Result memory r)
    {
        if (kernel == 0) return price(x, varE36, tau, window, n);
        if (kernel != 1) revert UnknownKernel();
        r = _moments(x, varE36, tau, window, n);
        r.mid = StudentTCdf.cdf5(r.d);
        r.pdf = StudentTCdf.pdf5(r.d);
        r.kernel = 1;
    }

    /// @notice YES ask/bid (WAD) around the Result's kernel F with density f and k = gammaS / sqrt(v):
    ///         ask = ceil(F + k*f) + h0, bid = max(0, floor(F - k*f) - h0). Always ask >= mid + h0 and bid <= mid.
    /// @dev Gaussian: F +/- k*f is rounded once (NormalCdf.band), so ask and bid are monotone in x (T4(e)) and the ceil
    ///      is capped at 1e18. Other kernels: mid +/- k*pdf rounded outward, not wei-monotone. ask may exceed 1e18 and
    ///      bid may be 0, so run the band check before computing 1e18 - ask.
    function askBid(Result memory r, uint256 gammaSWad, uint256 h0Wad) internal pure returns (uint256 ask, uint256 bid) {
        if (r.kernel == 0) {
            uint256 kappa = gammaSWad > GAMMA_MAX
                ? type(uint256).max
                : F.divUp(F.divUp(gammaSWad * 1e45, r.sqrtV), uint256(NormalCdf.SQRT_2PI_WAD));
            (uint256 up, uint256 dn) = NormalCdf.band(r.d, kappa);
            ask = up + h0Wad;
            bid = dn > h0Wad ? dn - h0Wad : 0;
        } else {
            ask = r.mid + F.fullMulDivUp(gammaSWad, r.pdf, r.sqrtV) + h0Wad;
            uint256 sub = F.fullMulDiv(gammaSWad, r.pdf, r.sqrtV) + h0Wad;
            bid = r.mid > sub ? r.mid - sub : 0;
        }
    }

    /// @notice Alias of `askBid`
    function askBidFactored(Result memory r, uint256 gammaSWad, uint256 h0Wad)
        internal
        pure
        returns (uint256 ask, uint256 bid)
    {
        return askBid(r, gammaSWad, h0Wad);
    }
}
