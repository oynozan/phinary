// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title SigmaPolicy (research prototype): the single sigma spec applied on top of the raw TWAP-return RV.
/// @notice varModel = clamp(varRaw + biasAdd, floor, cap); optional rate limit on published changes (live mode).
///         All values are per-second variance of ln(price) scaled by 1e36.
library SigmaPolicy {
    uint256 internal constant YEAR = 31_536_000;

    struct Config {
        uint256 floorE36; // e.g. (0.20)^2 / YEAR * 1e36
        uint256 capE36; // e.g. (2.50)^2 / YEAR * 1e36
        uint256 biasAddE36; // c * gamma^2 / H * 1e36 (fee-band correction; 0 for an exact-follower test pool)
        uint256 maxUpPerHourWad; // live mode: max multiplicative increase of variance per hour (1e18 = 0%)
        uint256 maxDownPerHourWad; // live mode: max multiplicative decrease of variance per hour
    }

    /// @notice c * gamma^2 / H in 1e36 per-second variance units; gammaPips in 1e-6, c in WAD.
    function feeBandBiasE36(uint256 gammaPips, uint32 H, uint256 cWad) internal pure returns (uint256) {
        // gamma = gammaPips/1e6 -> gamma^2 * 1e36 = gammaPips^2 * 1e24
        return gammaPips * gammaPips * 1e24 * cWad / 1e18 / uint256(H);
    }

    function annualToE36(uint256 sigmaWad) internal pure returns (uint256) {
        // sigma^2 / YEAR * 1e36 = sigmaWad^2 / YEAR
        return sigmaWad * sigmaWad / YEAR;
    }

    function apply_(uint256 rawE36, Config memory c) internal pure returns (uint256 v) {
        v = rawE36 + c.biasAddE36;
        if (v < c.floorE36) v = c.floorE36;
        if (v > c.capE36) v = c.capE36;
    }

    /// @notice live mode: move the published variance toward `target`, bounded per elapsed time (linear in hours).
    function rateLimit(uint256 published, uint256 target, uint256 elapsed, Config memory c)
        internal
        pure
        returns (uint256)
    {
        if (published == 0) return target;
        if (target > published) {
            uint256 maxV = published + published * c.maxUpPerHourWad / 1e18 * elapsed / 3600;
            return target < maxV ? target : maxV;
        } else {
            uint256 dec = published * c.maxDownPerHourWad / 1e18 * elapsed / 3600;
            uint256 minV = dec >= published ? 0 : published - dec;
            return target > minV ? target : minV;
        }
    }
}
