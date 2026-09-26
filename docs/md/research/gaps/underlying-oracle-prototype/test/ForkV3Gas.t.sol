// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./ForkV3.t.sol";
import {Reader} from "./E2E.t.sol";

contract ForkV3GasTest is ForkV3Test {
    function _g(Reader r, bytes memory data) internal returns (uint256 used) {
        vm.cool(address(ad));
        vm.cool(POOL);
        (used,) = r.gasOf(address(ad), data);
    }

    function test_fork_gas() public {
        Reader r = new Reader();
        ad.poke();
        (uint32 lastGrid, uint32 nWin,,,,,) = ad.st();
        emit log_named_uint("adapter sobTick (no v3 write this block)", _g(r, abi.encodeCall(ad.sobTick, (feed))));
        emit log_named_uint("adapter cumulativeNow (observe([0]))", _g(r, abi.encodeCall(ad.cumulativeNow, (feed))));
        emit log_named_uint("adapter cumulativeAtGrid", _g(r, abi.encodeCall(ad.cumulativeAtGrid, (feed, lastGrid - 1))));
        emit log_named_uint("adapter varianceE36", _g(r, abi.encodeCall(ad.varianceE36, (feed, nWin))));
        _push(true, 10 ether); // creates a v3 write in this block
        emit log_named_uint("adapter sobTick (v3 wrote this block)", _g(r, abi.encodeCall(ad.sobTick, (feed))));
        // poke that records exactly one new window
        vm.roll(block.number + 25);
        vm.warp(block.timestamp + H);
        _push(false, 30_000e6);
        vm.cool(address(ad));
        vm.cool(POOL);
        uint256 g0 = gasleft();
        uint32 n = ad.poke();
        emit log_named_uint("poke gas", g0 - gasleft());
        emit log_named_uint("poke checkpoints", n);
    }
}
