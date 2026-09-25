// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./HookFixture.sol";
import {StrikeMath} from "../../src/hook/StrikeMath.sol";
import {IUnderlyingOracle} from "../../src/interfaces/IUnderlyingOracle.sol";

/// @notice Half-tick settlement, redemption at exactly 1.0 (swap and redeem), INVALID fallback and sweep
abstract contract SettlementCases is HookFixture {
    address internal trader2 = makeAddr("trader2");
    uint64 internal expiry;

    function setUp() public virtual override {
        super.setUp();
        expiry = hook.marketInfo(mId).expiry;
        _fund(trader2, 1_000_000 * E6);
        _poolSwap(trader, kYes, true, false, 3_000 * E6);
        _poolSwap(trader, kNo, true, false, 1_000 * E6);
        _poolSwap(trader2, kYes, true, false, 500 * E6);
        _poolSwap(trader2, kNo, true, false, 2_500 * E6);
        _poolSwap(trader2, kNo, false, true, 500 * E6);
        vm.warp(block.timestamp + 5);
    }

    function _settleWithTick(int24 tick) internal returns (bool yesWon) {
        oracle.setFlatTick(tick);
        vm.warp(expiry);
        hook.settle(mId);
        _checkInvariants();
        return hook.marketInfo(mId).yesWon;
    }

    /* Settlement rule */

    function test_thresholdMatchesMpmath() public view {
        assertApproxEqAbs(StrikeMath.strikeTickWad(lnK, 0), 80067678793569898602667, 1e6);
        assertEq(hook.settleThresholdOf(mId), int256(uint256(1 hours)) * (StrikeMath.strikeTickWad(lnK, 0) - 0.5e18));
    }

    function test_settleBeforeExpiryReverts() public {
        vm.warp(expiry - 1);
        vm.expectRevert(PredictionHook.TooEarly.selector);
        hook.settle(mId);
    }

    function test_settle_halfTickBoundary_no() public {
        assertFalse(_settleWithTick(80067), "80067 < kappa - 1/2 = 80067.18");
    }

    function test_settle_halfTickBoundary_yes() public {
        oracle.setFlatTick(80068);
        vm.warp(expiry);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IPredictionHook.MarketSettled(mId, true, int256(80068) * 1 hours, false);
        hook.settle(mId);
        assertTrue(hook.marketInfo(mId).yesWon);
        assertEq(uint8(hook.marketInfo(mId).status), uint8(IPredictionHook.Status.Settled));
        _checkInvariants();
    }

    function test_settle_usesOnlyTheWindow() public {
        oracle.setFlatTick(0);
        uint32 t = uint32(expiry);
        oracle.setCum(t - 1 hours, 1e12);
        oracle.setCum(t, 1e12 + int56(80068) * 1 hours);
        vm.warp(expiry + 10 minutes);
        hook.settle(mId);
        assertTrue(hook.marketInfo(mId).yesWon);
    }

    function test_settle_decimalsShift12() public {
        oracle.setShift(12);
        uint256 id = hook.createMarket(_params());
        assertApproxEqAbs(StrikeMath.strikeTickWad(lnK, 12), -196256347646026550650556, 1e6);
        IPredictionHook.MarketParams memory p = hook.marketParams(id);
        oracle.setFlatTick(-196257);
        vm.warp(p.expiry);
        hook.settle(id);
        assertFalse(hook.marketInfo(id).yesWon, "-196257 < kappa - 1/2 = -196256.85");
        uint256 id2 = hook.createMarket(_params());
        oracle.setFlatTick(-196256);
        vm.warp(hook.marketParams(id2).expiry);
        hook.settle(id2);
        assertTrue(hook.marketInfo(id2).yesWon);
    }

    function _tieMarket(uint64 exp, int56 d) internal returns (uint256 id) {
        IPredictionHook.MarketParams memory p = _params();
        p.lnStrikeWad = 0;
        p.window = 10;
        p.expiry = exp;
        id = hook.createMarket(p);
        oracle.setCum(uint32(exp) - 10, 777);
        oracle.setCum(uint32(exp), 777 + d);
    }

    function test_settle_tieResolvesNo() public {
        uint64 e = uint64(block.timestamp + 2 hours);
        uint256 tie = _tieMarket(e, -5);
        uint256 above = _tieMarket(e + 100, -4);
        uint256 below = _tieMarket(e + 200, -6);
        assertEq(hook.settleThresholdOf(tie), -5e18);
        vm.warp(e + 200);
        hook.settle(tie);
        hook.settle(above);
        hook.settle(below);
        assertFalse(hook.marketInfo(tie).yesWon, "tie -> NO");
        assertTrue(hook.marketInfo(above).yesWon);
        assertFalse(hook.marketInfo(below).yesWon);
    }

    function test_settleTwiceReverts() public {
        _settleWithTick(90000);
        vm.expectRevert(PredictionHook.MarketClosed.selector);
        hook.settle(mId);
        vm.expectRevert(PredictionHook.MarketClosed.selector);
        hook.settleInvalid(mId);
    }

    function test_swapsAfterExpiryBeforeSettleRevert() public {
        vm.warp(expiry);
        vm.expectRevert(_wrapped(PredictionHook.NotTradable.selector));
        _poolSwap(trader, kYes, false, true, 10 * E6);
    }

    /* Redemption */

    function test_redeemViaSwap_exactlyOne() public {
        _settleWithTick(90000);
        uint256 bal = yes.balanceOf(trader);
        assertEq(_quoteV4(kYes, false, true, 1_000 * E6), 1_000 * E6, "quoter 1:1");
        assertEq(_quoteV4(kYes, false, false, 700 * E6), 700 * E6, "quoter 1:1 exact-out");

        uint256 u0 = usdc.balanceOf(trader);
        _poolSwap(trader, kYes, false, true, 1_000 * E6);
        assertEq(usdc.balanceOf(trader), u0 + 1_000 * E6);
        _routerSwap(trader, kYes, false, false, 700 * E6);
        assertEq(usdc.balanceOf(trader), u0 + 1_700 * E6);
        _routerSwap(trader, kYes, false, true, 300 * E6);
        _poolSwap(trader, kYes, false, false, 200 * E6);
        assertEq(yes.balanceOf(trader), bal - 2_200 * E6);
        assertEq(usdc.balanceOf(trader), u0 + 2_200 * E6);
        _checkInvariants();
        IPredictionHook.MarketInfo memory i = hook.marketInfo(mId);
        assertEq(i.invYes, 2_200 * E6);
    }

    function test_losingAndBuySwapsRevertAfterSettle() public {
        _settleWithTick(90000);
        vm.expectRevert(_wrapped(PredictionHook.MarketClosed.selector));
        _poolSwap(trader, kNo, false, true, 10 * E6);
        vm.expectRevert(_wrapped(PredictionHook.MarketClosed.selector));
        _routerSwap(trader, kNo, false, false, 10 * E6);
        vm.expectRevert(_wrapped(PredictionHook.MarketClosed.selector));
        _poolSwap(trader, kYes, true, true, 10 * E6);
        vm.expectRevert(_wrapped(PredictionHook.MarketClosed.selector));
        _poolSwap(trader, kNo, true, false, 10 * E6);
    }

    function test_redeemDirect() public {
        vm.expectRevert(PredictionHook.NotSettled.selector);
        vm.prank(trader);
        hook.redeem(mId, 1);

        assertFalse(_settleWithTick(70000));
        uint256 n = no.balanceOf(trader2);
        uint256 u0 = usdc.balanceOf(trader2);
        uint256 b0 = hook.marketInfo(mId).bucket;
        vm.expectEmit(true, true, true, true, address(hook));
        emit IPredictionHook.Redeemed(mId, trader2, n, n);
        vm.prank(trader2);
        assertEq(hook.redeem(mId, n), n);
        assertEq(usdc.balanceOf(trader2), u0 + n);
        assertEq(no.balanceOf(trader2), 0);
        assertEq(hook.marketInfo(mId).bucket, b0 - n);
        _checkInvariants();

        vm.expectRevert();
        vm.prank(trader2);
        hook.redeem(mId, 1);
        vm.expectRevert(PredictionHook.ZeroAmount.selector);
        vm.prank(trader);
        hook.redeem(mId, 0);
    }

    /* Sweep */

    function test_sweep() public {
        vm.expectRevert(PredictionHook.NotSettled.selector);
        hook.sweep(mId);
        _settleWithTick(90000);
        IPredictionHook.MarketInfo memory i = hook.marketInfo(mId);
        uint256 idle0 = hook.vaultIdle();
        uint256 plus0 = hook.navPlus();
        uint256 minus0 = hook.navMinus();
        assertEq(plus0, minus0, "resolved market has one value");
        vm.expectEmit(true, true, true, true, address(hook));
        emit IPredictionHook.Swept(mId, i.bucket - i.outYes);
        assertEq(hook.sweep(mId), i.bucket - i.outYes);
        assertEq(hook.vaultIdle(), idle0 + i.bucket - i.outYes);
        assertEq(hook.marketInfo(mId).bucket, i.outYes);
        assertEq(hook.navPlus(), plus0, "sweep is NAV-neutral");
        assertEq(hook.navMinus(), minus0);
        assertEq(hook.sweep(mId), 0);
        _checkInvariants();
    }

    function test_fullLifecycle_noStuckFunds() public {
        _settleWithTick(90000);
        hook.sweep(mId);
        uint256 y1 = yes.balanceOf(trader);
        uint256 y2 = yes.balanceOf(trader2);
        vm.prank(trader);
        hook.redeem(mId, y1);
        _poolSwap(trader2, kYes, false, true, y2);
        assertEq(hook.marketInfo(mId).bucket, 0);
        assertEq(hook.marketInfo(mId).outYes, 0);
        _checkInvariants();
        uint256 shares = hook.sharesOf(lp);
        vm.prank(lp);
        uint256 got = hook.withdraw(shares);
        assertEq(hook.totalShares(), 0);
        assertLe(hook.vaultIdle(), 2, "only the virtual-share dust stays");
        assertEq(usdc.balanceOf(lp), got);
        assertEq(usdc.balanceOf(address(manager)), hook.vaultIdle());
        _checkInvariants();
    }

    /* INVALID fallback */

    function test_settleInvalid_path() public {
        vm.warp(expiry + hook.GRACE());
        vm.expectRevert(PredictionHook.TooEarly.selector);
        hook.settleInvalid(mId);
        vm.warp(expiry + hook.GRACE() + 1);
        vm.expectRevert(PredictionHook.OracleAvailable.selector);
        hook.settleInvalid(mId);

        oracle.setOldest(uint32(expiry));
        vm.expectRevert(
            abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, uint32(expiry) - 1 hours)
        );
        hook.settle(mId);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IPredictionHook.MarketSettled(mId, false, 0, true);
        hook.settleInvalid(mId);
        assertEq(uint8(hook.marketInfo(mId).status), uint8(IPredictionHook.Status.Invalid));
        _checkInvariants();

        uint256 u0 = usdc.balanceOf(trader);
        assertEq(_quoteV4(kYes, false, true, 101), 50);
        _poolSwap(trader, kYes, false, true, 101);
        assertEq(usdc.balanceOf(trader), u0 + 50, "YES at 0.5, floor");
        uint256 n0 = no.balanceOf(trader);
        _routerSwap(trader, kNo, false, false, 100 * E6);
        assertEq(no.balanceOf(trader), n0 - 200 * E6, "NO at 0.5 exact-out");
        vm.expectRevert(_wrapped(PredictionHook.MarketClosed.selector));
        _poolSwap(trader, kYes, true, true, 10 * E6);
        vm.expectRevert(_wrapped(PredictionHook.ZeroAmount.selector));
        _poolSwap(trader, kYes, false, true, 1);
        _checkInvariants();

        uint256 y = yes.balanceOf(trader2);
        uint256 n = no.balanceOf(trader2);
        u0 = usdc.balanceOf(trader2);
        vm.prank(trader2);
        assertEq(hook.redeem(mId, y + n), (y + n) / 2);
        assertEq(yes.balanceOf(trader2), 0);
        assertEq(no.balanceOf(trader2), 0);
        assertEq(usdc.balanceOf(trader2), u0 + (y + n) / 2);
        _checkInvariants();

        IPredictionHook.MarketInfo memory i = hook.marketInfo(mId);
        uint256 req = (i.outYes + i.outNo + 1) / 2;
        assertEq(hook.sweep(mId), i.bucket - req);
        assertEq(hook.marketInfo(mId).bucket, req);
        uint256 yT = yes.balanceOf(trader);
        uint256 nT = no.balanceOf(trader);
        vm.prank(trader);
        hook.redeem(mId, yT + nT);
        i = hook.marketInfo(mId);
        assertEq(i.outYes + i.outNo, 0);
        hook.sweep(mId);
        assertEq(hook.marketInfo(mId).bucket, 0);
        _checkInvariants();
    }
}

contract Settlement_OutcomeIsCurrency0 is SettlementCases {
    function _outcomeIs0() internal pure override returns (bool) {
        return true;
    }
}

contract Settlement_OutcomeIsCurrency1 is SettlementCases {
    function _outcomeIs0() internal pure override returns (bool) {
        return false;
    }
}
