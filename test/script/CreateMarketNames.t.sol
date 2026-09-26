// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CreateMarket} from "../../script/CreateMarket.s.sol";

contract CreateMarketHarness is CreateMarket {
    function date(uint256 t) external pure returns (string memory) {
        return _date(t);
    }

    function hhmm(uint256 t) external pure returns (string memory) {
        return _hhmm(t);
    }
}

/// Token names from CreateMarket.s.sol match the keeper bot's ("ETH > $2701.35 25 Sep 14:31", bot/test/market.test.ts).
contract CreateMarketNamesTest is Test {
    CreateMarketHarness internal h = new CreateMarketHarness();

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
}
