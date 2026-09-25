// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {HartTail} from "../src/HartTail.sol";
contract HartFuzz is Test {
    /// forge-config: default.fuzz.runs = 1000000
    function testFuzz_tail_step(int256 z) public pure {
        z = bound(z, 0, 7071067811865469999);
        assertLe(HartTail.tail(z + 1), HartTail.tail(z));
    }
    /// same, restricted to the band where counterexamples are known to exist
    /// forge-config: default.fuzz.runs = 1000000
    function testFuzz_tail_step_hot(int256 z) public pure {
        z = bound(z, 5e18, 7071067811865469999);
        assertLe(HartTail.tail(z + 1), HartTail.tail(z));
    }
}
