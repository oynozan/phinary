// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {DemoToken} from "../../src/demo/DemoToken.sol";

contract DemoTokenTest is Test {
    DemoToken weth;
    DemoToken usdc;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_790_000_000);
        weth = new DemoToken("Demo Wrapped Ether", "dWETH", 18, 1e18, 5e18, address(this));
        usdc = new DemoToken("Demo USD Coin", "dUSDC", 6, 10_000e6, 50_000e6, address(this));
    }

    function test_metadata() public view {
        assertEq(weth.name(), "Demo Wrapped Ether");
        assertEq(weth.symbol(), "dWETH");
        assertEq(weth.decimals(), 18);
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.owner(), address(this));
        assertEq(usdc.faucetPerCall(), 10_000e6);
        assertEq(usdc.faucetPerHour(), 50_000e6);
    }

    function test_ownerMintUnlimited() public {
        usdc.mint(alice, type(uint128).max);
        assertEq(usdc.balanceOf(alice), type(uint128).max);
    }

    function test_minterMint() public {
        vm.prank(bob);
        vm.expectRevert(DemoToken.NotMinter.selector);
        usdc.mint(bob, 1);

        usdc.setMinter(bob, true);
        vm.prank(bob);
        usdc.mint(alice, 1e30);
        assertEq(usdc.balanceOf(alice), 1e30);

        usdc.setMinter(bob, false);
        vm.prank(bob);
        vm.expectRevert(DemoToken.NotMinter.selector);
        usdc.mint(bob, 1);
    }

    function test_adminFunctionsOnlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(Ownable.Unauthorized.selector);
        usdc.setMinter(alice, true);
        vm.expectRevert(Ownable.Unauthorized.selector);
        usdc.setFaucetLimits(1, 1);
        vm.stopPrank();
    }

    function test_faucetPerCallCap() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DemoToken.FaucetPerCallExceeded.selector, 10_000e6 + 1, 10_000e6));
        usdc.faucet(10_000e6 + 1);

        vm.prank(alice);
        usdc.faucet(10_000e6);
        assertEq(usdc.balanceOf(alice), 10_000e6);
    }

    function test_faucetHourlyCapAndReset() public {
        vm.startPrank(alice);
        for (uint256 i; i < 5; ++i) {
            usdc.faucet(10_000e6);
        }
        assertEq(usdc.faucetRemaining(alice), 0);
        vm.expectRevert(abi.encodeWithSelector(DemoToken.FaucetHourlyExceeded.selector, 1, 0));
        usdc.faucet(1);

        vm.warp(block.timestamp + 1 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(DemoToken.FaucetHourlyExceeded.selector, 1, 0));
        usdc.faucet(1);

        vm.warp(block.timestamp + 1);
        assertEq(usdc.faucetRemaining(alice), 50_000e6);
        usdc.faucet(10_000e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice), 60_000e6);
        assertEq(usdc.faucetRemaining(alice), 40_000e6);
    }

    function test_faucetCapIsPerAddress() public {
        vm.prank(alice);
        weth.faucet(1e18);
        vm.prank(alice);
        weth.faucet(1e18);
        vm.prank(bob);
        weth.faucet(1e18);
        assertEq(weth.faucetRemaining(alice), 3e18);
        assertEq(weth.faucetRemaining(bob), 4e18);
    }

    function test_faucetPartialThenOverflowReportsRemaining() public {
        vm.startPrank(alice);
        weth.faucet(1e18);
        weth.faucet(1e18);
        weth.faucet(1e18);
        weth.faucet(0.5e18);
        weth.faucet(1e18);
        vm.expectRevert(abi.encodeWithSelector(DemoToken.FaucetHourlyExceeded.selector, 1e18, 0.5e18));
        weth.faucet(1e18);
        weth.faucet(0.5e18);
        vm.stopPrank();
        assertEq(weth.balanceOf(alice), 5e18);
    }

    function test_setFaucetLimits() public {
        usdc.setFaucetLimits(1e6, 2e6);
        vm.startPrank(alice);
        usdc.faucet(1e6);
        usdc.faucet(1e6);
        vm.expectRevert(abi.encodeWithSelector(DemoToken.FaucetHourlyExceeded.selector, 1, 0));
        usdc.faucet(1);
        vm.stopPrank();

        usdc.setFaucetLimits(0, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DemoToken.FaucetPerCallExceeded.selector, 1, 0));
        usdc.faucet(1);
    }

    function test_permit2InfiniteAllowance() public view {
        assertEq(usdc.allowance(alice, 0x000000000022D473030F116dDEE9F6B43aC78BA3), type(uint256).max);
    }

    function testFuzz_faucetNeverExceedsHourlyCap(uint256[8] memory amounts, uint256[8] memory gaps) public {
        uint256 windowStart;
        uint256 mintedInWindow;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 0, 1e18);
            vm.warp(block.timestamp + bound(gaps[i], 0, 40 minutes));
            if (mintedInWindow == 0 || block.timestamp >= windowStart + 1 hours) {
                windowStart = block.timestamp;
                mintedInWindow = 0;
            }
            vm.prank(alice);
            if (mintedInWindow + amount > 5e18) {
                vm.expectRevert();
                weth.faucet(amount);
            } else {
                weth.faucet(amount);
                mintedInWindow += amount;
            }
            assertLe(mintedInWindow, 5e18);
            assertEq(weth.faucetRemaining(alice), 5e18 - mintedInWindow);
        }
    }
}
