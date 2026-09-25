// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../integration/StackFixture.sol";

abstract contract BoundaryBase is StackFixture {
    address internal carol = makeAddr("carol");

    function setUp() public virtual override {
        super.setUp();
        _fundUsdc(liam, 100_000 * E6);
        _deposit(liam, 100_000 * E6);
        _fundUsdc(alice, 10_000 * E6);
        _fundUsdc(bob, 10_000 * E6);
        _fundUsdc(carol, 10_000 * E6);
        _nextBlock(1);
    }

    function _open(IPredictionHook.MarketParams memory p) internal returns (uint256 id) {
        id = _create(p);
        _approveOutcomes(alice, id);
        _approveOutcomes(bob, id);
        _approveOutcomes(carol, id);
    }

    /// @dev The keeper's demo market with a budget and cap large enough for the boundary trades
    function _demo(uint256 budget) internal returns (uint256) {
        IPredictionHook.MarketParams memory p = _demoParams();
        p.budget = budget;
        p.quote.qEpochMax = uint128(1_000 * E6);
        p.quote.lambdaWad = 0.0001e18;
        return _open(p);
    }

    function _settle(uint256 id) internal returns (bool) {
        vm.prank(keeper);
        hook.settle(id);
        return hook.marketInfo(id).yesWon;
    }

    function _expectAllFourRevert(uint256 id, bytes memory err) internal {
        _expectSwapRevert(alice, _poolKey(id, true), true, 1 * E6, err);
        _expectSwapRevert(alice, _poolKey(id, true), false, 1 * E6, err);
        _expectSwapRevert(bob, _poolKey(id, false), true, 1 * E6, err);
        _expectSwapRevert(bob, _poolKey(id, false), false, 1 * E6, err);
    }

    function _balance(uint256 id, bool isYes, address who) internal view returns (uint256) {
        return _outcome(id, isYes).balanceOf(who);
    }
}

