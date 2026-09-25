// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title StrikeMath
/// @notice Settlement threshold of the half-tick integer rule (docs/SPEC.md §3.5)
/// @dev The oracle's normalised tick satisfies ln(USD per ETH) = normTick * ln(1.0001) + decimalsShift * ln(10)
library StrikeMath {
    int256 internal constant LN10_E36 = 2302585092994045684017991454684364208;
    int256 internal constant LN_1_0001_E36 = 99995000333308335333166680951131;

    /// @notice Strike as a normalised oracle tick in WAD, (lnStrikeWad - decimalsShift * ln10) / ln(1.0001)
    function strikeTickWad(int256 lnStrikeWad, int16 decimalsShift) internal pure returns (int256) {
        return (lnStrikeWad * 1e18 - int256(decimalsShift) * LN10_E36) * 1e18 / LN_1_0001_E36;
    }

    /// @notice YES iff D * 1e18 > threshold with D = cum(T) - cum(T - window), a tie resolves NO
    function threshold(int256 lnStrikeWad, int16 decimalsShift, uint32 window) internal pure returns (int256) {
        return int256(uint256(window)) * (strikeTickWad(lnStrikeWad, decimalsShift) - 0.5e18);
    }
}
