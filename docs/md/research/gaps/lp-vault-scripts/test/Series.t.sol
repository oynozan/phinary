// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SeriesHook, OutcomeToken} from "../src/SeriesHook.sol";

contract SeriesTest is Test, Deployers {
    using TransientStateLibrary for IPoolManager;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    SeriesHook hook;
    MockERC20 usdcT;
    Currency usdcC;
    address lp1 = makeAddr("lp1");
    address lp2 = makeAddr("lp2");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address[] actors;
    uint256 donatedUSDC; // ERC-6909 USDC claims donated to the hook
    uint256 okSwaps;
    uint256 okSells;
    uint256 constant U = 1e6;
    uint256 T0 = 1_800_000_000;

    function setUp() public {
        vm.warp(T0);
        deployFreshManagerAndRouters(); // fresh PM: holds zero ERC20 of anything
        usdcT = new MockERC20("USDC", "USDC", 6);
        usdcC = Currency.wrap(address(usdcT));
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        );
        address where = address(flags | (uint160(0xBEEF) << 100));
        deployCodeTo("SeriesHook.sol:SeriesHook", abi.encode(manager, usdcC), where);
        hook = SeriesHook(where);
        actors = [lp1, lp2, alice, bob];
        for (uint256 i; i < actors.length; ++i) {
            usdcT.mint(actors[i], 10_000_000 * U);
            vm.prank(actors[i]);
            usdcT.approve(address(hook), type(uint256).max);
            vm.prank(actors[i]);
            usdcT.approve(address(swapRouter), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------ helpers
    function _series3(uint256 B, bool forceExact) internal returns (uint256 sid, uint256[3] memory m) {
        sid = hook.createSeries(uint64(T0 + 1 hours), uint64(T0 + 7 days), B, forceExact);
        m[1] = hook.addMarket(sid, 5000, 0.5e18); // inserted out of order on purpose
        m[0] = hook.addMarket(sid, 4500, 0.8e18);
        m[2] = hook.addMarket(sid, 5500, 0.3e18);
    }

    function _approveOutcomes(uint256 mid) internal {
        (,, OutcomeToken y, OutcomeToken n,,,,) = hook.markets(mid);
        for (uint256 i; i < actors.length; ++i) {
            vm.startPrank(actors[i]);
            y.approve(address(swapRouter), type(uint256).max);
            n.approve(address(swapRouter), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// buy (USDC -> outcome) or sell (outcome -> USDC), exact in or exact out
    function _swap(address who, uint256 mid, bool isYes, bool buy, bool exactIn, uint256 amt) internal {
        PoolKey memory key = hook.poolKeyOf(mid, isYes);
        Currency input = buy ? usdcC : (isYes ? _yes(mid) : _no(mid));
        bool zeroForOne = key.currency0 == input;
        SwapParams memory p = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: exactIn ? -int256(amt) : int256(amt),
            sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
        vm.prank(who);
        swapRouter.swap(key, p, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");
    }

    function _yes(uint256 mid) internal view returns (Currency) {
        (,, OutcomeToken y,,,,,) = hook.markets(mid);
        return Currency.wrap(address(y));
    }

    function _no(uint256 mid) internal view returns (Currency) {
        (,,, OutcomeToken n,,,,) = hook.markets(mid);
        return Currency.wrap(address(n));
    }

    function _checkInvariants(uint256 sid) internal view {
        // V1: sum of USDC ledger buckets == hook's ERC-6909 USDC claims (minus donations)
        assertEq(manager.balanceOf(address(hook), usdcC.toId()), hook.ledgerUSDC() + donatedUSDC, "V1 buckets");
        assertEq(manager.getNonzeroDeltaCount(), 0, "deltas");
        (SeriesHook.State st, uint256 D, uint256 B,,,,) = hook.seriesInfo(sid);
        uint256[] memory ids = hook.seriesMarkets(sid);
        for (uint256 i; i < ids.length; ++i) {
            (,, OutcomeToken y, OutcomeToken n, uint128 invY, uint128 invN, uint256 coll,) = hook.markets(ids[i]);
            // V2: outcome claims == inventory ledger
            assertEq(manager.balanceOf(address(hook), Currency.wrap(address(y)).toId()), invY, "V2 yes");
            assertEq(manager.balanceOf(address(hook), Currency.wrap(address(n)).toId()), invN, "V2 no");
            if (st == SeriesHook.State.LIVE) {
                // V3: complete sets
                assertEq(y.totalSupply(), coll, "V3 yes supply");
                assertEq(n.totalSupply(), coll, "V3 no supply");
                // PM physically holds the ERC20 that backs every claim
                assertGe(y.balanceOf(address(manager)), invY, "PM backs yes claims");
            }
            // strikes sorted
            if (i > 0) {
                (, uint256 kPrev,,,,,,) = hook.markets(ids[i - 1]);
                (, uint256 k,,,,,,) = hook.markets(ids[i]);
                assertLt(kPrev, k, "sorted");
            }
            // slot0 of the prediction pools never moves (no CL fall-through)
            (uint160 sp,,,) = manager.getSlot0(hook.poolKeyOf(ids[i], true).toId());
            assertEq(sp, 79228162514264337593543950336, "slot0");
        }
        if (st == SeriesHook.State.LIVE) {
            // V5: exact ladder cap
            assertGe(hook.ladderMinOf(sid), int256(D) - int256(B), "V5 ladder");
        }
    }


    function _wealth(address a) internal view returns (uint256) {
        return usdcT.balanceOf(a) + manager.balanceOf(a, usdcC.toId());
    }

    // ------------------------------------------------------------------ tests
    function test_endToEnd_claimsOnlySwapPath() public {
        (uint256 sid, uint256[3] memory m) = _series3(1_000_000 * U, false);
        for (uint256 i; i < 3; ++i) _approveOutcomes(m[i]);
        uint256 w0 = _wealth(lp1) + _wealth(lp2) + _wealth(alice) + _wealth(bob);

        vm.prank(lp1);
        hook.subscribe(sid, 600_000 * U);
        vm.prank(lp2);
        hook.subscribe(sid, 400_000 * U);
        vm.warp(T0 + 50 minutes); // subscriptions closed, pre-mint window
        vm.prank(bob);
        vm.expectRevert(SeriesHook.WrongState.selector);
        hook.subscribe(sid, 1 * U);
        for (uint256 i; i < 3; ++i) hook.topUp(m[i], 300_000 * U); // pre-mint complete sets as claims
        _checkInvariants(sid);

        // trading before open reverts (wrapped hook error)
        vm.expectRevert();
        this.swapExt(alice, m[1], true, true, true, 1000 * U);

        vm.warp(T0 + 1 hours);
        // no mid-life entry
        vm.prank(bob);
        vm.expectRevert(SeriesHook.WrongState.selector);
        hook.subscribe(sid, 1 * U);

        _swap(alice, m[1], true, true, true, 10_000 * U); // buy YES@5000, exact in
        _checkInvariants(sid);
        _swap(bob, m[0], false, true, false, 5_000 * U); // buy NO@4500, exact out
        _checkInvariants(sid);
        _swap(alice, m[1], true, false, true, 4_000 * U); // sell YES@5000, exact in
        _checkInvariants(sid);
        _swap(alice, m[1], true, false, false, 1_000 * U); // sell YES@5000, exact out (USDC out)
        _checkInvariants(sid);
        _swap(bob, m[2], true, true, false, 20_000 * U); // buy YES@5500, exact out
        _checkInvariants(sid);

        // no exit before settlement
        vm.prank(lp1);
        vm.expectRevert(SeriesHook.WrongState.selector);
        hook.claim(sid, 1, lp1, true);

        vm.warp(T0 + 7 days);
        hook.setOracle(sid, 5200); // 4500 < 5000 < S_T <= 5500
        hook.settle(sid);
        hook.finalize(sid);
        _checkInvariants(sid);

        // traders redeem (alice YES@5000 wins; bob NO@4500 and YES@5500 lose)
        (,, OutcomeToken y1,,,,,) = hook.markets(m[1]);
        uint256 aY = y1.balanceOf(alice);
        vm.prank(alice);
        assertEq(hook.redeem(m[1], true, aY, alice, false), aY);
        (,,, OutcomeToken n0,,,,) = hook.markets(m[0]);
        uint256 bN = n0.balanceOf(bob);
        vm.prank(bob);
        assertEq(hook.redeem(m[0], false, bN, bob, false), 0);
        (,, OutcomeToken y2,,,,,) = hook.markets(m[2]);
        uint256 bY = y2.balanceOf(bob);
        vm.prank(bob);
        assertEq(hook.redeem(m[2], true, bY, bob, true), 0);

        // LPs exit: one as ERC-6909 claims (no unlock), one as ERC20
        vm.prank(lp1);
        uint256 o1 = hook.claim(sid, 600_000 * U, lp1, true);
        vm.prank(lp2);
        uint256 o2 = hook.claim(sid, 400_000 * U, lp2, false);
        (,,,, uint256 remShares, uint256 remCash,) = hook.seriesInfo(sid);
        assertEq(remShares, 0);
        assertEq(remCash, 0, "no dust left");
        _checkInvariants(sid);

        // conservation: total USDC wealth of all actors unchanged; hook ledger drained
        uint256 w1 = _wealth(lp1) + _wealth(lp2) + _wealth(alice) + _wealth(bob);
        assertEq(w1, w0, "conservation");
        assertEq(hook.ledgerUSDC(), 0);
        assertEq(manager.balanceOf(address(hook), usdcC.toId()), 0);
        int256 lpPnl = int256(o1 + o2) - int256(1_000_000 * U);
        emit log_named_int("LP P&L (units)", lpPnl);
        // zero-sum: LP P&L == -(traders' P&L)
        int256 traderPnl = int256(_wealth(alice) + _wealth(bob)) - int256(20_000_000 * U);
        assertEq(lpPnl, -traderPnl, "zero-sum");
    }

    function test_ladderCap_exactAllowsOffsetting_blocksAligned() public {
        (uint256 sid, uint256[3] memory m) = _series3(100_000 * U, false);
        for (uint256 i; i < 3; ++i) _approveOutcomes(m[i]);
        vm.prank(lp1);
        hook.subscribe(sid, 1_000_000 * U);
        vm.warp(T0 + 50 minutes);
        for (uint256 i; i < 3; ++i) hook.topUp(m[i], 300_000 * U);
        vm.warp(T0 + 1 hours);

        _swap(bob, m[2], true, true, false, 120_000 * U); // traders long YES@5500 (vault short)
        _checkInvariants(sid);
        // traders long NO@4500: union bound fails (822.4k < 900k) but the positions cannot both win
        _swap(alice, m[0], false, true, false, 120_000 * U);
        _checkInvariants(sid);
        assertEq(hook.ladderMinOf(sid), int256(942_400 * U));
        // aligned: traders long YES@5000 too -> region S>5500 loses 116.4k > B = 100k
        try this.swapExt(alice, m[1], true, true, false, 120_000 * U) {
            fail();
        } catch (bytes memory err) {
            // PoolManager wraps hook reverts: WrappedError(address,bytes4,bytes reason,bytes details)
            bytes memory body = new bytes(err.length - 4);
            for (uint256 i; i < body.length; ++i) body[i] = err[i + 4];
            (, , bytes memory reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
            assertEq(bytes4(reason), SeriesHook.LadderCap.selector, "LadderCap");
            bytes memory args = new bytes(reason.length - 4);
            for (uint256 i; i < args.length; ++i) args[i] = reason[i + 4];
            (int256 minW, int256 floor_) = abi.decode(args, (int256, int256));
            emit log_named_int("minW after rejected trade", minW);
            assertEq(minW, int256(883_600 * U));
            assertEq(floor_, int256(900_000 * U));
        }
        _checkInvariants(sid);
    }

    function test_inflation_and_donations_do_not_move_shares() public {
        (uint256 sid, uint256[3] memory m) = _series3(1_000_000 * U, false);
        address attacker = makeAddr("attacker");
        usdcT.mint(attacker, 20_000 * U);
        vm.startPrank(attacker);
        usdcT.approve(address(hook), type(uint256).max);
        hook.subscribe(sid, 10_000 * U + 1);
        hook.unsubscribe(sid, 10_000 * U); // attacker now holds 10k USDC as ERC-6909 claims, 1 share
        manager.transfer(address(hook), usdcC.toId(), 10_000 * U); // donate claims
        usdcT.transfer(address(hook), 5_000 * U); // donate ERC20
        vm.stopPrank();
        donatedUSDC = 10_000 * U;
        vm.prank(alice);
        hook.subscribe(sid, 10_000 * U - 1);
        assertEq(hook.sharesOf(sid, alice), 10_000 * U - 1, "1:1 shares");
        _checkInvariants(sid);
        vm.warp(T0 + 7 days);
        hook.setOracle(sid, 5000);
        hook.settle(sid);
        hook.finalize(sid);
        vm.prank(alice);
        assertEq(hook.claim(sid, 10_000 * U - 1, alice, true), 10_000 * U - 1, "victim made whole");
        vm.prank(attacker);
        assertEq(hook.claim(sid, 1, attacker, true), 1, "attacker gets 1 unit");
        m; // silence
    }

    function test_liveness_pause_and_deadOracle() public {
        (uint256 sid, uint256[3] memory m) = _series3(1_000_000 * U, false);
        for (uint256 i; i < 3; ++i) _approveOutcomes(m[i]);
        vm.prank(lp1);
        hook.subscribe(sid, 1_000_000 * U);
        vm.warp(T0 + 50 minutes);
        hook.topUp(m[1], 300_000 * U);
        vm.warp(T0 + 1 hours);
        _swap(alice, m[1], true, true, true, 10_000 * U);
        _swap(bob, m[1], false, true, true, 10_000 * U);
        hook.setPaused(true);
        vm.expectRevert();
        this.swapExt(alice, m[1], true, true, true, 1_000 * U);
        vm.warp(T0 + 7 days);
        vm.expectRevert(bytes("oracle unavailable"));
        hook.settle(sid);
        vm.expectRevert(SeriesHook.WrongState.selector);
        hook.settleInvalid(sid);
        vm.warp(T0 + 14 days);
        hook.settleInvalid(sid); // permissionless INVALID (50/50) fallback
        hook.finalize(sid);
        (,, OutcomeToken y,,,,,) = hook.markets(m[1]);
        (,,, OutcomeToken n,,,,) = hook.markets(m[1]);
        uint256 aY = y.balanceOf(alice);
        uint256 bN = n.balanceOf(bob);
        vm.prank(alice);
        assertEq(hook.redeem(m[1], true, aY, alice, true), aY / 2); // still paused
        vm.prank(bob);
        assertEq(hook.redeem(m[1], false, bN, bob, false), bN / 2);
        vm.prank(lp1);
        hook.claim(sid, 1_000_000 * U, lp1, true);
        _checkInvariants(sid);
        assertLe(hook.ledgerUSDC(), 1, "at most 1 unit of 50/50 dust");
    }

    /// Random op sequences through the real PoolManager; invariants after every step; full wind-down.
    function testFuzz_randomOps(uint256 seed) public {
        (uint256 sid, uint256[3] memory m) = _series3(250_000 * U, seed % 2 == 0);
        for (uint256 i; i < 3; ++i) _approveOutcomes(m[i]);
        uint256 w0 = _wealth(lp1) + _wealth(lp2) + _wealth(alice) + _wealth(bob);
        uint256 s1 = 1 + (seed % 900_000) * U;
        uint256 s2 = 1 + ((seed >> 20) % 900_000) * U;
        vm.prank(lp1);
        hook.subscribe(sid, s1);
        vm.prank(lp2);
        hook.subscribe(sid, s2);
        vm.warp(T0 + 50 minutes);
        for (uint256 i; i < 3; ++i) hook.topUp(m[i], (s1 + s2) / 4);
        vm.warp(T0 + 1 hours);
        for (uint256 k; k < 40; ++k) {
            uint256 r = uint256(keccak256(abi.encode(seed, k)));
            uint256 mid = m[r % 3];
            address who = (r >> 8) % 2 == 0 ? alice : bob;
            bool isYes = (r >> 9) % 2 == 0;
            bool buy = (r >> 10) % 3 != 0;
            bool exactIn = (r >> 11) % 2 == 0;
            uint256 amt = 1 + (r >> 12) % (50_000 * U);
            if ((r >> 40) % 10 == 0) {
                try hook.merge(mid, amt) {} catch {}
            } else if ((r >> 40) % 10 == 1) {
                try hook.topUp(mid, amt) {} catch {}
            } else {
                if (!buy) {
                    // sell at most what the trader holds
                    Currency c = isYes ? _yes(mid) : _no(mid);
                    uint256 bal = MockERC20(Currency.unwrap(c)).balanceOf(who);
                    if (bal == 0) continue;
                    if (exactIn) amt = 1 + amt % bal;
                }
                try this.swapExt(who, mid, isYes, buy, exactIn, amt) { okSwaps++; if (!buy) okSells++; } catch {}
            }
            _checkInvariants(sid);
        }
        vm.warp(T0 + 7 days);
        hook.setOracle(sid, 4000 + (seed % 2000));
        hook.settle(sid);
        hook.finalize(sid);
        _checkInvariants(sid);
        for (uint256 i; i < 3; ++i) {
            for (uint256 a = 2; a < 4; ++a) {
                (,, OutcomeToken y, OutcomeToken n,,,,) = hook.markets(m[i]);
                uint256 by = y.balanceOf(actors[a]);
                uint256 bn = n.balanceOf(actors[a]);
                vm.startPrank(actors[a]);
                if (by > 0) hook.redeem(m[i], true, by, actors[a], a == 2);
                if (bn > 0) hook.redeem(m[i], false, bn, actors[a], a == 3);
                vm.stopPrank();
            }
        }
        vm.prank(lp2);
        hook.claim(sid, s2, lp2, false);
        vm.prank(lp1);
        hook.claim(sid, s1, lp1, true);
        _checkInvariants(sid);
        assertEq(hook.ledgerUSDC(), 0, "all paid, no dust");
        assertEq(_wealth(lp1) + _wealth(lp2) + _wealth(alice) + _wealth(bob), w0, "conservation");
        if (s1 + s2 > 200_000 * U) assertGt(okSwaps, 3, "swaps executed");
    }

    function swapExt(address who, uint256 mid, bool isYes, bool buy, bool exactIn, uint256 amt) external {
        require(msg.sender == address(this));
        _swap(who, mid, isYes, buy, exactIn, amt);
    }

    // ------------------------------------------------------------------ gas: exact ladder check inside beforeSwap
    function _gasForStrikes(uint256 n) internal returns (uint256 g) {
        uint256 sid = hook.createSeries(uint64(T0 + 1 hours), uint64(T0 + 7 days), 1_000_000 * U, true);
        uint256 target;
        for (uint256 i; i < n; ++i) {
            uint256 mid = hook.addMarket(sid, 3000 + 100 * i, 0.5e18);
            if (i == n / 2) target = mid;
        }
        _approveOutcomes(target);
        vm.prank(lp1);
        hook.subscribe(sid, 1_000_000 * U);
        vm.warp(T0 + 50 minutes);
        hook.topUp(target, 100_000 * U);
        vm.warp(T0 + 1 hours);
        vm.cool(address(hook));
        vm.cool(address(manager));
        vm.cool(address(usdcT));
        vm.cool(Currency.unwrap(_yes(target)));
        vm.cool(address(swapRouter));
        uint256 g0 = gasleft();
        _swap(alice, target, true, true, true, 1_000 * U);
        g = g0 - gasleft();
    }

    function test_gas_n1() public { emit log_named_uint("swap gas, 1 strike, exact ladder", _gasForStrikes(1)); }
    function test_gas_n8() public { emit log_named_uint("swap gas, 8 strikes, exact ladder", _gasForStrikes(8)); }
    function test_gas_n16() public { emit log_named_uint("swap gas, 16 strikes, exact ladder", _gasForStrikes(16)); }
    function test_gas_n30_fastPath() public {
        // same as n30 but with the O(1) union-bound fast path enabled
        uint256 sid = hook.createSeries(uint64(T0 + 1 hours), uint64(T0 + 7 days), 1_000_000 * U, false);
        uint256 target;
        for (uint256 i; i < 30; ++i) {
            uint256 mid = hook.addMarket(sid, 3000 + 100 * i, 0.5e18);
            if (i == 15) target = mid;
        }
        _approveOutcomes(target);
        vm.prank(lp1);
        hook.subscribe(sid, 1_000_000 * U);
        vm.warp(T0 + 50 minutes);
        hook.topUp(target, 100_000 * U);
        vm.warp(T0 + 1 hours);
        vm.cool(address(hook)); vm.cool(address(manager)); vm.cool(address(usdcT));
        vm.cool(Currency.unwrap(_yes(target))); vm.cool(address(swapRouter));
        uint256 g0 = gasleft();
        _swap(alice, target, true, true, true, 1_000 * U);
        emit log_named_uint("swap gas, 30 strikes, O(1) fast path", g0 - gasleft());
    }

    function test_gas_n30() public { emit log_named_uint("swap gas, 30 strikes, exact ladder", _gasForStrikes(30)); }
}