/// @notice Time boundaries, settlement and redemption rules, market isolation and the vault's NAV bounds, on the real
///         stack (PredictionHook + UnderlyingOracleHook + PriceSteerer + Circle-like USDC)
contract BoundariesTest is BoundaryBase {
    /* Time boundaries */

    function test_openTime_boundary() public {
        IPredictionHook.MarketParams memory p = _demoParams();
        p.openTime = uint64(_now() + 20);
        p.expiry = uint64(_now() + 80);
        uint256 id = _open(p);
        _warpTo(p.openTime - 1);
        assertFalse(hook.quote(id).tradable);
        _expectSwapRevert(alice, _poolKey(id, true), true, 1 * E6, _wrapped(PredictionHook.NotTradable.selector));
        _warpTo(p.openTime);
        assertTrue(hook.quote(id).tradable);
        _trade("Alice", alice, id, true, true, true, 1 * E6, true);
    }

    function test_cutoff_plusMinusOneSecond() public {
        uint256 id = _demo(100 * E6);
        IPredictionHook.MarketParams memory p = hook.marketParams(id);
        uint256 cutoff = p.expiry - p.window - p.cutoffBuffer;
        _warpTo(cutoff - 1);
        assertTrue(hook.quote(id).tradable, "last tradable second");
        _trade("Alice", alice, id, true, true, true, 2 * E6, true);
        _trade("Bob", bob, id, false, true, false, 2 * E6, false);
        _trade("Alice", alice, id, true, false, true, 1 * E6, false);
        _trade("Bob", bob, id, false, false, false, 0.5e6, true);

        _warpTo(cutoff);
        IPredictionHook.Quote memory q = hook.quote(id);
        assertFalse(q.tradable, "cutoff: halted");
        assertGt(q.midYes, 0, "the quote is still displayed while tau > window");
        _expectAllFourRevert(id, _wrapped(PredictionHook.NotTradable.selector));
        IV4Quoter.QuoteExactSingleParams memory qp = IV4Quoter.QuoteExactSingleParams({
            poolKey: _poolKey(id, true),
            zeroForOne: _swapParams(_poolKey(id, true), true, true, 1e6).zeroForOne,
            exactAmount: 1e6,
            hookData: ""
        });
        vm.expectRevert();
        quoter.quoteExactInputSingle(qp);
        _checkLedger();
    }

    function test_expiry_settleBeforeExpiryReverts() public {
        uint256 id = _demo(100 * E6);
        _trade("Alice", alice, id, true, true, true, 3 * E6, true);
        _trade("Bob", bob, id, false, true, true, 3 * E6, true);
        uint64 exp = hook.marketInfo(id).expiry;
        _warpTo(exp - 1);
        vm.expectRevert(PredictionHook.TooEarly.selector);
        hook.settle(id);
        _expectAllFourRevert(id, _wrapped(PredictionHook.NotTradable.selector));
        _warpTo(exp);
        _expectAllFourRevert(id, _wrapped(PredictionHook.NotTradable.selector));
        vm.expectRevert(PredictionHook.NotSettled.selector);
        hook.sweep(id);
        vm.expectRevert(PredictionHook.NotSettled.selector);
        vm.prank(alice);
        hook.redeem(id, 1);
        bool yesWon = _settle(id);
        vm.expectRevert(PredictionHook.MarketClosed.selector);
        hook.settle(id);
        vm.expectRevert(PredictionHook.MarketClosed.selector);
        hook.settleInvalid(id);
        _expectSwapRevert(alice, _poolKey(id, true), true, 1 * E6, _wrapped(PredictionHook.MarketClosed.selector));
        _expectSwapRevert(bob, _poolKey(id, false), true, 1 * E6, _wrapped(PredictionHook.MarketClosed.selector));
        address loser = yesWon ? bob : alice;
        _expectSwapRevert(loser, _poolKey(id, !yesWon), false, 1 * E6, _wrapped(PredictionHook.MarketClosed.selector));
        _checkLedger();
    }

    /* Redemption */

    function _yesWinsMarket() internal returns (uint256 id) {
        id = _demo(100 * E6);
        _trade("Alice", alice, id, true, true, true, 5 * E6, true);
        _trade("Carol", carol, id, true, true, false, 4 * E6, false);
        _trade("Bob", bob, id, false, true, true, 6 * E6, true);
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        _warpTo(i.expiry - 10);
        _steerUsd(_spotUsd() * 1001 / 1000);
        _warpTo(i.expiry);
        assertTrue(_settle(id), "ETH +0.1% through the window: YES");
    }

    function test_redemptionAfterSettle_swapAndDirect() public {
        uint256 id = _yesWinsMarket();
        uint256 a = _balance(id, true, alice);
        assertEq(_quoteV4(_poolKey(id, true), false, true, a), a, "quoter exact-in 1:1");
        assertEq(_quoteV4(_poolKey(id, true), false, false, 1e6), 1e6, "quoter exact-out 1:1");

        uint256 u0 = usdc.balanceOf(alice);
        (uint256 q, uint256 cash) = _swap(alice, id, true, false, true, a / 2, false);
        assertEq(cash, q, "PoolSwapTest exact-in at 1.0");
        (q, cash) = _swap(alice, id, true, false, false, 1e6, true);
        assertEq(q, cash, "V4Router exact-out at 1.0");
        uint256 rest = _balance(id, true, alice);
        vm.prank(alice);
        assertEq(hook.redeem(id, rest), rest, "direct redeem at 1.0");
        assertEq(usdc.balanceOf(alice), u0 + a, "Alice got exactly 1 USDC per YES");
        assertEq(_balance(id, true, alice), 0);

        uint256 c = _balance(id, true, carol);
        vm.prank(carol);
        hook.redeem(id, c);
        vm.expectRevert();
        vm.prank(bob);
        hook.redeem(id, 1);
        _checkLedger();
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        assertEq(i.outYes, 0, "every YES redeemed");
        uint256 swept = hook.sweep(id);
        assertEq(swept, i.bucket, "the rest of the bucket goes back to the vault");
        assertEq(hook.marketInfo(id).bucket, 0);
        _checkLedger();
    }

    function test_losingTokenSellReverts_bothOutcomes() public {
        uint256 y = _yesWinsMarket();
        uint256 n = _balance(y, false, bob);
        assertGt(n, 0);
        _expectSwapRevert(bob, _poolKey(y, false), false, n, _wrapped(PredictionHook.MarketClosed.selector));
        PoolKey memory kn = _poolKey(y, false);
        bytes memory plan = _routerPlan(kn, false, false, 1e6);
        vm.expectRevert(_wrapped(PredictionHook.MarketClosed.selector));
        vm.prank(bob);
        router.executeActions(plan);

        uint256 id = _demo(100 * E6);
        _trade("Alice", alice, id, true, true, true, 5 * E6, true);
        _trade("Bob", bob, id, false, true, true, 5 * E6, true);
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        _warpTo(i.expiry - 10);
        _steerUsd(_spotUsd() * 999 / 1000);
        _warpTo(i.expiry);
        assertFalse(_settle(id), "ETH -0.1%: NO");
        _expectSwapRevert(alice, _poolKey(id, true), false, 1e6, _wrapped(PredictionHook.MarketClosed.selector));
        (uint256 q, uint256 cash) = _swap(bob, id, false, false, true, _balance(id, false, bob), true);
        assertEq(q, cash, "NO redeems at 1.0");
        _checkLedger();
    }

    /* Isolation */

    /// @dev Market A pays out a loss to the vault while market B, open on the same hook and oracle, is untouched;
    ///      a trade in A that A's own bucket cannot back reverts although B and the vault hold plenty
    function test_multiMarketIsolation() public {
        uint256 a = _demo(100 * E6);
        IPredictionHook.MarketParams memory pb = _demoParams();
        pb.expiry = uint64(_now() + 300);
        pb.budget = 100 * E6;
        pb.quote.qEpochMax = uint128(1_000 * E6);
        pb.quote.lambdaWad = 0.0001e18;
        uint256 b = _open(pb);

        _trade("Bob", bob, b, false, true, true, 20 * E6, true);
        _trade("Carol", carol, b, true, true, true, 5 * E6, false);
        IPredictionHook.MarketInfo memory b0 = hook.marketInfo(b);

        _trade("Alice", alice, a, true, true, false, 200 * E6, true);
        _expectSwapRevertOut(alice, _poolKey(a, true), 100 * E6, _wrapped(PredictionHook.Insolvent.selector));
        assertGt(hook.vaultIdle(), 1_000 * E6, "idle is plenty");
        assertGt(b0.bucket, 100 * E6, "so is B's bucket");

        IPredictionHook.MarketInfo memory ai = hook.marketInfo(a);
        _warpTo(ai.expiry - 10);
        _steerUsd(_spotUsd() * 1002 / 1000);
        _warpTo(ai.expiry);
        assertTrue(_settle(a), "ETH rallied: A pays YES");
        uint256 idle0 = hook.vaultIdle();
        uint256 y = _balance(a, true, alice);
        _swap(alice, a, true, false, true, y, true);
        assertEq(hook.marketInfo(a).outYes, 0);
        vm.expectRevert();
        vm.prank(alice);
        hook.redeem(a, 1);
        hook.sweep(a);
        assertEq(hook.marketInfo(a).bucket, 0, "A's loss stopped at A's bucket");

        IPredictionHook.MarketInfo memory b1 = hook.marketInfo(b);
        assertEq(b1.bucket, b0.bucket, "B's bucket untouched");
        assertEq(b1.outYes, b0.outYes);
        assertEq(b1.outNo, b0.outNo);
        assertGe(hook.vaultIdle(), idle0, "the vault only gains the sweep");
        _nextBlock(1);
        _trade("Carol", carol, b, true, true, true, 1 * E6, true);
        _checkLedger();
    }

    function _expectSwapRevertOut(address who, PoolKey memory k, uint256 amt, bytes memory err) internal {
        SwapParams memory sp = _swapParams(k, true, false, amt);
        PoolSwapTest.TestSettings memory ts = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        vm.expectRevert(err);
        vm.prank(who);
        swapRouter.swap(k, sp, ts, "");
    }

    /* Vault */

    function test_vaultNav_underOpenExposure() public {
        uint256 a = _demo(1_000 * E6);
        uint256 b = _demo(500 * E6);
        _trade("Alice", alice, a, true, true, false, 900 * E6, true);
        _trade("Bob", bob, a, false, true, false, 300 * E6, false);
        _trade("Carol", carol, b, false, true, true, 100 * E6, true);
        _checkLedger();

        IPredictionHook.MarketInfo memory ia = hook.marketInfo(a);
        IPredictionHook.MarketInfo memory ib = hook.marketInfo(b);
        uint256 idle = hook.vaultIdle();
        uint256 plus = idle + (ia.bucket - ia.outNo) + (ib.bucket - ib.outYes);
        uint256 minus = idle + (ia.bucket - ia.outYes) + (ib.bucket - ib.outNo);
        assertEq(hook.navPlus(), plus, "NAV+ = idle + sum(bucket - min(out))");
        assertEq(hook.navMinus(), minus, "NAV- = idle + sum(bucket - max(out))");
        assertGt(plus, minus, "open exposure opens a gap");
        console2.log(
            string.concat("NAV+ ", _dec(plus, 6, 2), "  NAV- ", _dec(minus, 6, 2), "  idle ", _dec(idle, 6, 2))
        );

        address lp2 = makeAddr("lp2");
        _fundUsdc(lp2, 10_000 * E6);
        uint256 ts = hook.totalShares();
        uint256 shares = _deposit(lp2, 10_000 * E6);
        assertEq(shares, 10_000 * E6 * (ts + 1e6) / (plus + 1), "deposit priced at NAV+");
        uint256 ts2 = hook.totalShares();
        uint256 minus2 = hook.navMinus();
        vm.prank(lp2);
        uint256 back = hook.withdraw(shares);
        assertEq(back, shares * (minus2 + 1) / (ts2 + 1e6), "withdraw priced at NAV-");
        assertLt(back, 10_000 * E6, "an in-and-out LP pays the exposure gap");

        uint256 all = hook.sharesOf(liam);
        vm.expectRevert(PredictionHook.InsufficientIdle.selector);
        vm.prank(liam);
        hook.withdraw(all);

        _warpTo(hook.marketInfo(b).expiry);
        _settle(a);
        _settle(b);
        assertEq(hook.navPlus(), hook.navMinus(), "resolved markets have one value");
        hook.sweep(a);
        hook.sweep(b);
        assertEq(hook.navPlus(), hook.navMinus());
        _checkLedger();
    }

    /* Circle blacklist */

    function test_blacklistedHolder_onlyBlocksThemselves() public {
        uint256 id = _yesWinsMarket();
        usdc.blacklist(alice, true);
        uint256 a = _balance(id, true, alice);
        IPredictionHook.MarketInfo memory i0 = hook.marketInfo(id);
        PoolKey memory k = _poolKey(id, true);
        bytes memory plan = _routerPlan(k, false, true, a);
        vm.expectRevert();
        vm.prank(alice);
        router.executeActions(plan);
        vm.expectRevert();
        vm.prank(alice);
        hook.redeem(id, a);
        assertEq(abi.encode(hook.marketInfo(id)), abi.encode(i0), "failed attempts leave the ledger unchanged");

        uint256 c = _balance(id, true, carol);
        (uint256 q, uint256 cash) = _swap(carol, id, true, false, true, c, true);
        assertEq(q, cash, "other winners redeem normally");
        hook.sweep(id);
        _checkLedger();

        usdc.blacklist(alice, false);
        vm.prank(alice);
        assertEq(hook.redeem(id, a), a, "the reserved USDC waits for Alice");
        _checkLedger();
    }
}

