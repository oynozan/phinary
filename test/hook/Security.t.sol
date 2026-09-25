// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./HookFixture.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @notice Router that syncs and pays USDC before the swap and settles after it (the sync-interleaving hazard)
contract PreSyncRouter is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager internal immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function run(PoolKey calldata key, SwapParams calldata p, Currency payC, Currency outC, uint256 pay) external {
        pm.unlock(abi.encode(key, p, payC, outC, pay));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        (PoolKey memory key, SwapParams memory p, Currency payC, Currency outC, uint256 pay) =
            abi.decode(raw, (PoolKey, SwapParams, Currency, Currency, uint256));
        pm.sync(payC);
        MockUSDC(Currency.unwrap(payC)).transfer(address(pm), pay);
        pm.swap(key, p, "");
        pm.settle();
        int256 got = pm.currencyDelta(address(this), outC);
        if (got > 0) pm.take(outC, address(this), uint256(got));
        return "";
    }
}

/// @notice Liquidity, donate, foreign-initialize and direct-callback reverts, access control and parameter validation
contract SecurityTest is HookFixture {
    address internal stranger = makeAddr("stranger");

    function _hookRevert(bytes4 callback, bytes4 inner) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            callback,
            abi.encodeWithSelector(inner),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function test_permissionsMatchAddress() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize && p.beforeAddLiquidity && p.beforeRemoveLiquidity && p.beforeSwap);
        assertTrue(p.beforeSwapReturnDelta && p.beforeDonate);
        assertFalse(p.afterSwap || p.afterInitialize || p.afterSwapReturnDelta || p.afterDonate);
        assertEq(uint160(address(hook)) & 0x3fff, 0x2AA8);
    }

    function test_addLiquidityReverts() public {
        vm.expectRevert(_hookRevert(IHooks.beforeAddLiquidity.selector, PredictionHook.LiquidityDisabled.selector));
        modifyLiquidityRouter.modifyLiquidity(kYes, LIQUIDITY_PARAMS, "");
    }

    function test_removeLiquidityReverts() public {
        vm.expectRevert(_hookRevert(IHooks.beforeRemoveLiquidity.selector, PredictionHook.LiquidityDisabled.selector));
        modifyLiquidityRouter.modifyLiquidity(kNo, REMOVE_LIQUIDITY_PARAMS, "");
    }

    function test_donateReverts() public {
        vm.expectRevert(_hookRevert(IHooks.beforeDonate.selector, PredictionHook.DonateDisabled.selector));
        donateRouter.donate(kYes, 1, 1, "");
    }

    function test_foreignInitializeReverts() public {
        MockERC20 a = new MockERC20("A", "A", 18);
        (address c0, address c1) =
            address(a) < address(usdc) ? (address(a), address(usdc)) : (address(usdc), address(a));
        PoolKey memory k = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 0, 60, IHooks(address(hook)));
        vm.expectRevert(_hookRevert(IHooks.beforeInitialize.selector, PredictionHook.ForeignInitialize.selector));
        manager.initialize(k, SQRT_1_1);
        PoolKey memory k2 = PoolKey(kYes.currency0, kYes.currency1, 3000, 60, IHooks(address(hook)));
        vm.expectRevert(_hookRevert(IHooks.beforeInitialize.selector, PredictionHook.ForeignInitialize.selector));
        manager.initialize(k2, SQRT_1_1);
    }

    function test_directCallbacksRevert() public {
        SwapParams memory p = _swapParams(kYes, true, true, 1e6);
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), kYes, p, "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeInitialize(address(this), kYes, SQRT_1_1);
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeAddLiquidity(address(this), kYes, LIQUIDITY_PARAMS, "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeDonate(address(this), kYes, 1, 1, "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(stranger, uint256(1), false));
        vm.expectRevert(BaseHook.HookNotImplemented.selector);
        vm.prank(address(manager));
        hook.afterSwap(address(this), kYes, p, BalanceDelta.wrap(0), "");
    }

    function test_accessControl() public {
        IPredictionHook.MarketParams memory p = _params();
        vm.expectRevert(PredictionHook.Unauthorized.selector);
        vm.prank(stranger);
        hook.createMarket(p);
        vm.expectRevert(PredictionHook.Unauthorized.selector);
        vm.prank(stranger);
        hook.setKeeper(stranger);
        vm.prank(keeperAddr);
        uint256 id = hook.createMarket(p);
        assertEq(id, 2);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IPredictionHook.KeeperSet(stranger);
        hook.setKeeper(stranger);
        vm.expectRevert(PredictionHook.Unauthorized.selector);
        vm.prank(keeperAddr);
        hook.createMarket(p);
        assertEq(hook.owner(), address(this));
    }

    function test_createMarketValidation() public {
        IPredictionHook.MarketParams memory p = _params();
        p.kernel = 1;
        vm.expectRevert(PredictionHook.UnsupportedKernel.selector);
        hook.createMarket(p);

        p = _params();
        p.window = 0;
        _expectInvalid(p);
        p = _params();
        p.oracle = address(0);
        _expectInvalid(p);
        p = _params();
        p.quote.pMinWad = 0;
        _expectInvalid(p);
        p = _params();
        p.quote.pMinWad = 0.5e18;
        _expectInvalid(p);
        p = _params();
        p.quote.qEpochMax = 0;
        _expectInvalid(p);
        p = _params();
        p.sigmaMode = 2;
        _expectInvalid(p);
        p = _params();
        p.sigmaMode = 1;
        _expectInvalid(p);
        p = _params();
        p.expiry = uint64(block.timestamp + p.window + p.cutoffBuffer);
        _expectInvalid(p);
        p = _params();
        p.openTime = p.expiry - p.window - p.cutoffBuffer;
        _expectInvalid(p);
        p = _params();
        p.expiry = uint64(type(uint32).max) + 1;
        _expectInvalid(p);
    }

    function _expectInvalid(IPredictionHook.MarketParams memory p) internal {
        vm.expectRevert(PredictionHook.InvalidParams.selector);
        hook.createMarket(p);
    }

    function test_marketRegistry() public {
        IPredictionHook.MarketParams memory p = _params();
        vm.recordLogs();
        uint256 id = hook.createMarket(p);
        assertEq(hook.marketCount(), 2);
        (PoolKey memory ky, PoolKey memory kn) = hook.poolKeys(id);
        (uint256 m1, bool y1) = hook.marketOfPool(PoolId.unwrap(ky.toId()));
        (uint256 m2, bool y2) = hook.marketOfPool(PoolId.unwrap(kn.toId()));
        assertEq(m1, id);
        assertTrue(y1);
        assertEq(m2, id);
        assertFalse(y2);
        (uint256 m3,) = hook.marketOfPool(bytes32(uint256(123)));
        assertEq(m3, 0);
        assertEq(ky.fee, 0);
        assertEq(ky.tickSpacing, 60);
        assertEq(address(ky.hooks), address(hook));

        IPredictionHook.MarketParams memory r = hook.marketParams(id);
        assertEq(r.yesName, p.yesName);
        assertEq(r.noSymbol, p.noSymbol);
        assertEq(r.quote.lambdaWad, p.quote.lambdaWad);
        assertEq(r.budget, p.budget);
        OutcomeToken y = OutcomeToken(hook.marketInfo(id).yes);
        assertEq(y.decimals(), 6);
        assertEq(y.hook(), address(hook));
        assertEq(y.marketId(), id);
        assertTrue(y.isYes());

        vm.expectRevert(PredictionHook.UnknownMarket.selector);
        hook.marketInfo(0);
        vm.expectRevert(PredictionHook.UnknownMarket.selector);
        hook.quote(3);
    }

    function test_outcomeTokenMintOnlyHook() public {
        vm.expectRevert(OutcomeToken.OnlyHook.selector);
        yes.mint(stranger, 1);
    }

    function test_preSyncRouter_onDemandMint_failsClosed() public {
        PreSyncRouter r = new PreSyncRouter(manager);
        usdc.mint(address(r), 1_000 * E6);
        uint256 b0 = hook.marketInfo(mId).bucket;
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        r.run(
            kYes,
            _swapParams(kYes, true, true, 100 * E6),
            Currency.wrap(address(usdc)),
            Currency.wrap(address(yes)),
            100 * E6
        );
        assertEq(hook.marketInfo(mId).bucket, b0);
    }

    function test_preSyncRouter_inventoryPath_works() public {
        _poolSwap(trader, kYes, true, false, 1_000 * E6);
        _poolSwap(trader, kYes, false, true, 1_000 * E6);
        vm.warp(block.timestamp + 1);
        PreSyncRouter r = new PreSyncRouter(manager);
        usdc.mint(address(r), 1_000 * E6);
        (uint256 q,) = _expect(mId, true, true, true, 100 * E6);
        r.run(
            kYes,
            _swapParams(kYes, true, true, 100 * E6),
            Currency.wrap(address(usdc)),
            Currency.wrap(address(yes)),
            100 * E6
        );
        assertEq(yes.balanceOf(address(r)), q);
        _checkInvariants();
    }
}
