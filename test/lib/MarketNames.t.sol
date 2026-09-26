// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MarketNames} from "../../src/lib/MarketNames.sol";

contract MarketNamesHarness {
    function strikeCents(int256 lnSpotWad) external pure returns (uint256) {
        return MarketNames.strikeCents(lnSpotWad);
    }

    function lnStrikeWad(uint256 cents) external pure returns (int256) {
        return MarketNames.lnStrikeWad(cents);
    }

    function formatCents(uint256 cents) external pure returns (string memory) {
        return MarketNames.formatCents(cents);
    }

    function date(uint256 t) external pure returns (string memory) {
        return MarketNames.date(t);
    }

    function hhmm(uint256 t) external pure returns (string memory) {
        return MarketNames.hhmm(t);
    }

    function names(string memory ticker, uint256 cents, uint256 expiry)
        external
        pure
        returns (string memory yesName, string memory noName, string memory yesSymbol, string memory noSymbol)
    {
        return MarketNames.names(ticker, cents, expiry);
    }
}

/// @notice Mirrors test/script/CreateMarketNames.t.sol's date assertions; MarketScheduler and CreateMarket.s.sol both
///         build display strings through this library, so it is tested standalone here.
contract MarketNamesTest is Test {
    MarketNamesHarness internal h = new MarketNamesHarness();

    function test_dateAndTime() public view {
        assertEq(h.date(1790346660), "25 Sep");
        assertEq(h.hhmm(1790346660), "14:31");
        assertEq(h.date(1790380800), "26 Sep");
        assertEq(h.hhmm(1790380800), "00:00");
        assertEq(h.date(1791244800), "6 Oct");
        assertEq(h.date(1772323200), "1 Mar");
        assertEq(h.date(1767139199), "30 Dec");
        assertEq(h.date(1767225599), "31 Dec");
        assertEq(h.date(1767225600), "1 Jan");
        assertEq(h.date(1709164800), "29 Feb");
    }

    function test_formatCents() public view {
        assertEq(h.formatCents(2690_13), "2690.13");
        assertEq(h.formatCents(1_000_000_05), "1000000.05");
        assertEq(h.formatCents(5), "0.05");
        assertEq(h.formatCents(100), "1.00");
    }

    function test_names() public view {
        (string memory yesName, string memory noName, string memory yesSymbol, string memory noSymbol) =
            h.names("ETH", 269013, 1790346660);
        assertEq(yesName, "ETH > $2690.13 25 Sep 14:31");
        assertEq(noName, "ETH < $2690.13 25 Sep 14:31");
        assertEq(yesSymbol, "ETHUP");
        assertEq(noSymbol, "ETHDOWN");
    }

    /// @dev The 15m track's market opened at 26 Sep 14:00 UTC; the ticker alone tells it from the 1m market with the
    ///      same expiry
    function test_namesFifteenMinuteTrack() public view {
        (string memory yesName, string memory noName, string memory yesSymbol, string memory noSymbol) =
            h.names("ETH15M", 269013, 1790432100);
        assertEq(yesName, "ETH15M > $2690.13 26 Sep 14:15");
        assertEq(noName, "ETH15M < $2690.13 26 Sep 14:15");
        assertEq(yesSymbol, "ETH15MUP");
        assertEq(noSymbol, "ETH15MDOWN");
    }

    /// @dev The scheduler caps tickers at 6 characters, so no symbol passes 11 (a common wallet display limit)
    function test_symbolsFitElevenChars() public view {
        string[3] memory tickers = ["ETH", "ETH15M", "ABCDEF"];
        for (uint256 i; i < tickers.length; ++i) {
            (,, string memory yesSymbol, string memory noSymbol) = h.names(tickers[i], 269013, 1790432100);
            assertLe(bytes(yesSymbol).length, 11, yesSymbol);
            assertLe(bytes(noSymbol).length, 11, noSymbol);
        }
    }

    /// @dev strikeCents and lnStrikeWad are inverses over the cent range CreateMarket.s.sol and MarketScheduler use.
    function testFuzz_strikeCentsRoundTrip(uint256 c) public view {
        c = bound(c, 1, 1e12);
        assertEq(h.strikeCents(h.lnStrikeWad(c)), c);
    }
}
