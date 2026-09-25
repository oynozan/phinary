// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./Base.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {MockV4Router} from "v4-periphery/test/mocks/MockV4Router.sol";
import {Planner, Plan} from "v4-periphery/test/shared/Planner.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";

/// Router that calls sync(USDC) and transfers BEFORE swap and settles AFTER it (06 §1.3 / T23 hazard).
contract PreSyncRouter is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager immutable pm;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    struct Data {
        PoolKey key;
        SwapParams p;
        Currency payC;
        Currency outC;
        uint256 pay;
        bool repayIfUnsettled;
    }

    function run(Data calldata d) external {
        pm.unlock(abi.encode(d));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        Data memory d = abi.decode(raw, (Data));
        pm.sync(d.payC); // pending sync ...
        MockUSDC(Currency.unwrap(d.payC)).transfer(address(pm), d.pay); // ... and transfer, before the swap
        BalanceDelta bd = pm.swap(d.key, d.p, "");
        pm.settle(); // expects to be credited `pay` in payC
        int256 owed = pm.currencyDelta(address(this), d.payC);
        if (owed < 0 && d.repayIfUnsettled) {
            // a "defensive" router that pays again atomically
            pm.sync(d.payC);
            MockUSDC(Currency.unwrap(d.payC)).transfer(address(pm), uint256(-owed));
            pm.settle();
        }
        int256 got = pm.currencyDelta(address(this), d.outC);
        if (got > 0) pm.take(d.outC, address(this), uint256(got));
        bd;
        return "";
    }
}

/// Attacker that donates YES into the PM under its own pending sync(YES), then buys YES (on-demand path).
contract DonateThenBuy is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager immutable pm;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    struct Data {
        PoolKey key;
        SwapParams p;
        Currency yesC;
        Currency usdcC;
        uint256 donate;
    }

    function run(Data calldata d) external {
        pm.unlock(abi.encode(d));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        Data memory d = abi.decode(raw, (Data));
        pm.sync(d.yesC);
        MockUSDC(Currency.unwrap(d.yesC)).transfer(address(pm), d.donate); // same ERC20 interface
        pm.swap(d.key, d.p, "");
        uint256 credited = pm.settle(); // tries to get credited for the donation after the hook's sync/settle
        require(credited == 0, "attacker got credited");
        int256 owe = pm.currencyDelta(address(this), d.usdcC);
        pm.sync(d.usdcC);
        MockUSDC(Currency.unwrap(d.usdcC)).transfer(address(pm), uint256(-owe));
        pm.settle();
        int256 got = pm.currencyDelta(address(this), d.yesC);
        pm.take(d.yesC, address(this), uint256(got));
        return "";
    }
}

