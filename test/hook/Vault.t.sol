// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./HookFixture.sol";

/// @notice LP vault deposits at NAV+ and withdrawals at NAV- from idle only, safe against donations and first depositors
contract VaultTest is HookFixture {
    address internal lp2 = makeAddr("lp2");
    address internal attacker = makeAddr("attacker");

    function _skewBook() internal {
        _poolSwap(trader, kYes, true, false, 8_000 * E6);
        _poolSwap(trader, kNo, true, false, 3_000 * E6);
        vm.warp(block.timestamp + 1);
    }

    function test_firstDepositShares() public view {
        assertEq(hook.sharesOf(lp), 1_000_000 * E6 * 1e6, "assets * 1e6 / 1 at NAV+ = 0");
        assertEq(hook.totalShares(), hook.sharesOf(lp));
        assertEq(hook.vaultIdle(), 900_000 * E6);
        assertEq(hook.navPlus(), 1_000_000 * E6);
        assertEq(hook.navMinus(), 1_000_000 * E6);
    }

    function test_createMarketMovesBudget_navNeutral() public {
        uint256 idle0 = hook.vaultIdle();
        uint256 plus0 = hook.navPlus();
        uint256 id = hook.createMarket(_params());
        assertEq(hook.vaultIdle(), idle0 - 100_000 * E6);
        assertEq(hook.marketInfo(id).bucket, 100_000 * E6);
        assertEq(hook.navPlus(), plus0);
        assertEq(hook.navMinus(), plus0);
        IPredictionHook.MarketParams memory p = _params();
        p.budget = hook.vaultIdle() + 1;
        vm.expectRevert(PredictionHook.InsufficientIdle.selector);
        hook.createMarket(p);
    }

    function test_navAggregates_trackBook() public {
        _skewBook();
        IPredictionHook.MarketInfo memory i = hook.marketInfo(mId);
        assertEq(i.outYes, 8_000 * E6);
        assertEq(i.outNo, 3_000 * E6);
        assertEq(hook.navPlus(), hook.vaultIdle() + i.bucket - i.outNo, "best case");
        assertEq(hook.navMinus(), hook.vaultIdle() + i.bucket - i.outYes, "worst case");
        _checkInvariants();
    }

    function test_depositAtNavPlus_withdrawAtNavMinus() public {
        _skewBook();
        uint256 ts = hook.totalShares();
        uint256 plus = hook.navPlus();
        uint256 shares = _deposit(lp2, 50_000 * E6);
        assertEq(shares, 50_000 * E6 * (ts + 1e6) / (plus + 1));
        uint256 minus = hook.navMinus();
        ts = hook.totalShares();
        vm.prank(lp2);
        uint256 assets = hook.withdraw(shares);
        assertEq(assets, shares * (minus + 1) / (ts + 1e6));
        assertLt(assets, 50_000 * E6, "round trip pays the NAV+/NAV- gap");
        assertEq(usdc.balanceOf(lp2), assets);
        _checkInvariants();
    }

    function test_depositWithdrawRoundTrip_neverProfits_fuzz(uint256 a, uint256 yBuy, uint256 nBuy, bool settleFirst)
        public
    {
        a = bound(a, 1, 10_000_000 * E6);
        yBuy = bound(yBuy, 0, 20_000 * E6);
        nBuy = bound(nBuy, 0, 20_000 * E6);
        if (yBuy != 0) _poolSwap(trader, kYes, true, false, yBuy);
        vm.warp(block.timestamp + 1);
        if (nBuy != 0) _poolSwap(trader, kNo, true, false, nBuy);
        if (settleFirst) {
            vm.warp(hook.marketInfo(mId).expiry);
            hook.settle(mId);
            hook.sweep(mId);
        }
        usdc.mint(lp2, a);
        vm.startPrank(lp2);
        usdc.approve(address(hook), a);
        uint256 shares;
        try hook.deposit(a) returns (uint256 s) {
            shares = s;
        } catch {
            vm.stopPrank();
            return;
        }
        if (hook.vaultIdle() >= shares * (hook.navMinus() + 1) / (hook.totalShares() + 1e6)) {
            try hook.withdraw(shares) {} catch {}
        }
        vm.stopPrank();
        assertLe(usdc.balanceOf(lp2), a, "no profit from deposit + withdraw");
        _checkInvariants();
    }

    function test_withdrawOnlyFromIdle() public {
        IPredictionHook.MarketParams memory p = _params();
        p.budget = hook.vaultIdle();
        hook.createMarket(p);
        assertEq(hook.vaultIdle(), 0);
        uint256 s = hook.sharesOf(lp);
        vm.expectRevert(PredictionHook.InsufficientIdle.selector);
        vm.prank(lp);
        hook.withdraw(s / 10);
        vm.expectRevert(PredictionHook.InsufficientShares.selector);
        vm.prank(lp);
        hook.withdraw(s + 1);
        vm.expectRevert(PredictionHook.ZeroAmount.selector);
        vm.prank(lp);
        hook.withdraw(0);
        vm.expectRevert(PredictionHook.ZeroAmount.selector);
        vm.prank(lp);
        hook.deposit(0);
    }

    function test_settleMovesNavTowardsOutcome_sweepNeutral() public {
        _skewBook();
        uint256 plus0 = hook.navPlus();
        uint256 minus0 = hook.navMinus();
        oracle.setFlatTick(90_000);
        vm.warp(hook.marketInfo(mId).expiry);
        hook.settle(mId);
        assertEq(hook.navMinus(), minus0, "YES (the larger side) won: worst case realised");
        assertLt(hook.navPlus(), plus0);
        assertEq(hook.navPlus(), hook.navMinus());
        uint256 plus1 = hook.navPlus();
        hook.sweep(mId);
        assertEq(hook.navPlus(), plus1);
        _checkInvariants();
    }

    function test_donationsDoNotMoveSharePrice() public {
        _skewBook();
        uint256 plus0 = hook.navPlus();
        uint256 minus0 = hook.navMinus();
        usdc.mint(attacker, 500_000 * E6);
        vm.prank(attacker);
        usdc.transfer(address(hook), 100_000 * E6);
        _giveClaims(attacker, 200_000 * E6);
        vm.prank(attacker);
        manager.transfer(address(hook), uint160(address(usdc)), 200_000 * E6);
        assertEq(hook.navPlus(), plus0);
        assertEq(hook.navMinus(), minus0);
        uint256 ts = hook.totalShares();
        assertEq(_deposit(lp2, 1_000 * E6), 1_000 * E6 * (ts + 1e6) / (plus0 + 1));
        uint256 sumBucket = hook.marketInfo(mId).bucket;
        assertLe(sumBucket + hook.vaultIdle(), manager.balanceOf(address(hook), uint160(address(usdc))));
    }

    function test_firstDepositorInflationAttack_fails() public {
        address h2 = address(FLAGS | (uint160(0x5555) << 144));
        deployCodeTo("src/PredictionHook.sol:PredictionHook", abi.encode(manager, address(usdc), address(this)), h2);
        PredictionHook fresh = PredictionHook(h2);
        usdc.mint(attacker, 1_000_001 * E6);
        vm.startPrank(attacker);
        usdc.approve(address(fresh), 1);
        uint256 aShares = fresh.deposit(1);
        usdc.transfer(address(fresh), 500_000 * E6);
        vm.stopPrank();
        _giveClaims(attacker, 500_000 * E6);
        vm.prank(attacker);
        manager.transfer(address(fresh), uint160(address(usdc)), 500_000 * E6);
        assertEq(fresh.navPlus(), 1, "donations are not NAV");

        usdc.mint(lp2, 1_000 * E6);
        vm.startPrank(lp2);
        usdc.approve(address(fresh), 1_000 * E6);
        uint256 vShares = fresh.deposit(1_000 * E6);
        uint256 back = fresh.withdraw(vShares);
        vm.stopPrank();
        assertGe(back + 1, 1_000 * E6, "victim loses at most 1 unit");
        vm.prank(attacker);
        assertLe(fresh.withdraw(aShares), 1);
    }

    /// @dev Moves `amt` of USDC into PoolManager claims owned by `who`
    function _giveClaims(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(claimsRouter), amt);
        claimsRouter.deposit(Currency.wrap(address(usdc)), who, amt);
        vm.stopPrank();
    }
}