/// @notice INVALID fallback with a small oracle ring (16 observations), so the settlement window can be overwritten
contract BoundariesInvalidTest is BoundaryBase {
    function _oracleCardinality() internal pure override returns (uint16) {
        return 16;
    }

    function test_settleInvalid_timing_GRACE() public {
        uint256 id = _demo(100 * E6);
        _trade("Alice", alice, id, true, true, true, 5 * E6, true);
        _trade("Bob", bob, id, false, true, true, 3 * E6, true);
        _trade("Carol", carol, id, false, true, false, 2 * E6, false);
        uint64 exp = hook.marketInfo(id).expiry;
        uint256 grace = hook.GRACE();
        assertEq(grace, 3600, "keeper KEEPER_INVALID_AFTER_SEC default is GRACE + 1");

        uint256 snap = vm.snapshotState();
        _warpTo(exp + grace + 1);
        vm.expectRevert(PredictionHook.OracleAvailable.selector);
        hook.settleInvalid(id);
        _settle(id);
        vm.revertToState(snap);

        _warpTo(exp);
        for (uint256 i; i < 20; ++i) {
            _nextBlock(1);
            _steerUsd(_spotUsd() * (i % 2 == 0 ? 10_001 : 9_999) / 10_000);
        }
        assertGt(oracle.oldestObservationTime(), exp - 10, "the window has left the ring");
        vm.expectPartialRevert(IUnderlyingOracle.ObservationUnavailable.selector);
        hook.settle(id);
        _warpTo(exp + grace);
        vm.expectRevert(PredictionHook.TooEarly.selector);
        hook.settleInvalid(id);
        _warpTo(exp + grace + 1);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IPredictionHook.MarketSettled(id, false, 0, true);
        hook.settleInvalid(id);
        assertEq(uint8(hook.marketInfo(id).status), uint8(IPredictionHook.Status.Invalid));
        _checkLedger();

        _expectSwapRevert(alice, _poolKey(id, true), true, 1e6, _wrapped(PredictionHook.MarketClosed.selector));
        uint256 y = _balance(id, true, alice);
        (uint256 q, uint256 cash) = _swap(alice, id, true, false, true, y, true);
        assertEq(cash, q / 2, "YES sells at 0.5");
        uint256 nb = _balance(id, false, bob);
        (q, cash) = _swap(bob, id, false, false, true, nb, false);
        assertEq(cash, q / 2, "NO sells at 0.5");
        uint256 nc = _balance(id, false, carol);
        vm.prank(carol);
        assertEq(hook.redeem(id, nc), nc / 2, "redeem pays floor(amount / 2)");
        _checkLedger();

        hook.sweep(id);
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        assertEq(i.outYes + i.outNo, 0);
        assertEq(i.bucket, 0, "INVALID market fully unwound");
        uint256 shares = hook.sharesOf(liam);
        vm.prank(liam);
        hook.withdraw(shares);
        assertLe(usdc.balanceOf(address(manager)), 2, "only rounding stays");
        _checkLedger();
    }
}
