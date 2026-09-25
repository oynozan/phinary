// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./HookFixture.sol";

/// @notice The quote follows S, sigma and tau, impact lives only inside one epoch, and band, epoch cap and cutoff halt
contract PricingTest is HookFixture {
    function _yesBuyCost(PoolKey memory k, uint256 q) internal returns (uint256 cost) {
        uint256 u0 = usdc.balanceOf(trader);
        _poolSwap(trader, k, true, false, q);
        cost = u0 - usdc.balanceOf(trader);
    }

    function _assertQuoteMatchesModel(uint256 id) internal view {
        IPredictionHook.Quote memory qt = hook.quote(id);
        (uint256 ask, uint256 bid, uint256 mid) = _askBid(id);
        assertTrue(qt.tradable, "tradable");
        assertEq(qt.midYes, mid, "mid");
        assertEq(qt.askYes, ask, "ask");
        assertEq(qt.bidYes, bid, "bid");
        assertEq(qt.askNo, WAD - bid, "askNo");
        assertEq(qt.bidNo, WAD - ask, "bidNo");
        assertEq(qt.xWad, oracle.lnSpot() - hook.marketParams(id).lnStrikeWad, "x");
        assertEq(qt.varE36, oracle.varE36(), "var");
        assertEq(qt.tau, hook.marketParams(id).expiry - block.timestamp, "tau");
        assertLe(bid, mid);
        assertGe(ask, mid);
    }

    function test_quoteMatchesModel_atmNearHalf() public view {
        _assertQuoteMatchesModel(mId);
        IPredictionHook.Quote memory qt = hook.quote(mId);
        assertApproxEqAbs(qt.midYes, 0.49e18, 0.02e18);
        assertGe(qt.askYes + qt.askNo, WAD);
        assertLe(qt.bidYes + qt.bidNo, WAD);
    }

    function test_priceRespondsToSpot() public {
        uint256 m0 = hook.quote(mId).midYes;
        (uint256 q0,) = _expect(mId, true, true, true, 1_000 * E6);
        oracle.setLnSpot(lnK + 0.02e18);
        _assertQuoteMatchesModel(mId);
        uint256 m1 = hook.quote(mId).midYes;
        assertGt(m1, m0, "YES up when S up");
        (uint256 q1,) = _expect(mId, true, true, true, 1_000 * E6);
        assertLt(q1, q0, "fewer YES per USDC");
        _poolSwap(trader, kYes, true, true, 1_000 * E6);
        assertEq(yes.balanceOf(trader), q1);
        oracle.setLnSpot(lnK - 0.02e18);
        assertLt(hook.quote(mId).midYes, m0, "YES down when S down");
        _assertQuoteMatchesModel(mId);
    }

    function test_priceRespondsToSigma() public {
        oracle.setLnSpot(lnK - 0.05e18);
        uint256 m0 = hook.quote(mId).midYes;
        oracle.setVar(VAR_60 * 4);
        _assertQuoteMatchesModel(mId);
        uint256 m1 = hook.quote(mId).midYes;
        assertGt(m1, m0, "OTM YES gains with sigma");
        (uint256 q, uint256 cash) = _expect(mId, true, true, false, 500 * E6);
        _poolSwap(trader, kYes, true, false, 500 * E6);
        assertEq(usdc.balanceOf(trader), 1_000_000 * E6 - cash);
        assertEq(yes.balanceOf(trader), q);
    }

    function test_priceRespondsToTime() public {
        oracle.setLnSpot(lnK + 0.01e18);
        uint256 m0 = hook.quote(mId).midYes;
        vm.warp(block.timestamp + 12 hours);
        _assertQuoteMatchesModel(mId);
        uint256 m1 = hook.quote(mId).midYes;
        assertGt(m1, m0, "ITM YES converges up as tau falls");
    }

    function test_fixedSigmaMode_ignoresOracleVariance() public {
        IPredictionHook.MarketParams memory p = _params();
        p.sigmaMode = 1;
        p.fixedVarE36 = VAR_60;
        uint256 id = hook.createMarket(p);
        uint256 m0 = hook.quote(id).midYes;
        oracle.setVar(VAR_60 * 9);
        assertEq(hook.quote(id).midYes, m0);
        assertEq(hook.quote(id).varE36, VAR_60);
    }

    function test_continuousAveraging_nSamplesZero() public {
        IPredictionHook.MarketParams memory p = _params();
        p.nSamples = 0;
        uint256 id = hook.createMarket(p);
        _assertQuoteMatchesModel(id);
    }

    function test_noResponseToTradeHistoryAcrossEpochs() public {
        uint256 other = hook.createMarket(_params());
        (OutcomeToken y2, OutcomeToken n2, PoolKey memory ky2,) = _market(other);
        _approveTokens(trader, y2, n2);
        IPredictionHook.Quote memory before = hook.quote(mId);
        _poolSwap(trader, kYes, true, false, 20_000 * E6);
        _poolSwap(trader, kNo, true, false, 3_000 * E6);
        _poolSwap(trader, kYes, false, true, 5_000 * E6);
        vm.warp(block.timestamp + 2);
        IPredictionHook.Quote memory a = hook.quote(mId);
        IPredictionHook.Quote memory b = hook.quote(other);
        assertEq(a.askYes, b.askYes);
        assertEq(a.bidYes, b.bidYes);
        assertEq(a.midYes, b.midYes);
        assertTrue(before.askYes != a.askYes, "tau moved");
        uint256 cA = _yesBuyCost(kYes, 1_000 * E6);
        uint256 cB = _yesBuyCost(ky2, 1_000 * E6);
        assertEq(cA, cB, "same fill regardless of history");
    }

    function test_epochImpact_accumulatesWithinBlock_resetsNextBlock() public {
        uint256 q = 1_000 * E6;
        (, uint256 fresh) = _expectAt(mId, true, true, false, q, 0);
        uint256 c1 = _yesBuyCost(kYes, q);
        assertEq(c1, fresh);
        (, uint256 second) = _expectAt(mId, true, true, false, q, int256(q));
        uint256 c2 = _yesBuyCost(kYes, q);
        assertEq(c2, second);
        assertGt(c2, c1, "impact accumulates");
        (, int256 f) = hook.epochOf(mId);
        assertEq(f, int256(2 * q));

        vm.warp(block.timestamp + 1);
        assertEq(_flow(mId), 0);
        (, uint256 fresh2) = _expectAt(mId, true, true, false, q, 0);
        assertEq(_yesBuyCost(kYes, q), fresh2, "impact reset");
        assertLt(fresh2, c2);
    }

    function test_sharedFlow_yesAndNoPools() public {
        uint256 q = 2_000 * E6;
        _poolSwap(trader, kYes, true, false, q);
        assertEq(_flow(mId), int256(q));
        (, uint256 noCostAfter) = _expectAt(mId, false, true, false, q, int256(q));
        (, uint256 noCostFresh) = _expectAt(mId, false, true, false, q, 0);
        assertLt(noCostAfter, noCostFresh, "YES buying makes NO cheaper");
        uint256 u0 = usdc.balanceOf(trader);
        _poolSwap(trader, kNo, true, false, q);
        assertEq(u0 - usdc.balanceOf(trader), noCostAfter);
        assertEq(_flow(mId), 0);
    }

    function test_bandHalts_deepInTheMoney() public {
        _poolSwap(trader, kNo, true, false, 100 * E6);
        _poolSwap(trader, kYes, true, false, 100 * E6);
        vm.warp(block.timestamp + 1);
        oracle.setLnSpot(lnK + 0.4e18);
        IPredictionHook.Quote memory qt = hook.quote(mId);
        assertGt(qt.askYes, 0.98e18);
        vm.expectRevert(_wrapped(PredictionHook.OutOfBand.selector));
        _poolSwap(trader, kYes, true, true, 10 * E6);
        vm.expectRevert(_wrapped(PredictionHook.OutOfBand.selector));
        _routerSwap(trader, kNo, false, true, 10 * E6);
    }

    function test_bandHalts_deepOutOfTheMoney() public {
        _poolSwap(trader, kYes, true, false, 100 * E6);
        vm.warp(block.timestamp + 1);
        oracle.setLnSpot(lnK - 0.4e18);
        IPredictionHook.Quote memory qt = hook.quote(mId);
        assertLt(qt.bidYes, 0.02e18);
        vm.expectRevert(_wrapped(PredictionHook.OutOfBand.selector));
        _poolSwap(trader, kYes, false, true, 10 * E6);
        vm.expectRevert(_wrapped(PredictionHook.OutOfBand.selector));
        _routerSwap(trader, kNo, true, true, 10 * E6);
    }

    function test_bandHalts_executedEndpoint() public {
        IPredictionHook.MarketParams memory p = _params();
        p.quote.lambdaWad = 0.0001e18;
        uint256 id = hook.createMarket(p);
        (OutcomeToken y2, OutcomeToken n2, PoolKey memory ky2,) = _market(id);
        _approveTokens(trader, y2, n2);
        (uint256 ask,,) = _askBid(id);
        uint256 room = (0.98e18 - ask) * E6 / p.quote.lambdaWad;
        vm.expectRevert(_wrapped(PredictionHook.OutOfBand.selector));
        _poolSwap(trader, ky2, true, false, room + 1);
        _poolSwap(trader, ky2, true, false, room);
        assertEq(y2.balanceOf(trader), room);
        vm.expectRevert(_wrapped(PredictionHook.OutOfBand.selector));
        _poolSwap(trader, ky2, true, false, 1);
        vm.warp(block.timestamp + 1);
        _poolSwap(trader, ky2, true, false, 1);
    }

    function test_epochCap() public {
        IPredictionHook.MarketParams memory p = _params();
        p.quote.qEpochMax = uint128(1_000 * E6);
        uint256 id = hook.createMarket(p);
        (OutcomeToken y2, OutcomeToken n2, PoolKey memory ky2, PoolKey memory kn2) = _market(id);
        _approveTokens(trader, y2, n2);
        _poolSwap(trader, ky2, true, false, 1_000 * E6);
        vm.expectRevert(_wrapped(PredictionHook.EpochCapExceeded.selector));
        _poolSwap(trader, ky2, true, false, 1);
        _poolSwap(trader, kn2, true, false, 400 * E6);
        _poolSwap(trader, ky2, true, false, 400 * E6);
        vm.expectRevert(_wrapped(PredictionHook.EpochCapExceeded.selector));
        _poolSwap(trader, kn2, true, false, 2_000 * E6 + 1);
        vm.warp(block.timestamp + 1);
        _poolSwap(trader, kn2, true, false, 1_000 * E6);
        assertEq(_flow(id), -int256(1_000 * E6));
    }

    function test_cutoffAndOpenTime() public {
        IPredictionHook.MarketParams memory p = _params();
        p.openTime = uint64(block.timestamp + 1 hours);
        uint256 id = hook.createMarket(p);
        (OutcomeToken y2, OutcomeToken n2, PoolKey memory ky2,) = _market(id);
        _approveTokens(trader, y2, n2);
        assertFalse(hook.quote(id).tradable);
        vm.expectRevert(_wrapped(PredictionHook.NotTradable.selector));
        _poolSwap(trader, ky2, true, true, 10 * E6);
        vm.warp(p.openTime);
        _poolSwap(trader, ky2, true, true, 10 * E6);

        uint256 cutoff = p.expiry - p.window - p.cutoffBuffer;
        vm.warp(cutoff - 1);
        assertTrue(hook.quote(id).tradable);
        _poolSwap(trader, ky2, false, true, y2.balanceOf(trader));
        vm.warp(cutoff);
        assertFalse(hook.quote(id).tradable);
        vm.expectRevert(_wrapped(PredictionHook.NotTradable.selector));
        _poolSwap(trader, ky2, true, true, 10 * E6);
        vm.warp(p.expiry - p.window);
        assertEq(hook.quote(id).midYes, 0, "no price inside the window");
    }

    function test_zeroVarianceReverts() public {
        oracle.setVar(0);
        vm.expectRevert(_wrapped(BinaryPricer.ZeroVariance.selector));
        _poolSwap(trader, kYes, true, true, 10 * E6);
        _assertUnpriced(mId);
        vm.expectRevert(BinaryPricer.ZeroVariance.selector);
        hook.quoteStrict(mId);
    }

    function _assertUnpriced(uint256 id) internal view {
        IPredictionHook.Quote memory qt = hook.quote(id);
        assertFalse(qt.tradable, "tradable");
        assertEq(qt.tau, hook.marketParams(id).expiry - block.timestamp, "tau");
        assertEq(qt.midYes + qt.askYes + qt.bidYes + qt.askNo + qt.bidNo + qt.varE36, 0, "prices");
        assertEq(qt.xWad, 0, "x");
    }

    function test_quoteDoesNotRevert_whenOracleReverts() public {
        uint256 id2 = hook.createMarket(_params());
        vm.mockCallRevert(address(oracle), abi.encodeWithSelector(MockOracle.lnSpotSoBWad.selector), "NotBound");
        _assertUnpriced(mId);
        _assertUnpriced(id2);
        vm.expectRevert(bytes("NotBound"));
        hook.quoteStrict(mId);
        vm.clearMockedCalls();
        _assertQuoteMatchesModel(mId);
        IPredictionHook.Quote memory a = hook.quote(mId);
        IPredictionHook.Quote memory b = hook.quoteStrict(mId);
        assertEq(abi.encode(a), abi.encode(b));
        vm.expectRevert(PredictionHook.UnknownMarket.selector);
        hook.quote(99);
    }
}
