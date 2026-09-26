// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../hook/HookFixture.sol";
import {console2} from "forge-std/console2.sol";
import {MarketScheduler} from "../../src/MarketScheduler.sol";
import {MarketGatekeeper} from "../../src/MarketGatekeeper.sol";
import {IMarketScheduler} from "../../src/interfaces/IMarketScheduler.sol";
import {demoTracks, withOracle} from "./TracksFixture.sol";

/// @notice Both live tracks open markets into one shared vault while traders buy and sell, markets settle (or go
///         INVALID), winners redeem, buckets are swept and the LP deposits and withdraws. Every open is checked
///         against `canOpen()`, `nextOpenTime()` and the budget rule it should have used; calls that may legitimately
///         halt are caught and their revert reason must be on an allowlist, otherwise `unexpected` grows.
contract TracksHandler is Test {
    uint256 internal constant MAX_MARKETS = 40;
    uint256 internal constant QUARTER = 900;

    PredictionHook internal hook;
    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    MockUSDC internal usdc;
    MockOracle internal oracle;
    int256 internal lnK;
    MarketScheduler[2] internal tracks;

    address[] public actors;
    address public lp = address(0x1B0);
    uint256 public unexpected;
    bytes public lastUnexpected;
    uint256 public canOpenMismatches;
    uint256 public budgetMismatches;
    uint256 public sharedBlockOpens;
    /// @dev Fuzzed calls so far; the `...Again` and `...Third` wrappers count once, through the function they call
    uint256 public calls;
    mapping(bytes32 => uint256) public ok;
    mapping(uint256 marketId => uint256) public slotOf;

    constructor(
        PredictionHook hook_,
        IPoolManager manager_,
        PoolSwapTest swapRouter_,
        MockUSDC usdc_,
        MockOracle oracle_,
        int256 lnK_,
        MarketGatekeeper gk_
    ) {
        hook = hook_;
        manager = manager_;
        swapRouter = swapRouter_;
        usdc = usdc_;
        oracle = oracle_;
        lnK = lnK_;
        address[] memory s = gk_.schedulers();
        tracks[0] = MarketScheduler(s[0]);
        tracks[1] = MarketScheduler(s[1]);
        for (uint256 i; i < 3; ++i) {
            address a = address(uint160(0xA11CE0 + i));
            actors.push(a);
            usdc.mint(a, 1_000_000e6);
            vm.prank(a);
            usdc.approve(address(swapRouter), type(uint256).max);
        }
        usdc.mint(lp, 1_000_000e6);
        vm.prank(lp);
        usdc.approve(address(hook), type(uint256).max);
    }

    modifier counted() {
        calls++;
        _;
    }

    function track(uint256 i) external view returns (MarketScheduler) {
        return tracks[i];
    }

    /* Revert classification */

    function _inner(bytes memory err) internal pure returns (bytes4 sel) {
        if (err.length < 4) return bytes4(0);
        sel = bytes4(err);
        if (sel != CustomRevert.WrappedError.selector) return sel;
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = err[i + 4];
        }
        (,, bytes memory reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
        return reason.length < 4 ? bytes4(0) : bytes4(reason);
    }

    function _expected(bytes memory err, bytes4[] memory allowed) internal {
        bytes4 sel = _inner(err);
        for (uint256 i; i < allowed.length; ++i) {
            if (sel == allowed[i]) return;
        }
        unexpected++;
        lastUnexpected = err;
    }

    function _one(bytes4 a) internal pure returns (bytes4[] memory l) {
        l = new bytes4[](1);
        l[0] = a;
    }

    function _two(bytes4 a, bytes4 b) internal pure returns (bytes4[] memory l) {
        l = new bytes4[](2);
        (l[0], l[1]) = (a, b);
    }

    function _three(bytes4 a, bytes4 b, bytes4 c) internal pure returns (bytes4[] memory l) {
        l = new bytes4[](3);
        (l[0], l[1], l[2]) = (a, b, c);
    }

    function _swapHalts() internal pure returns (bytes4[] memory a) {
        a = new bytes4[](8);
        a[0] = PredictionHook.OutOfBand.selector;
        a[1] = PredictionHook.EpochCapExceeded.selector;
        a[2] = PredictionHook.Insolvent.selector;
        a[3] = PredictionHook.ZeroAmount.selector;
        a[4] = PredictionHook.NotTradable.selector;
        a[5] = PredictionHook.MarketClosed.selector;
        a[6] = QuoteMath.Band.selector;
        a[7] = QuoteMath.Unreachable.selector;
    }

    /* Opening */

    /// @dev One open, checked against what `canOpen()`, `nextOpenTime()` and `min(max, idle / 2)` said just before
    function _open(MarketScheduler s) internal {
        if (hook.marketCount() >= MAX_MARKETS) return;
        IMarketScheduler.Config memory c = s.config();
        uint256 slot = vm.getBlockTimestamp() / c.period;
        bool can = s.canOpen();
        bool due = s.nextOpenTime() <= vm.getBlockTimestamp();
        uint256 half = hook.vaultIdle() / 2;
        uint256 budget = half < c.maxBudget ? half : c.maxBudget;
        bytes32 tag = address(s) == address(tracks[0]) ? bytes32("open1m") : bytes32("open15m");
        try s.open() returns (uint256 id) {
            if (!can || !due) canOpenMismatches++;
            if (hook.marketInfo(id).bucket != budget) budgetMismatches++;
            slotOf[id] = slot;
            _approveMarket(id);
            ok[tag]++;
        } catch (bytes memory e) {
            if (can) canOpenMismatches++;
            _expected(
                e,
                _three(
                    IMarketScheduler.AlreadyOpened.selector,
                    IMarketScheduler.TooLate.selector,
                    IMarketScheduler.InsufficientIdle.selector
                )
            );
        }
    }

    function open(uint256 which) external counted {
        _open(tracks[which % 2]);
    }

    /// @dev Jump to the next quarter hour and open both tracks in the same block, in either order
    function openAtQuarter(bool fifteenFirst, uint256 topUp) public counted {
        if (hook.marketCount() + 2 > MAX_MARKETS) return;
        vm.warp((vm.getBlockTimestamp() / QUARTER + 1) * QUARTER);
        if (hook.vaultIdle() < 4e6) {
            vm.prank(lp);
            hook.deposit(bound(topUp, 4e6, 40e6));
        }
        uint256 before = hook.marketCount();
        _open(tracks[fifteenFirst ? 1 : 0]);
        _open(tracks[fifteenFirst ? 0 : 1]);
        if (hook.marketCount() == before + 2) sharedBlockOpens++;
        ok["quarter"]++;
    }

    function openAtQuarterAgain(bool fifteenFirst, uint256 topUp) external {
        openAtQuarter(fifteenFirst, topUp);
    }

    function openAtQuarterThird(bool fifteenFirst, uint256 topUp) external {
        openAtQuarter(fifteenFirst, topUp);
    }

    function _approveMarket(uint256 id) internal {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        for (uint256 j; j < actors.length; ++j) {
            vm.startPrank(actors[j]);
            OutcomeToken(i.yes).approve(address(swapRouter), type(uint256).max);
            OutcomeToken(i.no).approve(address(swapRouter), type(uint256).max);
            vm.stopPrank();
        }
    }

    /* Market selection */

    uint8 internal constant LIVE = 0;
    uint8 internal constant DUE = 1;
    uint8 internal constant ABANDONED = 2;
    uint8 internal constant RESOLVED = 3;

    function _matches(uint256 id, uint8 kind) internal view returns (bool) {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        uint256 t = vm.getBlockTimestamp();
        if (kind == RESOLVED) return i.status != IPredictionHook.Status.Trading;
        if (i.status != IPredictionHook.Status.Trading) return false;
        if (kind == LIVE) return t >= i.openTime && t + i.window + i.cutoffBuffer < i.expiry;
        if (kind == DUE) return t >= i.expiry;
        return t > i.expiry + hook.GRACE();
    }

    /// @dev The first market of `kind` at or after the seeded id, else the seeded id itself (0 without markets)
    function _pick(uint256 seed, uint8 kind) internal view returns (uint256) {
        uint256 n = hook.marketCount();
        if (n == 0) return 0;
        for (uint256 j; j < n; ++j) {
            uint256 id = 1 + (seed % n + j) % n;
            if (_matches(id, kind)) return id;
        }
        return 1 + seed % n;
    }

    function _redeemable(uint256 id, address a) internal view returns (uint256) {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        if (i.status == IPredictionHook.Status.Settled) return OutcomeToken(i.yesWon ? i.yes : i.no).balanceOf(a);
        if (i.status == IPredictionHook.Status.Invalid) {
            uint256 both = OutcomeToken(i.yes).balanceOf(a) + OutcomeToken(i.no).balanceOf(a);
            return both < 2 ? 0 : both;
        }
        return 0;
    }

    /* Trading */

    function _swap(address a, uint256 id, bool isYes, bool isBuy, uint256 amt) internal {
        (PoolKey memory ky, PoolKey memory kn) = hook.poolKeys(id);
        PoolKey memory k = isYes ? ky : kn;
        bool zf1 = isBuy == (Currency.unwrap(k.currency0) == address(usdc));
        SwapParams memory p = SwapParams({
            zeroForOne: zf1,
            amountSpecified: -int256(amt),
            sqrtPriceLimitX96: zf1 ? 4295128740 : 1461446703485210103287273052203988822378723970341
        });
        vm.prank(a);
        try swapRouter.swap(k, p, PoolSwapTest.TestSettings(false, false), "") {
            ok[isBuy ? bytes32("buy") : bytes32("sell")]++;
        } catch (bytes memory e) {
            _expected(e, _swapHalts());
        }
    }

    /// @dev Buys on a live market when there is one, otherwise on a closed one, which must halt
    function buy(uint256 who, uint256 m, bool isYes, uint256 amt) public counted {
        uint256 id = _pick(m, LIVE);
        if (id == 0) return;
        _swap(actors[who % actors.length], id, isYes, true, bound(amt, 1, 3e6));
    }

    function buyAgain(uint256 who, uint256 m, bool isYes, uint256 amt) external {
        buy(who, m, isYes, amt);
    }

    function sell(uint256 who, uint256 m, bool isYes, uint256 amt) public counted {
        address a = actors[who % actors.length];
        uint256 n = hook.marketCount();
        for (uint256 j; j < n; ++j) {
            uint256 id = 1 + (m % n + j) % n;
            if (!_matches(id, LIVE)) continue;
            IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
            uint256 bal = OutcomeToken(isYes ? i.yes : i.no).balanceOf(a);
            if (bal == 0) continue;
            _swap(a, id, isYes, false, bound(amt, 1, bal));
            return;
        }
    }

    function warp(uint256 dt) external counted {
        vm.warp(vm.getBlockTimestamp() + bound(dt, 1, 3 minutes));
    }

    function moveOracle(int256 dx) external counted {
        oracle.setLnSpot(lnK + bound(dx, -0.02e18, 0.02e18));
    }

    /* Resolution */

    function settle(uint256 m, int256 tickOff) public counted {
        uint256 id = _pick(m, DUE);
        if (id == 0) return;
        int256 t0 = hook.settleThresholdOf(id) / (int256(uint256(hook.marketInfo(id).window)) * 1e18);
        oracle.setFlatTick(int24(t0 + bound(tickOff, -2, 2)));
        try hook.settle(id) {
            ok["settle"]++;
        } catch (bytes memory e) {
            _expected(e, _two(PredictionHook.TooEarly.selector, PredictionHook.MarketClosed.selector));
        }
    }

    function settleAgain(uint256 m, int256 tickOff) external {
        settle(m, tickOff);
    }

    function settleInvalid(uint256 m) external counted {
        uint256 id = _pick(m, ABANDONED);
        if (id == 0) return;
        oracle.setUnavailable(true);
        try hook.settleInvalid(id) {
            ok["invalid"]++;
        } catch (bytes memory e) {
            _expected(e, _two(PredictionHook.TooEarly.selector, PredictionHook.MarketClosed.selector));
        }
        oracle.setUnavailable(false);
    }

    /// @dev Redemption of a resolved market never fails for a held amount with a nonzero payout
    function redeem(uint256 who, uint256 m, uint256 amt) external counted {
        address a = actors[who % actors.length];
        uint256 n = hook.marketCount();
        for (uint256 j; j < n; ++j) {
            uint256 id = 1 + (m % n + j) % n;
            uint256 bal = _redeemable(id, a);
            if (bal == 0) continue;
            bool inv = hook.marketInfo(id).status == IPredictionHook.Status.Invalid;
            amt = bound(amt, inv ? 2 : 1, bal);
            uint256 u0 = usdc.balanceOf(a);
            vm.prank(a);
            uint256 payout = hook.redeem(id, amt);
            assertEq(payout, inv ? amt / 2 : amt, "redeem payout");
            assertEq(usdc.balanceOf(a) - u0, payout, "redeem paid");
            ok["redeem"]++;
            return;
        }
    }

    /// @dev Sweeps a resolved market, exactly its excess over what winners can still redeem
    function sweep(uint256 m) public counted {
        uint256 id = _pick(m, RESOLVED);
        if (id == 0) return;
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        if (i.status == IPredictionHook.Status.Trading) {
            try hook.sweep(id) {
                revert("swept a trading market");
            } catch (bytes memory e) {
                _expected(e, _one(PredictionHook.NotSettled.selector));
            }
            return;
        }
        uint256 req =
            i.status == IPredictionHook.Status.Settled ? (i.yesWon ? i.outYes : i.outNo) : (i.outYes + i.outNo + 1) / 2;
        uint256 idle = hook.vaultIdle();
        uint256 amount = hook.sweep(id);
        assertEq(amount, i.bucket - req, "sweep amount");
        assertEq(hook.vaultIdle(), idle + amount, "sweep to idle");
        ok["sweep"]++;
    }

    function sweepAgain(uint256 m) external {
        sweep(m);
    }

    /* Vault */

    function deposit(uint256 amt) external counted {
        vm.prank(lp);
        hook.deposit(bound(amt, 1e6, 50e6));
        ok["deposit"]++;
    }

    function withdraw(uint256 shares) external counted {
        uint256 s = hook.sharesOf(lp);
        if (s == 0) return;
        vm.prank(lp);
        try hook.withdraw(bound(shares, 1, s)) {
            ok["withdraw"]++;
        } catch (bytes memory e) {
            _expected(e, _two(PredictionHook.InsufficientIdle.selector, PredictionHook.ZeroAmount.selector));
        }
    }
}

