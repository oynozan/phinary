// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {LibString} from "solady/utils/LibString.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {PredictionHook} from "../../src/PredictionHook.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
import {IUnderlyingOracle} from "../../src/interfaces/IUnderlyingOracle.sol";
import {MarketScheduler} from "../../src/MarketScheduler.sol";
import {MarketGatekeeper} from "../../src/MarketGatekeeper.sol";
import {IMarketGatekeeper} from "../../src/interfaces/IMarketGatekeeper.sol";
import {IMarketScheduler} from "../../src/interfaces/IMarketScheduler.sol";
import {MarketNames} from "../../src/lib/MarketNames.sol";
import {MockUSDC} from "../hook/mocks/MockUSDC.sol";
import {TracksFixture, track1m} from "./TracksFixture.sol";

/// @notice One scheduler per test set, deployed as the only track of its own gatekeeper, on the 1m track config
contract MarketSchedulerTest is TracksFixture {
    uint32 internal constant PERIOD = 60;
    uint32 internal constant TENOR = 60;
    uint32 internal constant WINDOW = 10;
    uint32 internal constant CUTOFF = 2;
    uint256 internal constant MAX_BUDGET = 10 * E6;
    uint256 internal constant MIN_BUDGET = 1 * E6;

    MockUSDC internal usdc;
    PredictionHook internal hook;
    MarketScheduler internal scheduler;
    IMarketGatekeeper internal gatekeeper;

    address internal lp = makeAddr("lp");

    function setUp() public {
        _setUpShared();
        (usdc, hook, scheduler) = _deploy(_config());
        gatekeeper = scheduler.gatekeeper();
        _deposit(hook, usdc, lp, 1_000_000 * E6);
    }

    /* Config and deployment helpers */

    function _config() internal pure returns (IMarketScheduler.Config memory c) {
        c = track1m();
        assert(c.period == PERIOD && c.tenor == TENOR && c.window == WINDOW && c.cutoffBuffer == CUTOFF);
        assert(c.maxBudget == MAX_BUDGET && c.minBudget == MIN_BUDGET);
    }

    function _deploy(IMarketScheduler.Config memory c)
        internal
        returns (MockUSDC u, PredictionHook h, MarketScheduler s)
    {
        MarketGatekeeper g;
        (u, h, g) = _deployTracks(_one(c));
        s = MarketScheduler(g.schedulers()[0]);
    }

    function _funded(IMarketScheduler.Config memory c) internal returns (PredictionHook h, MarketScheduler s) {
        MockUSDC u;
        (u, h, s) = _deploy(c);
        _deposit(h, u, lp, 100 * E6);
    }

    function _slotStart() internal view returns (uint256) {
        return (vm.getBlockTimestamp() / PERIOD) * PERIOD;
    }

    /* Tests */

    function test_anyoneOpens() public {
        vm.prank(address(0xBEEF));
        uint256 id = scheduler.open();
        assertEq(id, 1);
        assertEq(hook.marketCount(), 1);
        assertEq(scheduler.lastSlot(), vm.getBlockTimestamp() / PERIOD);
    }

    function test_secondOpenSameSlotReverts() public {
        scheduler.open();
        vm.expectRevert(
            abi.encodeWithSelector(IMarketScheduler.AlreadyOpened.selector, vm.getBlockTimestamp() / PERIOD)
        );
        scheduler.open();
    }

    function test_nextSlotOpens() public {
        scheduler.open();
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        uint256 id = scheduler.open();
        assertEq(id, 2);
        assertEq(scheduler.lastSlot(), vm.getBlockTimestamp() / PERIOD);
    }

    function test_expiryOnMinuteBoundary() public {
        uint256 slotStart = _slotStart();
        vm.warp(slotStart + TENOR - WINDOW - CUTOFF - 1);
        uint256 id = scheduler.open();
        assertEq(hook.marketInfo(id).expiry, slotStart + TENOR);
    }

    /// @dev With `tenor == period` a market expires exactly when the next slot starts, so markets run back to back
    function test_tenorEqualsPeriodRunsBackToBack() public {
        uint256 slotStart = _slotStart();
        uint256 a = scheduler.open();
        assertEq(hook.marketInfo(a).expiry, slotStart + PERIOD, "expiry == next slot start");

        vm.warp(slotStart + PERIOD);
        uint256 b = scheduler.open();
        assertEq(hook.marketInfo(b).openTime, hook.marketInfo(a).expiry, "next opens at the previous expiry");
        assertEq(hook.marketInfo(b).expiry, slotStart + 2 * PERIOD);
    }

    function test_tenorLongerThanPeriodOverlaps() public {
        IMarketScheduler.Config memory c = _config();
        c.tenor = 2 * PERIOD;
        (PredictionHook h, MarketScheduler s) = _funded(c);
        uint256 slotStart = _slotStart();

        vm.warp(slotStart + PERIOD - 1);
        uint256 a = s.open();
        vm.warp(slotStart + PERIOD);
        uint256 b = s.open();
        assertEq(h.marketInfo(a).expiry, slotStart + 2 * PERIOD);
        assertEq(h.marketInfo(b).expiry, slotStart + 3 * PERIOD);
        assertEq(s.openDeadline(slotStart / PERIOD), slotStart + 2 * PERIOD - WINDOW - CUTOFF);
    }

    function test_tenorShorterThanPeriodLeavesGaps() public {
        IMarketScheduler.Config memory c = _config();
        c.tenor = WINDOW + CUTOFF + 18;
        (PredictionHook h, MarketScheduler s) = _funded(c);
        uint256 slotStart = _slotStart();
        uint256 slot = slotStart / PERIOD;
        assertEq(s.openDeadline(slot), slotStart + 18);

        vm.warp(slotStart + 18);
        assertFalse(s.canOpen());
        assertEq(s.nextOpenTime(), slotStart + PERIOD);
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.TooLate.selector, slot));
        s.open();

        vm.warp(slotStart + PERIOD);
        uint256 id = s.open();
        assertEq(h.marketInfo(id).expiry, slotStart + PERIOD + c.tenor);
    }

    /// @dev setUp() fixes the oracle's spot at exactly 2690.13 and the clock at 26 Sep 14:00:00 UTC, so the names are
    ///      known literals, not just a round trip through the same MarketNames calls the scheduler itself uses.
    function test_namesAndSymbols() public {
        uint256 id = scheduler.open();
        IPredictionHook.MarketInfo memory info = hook.marketInfo(id);
        string memory yesName = IERC20Metadata(info.yes).name();
        string memory noName = IERC20Metadata(info.no).name();

        assertEq(IERC20Metadata(info.yes).symbol(), "ETHUP");
        assertEq(IERC20Metadata(info.no).symbol(), "ETHDOWN");
        assertEq(yesName, "ETH > $2690.13 26 Sep 14:01");
        assertEq(noName, "ETH < $2690.13 26 Sep 14:01");
        assertTrue(LibString.startsWith(yesName, "ETH > $"), "yes name prefix");

        // Cross-check against MarketNames in addition to (not instead of) the literals above.
        uint256 cents = MarketNames.strikeCents(oracle.lnSpotSoBWad());
        (string memory expectedYes, string memory expectedNo,,) = MarketNames.names("ETH", cents, info.expiry);
        assertEq(yesName, expectedYes);
        assertEq(noName, expectedNo);
    }

    function test_strikeMatchesScriptRounding() public {
        uint256 id = scheduler.open();
        int256 expected = MarketNames.lnStrikeWad(MarketNames.strikeCents(oracle.lnSpotSoBWad()));
        assertEq(hook.marketInfo(id).lnStrikeWad, expected);
    }

    /// @return The budget of the first market opened on a fresh vault holding `idle`
    function _budgetForIdle(uint256 idle) internal returns (uint256) {
        (MockUSDC u, PredictionHook h, MarketScheduler s) = _deploy(_config());
        _deposit(h, u, lp, idle);
        return h.marketInfo(s.open()).bucket;
    }

    function test_budgetRule() public {
        assertEq(_budgetForIdle(33 * E6), 10 * E6, "33 idle -> 10 budget");
        assertEq(_budgetForIdle(12 * E6), 6 * E6, "12 idle -> 6 budget");
        assertEq(_budgetForIdle(2 * MIN_BUDGET), MIN_BUDGET, "idle 2 * min -> exactly min");
        assertEq(_budgetForIdle(2 * MAX_BUDGET), MAX_BUDGET, "idle 2 * max -> exactly max");
        assertEq(_budgetForIdle(2 * MAX_BUDGET + 2), MAX_BUDGET, "idle / 2 == max + 1 -> max");

        (MockUSDC u, PredictionHook h, MarketScheduler s) = _deploy(_config());
        _deposit(h, u, lp, 2 * MIN_BUDGET - 1);
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.InsufficientIdle.selector, MIN_BUDGET - 1, MIN_BUDGET));
        s.open();
    }

    function test_ownerIsGatekeeperKeeperZero() public view {
        assertEq(hook.owner(), address(gatekeeper));
        assertEq(hook.keeper(), address(0));
        assertEq(address(scheduler.hook()), address(hook));
        assertEq(address(gatekeeper.hook()), address(hook));
        assertTrue(gatekeeper.isScheduler(address(scheduler)));
    }

    function test_eoaCreateMarketReverts() public {
        IPredictionHook.MarketParams memory p;
        vm.prank(address(0xABCD));
        vm.expectRevert(PredictionHook.Unauthorized.selector);
        hook.createMarket(p);
    }

    /// @dev The deployer (address(this), which deployed usdc/oracle/hook/gatekeeper in _deploy) has no more standing
    ///      than any other address: it is neither the hook's `owner` (the gatekeeper) nor `keeper` (never set), nor
    ///      one of the gatekeeper's schedulers, so every admin entry point rejects it.
    function test_deployerCannotAdministerHook() public {
        IPredictionHook.MarketParams memory p;
        vm.expectRevert(PredictionHook.Unauthorized.selector);
        hook.createMarket(p);

        vm.expectRevert(PredictionHook.Unauthorized.selector);
        hook.setKeeper(address(0xBEEF));

        vm.expectRevert(IMarketGatekeeper.NotScheduler.selector);
        gatekeeper.createMarket(p);
    }

    function test_oracleRevertKeepsSlot() public {
        oracle.setSpotUnavailable(true);
        vm.expectRevert(
            abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, uint32(vm.getBlockTimestamp()))
        );
        scheduler.open();
        assertEq(scheduler.lastSlot(), 0);
        assertEq(scheduler.marketOfSlot(vm.getBlockTimestamp() / PERIOD), 0);

        oracle.setSpotUnavailable(false);
        uint256 id = scheduler.open();
        assertEq(id, 1);
        assertEq(scheduler.lastSlot(), vm.getBlockTimestamp() / PERIOD);
    }

    function test_canOpenMirrorsOpen() public {
        assertTrue(scheduler.canOpen());
        scheduler.open();
        assertFalse(scheduler.canOpen());
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        assertTrue(scheduler.canOpen());

        // Idle below 2*minBudget: budget = min(maxBudget, idle/2) would be below minBudget, so open() must revert
        // and canOpen() must say so up front, not just once open() is actually called (the contract is immutable,
        // so this can never be patched after deploy).
        (,, MarketScheduler sLow) = _deploy(_config());
        assertFalse(sLow.canOpen(), "fresh vault, idle 0 < 2*minBudget");
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.InsufficientIdle.selector, 0, MIN_BUDGET));
        sLow.open();

        // A reverting spot read must also show up in canOpen() before open() is ever called.
        oracle.setSpotUnavailable(true);
        assertFalse(scheduler.canOpen(), "oracle revert");
        vm.expectRevert(
            abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, uint32(vm.getBlockTimestamp()))
        );
        scheduler.open();
        oracle.setSpotUnavailable(false);

        // A spot so low that the strike rounds to 0 cents makes open() revert on ln(0), so canOpen() says no.
        oracle.setLnSpot(-7e18);
        assertEq(MarketNames.strikeCents(oracle.lnSpotSoBWad()), 0);
        assertFalse(scheduler.canOpen(), "zero strike");
        vm.expectRevert(F.LnWadUndefined.selector);
        scheduler.open();
        oracle.setLnSpot(F.lnWad(2690.13e18));
        assertTrue(scheduler.canOpen());

        // Past the slot's deadline the hook would reject the market, so canOpen() already says no.
        vm.warp(scheduler.openDeadline(vm.getBlockTimestamp() / PERIOD));
        assertFalse(scheduler.canOpen(), "past the deadline");
    }

    function test_openDeadline() public {
        uint256 slot = vm.getBlockTimestamp() / PERIOD;
        uint256 deadline = scheduler.openDeadline(slot);
        assertEq(deadline, slot * PERIOD + TENOR - WINDOW - CUTOFF);

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.TooLate.selector, slot));
        scheduler.open();
        assertEq(scheduler.lastSlot(), 0, "a TooLate open leaves lastSlot");

        vm.warp(scheduler.openDeadline(slot + 1) - 1);
        uint256 id = scheduler.open();
        IPredictionHook.MarketInfo memory info = hook.marketInfo(id);
        assertEq(info.openTime + info.window + info.cutoffBuffer + 1, info.expiry, "last second the hook accepts");
    }

    /// @dev Past the deadline the slot is named even when the budget or the oracle would also fail
    function test_tooLateBeforeBudgetAndOracle() public {
        uint256 slot = vm.getBlockTimestamp() / PERIOD;
        (,, MarketScheduler unfunded) = _deploy(_config());
        vm.warp(unfunded.openDeadline(slot));
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.TooLate.selector, slot));
        unfunded.open();

        oracle.setSpotUnavailable(true);
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.TooLate.selector, slot));
        scheduler.open();
    }

    function test_nextOpenTimeBeforeFirstOpen() public {
        uint256 slotStart = _slotStart();
        assertEq(scheduler.lastSlot(), 0);
        assertEq(scheduler.nextOpenTime(), slotStart, "due now");
        assertTrue(scheduler.canOpen());

        vm.warp(scheduler.openDeadline(slotStart / PERIOD));
        assertEq(scheduler.nextOpenTime(), slotStart + PERIOD, "current slot lost");
        assertFalse(scheduler.canOpen());
    }

    function test_nextOpenTimeAfterSkippedSlot() public {
        uint256 slotStart = _slotStart();
        scheduler.open();
        assertEq(scheduler.nextOpenTime(), slotStart + PERIOD);
        assertFalse(scheduler.canOpen());

        vm.warp(slotStart + 2 * PERIOD + 5);
        assertEq(scheduler.nextOpenTime(), slotStart + 2 * PERIOD, "skipped slot, the current one is due");
        assertTrue(scheduler.canOpen());

        vm.warp(scheduler.openDeadline(slotStart / PERIOD + 2));
        assertEq(scheduler.nextOpenTime(), slotStart + 3 * PERIOD, "current slot past its deadline");
        assertFalse(scheduler.canOpen());
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.TooLate.selector, slotStart / PERIOD + 2));
        scheduler.open();

        vm.warp(slotStart + 3 * PERIOD);
        assertTrue(scheduler.canOpen());
        scheduler.open();
        assertEq(scheduler.nextOpenTime(), slotStart + 4 * PERIOD);
    }

    function test_marketOfSlot() public {
        uint256 slot = vm.getBlockTimestamp() / PERIOD;
        uint256 a = scheduler.open();
        assertEq(scheduler.marketOfSlot(slot), a);

        vm.warp(scheduler.openDeadline(slot + 1));
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.TooLate.selector, slot + 1));
        scheduler.open();

        vm.warp((slot + 2) * PERIOD);
        uint256 b = scheduler.open();
        assertEq(scheduler.marketOfSlot(slot), a);
        assertEq(scheduler.marketOfSlot(slot + 1), 0, "skipped slot");
        assertEq(scheduler.marketOfSlot(slot + 2), b);
        assertEq(scheduler.marketOfSlot(slot + 3), 0, "future slot");
    }

    /// @dev The indexer's MarketOpened handler updates the row that the hook's MarketCreated inserted
    function test_marketOpenedFollowsMarketCreated() public {
        uint256 slot = vm.getBlockTimestamp() / PERIOD;
        vm.recordLogs();
        vm.prank(address(0xBEEF));
        scheduler.open();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 created = type(uint256).max;
        uint256 opened = type(uint256).max;
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics[0];
            if (logs[i].emitter == address(hook) && t0 == IPredictionHook.MarketCreated.selector) created = i;
            if (logs[i].emitter == address(scheduler) && t0 == IMarketScheduler.MarketOpened.selector) opened = i;
        }
        assertLt(created, opened, "MarketCreated before MarketOpened");
        assertEq(uint256(logs[opened].topics[1]), 1, "marketId");
        assertEq(uint256(logs[opened].topics[2]), slot, "slot");
        assertEq(address(uint160(uint256(logs[opened].topics[3]))), address(0xBEEF), "caller");
        (uint256 budget, uint256 cents) = abi.decode(logs[opened].data, (uint256, uint256));
        assertEq(budget, MAX_BUDGET);
        assertEq(cents, 2690_13);
    }

    /// @dev `tenor <= window + cutoffBuffer` is the only tenor rule, the shortest tenor still opens at a slot's start
    function test_constructorRejectsShortTenor() public {
        IMarketScheduler.Config memory c = _config();
        c.tenor = WINDOW + CUTOFF;
        vm.expectRevert(IMarketScheduler.InvalidConfig.selector);
        this.deployScheduler(IPredictionHook(address(hook)), gatekeeper, address(oracle), c);

        c.tenor = WINDOW + CUTOFF + 1;
        (PredictionHook h, MarketScheduler s) = _funded(c);
        uint256 slotStart = _slotStart();
        assertEq(s.openDeadline(slotStart / PERIOD), slotStart + 1);
        uint256 id = s.open();
        assertEq(h.marketInfo(id).expiry, slotStart + c.tenor);
    }

    /// @dev Every branch of the constructor's InvalidConfig check, one config field at a time. The oracle/qEpochMax
    ///      /pMinWad branches mirror the hook's own createMarket validation (PredictionHook.sol createMarket): a
    ///      scheduler built without them deploys, but every open() reverts InvalidParams forever, since the
    ///      scheduler's config is immutable. The 365-day bound on period and tenor does the same for the
    ///      `lastSlot == 0` sentinel (AlreadyOpened(0) forever) and the hook's uint32 expiry (InvalidParams).
    function test_constructorRejectsInvalidConfigs() public {
        IMarketScheduler.Config memory periodZero = _config();
        periodZero.period = 0;
        _expectInvalidConfig(periodZero, gatekeeper, address(oracle));

        IMarketScheduler.Config memory windowZero = _config();
        windowZero.window = 0;
        _expectInvalidConfig(windowZero, gatekeeper, address(oracle));

        IMarketScheduler.Config memory shortTenor = _config();
        shortTenor.tenor = WINDOW + CUTOFF;
        _expectInvalidConfig(shortTenor, gatekeeper, address(oracle));

        IMarketScheduler.Config memory longPeriod = _config();
        longPeriod.period = 365 days + 1;
        _expectInvalidConfig(longPeriod, gatekeeper, address(oracle));

        IMarketScheduler.Config memory longTenor = _config();
        longTenor.tenor = 365 days + 1;
        _expectInvalidConfig(longTenor, gatekeeper, address(oracle));

        IMarketScheduler.Config memory emptyTicker = _config();
        emptyTicker.ticker = "";
        _expectInvalidConfig(emptyTicker, gatekeeper, address(oracle));

        IMarketScheduler.Config memory longTicker = _config();
        longTicker.ticker = "TOOLONG"; // 7 chars
        _expectInvalidConfig(longTicker, gatekeeper, address(oracle));

        IMarketScheduler.Config memory minZero = _config();
        minZero.minBudget = 0;
        _expectInvalidConfig(minZero, gatekeeper, address(oracle));

        IMarketScheduler.Config memory minAboveMax = _config();
        minAboveMax.minBudget = minAboveMax.maxBudget + 1;
        _expectInvalidConfig(minAboveMax, gatekeeper, address(oracle));

        _expectInvalidConfig(_config(), IMarketGatekeeper(address(0)), address(oracle));
        _expectInvalidConfig(_config(), gatekeeper, address(0));

        IMarketScheduler.Config memory zeroQEpochMax = _config();
        zeroQEpochMax.quote.qEpochMax = 0;
        _expectInvalidConfig(zeroQEpochMax, gatekeeper, address(oracle));

        IMarketScheduler.Config memory zeroPMin = _config();
        zeroPMin.quote.pMinWad = 0;
        _expectInvalidConfig(zeroPMin, gatekeeper, address(oracle));

        IMarketScheduler.Config memory pMinTooHigh = _config();
        pMinTooHigh.quote.pMinWad = 0.5e18; // >= WAD/2
        _expectInvalidConfig(pMinTooHigh, gatekeeper, address(oracle));
    }

    /// @dev The longest period and tenor the constructor accepts still open: the slot is far above 0 and the expiry
    ///      fits the hook's uint32
    function test_longestPeriodAndTenorOpen() public {
        IMarketScheduler.Config memory c = _config();
        c.period = 365 days;
        c.tenor = 365 days;
        (PredictionHook h, MarketScheduler s) = _funded(c);
        uint256 slot = vm.getBlockTimestamp() / c.period;
        assertGt(slot, 0);
        assertTrue(s.canOpen());
        uint256 id = s.open();
        assertEq(h.marketInfo(id).expiry, (slot + 1) * c.period);
    }

    function _expectInvalidConfig(IMarketScheduler.Config memory c, IMarketGatekeeper g, address oracleAddr) internal {
        vm.expectRevert(IMarketScheduler.InvalidConfig.selector);
        this.deployScheduler(IPredictionHook(address(hook)), g, oracleAddr, c);
    }

    function testFuzz_opensBeforeDeadline(uint256 s) public {
        uint256 slotStart = _slotStart();
        vm.warp(slotStart + bound(s, 0, TENOR - WINDOW - CUTOFF - 1));
        uint256 id = scheduler.open();
        assertEq(hook.marketCount(), id);
        assertEq(scheduler.marketOfSlot(slotStart / PERIOD), id);
        IPredictionHook.MarketInfo memory info = hook.marketInfo(id);
        assertEq(info.openTime, vm.getBlockTimestamp());
        assertEq(info.expiry, slotStart + TENOR);
        assertTrue(info.openTime + info.window + info.cutoffBuffer < info.expiry, "hook accepted the params");
    }

    function testFuzz_tooLateFromDeadline(uint256 s) public {
        uint256 slotStart = _slotStart();
        vm.warp(slotStart + bound(s, TENOR - WINDOW - CUTOFF, PERIOD - 1));
        assertFalse(scheduler.canOpen());
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.TooLate.selector, slotStart / PERIOD));
        scheduler.open();
        assertEq(scheduler.lastSlot(), 0);
        assertEq(scheduler.nextOpenTime(), slotStart + PERIOD);
    }

    /// @dev With budget and oracle fine, `nextOpenTime() <= now` exactly when `canOpen()`, and `open()` agrees
    function testFuzz_nextOpenTimeAgreesWithOpen(uint256 seed) public {
        for (uint256 i; i < 12; ++i) {
            vm.warp(vm.getBlockTimestamp() + 1 + uint256(keccak256(abi.encode(seed, i))) % 150);
            uint256 slot = vm.getBlockTimestamp() / PERIOD;
            uint256 next = scheduler.nextOpenTime();
            bool due = next <= vm.getBlockTimestamp();
            assertEq(scheduler.canOpen(), due, "canOpen == due");
            if (due) {
                assertEq(next, slot * PERIOD, "the due slot is the current one");
                uint256 id = scheduler.open();
                assertEq(scheduler.marketOfSlot(slot), id);
            } else {
                assertEq(next, (slot + 1) * PERIOD, "not due means the next slot");
                bytes4 sel = slot <= scheduler.lastSlot()
                    ? IMarketScheduler.AlreadyOpened.selector
                    : IMarketScheduler.TooLate.selector;
                vm.expectRevert(abi.encodeWithSelector(sel, slot));
                scheduler.open();
            }
            assertGt(scheduler.nextOpenTime(), vm.getBlockTimestamp(), "nothing due right after");
        }
    }
}
