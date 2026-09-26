// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PredictionHook} from "../../src/PredictionHook.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
import {MarketScheduler} from "../../src/MarketScheduler.sol";
import {MarketGatekeeper} from "../../src/MarketGatekeeper.sol";
import {IMarketGatekeeper} from "../../src/interfaces/IMarketGatekeeper.sol";
import {IMarketScheduler} from "../../src/interfaces/IMarketScheduler.sol";
import {MarketNames} from "../../src/lib/MarketNames.sol";
import {MockUSDC} from "../hook/mocks/MockUSDC.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {TracksFixture, trackConfig, track1m, track15m, solTrack, demoTracks, withOracle} from "./TracksFixture.sol";

/// @dev Answers every createMarket with one fixed id and touches no hook
contract FakeGatekeeper {
    uint256 internal immutable _id;

    constructor(uint256 id) {
        _id = id;
    }

    function createMarket(IPredictionHook.MarketParams calldata) external view returns (uint256) {
        return _id;
    }
}

/// @notice The live track list (1m ETH, 15m ETH15M) behind one gatekeeper that owns one hook, from 26 Sep 14:00 UTC
contract MarketGatekeeperTest is TracksFixture {
    MockUSDC internal usdc;
    PredictionHook internal hook;
    MarketGatekeeper internal gk;
    MarketScheduler internal s1m;
    MarketScheduler internal s15m;

    address internal lp = makeAddr("lp");

    function setUp() public {
        _setUpShared();
        (usdc, hook, gk) = _deployTracks(demoTracks());
        address[] memory s = gk.schedulers();
        s1m = MarketScheduler(s[0]);
        s15m = MarketScheduler(s[1]);
        _deposit(hook, usdc, lp, 1_000 * E6);
    }

    function _info(PredictionHook h, uint256 id) internal view returns (IPredictionHook.MarketInfo memory) {
        return h.marketInfo(id);
    }

    function _assertToken(address token, string memory name, string memory symbol) internal view {
        assertEq(IERC20Metadata(token).name(), name);
        assertEq(IERC20Metadata(token).symbol(), symbol);
    }

    /* Deployment */

    function test_schedulersAreCreateChildren() public view {
        address[] memory s = gk.schedulers();
        assertEq(s.length, 2);
        assertEq(gk.schedulerCount(), 2);
        IMarketScheduler.Config[] memory cs = demoTracks();
        for (uint256 i; i < s.length; ++i) {
            assertEq(s[i], vm.computeCreateAddress(address(gk), i + 1), "S_i at nonce i + 1");
            IMarketScheduler sc = IMarketScheduler(s[i]);
            assertEq(address(sc.hook()), address(hook));
            assertEq(address(sc.gatekeeper()), address(gk));
            assertEq(sc.oracle(), address(oracle));
            assertEq(keccak256(abi.encode(sc.config())), keccak256(abi.encode(cs[i])), "config");
            assertEq(sc.lastSlot(), 0);
        }
        assertEq(address(gk.hook()), address(hook));
        assertEq(hook.owner(), address(gk));
        assertEq(hook.keeper(), address(0));
    }

    /// @dev The live deploy order (step L4) without the fixture: the gatekeeper and its schedulers are created while
    ///      the hook address has no code, then the hook lands there with the gatekeeper as `owner`
    function test_deploysBeforeTheHook() public {
        address hookAddr = _nextHookAddr();
        assertEq(hookAddr.code.length, 0);
        MarketGatekeeper g = new MarketGatekeeper(IPredictionHook(hookAddr), withOracle(address(oracle), demoTracks()));
        address[] memory s = g.schedulers();

        MockUSDC u = new MockUSDC();
        deployCodeTo("src/PredictionHook.sol:PredictionHook", abi.encode(manager, address(u), address(g)), hookAddr);
        PredictionHook h = PredictionHook(hookAddr);
        assertEq(h.owner(), address(g));
        _deposit(h, u, lp, 100 * E6);

        uint256 a = MarketScheduler(s[0]).open();
        uint256 b = MarketScheduler(s[1]).open();
        assertEq(h.marketCount(), 2);
        assertEq(g.schedulerOf(a), s[0]);
        assertEq(g.schedulerOf(b), s[1]);
    }

    function test_isScheduler() public view {
        assertTrue(gk.isScheduler(address(s1m)));
        assertTrue(gk.isScheduler(address(s15m)));
        assertFalse(gk.isScheduler(address(0)), "unused immutable slots are address(0)");
        assertFalse(gk.isScheduler(address(this)));
        assertFalse(gk.isScheduler(address(gk)));
        assertFalse(gk.isScheduler(address(hook)));
        assertFalse(gk.isScheduler(vm.computeCreateAddress(address(gk), 3)));
    }

    /// @dev Four tracks, the SOL one behind its own oracle; the deploy transaction stays far under the EIP-7825 per
    ///      transaction cap of 2^24 gas
    function test_fourTracks() public {
        IMarketGatekeeper.Track[] memory ts = withOracle(address(oracle), new IMarketScheduler.Config[](4));
        ts[0].config = track1m();
        ts[1].config = trackConfig(300, 10, 10, "ETH5M");
        ts[2] = IMarketGatekeeper.Track({oracle: address(solOracle), config: solTrack()});
        ts[3].config = trackConfig(3600, 60, 60, "ETH1H");

        (MarketGatekeeper g, uint256 txGas) = _deployMetered(IPredictionHook(_nextHookAddr()), ts);
        emit log_named_uint("4-track gatekeeper deploy tx gas", txGas);
        assertLt(txGas, 16_777_216 / 2, "well under the EIP-7825 cap");

        address[] memory s = g.schedulers();
        assertEq(s.length, 4);
        assertEq(g.schedulerCount(), 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(s[i], vm.computeCreateAddress(address(g), i + 1));
            assertTrue(g.isScheduler(s[i]));
            assertEq(IMarketScheduler(s[i]).config().ticker, ts[i].config.ticker);
            assertEq(IMarketScheduler(s[i]).oracle(), ts[i].oracle);
        }
    }

    /// @dev MAX_TRACKS: eight tracks over two oracles deploy, fill every immutable slot and all open in one block
    function test_eightTracks() public {
        IMarketGatekeeper.Track[] memory ts = _eight();
        (MockUSDC u, PredictionHook h, MarketGatekeeper g) = _deployTracks(ts);
        address[] memory s = g.schedulers();
        assertEq(s.length, 8);
        assertEq(g.schedulerCount(), 8);
        assertFalse(g.isScheduler(address(0)));
        assertFalse(g.isScheduler(vm.computeCreateAddress(address(g), 9)));
        for (uint256 i; i < 8; ++i) {
            assertEq(s[i], vm.computeCreateAddress(address(g), i + 1));
            assertTrue(g.isScheduler(s[i]));
            assertEq(IMarketScheduler(s[i]).oracle(), ts[i].oracle);
            assertEq(IMarketScheduler(s[i]).config().ticker, ts[i].config.ticker);
        }

        _deposit(h, u, lp, 1_000 * E6);
        for (uint256 i; i < 8; ++i) {
            uint256 id = MarketScheduler(s[i]).open();
            assertEq(id, i + 1);
            assertEq(g.schedulerOf(id), s[i]);
            assertEq(_info(h, id).oracle, ts[i].oracle);
        }
        assertEq(h.marketCount(), 8);

        (, uint256 txGas) = _deployMetered(IPredictionHook(_nextHookAddr()), ts);
        emit log_named_uint("8-track gatekeeper deploy tx gas", txGas);
        assertLt(txGas, 16_777_216, "under the EIP-7825 cap");
    }

    /* Per-track oracles */

    /// @dev Each scheduler hands the hook its own track's oracle and names its strike from that oracle's spot, both
    ///      at deploy and after one oracle moves while the other stays put
    function test_trackReadsItsOwnOracle() public {
        IMarketGatekeeper.Track[] memory ts = new IMarketGatekeeper.Track[](2);
        ts[0] = IMarketGatekeeper.Track({oracle: address(oracle), config: track1m()});
        ts[1] = IMarketGatekeeper.Track({oracle: address(solOracle), config: solTrack()});
        (MockUSDC u, PredictionHook h, MarketGatekeeper g) = _deployTracks(ts);
        _deposit(h, u, lp, 100 * E6);
        MarketScheduler eth = MarketScheduler(g.schedulers()[0]);
        MarketScheduler sol = MarketScheduler(g.schedulers()[1]);
        assertEq(eth.oracle(), address(oracle));
        assertEq(sol.oracle(), address(solOracle));

        IPredictionHook.MarketInfo memory e = _info(h, eth.open());
        IPredictionHook.MarketInfo memory o = _info(h, sol.open());
        assertEq(e.oracle, address(oracle));
        assertEq(o.oracle, address(solOracle));
        assertEq(e.lnStrikeWad, MarketNames.lnStrikeWad(2690_13));
        assertEq(o.lnStrikeWad, MarketNames.lnStrikeWad(187_42));
        _assertToken(o.yes, "SOL > $187.42 26 Sep 14:01", "SOLUP");
        _assertToken(o.no, "SOL < $187.42 26 Sep 14:01", "SOLDOWN");

        solOracle.setLnSpot(F.lnWad(190e18));
        vm.warp(T0 + 60);
        vm.expectEmit(address(sol));
        emit IMarketScheduler.MarketOpened(3, (T0 + 60) / 60, address(this), 10 * E6, 190_00);
        o = _info(h, sol.open());
        vm.expectEmit(address(eth));
        emit IMarketScheduler.MarketOpened(4, (T0 + 60) / 60, address(this), 10 * E6, 2690_13);
        e = _info(h, eth.open());
        assertEq(o.lnStrikeWad, MarketNames.lnStrikeWad(190_00), "SOL follows its own oracle");
        assertEq(e.lnStrikeWad, MarketNames.lnStrikeWad(2690_13), "ETH ignores the SOL move");
        _assertToken(o.yes, "SOL > $190.00 26 Sep 14:02", "SOLUP");

        oracle.setLnSpot(F.lnWad(2700.5e18));
        vm.warp(T0 + 120);
        e = _info(h, eth.open());
        o = _info(h, sol.open());
        assertEq(e.lnStrikeWad, MarketNames.lnStrikeWad(2700_50), "ETH follows its own oracle");
        assertEq(o.lnStrikeWad, MarketNames.lnStrikeWad(190_00), "SOL ignores the ETH move");
        _assertToken(e.yes, "ETH > $2700.50 26 Sep 14:03", "ETHUP");
    }

    /// @dev A SOL track whose oracle cannot read spot this block stays closed while the ETH tracks open; once the
    ///      SOL oracle recovers, all three tracks with two oracles open in one block
    function test_tracksWithDifferentOraclesOpenInOneBlock() public {
        IMarketGatekeeper.Track[] memory ts = withOracle(address(oracle), demoTracks());
        IMarketGatekeeper.Track[] memory three = new IMarketGatekeeper.Track[](3);
        three[0] = ts[0];
        three[1] = IMarketGatekeeper.Track({oracle: address(solOracle), config: solTrack()});
        three[2] = ts[1];
        (MockUSDC u, PredictionHook h, MarketGatekeeper g) = _deployTracks(three);
        _deposit(h, u, lp, 100 * E6);
        address[] memory s = g.schedulers();

        solOracle.setSpotUnavailable(true);
        assertFalse(MarketScheduler(s[1]).canOpen(), "SOL oracle down");
        assertTrue(MarketScheduler(s[0]).canOpen(), "ETH unaffected");
        vm.expectRevert();
        MarketScheduler(s[1]).open();

        solOracle.setSpotUnavailable(false);
        uint256 blockNumber = vm.getBlockNumber();
        for (uint256 i; i < 3; ++i) {
            uint256 id = MarketScheduler(s[i]).open();
            IPredictionHook.MarketInfo memory m = _info(h, id);
            assertEq(g.schedulerOf(id), s[i]);
            assertEq(m.oracle, three[i].oracle);
            assertEq(m.openTime, T0);
        }
        assertEq(vm.getBlockNumber(), blockNumber, "one block");
        assertEq(h.marketCount(), 3);
        assertEq(_info(h, 2).lnStrikeWad, MarketNames.lnStrikeWad(187_42));
        assertEq(_info(h, 3).lnStrikeWad, MarketNames.lnStrikeWad(2690_13));
    }

    function test_rejectsInvalidTracks() public {
        IPredictionHook h = IPredictionHook(address(hook));
        address o = address(oracle);

        vm.expectRevert(IMarketGatekeeper.InvalidTracks.selector);
        this.deployGatekeeper(h, new IMarketGatekeeper.Track[](0));

        IMarketGatekeeper.Track[] memory nine = new IMarketGatekeeper.Track[](9);
        for (uint256 i; i < 8; ++i) {
            nine[i] = _eight()[i];
        }
        nine[8] = IMarketGatekeeper.Track({oracle: o, config: trackConfig(60, 10, 10, "I")});
        vm.expectRevert(IMarketGatekeeper.InvalidTracks.selector);
        this.deployGatekeeper(h, nine);

        IMarketScheduler.Config[] memory dup = new IMarketScheduler.Config[](3);
        dup[0] = track1m();
        dup[1] = track15m();
        dup[2] = trackConfig(300, 10, 10, "ETH");
        vm.expectRevert(IMarketGatekeeper.InvalidTracks.selector);
        this.deployGatekeeper(h, withOracle(o, dup));

        IMarketScheduler.Config[] memory laterDup = new IMarketScheduler.Config[](4);
        laterDup[0] = track1m();
        laterDup[1] = trackConfig(300, 10, 10, "ETH5M");
        laterDup[2] = track15m();
        laterDup[3] = trackConfig(3600, 60, 60, "ETH15M");
        vm.expectRevert(IMarketGatekeeper.InvalidTracks.selector);
        this.deployGatekeeper(h, withOracle(o, laterDup));

        IMarketScheduler.Config[] memory middleDup = new IMarketScheduler.Config[](3);
        middleDup[0] = track1m();
        middleDup[1] = trackConfig(300, 10, 10, "ETH5M");
        middleDup[2] = trackConfig(900, 30, 30, "ETH5M");
        vm.expectRevert(IMarketGatekeeper.InvalidTracks.selector);
        this.deployGatekeeper(h, withOracle(o, middleDup));

        IMarketScheduler.Config[] memory sameTicker = demoTracks();
        sameTicker[1].ticker = "ETH";
        vm.expectRevert(IMarketGatekeeper.InvalidTracks.selector);
        this.deployGatekeeper(h, withOracle(o, sameTicker));

        IMarketGatekeeper.Track[] memory crossOracleDup = withOracle(o, demoTracks());
        crossOracleDup[1] = IMarketGatekeeper.Track({oracle: address(solOracle), config: track1m()});
        vm.expectRevert(IMarketGatekeeper.InvalidTracks.selector);
        this.deployGatekeeper(h, crossOracleDup);

        vm.expectRevert(IMarketGatekeeper.InvalidTracks.selector);
        this.deployGatekeeper(IPredictionHook(address(0)), withOracle(o, demoTracks()));
    }

    function test_rejectsZeroOracle() public {
        IPredictionHook h = IPredictionHook(address(hook));

        vm.expectRevert(IMarketGatekeeper.InvalidTracks.selector);
        this.deployGatekeeper(h, withOracle(address(0), demoTracks()));

        IMarketGatekeeper.Track[] memory first = withOracle(address(oracle), demoTracks());
        first[0].oracle = address(0);
        vm.expectRevert(IMarketGatekeeper.InvalidTracks.selector);
        this.deployGatekeeper(h, first);

        IMarketGatekeeper.Track[] memory last = _eight();
        last[7].oracle = address(0);
        vm.expectRevert(IMarketGatekeeper.InvalidTracks.selector);
        this.deployGatekeeper(h, last);
    }

    function test_schedulerInvalidConfigBubbles() public {
        IMarketGatekeeper.Track[] memory ts = withOracle(address(oracle), demoTracks());
        ts[1].config.tenor = ts[1].config.window + ts[1].config.cutoffBuffer;
        vm.expectRevert(IMarketScheduler.InvalidConfig.selector);
        this.deployGatekeeper(IPredictionHook(address(hook)), ts);
    }

    /// @dev Eight 1m tracks with distinct tickers, the odd ones behind the SOL oracle
    function _eight() internal view returns (IMarketGatekeeper.Track[] memory ts) {
        ts = new IMarketGatekeeper.Track[](8);
        string[8] memory tickers = ["A", "B", "C", "D", "E", "F", "G", "H"];
        for (uint256 i; i < 8; ++i) {
            ts[i] = IMarketGatekeeper.Track({
                oracle: i % 2 == 0 ? address(oracle) : address(solOracle), config: trackConfig(60, 10, 10, tickers[i])
            });
        }
    }

    /// @dev A real CREATE, since forge swaps `new` in a test for an unmetered deployCode cheatcode. `txGas` is what a
    ///      CREATE transaction with this initcode pays: the opcode's cost (32000, 2 gas per initcode word, execution
    ///      and code deposit) plus the 21000 base and 16 or 4 gas per nonzero or zero initcode byte
    function _deployMetered(IPredictionHook h, IMarketGatekeeper.Track[] memory ts)
        internal
        returns (MarketGatekeeper g, uint256 txGas)
    {
        bytes memory initcode = abi.encodePacked(vm.getCode("MarketGatekeeper.sol:MarketGatekeeper"), abi.encode(h, ts));
        address a;
        uint256 before = gasleft();
        assembly ("memory-safe") {
            a := create(0, add(initcode, 0x20), mload(initcode))
        }
        txGas = before - gasleft() + 21_000;
        require(a != address(0), "create failed");
        for (uint256 i; i < initcode.length; ++i) {
            txGas += initcode[i] == 0 ? 4 : 16;
        }
        g = MarketGatekeeper(a);
    }

    /* Access */

    function test_onlySchedulersCreate() public {
        IPredictionHook.MarketParams memory p;

        vm.prank(makeAddr("eoa"));
        vm.expectRevert(IMarketGatekeeper.NotScheduler.selector);
        gk.createMarket(p);

        vm.expectRevert(IMarketGatekeeper.NotScheduler.selector);
        gk.createMarket(p);

        vm.prank(address(0));
        vm.expectRevert(IMarketGatekeeper.NotScheduler.selector);
        gk.createMarket(p);

        MarketScheduler rogue = new MarketScheduler(IPredictionHook(address(hook)), gk, address(oracle), track1m());
        assertTrue(rogue.canOpen(), "rogue passes its own checks");
        vm.expectRevert(IMarketGatekeeper.NotScheduler.selector);
        rogue.open();
        assertEq(hook.marketCount(), 0);
    }

    /// @dev A scheduler with the real hook behind a fake gatekeeper creates nothing, yet emits MarketOpened for a real
    ///      id and passes the `hook()` check; only the hook owner's `isScheduler` tells it apart
    function test_rogueSchedulerOnlyFailsIsScheduler() public {
        uint256 id = s15m.open();
        MarketScheduler rogue = new MarketScheduler(
            IPredictionHook(address(hook)),
            IMarketGatekeeper(address(new FakeGatekeeper(id))),
            address(oracle),
            track15m()
        );
        vm.expectEmit(address(rogue));
        emit IMarketScheduler.MarketOpened(id, T0 / 900, address(this), 10 * E6, 2690_13);
        rogue.open();

        assertEq(address(rogue.hook()), address(hook));
        assertEq(rogue.marketOfSlot(T0 / 900), id);
        assertEq(hook.marketCount(), 1, "the hook is untouched");
        assertFalse(IMarketGatekeeper(hook.owner()).isScheduler(address(rogue)));
        assertTrue(IMarketGatekeeper(hook.owner()).isScheduler(address(s15m)));
    }

    function test_hookAdminRejectsEveryoneButTheGatekeeper() public {
        IPredictionHook.MarketParams memory p;
        address[4] memory callers = [makeAddr("eoa"), address(this), address(s1m), address(s15m)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(PredictionHook.Unauthorized.selector);
            hook.createMarket(p);

            vm.prank(callers[i]);
            vm.expectRevert(PredictionHook.Unauthorized.selector);
            hook.setKeeper(callers[i]);
        }
        assertEq(hook.keeper(), address(0));
    }

    /* Tracks sharing one vault */

    /// @dev At 14:00 both slots start; each open takes min(max, idle / 2) of what the previous one left
    function test_bothTracksOpenAtQuarterHour() public {
        assertEq(vm.getBlockTimestamp() % 900, 0);
        (MockUSDC u, PredictionHook h, MarketGatekeeper g) = _deployTracks(demoTracks());
        _deposit(h, u, lp, 25 * E6);
        MarketScheduler a = MarketScheduler(g.schedulers()[0]);
        MarketScheduler b = MarketScheduler(g.schedulers()[1]);

        uint256 id1 = a.open();
        uint256 id2 = b.open();
        IPredictionHook.MarketInfo memory m1 = _info(h, id1);
        IPredictionHook.MarketInfo memory m2 = _info(h, id2);
        assertEq(m1.bucket, 10 * E6, "1m: min(10, 25 / 2)");
        assertEq(m2.bucket, 7.5e6, "15m: min(10, 15 / 2)");
        assertEq(h.vaultIdle(), 7.5e6);
        assertEq(m1.expiry, T0 + 60);
        assertEq(m2.expiry, T0 + 900);
        assertEq(m1.window, 10);
        assertEq(m2.window, 30);
        assertEq(h.marketParams(id2).nSamples, 30);
        assertEq(g.schedulerOf(id1), address(a));
        assertEq(g.schedulerOf(id2), address(b));
        assertEq(a.marketOfSlot(T0 / 60), id1);
        assertEq(b.marketOfSlot(T0 / 900), id2);

        _assertToken(m1.yes, "ETH > $2690.13 26 Sep 14:01", "ETHUP");
        _assertToken(m1.no, "ETH < $2690.13 26 Sep 14:01", "ETHDOWN");
        _assertToken(m2.yes, "ETH15M > $2690.13 26 Sep 14:15", "ETH15MUP");
        _assertToken(m2.no, "ETH15M < $2690.13 26 Sep 14:15", "ETH15MDOWN");

        (MockUSDC u2, PredictionHook h2, MarketGatekeeper g2) = _deployTracks(demoTracks());
        _deposit(h2, u2, lp, 25 * E6);
        uint256 first = MarketScheduler(g2.schedulers()[1]).open();
        uint256 second = MarketScheduler(g2.schedulers()[0]).open();
        assertEq(_info(h2, first).bucket, 10 * E6, "15m first takes the full budget");
        assertEq(_info(h2, second).bucket, 7.5e6, "1m second takes half of what is left");
    }

    /// @dev The 1m market opened at 14:14 and the 15m one opened at 14:00 share an expiry; only the ticker and
    ///      `schedulerOf` tell them apart
    function test_idsInterleaveAcrossTracks() public {
        address[] memory by = new address[](20);
        uint256 n;
        for (uint256 m; m <= 16; ++m) {
            vm.warp(T0 + m * 60 + 3);
            if (m == 15) {
                by[++n] = address(s15m);
                assertEq(s15m.open(), n);
            }
            by[++n] = address(s1m);
            assertEq(s1m.open(), n);
            if (m == 0) {
                by[++n] = address(s15m);
                assertEq(s15m.open(), n);
            }
        }
        assertEq(hook.marketCount(), n);
        assertEq(n, 19);
        for (uint256 id = 1; id <= n; ++id) {
            address s = gk.schedulerOf(id);
            assertEq(s, by[id], "schedulerOf");
            uint256 period = IMarketScheduler(s).config().period;
            uint256 openTime = _info(hook, id).openTime;
            assertEq(IMarketScheduler(s).marketOfSlot(openTime / period), id, "marketOfSlot");
        }
        assertEq(gk.schedulerOf(n + 1), address(0), "unknown id");
        assertEq(gk.schedulerOf(0), address(0));

        IPredictionHook.MarketInfo memory oneMin = _info(hook, 16);
        IPredictionHook.MarketInfo memory quarter = _info(hook, 2);
        assertEq(gk.schedulerOf(16), address(s1m));
        assertEq(oneMin.expiry, T0 + 900);
        assertEq(quarter.expiry, T0 + 900);
        _assertToken(oneMin.yes, "ETH > $2690.13 26 Sep 14:15", "ETHUP");
        _assertToken(quarter.yes, "ETH15M > $2690.13 26 Sep 14:15", "ETH15MUP");
    }

    /// @dev The worked timeline with the live configs: the 1m slot from 14:34:00 opens until 14:34:47, and the 15m
    ///      slot from 14:30:00 until 14:44:27 (window 30 plus cutoffBuffer 2 before its 14:45:00 expiry)
    function test_workedTimeline() public view {
        assertEq(s1m.openDeadline((T0 + 34 minutes) / 60), T0 + 34 minutes + 48, "14:34:48");
        assertEq(s15m.openDeadline((T0 + 30 minutes) / 900), T0 + 44 minutes + 28, "14:44:28");
    }

    function test_fifteenMinuteTrackDeadline() public {
        s15m.open();
        uint256 slot = T0 / 900 + 1;
        assertEq(s15m.nextOpenTime(), slot * 900);
        assertEq(s15m.openDeadline(slot), slot * 900 + 900 - 30 - 2);

        vm.warp(s15m.openDeadline(slot));
        assertFalse(s15m.canOpen());
        assertEq(s15m.nextOpenTime(), (slot + 1) * 900);
        vm.expectRevert(abi.encodeWithSelector(IMarketScheduler.TooLate.selector, slot));
        s15m.open();

        vm.warp(s15m.openDeadline(slot) - 1);
        uint256 id = s15m.open();
        assertEq(_info(hook, id).expiry, (slot + 1) * 900);
    }
}
