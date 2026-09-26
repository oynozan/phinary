// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {QuoteMath} from "../src/QuoteMath.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";

contract QuoteHalmos is Test {
    uint256 constant D = 2e24;
    // Lemma S, buy side, with the square root ABSTRACTED as any s with s^2 <= disc < (s+1)^2 (bounded widths)
    function check_lemmaS_buy_abstract(uint256 beta, uint256 lam, uint256 R, uint256 s) public pure {
        vm.assume(beta > 0 && beta < 2**96 && lam > 0 && lam < 2**64 && R < 2**128 && s < 2**100);
        uint256 disc = beta * beta + 4 * lam * R;
        vm.assume(s * s <= disc && (s + 1) * (s + 1) > disc);
        uint256 q = (s - beta) / (2 * lam);                   // s >= beta always, since disc >= beta^2
        assert(lam * q * q + beta * q <= R);                  // feasible
        assert(lam * (q + 1) * (q + 1) + beta * (q + 1) > R); // maximal
    }
    // Lemma S, sell side, abstract sqrt, WITH the increasing-branch (band) precondition
    function check_lemmaS_sell_abstract(uint256 beta, uint256 lam, uint256 R, uint256 s) public pure {
        vm.assume(beta > 0 && beta < 2**96 && lam > 0 && lam < 2**64 && R < 2**128 && s < 2**100);
        vm.assume(4 * lam * R <= beta * beta);
        uint256 disc = beta * beta - 4 * lam * R;
        vm.assume(s * s <= disc && (s + 1) * (s + 1) > disc);
        uint256 q = (beta - s + 2 * lam - 1) / (2 * lam);    // ceil
        vm.assume(2 * lam * q <= beta);                       // band: end marginal price >= 0
        assert(beta * q >= lam * q * q + R);                  // sufficient
        if (q > 0) assert(beta * (q - 1) < lam * (q - 1) * (q - 1) + R); // minimal
    }
    // Same WITHOUT the band precondition: expect a counterexample (q lands past the vertex)
    function check_lemmaS_sell_noband(uint256 beta, uint256 lam, uint256 R, uint256 s) public pure {
        vm.assume(beta > 0 && beta < 2**96 && lam > 0 && lam < 2**64 && R < 2**128 && s < 2**100);
        vm.assume(4 * lam * R <= beta * beta);
        uint256 disc = beta * beta - 4 * lam * R;
        vm.assume(s * s <= disc && (s + 1) * (s + 1) > disc);
        uint256 q = (beta - s + 2 * lam - 1) / (2 * lam);
        vm.assume(lam * q * q <= beta * q);
        assert(beta * q >= lam * q * q + R);
    }
    // Floor-sqrt correctness of solady sqrt (the other half of Lemma S)
    function check_sqrt_floor(uint256 x) public pure {
        vm.assume(x < 2**254);
        uint256 s = F.sqrt(x);
        assert(s * s <= x && (s + 1) * (s + 1) > x);
    }
    function check_sqrt_floor_128(uint128 x) public pure {
        uint256 s = F.sqrt(uint256(x));
        assert(s * s <= x && (s + 1) * (s + 1) > x);
    }
    // End-to-end Lemma S through the real library (concrete sqrt code)
    function check_buyExactIn_maximal(uint256 a, uint256 lam, uint256 amt) public pure {
        vm.assume(a >= 1e16 && a <= 0.99e18 && lam >= 1 && lam <= 1e16 && amt >= 1 && amt <= 1e15);
        uint256 q = QuoteMath.buyExactIn(a, lam, 0, amt);
        assert(QuoteMath.buyExactOut(a, lam, 0, q) <= amt);
        assert(QuoteMath.buyExactOut(a, lam, 0, q + 1) > amt);
    }
    // 512-bit mulDiv (v4 FullMath) vs 256-bit when no overflow
    function check_mulDiv_matches(uint128 a, uint128 b, uint256 d) public pure {
        vm.assume(d > 0);
        assert(FullMath.mulDiv(a, b, d) == uint256(a) * uint256(b) / d);
    }
    function check_mulDivUp_ge(uint256 a, uint256 b, uint256 d) public view {
        vm.assume(d > 0);
        try this.mdu(a, b, d) returns (uint256 up) { assert(up >= FullMath.mulDiv(a, b, d)); } catch {}
    }
    function mdu(uint256 a, uint256 b, uint256 d) external pure returns (uint256) { return FullMath.mulDivRoundingUp(a, b, d); }
}
