// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FullMath} from "v4-core/libraries/FullMath.sol";
/// Ledger-only model of swap-path-accounting-proto/src/PredictionHookProto.sol::beforeSwap effects (lines 214-246),
/// plus split/merge/fund/defund/resolve/redeem, for 2 markets sharing one USDC-claim balance (S4).
/// `claims` models PM.balanceOf(hook, USDC.id); mint/burn of claims are the proto's PM calls (lines 250-262).
contract VcsModel {
    uint256 internal constant WAD = 1e18;
    struct M { uint256 bucket; uint256 outY; uint256 outN; uint256 invY; uint256 invN; bool resolved; bool yesWon; }
    M[2] public m;
    uint256 public idle;    // vault idle cash (claims not allocated to any market)
    uint256 public claims;  // PM.balanceOf(hook, USDC.id)
    error Insolvent();
    error ZeroAmount();

    function required(M storage x) internal view returns (uint256) {
        if (x.resolved) return x.yesWon ? x.outY : x.outN;
        return x.outY > x.outN ? x.outY : x.outN;
    }
    function check(M storage x) internal view { if (x.bucket < required(x)) revert Insolvent(); }

    /// All 8 cases: (isYes, buying, exactIn). ask/bid in WAD. Amounts computed exactly like the proto.
    function swap(uint256 id, bool isYes, bool buying, bool exactIn, uint256 a, uint256 ask, uint256 bid) public {
        M storage x = m[id];
        require(!x.resolved);
        uint256 q; uint256 cash;
        if (buying) {
            if (exactIn) (cash, q) = (a, FullMath.mulDiv(a, WAD, ask));
            else (q, cash) = (a, FullMath.mulDivRoundingUp(a, ask, WAD));
        } else {
            if (exactIn) (q, cash) = (a, FullMath.mulDiv(a, bid, WAD));
            else (cash, q) = (a, FullMath.mulDivRoundingUp(a, WAD, bid));
        }
        _apply(x, isYes, buying, q, cash);
    }
    /// Same effects with the price layer abstracted away: q and cash are arbitrary (solvency is price-independent, I7).
    function swapAbs(uint256 id, bool isYes, bool buying, uint256 q, uint256 cash) public {
        M storage x = m[id];
        require(!x.resolved);
        _apply(x, isYes, buying, q, cash);
    }
    function _apply(M storage x, bool isYes, bool buying, uint256 q, uint256 cash) internal {
        if (q == 0 || cash == 0) revert ZeroAmount();
        if (buying) {
            x.bucket += cash;
            uint256 inv = isYes ? x.invY : x.invN;
            uint256 fromInv = q < inv ? q : inv;
            if (isYes) (x.invY, x.outY) = (inv - fromInv, x.outY + q);
            else (x.invN, x.outN) = (inv - fromInv, x.outN + q);
            claims += cash;                         // pm.mint(hook, USDC.id, cash)
        } else {
            uint256 b = x.bucket;
            if (cash > b) revert Insolvent();
            x.bucket = b - cash;
            if (isYes) (x.invY, x.outY) = (x.invY + q, x.outY - q);
            else (x.invN, x.outN) = (x.invN + q, x.outN - q);
            claims -= cash;                         // pm.burn(hook, USDC.id, cash)
        }
        check(x);
    }
    function split(uint256 id, uint256 amt) public { M storage x = m[id]; require(!x.resolved); x.bucket += amt; x.outY += amt; x.outN += amt; claims += amt; check(x); }
    function merge(uint256 id, uint256 amt) public { M storage x = m[id]; require(!x.resolved); x.bucket -= amt; x.outY -= amt; x.outN -= amt; claims -= amt; check(x); }
    function fund(uint256 id, uint256 amt) public { idle -= amt; m[id].bucket += amt; }
    function defund(uint256 id, uint256 amt) public { M storage x = m[id]; x.bucket -= amt; idle += amt; check(x); }
    function deposit(uint256 amt) public { idle += amt; claims += amt; }
    function withdraw(uint256 amt) public { idle -= amt; claims -= amt; }
    function resolve(uint256 id, bool yesWon) public { M storage x = m[id]; require(!x.resolved); x.resolved = true; x.yesWon = yesWon; check(x); }
    function redeem(uint256 id, uint256 amt) public {
        M storage x = m[id]; require(x.resolved);
        if (x.yesWon) x.outY -= amt; else x.outN -= amt;
        x.bucket -= amt; claims -= amt; check(x);
    }
}