/// @notice Two schedulers sharing one vault, behind the gatekeeper that owns the hook
contract TracksInvariantTest is HookFixture {
    /// @dev 26 Sep 2026 14:00:00 UTC, a quarter-hour boundary
    uint256 internal constant START = 1_790_431_200;
    /// @dev The default profile's invariant depth (foundry.toml); every passing run makes at least this many calls
    uint256 internal constant MIN_DEPTH = 100;

    TracksHandler internal h;
    MarketGatekeeper internal gk;

    function setUp() public override {
        vm.warp(START);
        deployFreshManagerAndRouters();
        deployCodeTo("test/hook/mocks/MockUSDC.sol:MockUSDC", USDC_LOW);
        usdc = MockUSDC(USDC_LOW);
        oracle = new MockOracle();
        lnK = F.lnWad(2690.13e18);
        oracle.setLnSpot(lnK);
        oracle.setVar(VAR_60);

        // The live deploy order: the gatekeeper first, against a hook address with no code yet, then the hook
        address hookAddr = address(FLAGS | (uint160(0x7777) << 144));
        require(hookAddr.code.length == 0, "hook address already has code");
        gk = new MarketGatekeeper(IPredictionHook(hookAddr), withOracle(address(oracle), demoTracks()));
        deployCodeTo("src/PredictionHook.sol:PredictionHook", abi.encode(manager, USDC_LOW, address(gk)), hookAddr);
        hook = PredictionHook(hookAddr);

        h = new TracksHandler(hook, manager, swapRouter, usdc, oracle, lnK, gk);
        vm.prank(h.lp());
        hook.deposit(60e6);

        bytes4[] memory sel = new bytes4[](21);
        sel[0] = TracksHandler.open.selector;
        sel[1] = TracksHandler.open.selector;
        sel[2] = TracksHandler.openAtQuarter.selector;
        sel[3] = TracksHandler.openAtQuarterAgain.selector;
        sel[4] = TracksHandler.openAtQuarterThird.selector;
        sel[5] = TracksHandler.buy.selector;
        sel[6] = TracksHandler.buyAgain.selector;
        sel[7] = TracksHandler.buy.selector;
        sel[8] = TracksHandler.sell.selector;
        sel[9] = TracksHandler.sell.selector;
        sel[10] = TracksHandler.warp.selector;
        sel[11] = TracksHandler.moveOracle.selector;
        sel[12] = TracksHandler.settle.selector;
        sel[13] = TracksHandler.settleAgain.selector;
        sel[14] = TracksHandler.settleInvalid.selector;
        sel[15] = TracksHandler.redeem.selector;
        sel[16] = TracksHandler.redeem.selector;
        sel[17] = TracksHandler.sweep.selector;
        sel[18] = TracksHandler.sweepAgain.selector;
        sel[19] = TracksHandler.deposit.selector;
        sel[20] = TracksHandler.withdraw.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: ci.invariant.fail-on-revert = true
    function invariant_ledgerAndSolvency() public view {
        _checkInvariants();
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: ci.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(h.unexpected(), 0, string(h.lastUnexpected()));
        assertEq(h.canOpenMismatches(), 0, "open() disagreed with canOpen() or nextOpenTime()");
        assertEq(h.budgetMismatches(), 0, "budget != min(maxBudget, idle / 2) at call time");
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: ci.invariant.fail-on-revert = true
    function invariant_tracks() public view {
        assertEq(hook.owner(), address(gk));
        assertEq(hook.keeper(), address(0));
        MarketScheduler s1m = h.track(0);
        MarketScheduler s15m = h.track(1);
        uint256[2] memory maxSlot;
        uint256 n = hook.marketCount();
        for (uint256 id = 1; id <= n; ++id) {
            address s = gk.schedulerOf(id);
            assertTrue(s == address(s1m) || s == address(s15m), "schedulerOf is a track");
            IMarketScheduler.Config memory c = IMarketScheduler(s).config();
            uint256 slot = h.slotOf(id);
            IPredictionHook.MarketParams memory p = hook.marketParams(id);
            assertEq(IMarketScheduler(s).marketOfSlot(slot), id, "marketOfSlot");
            assertEq(p.expiry, slot * c.period + c.tenor, "expiry == slot * period + tenor");
            assertGe(p.openTime, slot * c.period, "opened inside its slot");
            assertLt(p.openTime, IMarketScheduler(s).openDeadline(slot), "opened before the deadline");
            assertEq(p.window, c.window);
            assertEq(p.cutoffBuffer, c.cutoffBuffer);
            assertEq(p.nSamples, c.nSamples);
            assertGe(p.budget, c.minBudget);
            assertLe(p.budget, c.maxBudget);
            assertEq(p.yesSymbol, string.concat(c.ticker, "UP"));
            assertEq(p.noSymbol, string.concat(c.ticker, "DOWN"));
            uint256 t = s == address(s1m) ? 0 : 1;
            if (slot > maxSlot[t]) maxSlot[t] = slot;
        }
        _checkSchedule(s1m, maxSlot[0]);
        _checkSchedule(s15m, maxSlot[1]);
    }

    function _checkSchedule(MarketScheduler s, uint256 maxSlot) internal view {
        uint256 period = s.config().period;
        uint256 next = s.nextOpenTime();
        assertEq(s.lastSlot(), maxSlot, "lastSlot is the newest opened slot");
        assertEq(next % period, 0, "nextOpenTime is a slot start");
        assertGt(next, s.lastSlot() * period, "nextOpenTime after lastSlot");
        if (s.canOpen()) assertLe(next, vm.getBlockTimestamp(), "canOpen implies due");
    }

    /// @dev A full-depth run in which either track never opened, or the tracks never opened in the same block, fails
    ///      instead of passing vacuously. A shorter sequence (a shrunk or replayed counterexample) skips those checks,
    ///      so a persisted failure clears once its bug is fixed and shrinking keeps the real failure.
    function afterInvariant() public view {
        console2.log("markets", hook.marketCount(), "idle", hook.vaultIdle());
        console2.log("handler calls", h.calls());
        console2.log("open 1m / 15m", h.ok("open1m"), h.ok("open15m"));
        console2.log("shared-block opens", h.sharedBlockOpens(), "quarters", h.ok("quarter"));
        console2.log("buy / sell ok", h.ok("buy"), h.ok("sell"));
        console2.log("settle / invalid / redeem", h.ok("settle"), h.ok("invalid"), h.ok("redeem"));
        console2.log("sweep / deposit / withdraw", h.ok("sweep"), h.ok("deposit"), h.ok("withdraw"));
        assertEq(hook.marketCount(), h.ok("open1m") + h.ok("open15m"), "every market came from a track");
        if (h.calls() < MIN_DEPTH) return;
        assertGe(h.ok("open1m"), 1, "1m opened");
        assertGe(h.ok("open15m"), 1, "15m opened");
        assertGe(h.sharedBlockOpens(), 1, "both tracks opened in one block");
    }
}