contract AccountingTest is ProtoBase {
    using TransientStateLibrary for IPoolManager;

    bytes32 constant TRADE_SIG =
        keccak256("Trade(uint256,bool,bool,bool,uint256,uint256,uint256,uint256,int256)");

    struct Row {
        string label;
        bool isYes;
        bool buying;
        bool exactIn;
        uint256 amt;
    }

    function _rows() internal pure returns (Row[] memory r) {
        r = new Row[](12);
        r[0] = Row("1 buy YES exact-in 200 USDC", true, true, true, 200 * E6);
        r[1] = Row("2 buy YES exact-out 250 YES", true, true, false, 250 * E6);
        r[2] = Row("3 sell YES exact-in 250 YES", true, false, true, 250 * E6);
        r[3] = Row("4 sell YES exact-out 100 USDC", true, false, false, 100 * E6);
        r[4] = Row("5 buy YES exact-out 250 YES (from inventory)", true, true, false, 250 * E6);
        r[5] = Row("6 buy YES exact-in 300 USDC (inventory + mint)", true, true, true, 300 * E6);
        r[6] = Row("7 buy NO exact-in 200 USDC", false, true, true, 200 * E6);
        r[7] = Row("8 buy NO exact-out 250 NO", false, true, false, 250 * E6);
        r[8] = Row("9 sell NO exact-in 250 NO", false, false, true, 250 * E6);
        r[9] = Row("10 sell NO exact-out 100 USDC", false, false, false, 100 * E6);
        r[10] = Row("11 buy NO exact-in 100 USDC (from inventory)", false, true, true, 100 * E6);
        r[11] = Row("12 sell YES exact-in 1 unit (dust -> ZeroAmount)", true, false, true, 1);
    }

    function _table(bool outcomeIs0) internal {
        _deploy(PredictionHookProto.Mode.OnDemand, outcomeIs0);
        Row[] memory r = _rows();
        console.log("ordering: outcome is currency%s", outcomeIs0 ? "0" : "1");
        for (uint256 i; i < r.length; ++i) {
            PoolKey memory k = r[i].isYes ? kYes : kNo;
            SwapParams memory p = _params(k, r[i].buying, r[i].exactIn, r[i].amt);
            uint256 u0 = usdc.balanceOf(trader);
            OutcomeToken t = r[i].isYes ? yes : no;
            uint256 t0 = t.balanceOf(trader);
            if (i == 11) {
                vm.prank(trader);
                vm.expectRevert(); // wrapped PredictionHookProto.ZeroAmount (0.39 * 1 unit floors to 0)
                swapRouter.swap(k, p, PoolSwapTest.TestSettings(false, false), "");
                continue;
            }
            vm.recordLogs();
            vm.prank(trader);
            BalanceDelta cd = swapRouter.swap(k, p, PoolSwapTest.TestSettings(false, false), "");
            uint256 gasUsed = vm.lastCallGas().gasTotalUsed;
            Vm.Log[] memory logs = vm.getRecordedLogs();
            (,,, uint256 q, uint256 cash, uint256 fromInv, uint256 minted, int256 bsd) = _trade(logs);
            // caller delta == -hookDelta; trader balances moved by exactly the caller delta
            int256 dUsdc = int256(usdc.balanceOf(trader)) - int256(u0);
            int256 dOut = int256(t.balanceOf(trader)) - int256(t0);
            bool usdcIs0 = Currency.unwrap(k.currency0) == address(usdc);
            assertEq(dUsdc, usdcIs0 ? int256(cd.amount0()) : int256(cd.amount1()), "usdc moved == caller delta");
            assertEq(dOut, usdcIs0 ? int256(cd.amount1()) : int256(cd.amount0()), "outcome moved == caller delta");
            assertEq(r[i].buying ? -dUsdc : dUsdc, int256(cash));
            assertEq(r[i].buying ? dOut : -dOut, int256(q));
            assertEq(manager.getNonzeroDeltaCount(), 0);
            _checkInvariants();
            console.log(
                string.concat(
                    r[i].label,
                    " | zf1=",
                    p.zeroForOne ? "T" : "F",
                    " amtSpec=",
                    vm.toString(p.amountSpecified),
                    " | q=",
                    vm.toString(q),
                    " usdc=",
                    vm.toString(cash)
                )
            );
            console.log(
                string.concat(
                    "    BSD=",
                    vm.toString(bytes32(uint256(bsd))),
                    " spec=",
                    vm.toString(int256(bsd >> 128)),
                    " unspec=",
                    vm.toString(int256(int128(bsd)))
                )
            );
            console.log(
                string.concat(
                    "    callerDelta(a0,a1)=(",
                    vm.toString(int256(cd.amount0())),
                    ",",
                    vm.toString(int256(cd.amount1())),
                    ") fromInv=",
                    vm.toString(fromInv),
                    " minted=",
                    vm.toString(minted),
                    " gas=",
                    vm.toString(gasUsed)
                )
            );
        }
        (,, uint256 bucket, uint256 invY, uint256 invN, uint256 outY, uint256 outN,,,,) = hook.markets(mId);
        console.log("end: bucket=%s invY=%s invN=%s", bucket, invY, invN);
        console.log("     outY=%s outN=%s", outY, outN);
        console.log("     YES.supply=%s NO.supply=%s", yes.totalSupply(), no.totalSupply());
    }

    function _trade(Vm.Log[] memory logs)
        internal
        pure
        returns (bool, bool, bool, uint256, uint256, uint256, uint256, int256)
    {
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].topics[0] == TRADE_SIG) {
                return abi.decode(logs[j].data, (bool, bool, bool, uint256, uint256, uint256, uint256, int256));
            }
        }
        revert("no Trade event");
    }

    function test_deltaTable_outcomeIsCurrency0() public {
        _table(true);
    }

    function test_deltaTable_outcomeIsCurrency1() public {
        _table(false);
    }

    // ---------------------------------------------------------------------------------------------
    // Standard periphery router (V4Router actions) for all 8 cases, both orderings
    // ---------------------------------------------------------------------------------------------

    function _v4swap(MockV4Router r, PoolKey memory k, bool buying, bool exactIn, uint256 amt) internal {
        SwapParams memory p = _params(k, buying, exactIn, amt);
        Currency inC = p.zeroForOne ? k.currency0 : k.currency1;
        Currency outC = p.zeroForOne ? k.currency1 : k.currency0;
        Plan memory plan = Planner.init();
        if (exactIn) {
            plan = plan.add(
                Actions.SWAP_EXACT_IN_SINGLE,
                abi.encode(IV4Router.ExactInputSingleParams(k, p.zeroForOne, uint128(amt), 0, 0, ""))
            );
        } else {
            plan = plan.add(
                Actions.SWAP_EXACT_OUT_SINGLE,
                abi.encode(IV4Router.ExactOutputSingleParams(k, p.zeroForOne, uint128(amt), type(uint128).max, 0, ""))
            );
        }
        plan = plan.add(Actions.SETTLE_ALL, abi.encode(inC, type(uint256).max));
        plan = plan.add(Actions.TAKE_ALL, abi.encode(outC, 0));
        vm.prank(trader);
        r.executeActions(plan.encode());
        _checkInvariants();
    }

    function _v4all(bool outcomeIs0) internal {
        _deploy(PredictionHookProto.Mode.OnDemand, outcomeIs0);
        MockV4Router r = new MockV4Router(manager);
        vm.startPrank(trader);
        usdc.approve(address(r), type(uint256).max);
        yes.approve(address(r), type(uint256).max);
        no.approve(address(r), type(uint256).max);
        vm.stopPrank();
        for (uint256 s; s < 2; ++s) {
            PoolKey memory k = s == 0 ? kYes : kNo;
            _v4swap(r, k, true, true, 200 * E6);
            _v4swap(r, k, true, false, 250 * E6);
            _v4swap(r, k, false, true, 250 * E6);
            _v4swap(r, k, false, false, 100 * E6);
        }
        assertEq(usdc.balanceOf(address(r)), 0);
        assertEq(yes.balanceOf(address(r)), 0);
    }

    function test_v4Router_all8_outcome0() public {
        _v4all(true);
    }

    function test_v4Router_all8_outcome1() public {
        _v4all(false);
    }

    // ---------------------------------------------------------------------------------------------
    // (b) inventory-only mode = hard capacity limit
    // ---------------------------------------------------------------------------------------------

    function test_inventoryOnly_capacityLimit() public {
        _deploy(PredictionHookProto.Mode.InventoryOnly, true);
        // no inventory -> any buy reverts
        PoolKey memory k = kYes;
        SwapParams memory p = _params(k, true, true, 10 * E6);
        vm.prank(trader);
        vm.expectRevert();
        swapRouter.swap(k, p, PoolSwapTest.TestSettings(false, false), "");
        // pre-mint complete sets of inventory (06 §9.4a): 1000 YES + 1000 NO claims
        hook.restock(mId, true, 1000 * E6);
        hook.restock(mId, false, 1000 * E6);
        _checkInvariants();
        _swap(true, true, false, 1000 * E6); // exactly the inventory: OK
        _checkInvariants();
        p = _params(k, true, false, 1);
        vm.prank(trader);
        vm.expectRevert(); // inventory exhausted although the bucket could cover 1M more
        swapRouter.swap(k, p, PoolSwapTest.TestSettings(false, false), "");
        // physical complete-set identity holds in this mode: supply(YES)==supply(NO)==sets minted
        assertEq(yes.totalSupply(), 1000 * E6);
        assertEq(no.totalSupply(), 1000 * E6);
    }

    // ---------------------------------------------------------------------------------------------
    // (e) sync-interleaving hazard (06 §1.3 / T23)
    // ---------------------------------------------------------------------------------------------

    function _preSync(bool repay) internal returns (PreSyncRouter r, PreSyncRouter.Data memory d) {
        r = new PreSyncRouter(manager);
        usdc.mint(address(r), 1_000 * E6);
        d = PreSyncRouter.Data({
            key: kYes,
            p: _params(kYes, true, true, 100 * E6),
            payC: Currency.wrap(address(usdc)),
            outC: Currency.wrap(address(yes)),
            pay: 100 * E6,
            repayIfUnsettled: repay
        });
    }

    function test_T23_preSync_onDemandMint_failsClosed() public {
        _deploy(PredictionHookProto.Mode.OnDemand, true);
        (PreSyncRouter r, PreSyncRouter.Data memory d) = _preSync(false);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        r.run(d);
        _checkInvariants();
    }

    function test_T23_preSync_inventoryPath_works() public {
        _deploy(PredictionHookProto.Mode.OnDemand, true);
        hook.restock(mId, true, 1_000 * E6); // enough inventory -> no sync inside beforeSwap
        (PreSyncRouter r, PreSyncRouter.Data memory d) = _preSync(false);
        r.run(d);
        assertEq(yes.balanceOf(address(r)), uint256(100 * E6) * 1e18 / 0.41e18);
        _checkInvariants();
    }

    function test_T23_preSync_inventoryOnlyMode_works() public {
        _deploy(PredictionHookProto.Mode.InventoryOnly, false);
        hook.restock(mId, true, 1_000 * E6);
        (PreSyncRouter r, PreSyncRouter.Data memory d) = _preSync(false);
        r.run(d);
        _checkInvariants();
    }

    function test_T23_preSync_repayingRouter_selfHarmOnly() public {
        _deploy(PredictionHookProto.Mode.OnDemand, true);
        (PreSyncRouter r, PreSyncRouter.Data memory d) = _preSync(true);
        uint256 pmBefore = usdc.balanceOf(address(manager));
        uint256 bucketBefore = hook.totalBuckets();
        r.run(d);
        // hook/LP credited EXACTLY the trade cash, never the orphaned first transfer
        assertEq(hook.totalBuckets() - bucketBefore, 100 * E6, "hook credited exactly cash");
        // router paid twice; first 100 USDC is an orphan surplus in the PM, owned by no claim
        assertEq(usdc.balanceOf(address(r)), 800 * E6, "router paid 2x");
        assertEq(usdc.balanceOf(address(manager)) - pmBefore, 200 * E6);
        assertEq(usdc.balanceOf(address(manager)) - manager.balanceOf(address(hook), uint160(address(usdc))), 100 * E6);
        _checkInvariants();
        // nobody can claim the orphan: a fresh sync snapshots it, settle credits 0 -> take reverts / CurrencyNotSettled
        OrphanClaimer c = new OrphanClaimer(manager);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        c.run(Currency.wrap(address(usdc)), 100 * E6);
    }

    function test_T23_donateSameCurrency_hookNotMisCredited() public {
        _deploy(PredictionHookProto.Mode.OnDemand, true);
        // attacker acquires 50 YES normally
        DonateThenBuy a = new DonateThenBuy(manager);
        usdc.mint(address(a), 1_000 * E6);
        _swap(true, true, false, 50 * E6);
        vm.prank(trader);
        yes.transfer(address(a), 50 * E6);
        uint256 supplyBefore = yes.totalSupply();
        vm.recordLogs();
        a.run(
            DonateThenBuy.Data({
                key: kYes,
                p: _params(kYes, true, true, 100 * E6),
                yesC: Currency.wrap(address(yes)),
                usdcC: Currency.wrap(address(usdc)),
                donate: 50 * E6
            })
        );
        (,,, uint256 q,,, uint256 minted,) = _trade(vm.getRecordedLogs());
        // hook minted exactly q on demand; settle credited the hook exactly `minted`, the donation is orphaned
        assertEq(minted, q);
        assertEq(yes.totalSupply() - supplyBefore, q);
        assertEq(yes.balanceOf(address(a)), q, "attacker received only q");
        assertEq(yes.balanceOf(address(manager)), 50 * E6, "donated YES orphaned in PM");
        _checkInvariants(); // outYes still == supply - inv (orphan counted as outstanding: conservative)
    }

    // ---------------------------------------------------------------------------------------------
    // Users holding outcome tokens as ERC-6909 claims (takeClaims / settleUsingBurn)
    // ---------------------------------------------------------------------------------------------
    function test_userClaims_roundTrip() public {
        _deploy(PredictionHookProto.Mode.OnDemand, false);
        PoolKey memory k = kYes;
        vm.prank(trader);
        swapRouter.swap(k, _params(k, true, true, 100 * E6), PoolSwapTest.TestSettings(true, false), "");
        uint256 cl = manager.balanceOf(trader, uint160(address(yes)));
        assertGt(cl, 0);
        _checkInvariants(); // outstanding includes the user's claims (backed by ERC20 in the PM)
        vm.prank(trader);
        manager.setOperator(address(swapRouter), true);
        vm.prank(trader);
        swapRouter.swap(k, _params(k, false, true, cl), PoolSwapTest.TestSettings(false, true), "");
        assertEq(manager.balanceOf(trader, uint160(address(yes))), 0);
        _checkInvariants();
    }

    // ---------------------------------------------------------------------------------------------
    // Settlement: full lifecycle, no stuck USDC
    // ---------------------------------------------------------------------------------------------
    function test_lifecycle_settle_redeem_noStuckFunds() public {
        _deploy(PredictionHookProto.Mode.OnDemand, true);
        _swap(true, true, true, 300 * E6);
        _swap(false, true, true, 100 * E6);
        _swap(true, false, true, 50 * E6);
        vm.prank(trader);
        hook.split(mId, 10 * E6);
        _checkInvariants();
        hook.resolve(mId, true);
        _checkInvariants();
        uint256 y = yes.balanceOf(trader);
        uint256 n = no.balanceOf(trader);
        vm.prank(trader);
        assertEq(hook.redeem(mId, true, y), y);
        vm.prank(trader);
        assertEq(hook.redeem(mId, false, n), 0);
        _checkInvariants();
        (,, uint256 bucket,,,,,,,,) = hook.markets(mId);
        hook.defund(mId, bucket, address(this));
        hook.sweep(mId, true);
        hook.sweep(mId, false);
        _checkInvariants();
        assertEq(usdc.balanceOf(address(manager)), 0, "no USDC stuck in PM");
        assertEq(yes.totalSupply(), 0);
        assertEq(no.totalSupply(), 0);
        assertEq(yes.balanceOf(address(manager)), 0);
    }

    function test_gas_buyPaths() public {
        _deploy(PredictionHookProto.Mode.OnDemand, true);
        _swap(true, true, true, 1 * E6); // warm-up: first mint (cold supply/balances)
        _swap(true, true, true, 100 * E6);
        uint256 gMint = vm.lastCallGas().gasTotalUsed;
        _swap(true, false, true, 100 * E6); // sell -> inventory
        uint256 gSell = vm.lastCallGas().gasTotalUsed;
        _swap(true, true, false, 10 * E6); // from inventory
        uint256 gInv = vm.lastCallGas().gasTotalUsed;
        console.log("PoolSwapTest.swap gas: buy on-demand mint=%s, sell=%s, buy from inventory=%s", gMint, gSell, gInv);
    }
}

contract OrphanClaimer is IUnlockCallback {
    IPoolManager immutable pm;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    function run(Currency c, uint256 amt) external {
        pm.unlock(abi.encode(c, amt));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        (Currency c, uint256 amt) = abi.decode(raw, (Currency, uint256));
        pm.sync(c);
        pm.settle(); // credits 0: the orphan is part of the snapshot
        pm.take(c, address(this), amt); // leaves a -amt delta
        return "";
    }
}
