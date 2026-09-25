// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./HookFixture.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";

/// @notice Holds an unlock open and calls back into the hook from inside it
contract UnlockReentrant is IUnlockCallback {
    IPoolManager internal immutable pm;
    PredictionHook internal immutable hook;
    MockUSDC internal immutable usdc;

    constructor(IPoolManager pm_, PredictionHook hook_, MockUSDC usdc_) {
        pm = pm_;
        hook = hook_;
        usdc = usdc_;
        usdc_.approve(address(hook_), type(uint256).max);
    }

    function depositOutside(uint256 amt) external returns (uint256) {
        return hook.deposit(amt);
    }

    function run(bytes calldata call) external {
        pm.unlock(call);
    }

    function unlockCallback(bytes calldata call) external returns (bytes memory) {
        (bool ok, bytes memory ret) = address(hook).call(call);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return "";
    }
}

/// @notice Oracle whose spot read tries to re-enter the hook (mode 1) or checks that hook views are pre-trade (mode 2)
contract ProbeOracle {
    PredictionHook public hook;
    int256 public lnSpot;
    uint256 public varE36;
    uint8 public mode;
    uint256 public marketId;
    uint256 public wantBucket;
    uint256 public wantNavPlus;
    uint256 public wantNavMinus;
    uint256 public wantOutYes;

    function set(PredictionHook h, int256 s, uint256 v) external {
        hook = h;
        lnSpot = s;
        varE36 = v;
    }

    function arm(uint8 mode_, uint256 id) external {
        mode = mode_;
        marketId = id;
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        wantBucket = i.bucket;
        wantOutYes = i.outYes;
        wantNavPlus = hook.navPlus();
        wantNavMinus = hook.navMinus();
    }

    function lnSpotSoBWad() external returns (int256) {
        if (mode == 1) hook.deposit(1);
        if (mode == 2) {
            IPredictionHook.MarketInfo memory i = hook.marketInfo(marketId);
            require(i.bucket == wantBucket && i.outYes == wantOutYes, "mid-state bucket");
            require(hook.navPlus() == wantNavPlus && hook.navMinus() == wantNavMinus, "mid-state nav");
        }
        return lnSpot;
    }

    function varianceE36() external view returns (uint256, bool) {
        return (varE36, true);
    }

    function decimalsShift() external pure returns (int16) {
        return 0;
    }

    function cumulativeAt(uint32 t) external pure returns (int56) {
        return int56(uint56(t)) * 80_000;
    }
}

/// @notice T24: no re-entry from an unlock callback or from an oracle read, and views are consistent during the swap
contract ReentrancyTest is HookFixture {
    UnlockReentrant internal attacker;

    function setUp() public override {
        super.setUp();
        attacker = new UnlockReentrant(manager, hook, usdc);
        usdc.mint(address(attacker), 1_000_000 * E6);
        attacker.depositOutside(10_000 * E6);
    }

    function test_vaultCallsInsideUnlock_revert() public {
        uint256 idle = hook.vaultIdle();
        uint256 ts = hook.totalShares();
        vm.expectRevert(IPoolManager.AlreadyUnlocked.selector);
        attacker.run(abi.encodeCall(PredictionHook.deposit, (1_000 * E6)));
        uint256 shares = hook.sharesOf(address(attacker));
        vm.expectRevert(IPoolManager.AlreadyUnlocked.selector);
        attacker.run(abi.encodeCall(PredictionHook.withdraw, (shares)));
        assertEq(hook.vaultIdle(), idle);
        assertEq(hook.totalShares(), ts);
        assertEq(hook.sharesOf(address(attacker)), shares);
    }

    function test_redeemInsideUnlock_reverts() public {
        _poolSwap(trader, kYes, true, false, 1_000 * E6);
        vm.prank(trader);
        yes.transfer(address(attacker), 1_000 * E6);
        oracle.setFlatTick(81_000);
        vm.warp(hook.marketInfo(mId).expiry);
        hook.settle(mId);
        assertTrue(hook.marketInfo(mId).yesWon);
        uint256 bucket = hook.marketInfo(mId).bucket;
        vm.expectRevert(IPoolManager.AlreadyUnlocked.selector);
        attacker.run(abi.encodeCall(PredictionHook.redeem, (mId, 1_000 * E6)));
        assertEq(hook.marketInfo(mId).bucket, bucket);
        assertEq(yes.balanceOf(address(attacker)), 1_000 * E6);
        _checkInvariants();
    }

    function test_unlockCallbackOnlyFromPoolManager() public {
        vm.expectRevert();
        hook.unlockCallback(abi.encode(address(this), uint256(1), false));
    }

    function _probeMarket() internal returns (ProbeOracle o, uint256 id, PoolKey memory ky) {
        o = new ProbeOracle();
        o.set(hook, lnK, VAR_60);
        IPredictionHook.MarketParams memory p = _params();
        p.oracle = address(o);
        id = hook.createMarket(p);
        OutcomeToken y;
        OutcomeToken n;
        (y, n, ky,) = _market(id);
        _approveTokens(trader, y, n);
    }

    function test_oracleCannotReenter_swapPathIsStaticcall() public {
        (ProbeOracle o, uint256 id, PoolKey memory ky) = _probeMarket();
        o.arm(1, id);
        uint256 idle = hook.vaultIdle();
        uint256 bucket = hook.marketInfo(id).bucket;
        SwapParams memory sp = _swapParams(ky, true, true, 100 * E6);
        PoolSwapTest.TestSettings memory ts = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        vm.expectRevert(_wrapped(bytes("")));
        vm.prank(trader);
        swapRouter.swap{gas: 5_000_000}(ky, sp, ts, "");
        assertEq(hook.vaultIdle(), idle);
        assertEq(hook.marketInfo(id).bucket, bucket);
    }

    function test_viewsArePreTradeDuringOracleRead() public {
        (ProbeOracle o, uint256 id, PoolKey memory ky) = _probeMarket();
        _poolSwap(trader, ky, true, false, 500 * E6);
        o.arm(2, id);
        _poolSwap(trader, ky, true, false, 700 * E6);
        assertEq(hook.marketInfo(id).outYes, 1_200 * E6);
        o.arm(2, id);
        _poolSwap(trader, ky, false, true, 300 * E6);
        assertEq(hook.marketInfo(id).outYes, 900 * E6);
        _checkInvariants();
    }
}
