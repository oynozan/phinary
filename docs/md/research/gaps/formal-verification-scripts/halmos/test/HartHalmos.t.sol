// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {HartTail} from "../src/HartTail.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";

contract HartHalmos is Test {
    int256 constant WAD = 1e18;
    // (A) the full property: tail(z+1) <= tail(z) over the whole domain
    function check_tail_step(int256 z) public pure {
        vm.assume(z >= 0 && z < 37 * WAD);
        assert(HartTail.tail(z + 1) <= HartTail.tail(z));
    }
    // (A') the lower branch only, and a narrow window near z = 1 (upper bits fixed)
    function check_tail_step_lowbranch(int256 z) public pure {
        vm.assume(z >= 0 && z + 1 < HartTail.SPLIT);
        assert(HartTail.tail(z + 1) <= HartTail.tail(z));
    }
    function check_tail_step_window(uint32 t) public pure {
        int256 z = 1e18 + int256(uint256(t));
        assert(HartTail.tail(z + 1) <= HartTail.tail(z));
    }
    // (B) sub-lemmas of the decomposition proof
    function check_num_step(int256 z) public pure {
        vm.assume(z >= 0 && z + 1 < HartTail.SPLIT);
        assert(HartTail.num(z + 1) >= HartTail.num(z));
    }
    function check_expWad_step(int256 x) public pure {
        vm.assume(x >= -42139678854452767551 && x < 0);
        assert(F.expWad(x + 1) >= F.expWad(x));
    }
    function check_arg_step(int256 z) public pure {   // w(z) = z*z/WAD/2 is non-decreasing
        vm.assume(z >= 0 && z < 37 * WAD);
        assert((z + 1) * (z + 1) / WAD / 2 >= z * z / WAD / 2);
    }
    // (C) clamp + assembly (Lemma C) given an abstract non-increasing tail: fully symbolic, no arithmetic
    function check_lemmaC(int256 c0, int256 c1, int256 x, int256 y) public pure {
        // model tail values at |x|,|y| via an abstract monotone c: c(|x|) = c0, c(|y|) = c1
        vm.assume(x < y);
        int256 ax = x < 0 ? -x : x; int256 ay = y < 0 ? -y : y;
        vm.assume(ax >= 0 && ay >= 0 && c0 >= 0 && c1 >= 0 && c0 <= WAD / 2 && c1 <= WAD / 2);
        if (ax <= ay) vm.assume(c0 >= c1); else vm.assume(c1 >= c0);   // c non-increasing on [0, inf)
        if (ax == ay) vm.assume(c0 == c1);
        int256 px = x <= 0 ? c0 : WAD - c0;
        int256 py = y <= 0 ? c1 : WAD - c1;
        assert(px <= py);
    }
}
