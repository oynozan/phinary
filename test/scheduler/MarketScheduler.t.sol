// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {PredictionHook} from "../../src/PredictionHook.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
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

    function test_namesAndSymbols() public {
        uint256 id = scheduler.open();
        IPredictionHook.MarketInfo memory info = hook.marketInfo(id);
        uint256 cents = MarketNames.strikeCents(oracle.lnSpotSoBWad());
        (string memory yesName, string memory noName, string memory yesSymbol, string memory noSymbol) =
            MarketNames.names("ETH", cents, info.expiry);
        assertEq(IERC20Metadata(info.yes).name(), yesName);
        assertEq(IERC20Metadata(info.yes).symbol(), yesSymbol);
        assertEq(IERC20Metadata(info.no).name(), noName);
        assertEq(IERC20Metadata(info.no).symbol(), noSymbol);
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

    function test_oracleRevertKeepsSlot() public {
        oracle.setSpotUnavailable(true);
        vm.expectRevert();
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
    }

    function test_constructorRejectsShortTenor() public {
        IMarketScheduler.Config memory c = _config();
        c.tenor = PERIOD + WINDOW + CUTOFF - 1;
        vm.expectRevert(IMarketScheduler.InvalidConfig.selector);
        new MarketScheduler(IPredictionHook(address(hook)), address(oracle), c);
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
