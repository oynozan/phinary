// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./HookFixture.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IHookEvents} from "@openzeppelin/uniswap-hooks/interfaces/IHookEvents.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {QuoterRevert} from "v4-periphery/src/libraries/QuoterRevert.sol";

/// @notice The 8 swap cases through PoolSwapTest and V4Router, checked against the spec formulas and V4Quoter
abstract contract SwapCases is HookFixture {
    using TransientStateLibrary for IPoolManager;

    struct Case {
        bool isYes;
        bool isBuy;
        bool exactIn;
        uint256 amt;
    }

    function _cases() internal pure returns (Case[8] memory c) {
        c[0] = Case(true, true, true, 2_000 * E6);
        c[1] = Case(true, true, false, 1_500 * E6);
        c[2] = Case(true, false, true, 700 * E6);
        c[3] = Case(true, false, false, 300 * E6);
        c[4] = Case(false, true, true, 2_000 * E6);
        c[5] = Case(false, true, false, 1_500 * E6);
        c[6] = Case(false, false, true, 700 * E6);
        c[7] = Case(false, false, false, 300 * E6);
    }

    function _run(uint8 via, Case memory c) internal {
        PoolKey memory k = c.isYes ? kYes : kNo;
        OutcomeToken t = c.isYes ? yes : no;
        int256 f0 = _flow(mId);
        (uint256 q, uint256 cash) = _expect(mId, c.isYes, c.isBuy, c.exactIn, c.amt);
        uint256 quoted = _quoteV4(k, c.isBuy, c.exactIn, c.amt);
        assertEq(quoted, c.exactIn ? (c.isBuy ? q : cash) : (c.isBuy ? cash : q), "quoter == expectation");

        IPredictionHook.MarketInfo memory i0 = hook.marketInfo(mId);
        uint256 u0 = usdc.balanceOf(trader);
        uint256 t0 = t.balanceOf(trader);
        if (via == 0) {
            BalanceDelta d = _poolSwap(trader, k, c.isBuy, c.exactIn, c.amt);
            bool usdcIs0 = Currency.unwrap(k.currency0) == address(usdc);
            int256 dUsdc = usdcIs0 ? d.amount0() : d.amount1();
            int256 dTok = usdcIs0 ? d.amount1() : d.amount0();
            assertEq(dUsdc, c.isBuy ? -int256(cash) : int256(cash), "caller delta usdc");
            assertEq(dTok, c.isBuy ? int256(q) : -int256(q), "caller delta token");
        } else {
            _routerSwap(trader, k, c.isBuy, c.exactIn, c.amt);
        }
        assertEq(manager.getNonzeroDeltaCount(), 0, "deltas closed");
        assertEq(usdc.balanceOf(trader), c.isBuy ? u0 - cash : u0 + cash, "usdc moved");
        assertEq(t.balanceOf(trader), c.isBuy ? t0 + q : t0 - q, "token moved");
        assertEq(usdc.balanceOf(address(router)), 0, "router usdc");

        IPredictionHook.MarketInfo memory i1 = hook.marketInfo(mId);
        assertEq(i1.bucket, c.isBuy ? i0.bucket + cash : i0.bucket - cash, "bucket");
        uint256 out0 = c.isYes ? i0.outYes : i0.outNo;
        uint256 out1 = c.isYes ? i1.outYes : i1.outNo;
        assertEq(out1, c.isBuy ? out0 + q : out0 - q, "outstanding");
        int256 dq = int256(q);
        assertEq(_flow(mId), c.isYes == c.isBuy ? f0 + dq : f0 - dq, "epoch flow");
        _checkInvariants();
    }

    function _all(uint8 via) internal {
        Case[8] memory c = _cases();
        for (uint256 j; j < 8; ++j) {
            _run(via, c[j]);
        }
        vm.warp(block.timestamp + 12);
        for (uint256 j = 8; j > 0; --j) {
            _run(via, c[j - 1]);
        }
    }

    function test_poolSwapTest_all8() public {
        _all(0);
    }

    function test_v4Router_all8() public {
        _all(1);
    }

    function test_mixedRouters_sameBlock() public {
        Case[8] memory c = _cases();
        for (uint256 j; j < 8; ++j) {
            _run(uint8(j % 2), c[j]);
        }
    }

    function test_deltaWords_andEvents() public {
        (uint256 q, uint256 cash) = _expect(mId, true, true, true, 1_000 * E6);
        bool zf1 = _swapParams(kYes, true, true, 0).zeroForOne;
        (int128 a0, int128 a1) =
            zf1 ? (int128(int256(cash)), -int128(int256(q))) : (-int128(int256(q)), int128(int256(cash)));
        vm.expectEmit(true, true, true, true, address(hook));
        emit IHookEvents.HookSwap(PoolId.unwrap(kYes.toId()), address(swapRouter), a0, a1, 0, 0);
        vm.expectEmit(true, true, true, true, address(hook));
        emit IPredictionHook.Trade(mId, address(swapRouter), true, true, q, cash, cash * WAD / q);
        _poolSwap(trader, kYes, true, true, 1_000 * E6);
    }

    function test_inventoryFirst_thenMintShortfall() public {
        _poolSwap(trader, kYes, true, false, 1_000 * E6);
        _poolSwap(trader, kYes, false, true, 400 * E6);
        assertEq(hook.marketInfo(mId).invYes, 400 * E6);
        uint256 supply = yes.totalSupply();
        _poolSwap(trader, kYes, true, false, 300 * E6);
        assertEq(yes.totalSupply(), supply, "served from inventory");
        assertEq(hook.marketInfo(mId).invYes, 100 * E6);
        _poolSwap(trader, kYes, true, false, 250 * E6);
        assertEq(yes.totalSupply(), supply + 150 * E6, "shortfall minted");
        assertEq(hook.marketInfo(mId).invYes, 0);
        _checkInvariants();
    }

    function test_userClaims_roundTrip() public {
        vm.prank(trader);
        swapRouter.swap(kNo, _swapParams(kNo, true, true, 500 * E6), PoolSwapTest.TestSettings(true, false), "");
        uint256 cl = manager.balanceOf(trader, uint160(address(no)));
        assertGt(cl, 0);
        _checkInvariants();
        vm.startPrank(trader);
        manager.setOperator(address(swapRouter), true);
        swapRouter.swap(kNo, _swapParams(kNo, false, true, cl), PoolSwapTest.TestSettings(false, true), "");
        vm.stopPrank();
        assertEq(manager.balanceOf(trader, uint160(address(no))), 0);
        _checkInvariants();
    }

    function test_quoterEqualsExecution_fuzz(uint8 caseIdx, uint256 amt, uint256 pre) public {
        Case memory c = _cases()[caseIdx % 8];
        pre = bound(pre, 0, 5_000 * E6);
        if (pre != 0) _poolSwap(trader, c.isYes ? kYes : kNo, true, false, pre);
        amt = bound(amt, 10 * E6, 2_000 * E6);
        if (!c.isBuy) {
            _poolSwap(trader, c.isYes ? kYes : kNo, true, false, 5_000 * E6);
            amt = bound(amt, 10 * E6, 1_000 * E6);
        }
        PoolKey memory k = c.isYes ? kYes : kNo;
        uint256 quoted = _quoteV4(k, c.isBuy, c.exactIn, amt);
        uint256 u0 = usdc.balanceOf(trader);
        OutcomeToken t = c.isYes ? yes : no;
        uint256 t0 = t.balanceOf(trader);
        _routerSwap(trader, k, c.isBuy, c.exactIn, amt);
        uint256 dU = c.isBuy ? u0 - usdc.balanceOf(trader) : usdc.balanceOf(trader) - u0;
        uint256 dT = c.isBuy ? t.balanceOf(trader) - t0 : t0 - t.balanceOf(trader);
        assertEq(quoted, c.exactIn ? (c.isBuy ? dT : dU) : (c.isBuy ? dU : dT));
        _checkInvariants();
    }

    function test_quoterReportsNoQuote_whenHookReverts() public {
        vm.warp(block.timestamp + 1 days);
        IV4Quoter.QuoteExactSingleParams memory qp = IV4Quoter.QuoteExactSingleParams({
            poolKey: kYes,
            zeroForOne: _swapParams(kYes, true, true, 1).zeroForOne,
            exactAmount: uint128(100 * E6),
            hookData: ""
        });
        vm.expectRevert();
        quoter.quoteExactInputSingle(qp);
    }

    function test_hookDataIgnored(bytes calldata data) public {
        (uint256 q,) = _expect(mId, true, true, true, 100 * E6);
        vm.prank(trader);
        swapRouter.swap(kYes, _swapParams(kYes, true, true, 100 * E6), PoolSwapTest.TestSettings(false, false), data);
        assertEq(yes.balanceOf(trader), q);
    }

    function test_dustSellReverts() public {
        _poolSwap(trader, kYes, true, false, 10 * E6);
        vm.expectRevert(_wrapped(PredictionHook.ZeroAmount.selector));
        _poolSwap(trader, kYes, false, true, 1);
    }

    /* BeforeSwapDelta words: research table (swap-path-accounting-proto/delta_table_check.py) replayed */

    struct Row {
        bool isYes;
        bool isBuy;
        bool exactIn;
        uint256 amt;
    }

    function _researchRows() internal pure returns (Row[11] memory r) {
        r[0] = Row(true, true, true, 200);
        r[1] = Row(true, true, false, 250);
        r[2] = Row(true, false, true, 250);
        r[3] = Row(true, false, false, 100);
        r[4] = Row(true, true, false, 250);
        r[5] = Row(true, true, true, 300);
        r[6] = Row(false, true, true, 200);
        r[7] = Row(false, true, false, 250);
        r[8] = Row(false, false, true, 250);
        r[9] = Row(false, false, false, 100);
        r[10] = Row(false, true, true, 100);
    }

    /// @dev bsd(spec, unspec) = (spec << 128) | uint128(unspec), as in the research script
    function _bsd(int256 spec, int256 unspec) internal pure returns (bytes32) {
        return bytes32((uint256(uint128(int128(spec))) << 128) | uint256(uint128(int128(unspec))));
    }

    function test_beforeSwapDeltaWords_researchTable() public {
        Row[11] memory rows = _researchRows();
        for (uint256 j; j < 11; ++j) {
            Row memory r = rows[j];
            uint256 a = r.amt * E6;
            PoolKey memory k = r.isYes ? kYes : kNo;
            OutcomeToken t = r.isYes ? yes : no;
            (uint256 q, uint256 cash) = _expect(mId, r.isYes, r.isBuy, r.exactIn, a);
            uint256 unspecAmt = r.isBuy ? (r.exactIn ? q : cash) : (r.exactIn ? cash : q);
            (int256 spec, int256 uns) = r.exactIn ? (int256(a), -int256(unspecAmt)) : (-int256(a), int256(unspecAmt));
            bytes32 want = _bsd(spec, uns);
            assertEq(
                bytes32(uint256(BeforeSwapDelta.unwrap(toBeforeSwapDelta(int128(spec), int128(uns))))),
                want,
                "library packing"
            );

            IPredictionHook.MarketInfo memory i0 = hook.marketInfo(mId);
            uint256 inv0 = r.isYes ? i0.invYes : i0.invNo;
            uint256 supply0 = t.totalSupply();
            SwapParams memory sp = _swapParams(k, r.isBuy, r.exactIn, a);
            BalanceDelta d = _poolSwap(trader, k, r.isBuy, r.exactIn, a);

            (int256 hd0, int256 hd1) = (-int256(d.amount0()), -int256(d.amount1()));
            bool specIs0 = (sp.amountSpecified < 0) == sp.zeroForOne;
            (int256 gotSpec, int256 gotUns) = specIs0 ? (hd0, hd1) : (hd1, hd0);
            assertEq(_bsd(gotSpec, gotUns), want, "BeforeSwapDelta word");

            IPredictionHook.MarketInfo memory i1 = hook.marketInfo(mId);
            uint256 inv1 = r.isYes ? i1.invYes : i1.invNo;
            if (r.isBuy) {
                uint256 fromInv = q < inv0 ? q : inv0;
                assertEq(inv1, inv0 - fromInv, "fromInv");
                assertEq(t.totalSupply(), supply0 + q - fromInv, "minted");
            } else {
                assertEq(inv1, inv0 + q, "to inventory");
                assertEq(t.totalSupply(), supply0, "no burn");
            }
        }
        _checkInvariants();
    }

    /* Solvency guard */

    function _lowImpactMarket() internal returns (uint256 id, PoolKey memory ky, PoolKey memory kn) {
        IPredictionHook.MarketParams memory p = _params();
        p.quote.lambdaWad = 1e11;
        id = hook.createMarket(p);
        OutcomeToken y;
        OutcomeToken n;
        (y, n, ky, kn) = _market(id);
        _approveTokens(trader, y, n);
    }

    function _buyKeepsSolvent(uint256 id, bool isYes, uint256 q, uint256 cash) internal view returns (bool) {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        uint256 y = i.outYes + (isYes ? q : 0);
        uint256 n = i.outNo + (isYes ? 0 : q);
        return i.bucket + cash >= (y > n ? y : n);
    }

    function test_insolventBuyReverts_atBudgetLimit() public {
        (uint256 id, PoolKey memory ky,) = _lowImpactMarket();
        uint256 q = 40_000 * E6;
        bool hit;
        for (uint256 j; j < 20 && !hit; ++j) {
            (, uint256 cash) = _expect(id, true, true, false, q);
            if (_buyKeepsSolvent(id, true, q, cash)) {
                _poolSwap(trader, ky, true, false, q);
            } else {
                IPredictionHook.MarketInfo memory i0 = hook.marketInfo(id);
                vm.expectRevert(_wrapped(PredictionHook.Insolvent.selector));
                _poolSwap(trader, ky, true, false, q);
                IPredictionHook.MarketInfo memory i1 = hook.marketInfo(id);
                assertEq(i1.bucket, i0.bucket, "bucket unchanged");
                assertEq(i1.outYes, i0.outYes, "outYes unchanged");
                hit = true;
            }
            vm.warp(block.timestamp + 1);
        }
        assertTrue(hit, "budget limit reached");
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        assertGe(i.bucket, i.outYes > i.outNo ? i.outYes : i.outNo, "bucket >= max(out)");
        assertGe(i.outYes, 160_000 * E6, "levered well past the budget");
        _checkInvariants();
    }

    function test_insolventSellReverts_whenOtherSideBinds() public {
        (uint256 id, PoolKey memory ky, PoolKey memory kn) = _lowImpactMarket();
        _poolSwap(trader, ky, true, false, 20_000 * E6);
        for (uint256 j; j < 40; ++j) {
            vm.warp(block.timestamp + 1);
            IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
            uint256 margin = i.bucket - (i.outYes > i.outNo ? i.outYes : i.outNo);
            if (margin < 1_000 * E6) break;
            uint256 q = margin * 19 / 10;
            if (q > 40_000 * E6) q = 40_000 * E6;
            (, uint256 cash) = _expect(id, false, true, false, q);
            if (!_buyKeepsSolvent(id, false, q, cash)) break;
            _poolSwap(trader, kn, true, false, q);
        }
        vm.warp(block.timestamp + 1);
        IPredictionHook.MarketInfo memory i0 = hook.marketInfo(id);
        (, uint256 proceeds) = _expect(id, true, false, true, 20_000 * E6);
        assertGe(i0.outNo, i0.outYes, "NO binds");
        assertLt(i0.bucket - proceeds, i0.outNo, "sell would breach the NO requirement");
        vm.expectRevert(_wrapped(PredictionHook.Insolvent.selector));
        _poolSwap(trader, ky, false, true, 20_000 * E6);
        assertEq(hook.marketInfo(id).bucket, i0.bucket);
        _checkInvariants();
    }

    /* Cross-outcome arbitrage (T7): a complete set bought in one epoch costs >= q, sold returns <= q */

    address internal trader2 = makeAddr("trader2");

    function _via(uint8 via, PoolKey memory k, bool isBuy, bool exactIn, uint256 amt) internal {
        if (via % 2 == 0) _poolSwap(trader, k, isBuy, exactIn, amt);
        else _routerSwap(trader, k, isBuy, exactIn, amt);
    }

    /// @dev Trader's USDC moved and tokens moved (absolute) by one swap
    function _leg(uint8 via, bool isYes, bool isBuy, bool exactIn, uint256 amt)
        internal
        returns (uint256 cash, uint256 q)
    {
        OutcomeToken t = isYes ? yes : no;
        uint256 u0 = usdc.balanceOf(trader);
        uint256 t0 = t.balanceOf(trader);
        _via(via, isYes ? kYes : kNo, isBuy, exactIn, amt);
        uint256 u1 = usdc.balanceOf(trader);
        uint256 t1 = t.balanceOf(trader);
        (cash, q) = isBuy ? (u0 - u1, t1 - t0) : (u1 - u0, t0 - t1);
    }

    function _preFlow(int256 dx, uint256 pre, bool preYes) internal {
        oracle.setLnSpot(lnK + bound(dx, -0.02e18, 0.02e18));
        pre = bound(pre, 0, 5_000 * E6);
        if (pre == 0) return;
        _fund(trader2, 1_000_000 * E6);
        _poolSwap(trader2, preYes ? kYes : kNo, true, false, pre);
    }

    function test_completeSetBuy_costsAtLeastQ_fuzz(
        uint256 amt,
        int256 dx,
        uint256 pre,
        bool preYes,
        bool yesFirst,
        bool firstExactIn,
        uint8 via
    ) public {
        _preFlow(dx, pre, preYes);
        amt = firstExactIn ? bound(amt, E6, 1_500 * E6) : bound(amt, E6, 5_000 * E6);
        (uint256 c1, uint256 q) = _leg(via, yesFirst, true, firstExactIn, amt);
        (uint256 c2, uint256 q2) = _leg(via >> 1, !yesFirst, true, false, q);
        assertEq(q2, q);
        assertGe(c1 + c2, q, "complete set bought below par");
        _checkInvariants();
    }

    /// @dev False when the hook refuses the sell because it lies beyond the impact curve or the band this epoch (by design);
    ///      any other failure is re-raised
    function _sellExecutable(PoolKey memory k, bool exactIn, uint256 amt) internal returns (bool) {
        IV4Quoter.QuoteExactSingleParams memory qp = IV4Quoter.QuoteExactSingleParams({
            poolKey: k,
            zeroForOne: _swapParams(k, false, exactIn, amt).zeroForOne,
            exactAmount: uint128(amt),
            hookData: ""
        });
        bytes memory err;
        if (exactIn) {
            try quoter.quoteExactInputSingle(qp) returns (uint256, uint256) {
                return true;
            } catch (bytes memory e) {
                err = e;
            }
        } else {
            try quoter.quoteExactOutputSingle(qp) returns (uint256, uint256) {
                return true;
            } catch (bytes memory e) {
                err = e;
            }
        }
        bytes4[3] memory byDesign = [QuoteMath.Unreachable.selector, QuoteMath.Band.selector, PredictionHook.OutOfBand.selector];
        for (uint256 j; j < 3; ++j) {
            bytes memory refusal = abi.encodeWithSelector(QuoterRevert.UnexpectedRevertBytes.selector, _wrapped(byDesign[j]));
            if (keccak256(err) == keccak256(refusal)) return false;
        }
        assembly ("memory-safe") {
            revert(add(err, 0x20), mload(err))
        }
    }

    function test_completeSetSell_returnsAtMostQ_fuzz(
        uint256 amt,
        int256 dx,
        uint256 pre,
        bool preYes,
        bool yesFirst,
        bool firstExactIn,
        uint8 via
    ) public {
        _poolSwap(trader, kYes, true, false, 8_000 * E6);
        _poolSwap(trader, kNo, true, false, 8_000 * E6);
        vm.warp(block.timestamp + 1);
        _preFlow(dx, pre, preYes);
        amt = firstExactIn ? bound(amt, E6, 5_000 * E6) : bound(amt, E6, 600 * E6);
        vm.assume(_sellExecutable(yesFirst ? kYes : kNo, firstExactIn, amt));
        (uint256 c1, uint256 q) = _leg(via, yesFirst, false, firstExactIn, amt);
        (uint256 c2, uint256 q2) = _leg(via >> 1, !yesFirst, false, true, q);
        assertEq(q2, q);
        assertLe(c1 + c2, q, "complete set sold above par");
        _checkInvariants();
    }

    /* No address-based pricing: Thales' whitelisted 0.5% router cost its LPs more than their whole net loss */

    /// @dev The hook owner, the keeper, an LP, the usual trader, or a fresh address
    function _caller(uint256 seed) internal returns (address) {
        uint256 k = seed % 5;
        if (k == 0) return address(this);
        if (k == 1) return keeperAddr;
        if (k == 2) return lp;
        if (k == 3) return trader;
        return makeAddr(vm.toString(seed));
    }

    /// @dev `who` is both msg.sender and tx.origin
    function _swapAs(address who, bool viaRouter, PoolKey memory k, bool isBuy, bool exactIn, uint256 amt, bytes memory data)
        internal
    {
        vm.prank(who, who);
        if (viaRouter) router.executeActions(_routerPlan(k, isBuy, exactIn, amt, data));
        else swapRouter.swap(k, _swapParams(k, isBuy, exactIn, amt), PoolSwapTest.TestSettings(false, false), data);
    }

    /// @dev USDC and tokens moved by one swap from `who`, which must match the spec formula; sells first buy `pre` tokens
    function _fillAs(address who, bool viaRouter, Case memory c, uint256 pre, bytes memory data)
        internal
        returns (uint256 cash, uint256 q)
    {
        _fund(who, 1_000_000 * E6);
        PoolKey memory k = c.isYes ? kYes : kNo;
        if (!c.isBuy) _swapAs(who, viaRouter, k, true, false, pre, data);
        (uint256 eq, uint256 ecash) = _expect(mId, c.isYes, c.isBuy, c.exactIn, c.amt);
        OutcomeToken t = c.isYes ? yes : no;
        uint256 u0 = usdc.balanceOf(who);
        uint256 t0 = t.balanceOf(who);
        _swapAs(who, viaRouter, k, c.isBuy, c.exactIn, c.amt, data);
        (cash, q) = c.isBuy
            ? (u0 - usdc.balanceOf(who), t.balanceOf(who) - t0)
            : (usdc.balanceOf(who) - u0, t0 - t.balanceOf(who));
        assertEq(q, eq, "tokens == spec");
        assertEq(cash, ecash, "usdc == spec");
    }

    function test_fillIndependentOfCaller_fuzz(uint256 seedA, uint256 seedB, uint256 amt, uint256 pre, bytes calldata data)
        public
    {
        address a = _caller(seedA);
        address b = _caller(seedB);
        pre = bound(pre, 5_000 * E6, 10_000 * E6);
        Case[8] memory cs = _cases();
        for (uint256 j; j < 8; ++j) {
            Case memory c = cs[j];
            c.amt = c.isBuy ? bound(amt, E6, 2_000 * E6) : bound(amt, E6, 1_000 * E6);
            uint256 snap = vm.snapshotState();
            (uint256 cashA, uint256 qA) = _fillAs(a, (seedA >> 8) & 1 == 1, c, pre, "");
            vm.revertToState(snap);
            (uint256 cashB, uint256 qB) = _fillAs(b, (seedB >> 8) & 1 == 1, c, pre, data);
            vm.revertToState(snap);
            assertEq(cashA, cashB, "usdc depends on caller");
            assertEq(qA, qB, "tokens depend on caller");
        }
    }

    /* Swap gas does not depend on the number of markets (T19) */

    function _coldBuyGas(uint256 extraMarkets) internal returns (uint256 g) {
        IPredictionHook.MarketParams memory p = _params();
        p.budget = 1_000 * E6;
        for (uint256 j; j < extraMarkets; ++j) {
            hook.createMarket(p);
        }
        vm.cool(address(hook));
        vm.cool(address(manager));
        vm.cool(address(yes));
        vm.cool(address(no));
        vm.cool(address(usdc));
        vm.cool(address(oracle));
        vm.cool(address(swapRouter));
        SwapParams memory sp = _swapParams(kYes, true, true, 500 * E6);
        PoolSwapTest.TestSettings memory ts = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        vm.prank(trader);
        uint256 g0 = gasleft();
        swapRouter.swap(kYes, sp, ts, "");
        g = g0 - gasleft();
    }

    function test_swapGas_independentOfMarketCount() public {
        uint256 snap = vm.snapshotState();
        uint256 g1 = _coldBuyGas(1);
        vm.revertToState(snap);
        uint256 g2 = _coldBuyGas(100);
        assertEq(hook.marketCount(), 101);
        assertEq(g2, g1, "swap gas depends on market count");
    }
}

contract SwapCases_OutcomeIsCurrency0 is SwapCases {
    function _outcomeIs0() internal pure override returns (bool) {
        return true;
    }
}

contract SwapCases_OutcomeIsCurrency1 is SwapCases {
    function _outcomeIs0() internal pure override returns (bool) {
        return false;
    }
}
