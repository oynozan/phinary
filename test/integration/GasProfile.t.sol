// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./StackFixture.sol";

/// @notice Execution gas of each demo operation on the real stack, with the touched contracts' storage cooled first
///         (a fresh transaction), logged as a table and bounded so regressions show up. Excludes the 21k base cost.
contract GasProfileTest is StackFixture {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        _fundUsdc(liam, 1_000 * E6);
        _deposit(liam, 1_000 * E6);
        _fundUsdc(alice, 100 * E6);
        _fundUsdc(bob, 100 * E6);
        _nextBlock(1);
    }

    function _cool() internal {
        vm.cool(address(manager));
        vm.cool(address(hook));
        vm.cool(address(oracle));
        vm.cool(address(steerer));
        vm.cool(address(router));
        vm.cool(address(swapRouter));
        vm.cool(CIRCLE_USDC);
        vm.cool(address(weth));
        vm.cool(address(dusdc));
        if (id != 0) {
            IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
            vm.cool(i.yes);
            vm.cool(i.no);
        }
    }

    function _row(string memory what, uint256 gas, uint256 bound) internal pure {
        console2.log(string.concat("  ", what, ": ", vm.toString(gas)));
        assertLt(gas, bound, what);
    }

    function _gasSwap(address who, bool isYes, bool isBuy, bool exactIn, uint256 amt, bool useRouter)
        internal
        returns (uint256 used)
    {
        PoolKey memory k = _poolKey(id, isYes);
        bytes memory plan = _routerPlan(k, isBuy, exactIn, amt);
        SwapParams memory sp = _swapParams(k, isBuy, exactIn, amt);
        PoolSwapTest.TestSettings memory ts = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        _cool();
        vm.prank(who);
        uint256 g = gasleft();
        if (useRouter) router.executeActions(plan);
        else swapRouter.swap(k, sp, ts, "");
        used = g - gasleft();
    }

    function test_gasProfile_demoLifecycle() public {
        console2.log("execution gas, cold storage (demo market: 60 s, window 10 s, oracle sigma)");
        IPredictionHook.MarketParams memory p = _demoParams();
        _cool();
        vm.prank(keeper);
        uint256 g = gasleft();
        id = hook.createMarket(p);
        _row("keeper createMarket (2 tokens + 2 pools)", g - gasleft(), 3_000_000);
        _approveOutcomes(alice, id);
        _approveOutcomes(bob, id);

        _nextBlock(1);
        uint160 target = _sqrtPriceForUsd(2701e18);
        _cool();
        vm.prank(mirror);
        g = gasleft();
        steerer.steer(ethKey, target);
        _row("mirror steer, first in block (oracle write)", g - gasleft(), 300_000);
        target = _sqrtPriceForUsd(2702e18);
        _cool();
        vm.prank(mirror);
        g = gasleft();
        steerer.steer(ethKey, target);
        _row("mirror steer, same block", g - gasleft(), 250_000);

        _nextBlock(1);
        _row("buy YES exact-in, V4Router (mint on demand)", _gasSwap(alice, true, true, true, 5 * E6, true), 450_000);
        _row("buy NO exact-out, PoolSwapTest", _gasSwap(bob, false, true, false, 3 * E6, false), 450_000);
        _row("sell YES exact-in, V4Router (to inventory)", _gasSwap(alice, true, false, true, 1 * E6, true), 450_000);
        _row("buy YES exact-out, V4Router (from inventory)", _gasSwap(bob, true, true, false, 1 * E6, true), 450_000);
        IV4Quoter.QuoteExactSingleParams memory qp = IV4Quoter.QuoteExactSingleParams({
            poolKey: _poolKey(id, true),
            zeroForOne: _swapParams(_poolKey(id, true), true, true, 1e6).zeroForOne,
            exactAmount: 1e6,
            hookData: ""
        });
        (, uint256 qg) = quoter.quoteExactInputSingle(qp);
        _row("V4Quoter gasEstimate, buy YES", qg, 450_000);

        _warpTo(p.expiry);
        _cool();
        g = gasleft();
        hook.settle(id);
        _row("settle (two cumulativeAt reads)", g - gasleft(), 150_000);
        bool yesWon = hook.marketInfo(id).yesWon;
        address winner = yesWon ? alice : bob;
        uint256 bal = _outcome(id, yesWon).balanceOf(winner);
        _row("redeem via swap at 1.0, V4Router", _gasSwap(winner, yesWon, false, true, bal / 2, true), 350_000);
        bal = _outcome(id, yesWon).balanceOf(winner);
        _cool();
        vm.prank(winner);
        g = gasleft();
        hook.redeem(id, bal);
        _row("redeem() direct", g - gasleft(), 250_000);
        _cool();
        g = gasleft();
        hook.sweep(id);
        _row("sweep", g - gasleft(), 100_000);
        uint256 shares = hook.sharesOf(liam);
        _cool();
        vm.prank(liam);
        g = gasleft();
        hook.withdraw(shares);
        _row("LP withdraw", g - gasleft(), 250_000);
    }
}
