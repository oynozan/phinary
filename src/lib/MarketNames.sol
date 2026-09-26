// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {LibString} from "solady/utils/LibString.sol";

/// @title MarketNames
/// @notice Strike-cent conversions and the display strings ("ETH > $2690.13 25 Sep 14:31" / "ETHUP") shared by
///         CreateMarket.s.sol and the permissionless MarketScheduler, so the two build identical names for the
///         same market.
/// @dev All timestamps are unix seconds, read as UTC.
library MarketNames {
    /// @return Strike price in whole cents, rounded half up, from a WAD ln(price).
    function strikeCents(int256 lnSpotWad) internal pure returns (uint256) {
        return (uint256(F.expWad(lnSpotWad)) + 0.5e16) / 1e16;
    }

    /// @return WAD ln(price) of a strike given in whole cents.
    function lnStrikeWad(uint256 cents) internal pure returns (int256) {
        return F.lnWad(int256(cents * 1e16));
    }

    /// @return A whole-cents amount as a fixed 2-decimal string, e.g. "2690.13" or "0.05".
    function formatCents(uint256 cents) internal pure returns (string memory) {
        uint256 whole = cents / 100;
        uint256 frac = cents % 100;
        bytes memory fs = bytes(LibString.toString(frac));
        bytes memory pad = new bytes(2 - fs.length);
        for (uint256 i; i < pad.length; ++i) {
            pad[i] = "0";
        }
        return string.concat(LibString.toString(whole), ".", string(pad), string(fs));
    }

    /// @return "26 Sep" (UTC) of a unix timestamp, via Hinnant's days-to-civil conversion.
    function date(uint256 t) internal pure returns (string memory) {
        uint256 z = t / 86_400 + 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 day = doy - (153 * mp + 2) / 5 + 1;
        uint256 month = mp < 10 ? mp + 3 : mp - 9;
        bytes memory monthNames = "JanFebMarAprMayJunJulAugSepOctNovDec";
        bytes memory mon = new bytes(3);
        for (uint256 i; i < 3; ++i) {
            mon[i] = monthNames[(month - 1) * 3 + i];
        }
        return string.concat(LibString.toString(day), " ", string(mon));
    }

    /// @return "HH:MM" (UTC) of a unix timestamp.
    function hhmm(uint256 t) internal pure returns (string memory) {
        uint256 s = t % 86_400;
        return string.concat(_two(s / 3600), ":", _two((s / 60) % 60));
    }

    /// @dev The YES/NO names and symbols for a market, e.g. ("ETH > $2690.13 25 Sep 14:31",
    ///      "ETH < $2690.13 25 Sep 14:31", "ETHUP", "ETHDOWN") for ("ETH", 269013, <that expiry>).
    function names(string memory ticker, uint256 cents, uint256 expiry)
        internal
        pure
        returns (string memory yesName, string memory noName, string memory yesSymbol, string memory noSymbol)
    {
        string memory suffix = string.concat("$", formatCents(cents), " ", date(expiry), " ", hhmm(expiry));
        yesName = string.concat(ticker, " > ", suffix);
        noName = string.concat(ticker, " < ", suffix);
        yesSymbol = string.concat(ticker, "UP");
        noSymbol = string.concat(ticker, "DOWN");
    }

    function _two(uint256 v) private pure returns (string memory) {
        return v < 10 ? string.concat("0", LibString.toString(v)) : LibString.toString(v);
    }
}
