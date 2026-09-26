// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {LibString} from "solady/utils/LibString.sol";
import {PredictionHook} from "../../src/PredictionHook.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
import {IUnderlyingOracle} from "../../src/interfaces/IUnderlyingOracle.sol";
import {MarketScheduler} from "../../src/MarketScheduler.sol";
import {IMarketScheduler} from "../../src/interfaces/IMarketScheduler.sol";
import {MarketNames} from "../../src/lib/MarketNames.sol";
import {MockOracle} from "../hook/mocks/MockOracle.sol";
import {MockUSDC} from "../hook/mocks/MockUSDC.sol";

/// @notice One PoolManager and oracle shared by every hook+scheduler pair the tests deploy; each pair gets its own
///         hook address (permission bits in the low bits, a bumped salt in the high bits) and its own USDC so idle
///         balances stay under test control.
contract MarketSchedulerTest is Test, Deployers {
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.BEFORE_DONATE_FLAG
    );
    uint256 internal constant E6 = 1e6;
    uint256 internal constant T0 = 1_750_000_000;

    uint32 internal constant PERIOD = 60;
    uint32 internal constant TENOR = 120;
    uint32 internal constant WINDOW = 10;
    uint32 internal constant CUTOFF = 2;
    uint32 internal constant N_SAMPLES = 10;
    uint256 internal constant MAX_BUDGET = 10 * E6;
    uint256 internal constant MIN_BUDGET = 1 * E6;

    MockOracle internal oracle;
    MockUSDC internal usdc;
    PredictionHook internal hook;
    MarketScheduler internal scheduler;

    address internal lp = makeAddr("lp");
    uint160 internal _hookSalt = 0x4444;

    function setUp() public {
        vm.warp(T0);
        deployFreshManagerAndRouters();
        oracle = new MockOracle();
        oracle.setLnSpot(F.lnWad(2690.13e18));

        (usdc, hook, scheduler) = _deploy(_config());
        _deposit(hook, usdc, lp, 1_000_000 * E6);
    }

    /* Config and deployment helpers */

    function _config() internal pure returns (IMarketScheduler.Config memory c) {
        c.period = PERIOD;
        c.tenor = TENOR;
        c.window = WINDOW;
        c.cutoffBuffer = CUTOFF;
        c.nSamples = N_SAMPLES;
        c.quote = IPredictionHook.QuoteParams({
            h0Wad: 0.02e18,
            gammaSWad: 0.00002e18,
            lambdaWad: 0.001e18,
            qEpochMax: uint128(100 * E6),
            pMinWad: 0.02e18
        });
        c.maxBudget = MAX_BUDGET;
        c.minBudget = MIN_BUDGET;
        c.ticker = "ETH";
    }

    /// @dev Deploys a fresh USDC and hook, with the hook's owner predicted as the scheduler's CREATE2 address (the
    ///      hook address is chosen up front, so the scheduler's constructor args, and hence its init code hash, are
    ///      fully known before either contract exists).
    function _deploy(IMarketScheduler.Config memory c)
        internal
        returns (MockUSDC u, PredictionHook h, MarketScheduler s)
    {
        u = new MockUSDC();
        address hookAddr = address(FLAGS | (_hookSalt << 144));
        bytes32 salt = bytes32(uint256(_hookSalt));
        _hookSalt += 1;

        bytes memory initCode =
            abi.encodePacked(type(MarketScheduler).creationCode, abi.encode(IPredictionHook(hookAddr), address(oracle), c));
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), address(this));

        deployCodeTo("src/PredictionHook.sol:PredictionHook", abi.encode(manager, address(u), predicted), hookAddr);
        h = PredictionHook(hookAddr);
        s = new MarketScheduler{salt: salt}(IPredictionHook(hookAddr), address(oracle), c);
        require(address(s) == predicted, "scheduler address prediction mismatch");
    }

    function _deposit(PredictionHook h, MockUSDC u, address who, uint256 amt) internal {
        u.mint(who, amt);
        vm.startPrank(who);
        u.approve(address(h), amt);
        h.deposit(amt);
        vm.stopPrank();
    }

    /* Tests */

    function test_anyoneOpens() public {
        vm.prank(address(0xBEEF));
        uint256 id = scheduler.open();
        assertEq(id, 1);
        assertEq(hook.marketCount(), 1);
        assertEq(scheduler.lastSlot(), block.timestamp / PERIOD);
    }

    function test_secondOpenSameSlotReverts() public {
        scheduler.open();
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.AlreadyOpened.selector, block.timestamp / PERIOD));
        scheduler.open();
    }

    function test_nextSlotOpens() public {
        scheduler.open();
        vm.warp(block.timestamp + PERIOD);
        uint256 id = scheduler.open();
        assertEq(id, 2);
        assertEq(scheduler.lastSlot(), block.timestamp / PERIOD);
    }

    function test_expiryOnMinuteBoundary() public {
        uint256 slotStart = (block.timestamp / PERIOD) * PERIOD;
        vm.warp(slotStart + 59);
        uint256 id = scheduler.open();
        assertEq(hook.marketInfo(id).expiry, slotStart + TENOR);
    }

    /// @dev setUp() fixes the oracle's spot at exactly 2690.13, so the strike is exactly $2690.13; this asserts
    ///      literal strings, not just a round trip through the same MarketNames calls the scheduler itself uses.
    function test_namesAndSymbols() public {
        uint256 id = scheduler.open();
        IPredictionHook.MarketInfo memory info = hook.marketInfo(id);
        string memory yesName = IERC20Metadata(info.yes).name();
        string memory noName = IERC20Metadata(info.no).name();

        assertEq(IERC20Metadata(info.yes).symbol(), "ETHUP");
        assertEq(IERC20Metadata(info.no).symbol(), "ETHDOWN");
        assertTrue(LibString.startsWith(yesName, "ETH > $"), "yes name prefix");
        assertTrue(LibString.startsWith(noName, "ETH < $"), "no name prefix");
        assertTrue(LibString.contains(yesName, "$2690.13"), "yes name strike");
        assertTrue(LibString.contains(noName, "$2690.13"), "no name strike");

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

    function test_budgetRule() public {
        (MockUSDC u1, PredictionHook h1, MarketScheduler s1) = _deploy(_config());
        _deposit(h1, u1, lp, 33 * E6);
        uint256 id1 = s1.open();
        assertEq(h1.marketInfo(id1).bucket, 10 * E6, "33 idle -> 10 budget");

        (MockUSDC u2, PredictionHook h2, MarketScheduler s2) = _deploy(_config());
        _deposit(h2, u2, lp, 12 * E6);
        uint256 id2 = s2.open();
        assertEq(h2.marketInfo(id2).bucket, 6 * E6, "12 idle -> 6 budget");

        (MockUSDC u3, PredictionHook h3, MarketScheduler s3) = _deploy(_config());
        _deposit(h3, u3, lp, 3 * E6 / 2);
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.InsufficientIdle.selector, 3 * E6 / 4, MIN_BUDGET));
        s3.open();
    }

    function test_ownerIsSchedulerKeeperZero() public view {
        assertEq(hook.owner(), address(scheduler));
        assertEq(hook.keeper(), address(0));
    }

    function test_eoaCreateMarketReverts() public {
        IPredictionHook.MarketParams memory p;
        vm.prank(address(0xABCD));
        vm.expectRevert(PredictionHook.Unauthorized.selector);
        hook.createMarket(p);
    }

    /// @dev The deployer (address(this), which deployed usdc/oracle/hook/scheduler in _deploy) has no more
    ///      standing with the hook than any other address: it is neither `owner` (the scheduler) nor `keeper`
    ///      (never set), so both admin entry points reject it.
    function test_deployerCannotAdministerHook() public {
        IPredictionHook.MarketParams memory p;
        vm.expectRevert(PredictionHook.Unauthorized.selector);
        hook.createMarket(p);

        vm.expectRevert(PredictionHook.Unauthorized.selector);
        hook.setKeeper(address(0xBEEF));
    }

    function test_oracleRevertKeepsSlot() public {
        oracle.setSpotUnavailable(true);
        vm.expectRevert(
            abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, uint32(block.timestamp))
        );
        scheduler.open();
        assertEq(scheduler.lastSlot(), 0);

        oracle.setSpotUnavailable(false);
        uint256 id = scheduler.open();
        assertEq(id, 1);
        assertEq(scheduler.lastSlot(), block.timestamp / PERIOD);
    }

    function test_canOpenMirrorsOpen() public {
        assertTrue(scheduler.canOpen());
        scheduler.open();
        assertFalse(scheduler.canOpen());
        vm.warp(block.timestamp + PERIOD);
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
            abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, uint32(block.timestamp))
        );
        scheduler.open();
        oracle.setSpotUnavailable(false);
    }

    function test_constructorRejectsShortTenor() public {
        IMarketScheduler.Config memory c = _config();
        c.tenor = PERIOD + WINDOW + CUTOFF - 1;
        vm.expectRevert(IMarketScheduler.InvalidConfig.selector);
        new MarketScheduler(IPredictionHook(address(hook)), address(oracle), c);
    }

    /// @dev Every branch of the constructor's InvalidConfig check, one config field at a time. The oracle/qEpochMax
    ///      /pMinWad branches mirror the hook's own createMarket validation (PredictionHook.sol createMarket): a
    ///      scheduler built without them deploys, but every open() reverts InvalidParams forever, since the
    ///      scheduler's config is immutable.
    function test_constructorRejectsInvalidConfigs() public {
        IMarketScheduler.Config memory periodZero = _config();
        periodZero.period = 0;
        _expectInvalidConfig(periodZero, address(oracle));

        IMarketScheduler.Config memory shortTenor = _config();
        shortTenor.tenor = PERIOD + WINDOW + CUTOFF - 1;
        _expectInvalidConfig(shortTenor, address(oracle));

        IMarketScheduler.Config memory emptyTicker = _config();
        emptyTicker.ticker = "";
        _expectInvalidConfig(emptyTicker, address(oracle));

        IMarketScheduler.Config memory longTicker = _config();
        longTicker.ticker = "TOOLONG"; // 7 chars
        _expectInvalidConfig(longTicker, address(oracle));

        IMarketScheduler.Config memory minAboveMax = _config();
        minAboveMax.minBudget = minAboveMax.maxBudget + 1;
        _expectInvalidConfig(minAboveMax, address(oracle));

        _expectInvalidConfig(_config(), address(0)); // oracle == address(0)

        IMarketScheduler.Config memory zeroQEpochMax = _config();
        zeroQEpochMax.quote.qEpochMax = 0;
        _expectInvalidConfig(zeroQEpochMax, address(oracle));

        IMarketScheduler.Config memory zeroPMin = _config();
        zeroPMin.quote.pMinWad = 0;
        _expectInvalidConfig(zeroPMin, address(oracle));

        IMarketScheduler.Config memory pMinTooHigh = _config();
        pMinTooHigh.quote.pMinWad = 0.5e18; // >= WAD/2
        _expectInvalidConfig(pMinTooHigh, address(oracle));
    }

    function _expectInvalidConfig(IMarketScheduler.Config memory c, address oracleAddr) internal {
        vm.expectRevert(IMarketScheduler.InvalidConfig.selector);
        new MarketScheduler(IPredictionHook(address(hook)), oracleAddr, c);
    }

    function testFuzz_openAnySecondOfSlot(uint256 s) public {
        uint256 slotStart = (block.timestamp / PERIOD) * PERIOD;
        vm.warp(slotStart + (s % PERIOD));
        uint256 id = scheduler.open();
        assertEq(hook.marketCount(), id);
        IPredictionHook.MarketInfo memory info = hook.marketInfo(id);
        assertEq(info.openTime, block.timestamp);
        assertTrue(info.openTime + info.window + info.cutoffBuffer < info.expiry, "hook accepted the params");
    }
}
