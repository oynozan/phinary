// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {LibString} from "solady/utils/LibString.sol";
import {DeployTracks} from "../../script/DeployTracks.s.sol";
import {RenounceOracle} from "../../script/RenounceOracle.s.sol";
import {TrackSet} from "../../script/base/TrackSet.sol";
import {PredictionHook} from "../../src/PredictionHook.sol";
import {MarketScheduler} from "../../src/MarketScheduler.sol";
import {IMarketScheduler} from "../../src/interfaces/IMarketScheduler.sol";
import {IMarketGatekeeper} from "../../src/interfaces/IMarketGatekeeper.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
import {UnderlyingOracleHook} from "../../src/oracle/UnderlyingOracleHook.sol";
import {MockOracle} from "../hook/mocks/MockOracle.sol";
import {MockUSDC} from "../hook/mocks/MockUSDC.sol";
import {OracleTestBase} from "../oracle/OracleTestBase.sol";

/// @dev The approved Unichain Sepolia values, which are also the script defaults
function demoConfig(string memory ticker, uint32 period, uint32 window) pure returns (IMarketScheduler.Config memory c) {
    c.period = period;
    c.tenor = period;
    c.window = window;
    c.cutoffBuffer = 2;
    c.nSamples = window;
    c.quote = IPredictionHook.QuoteParams({
        h0Wad: 0.02e18,
        gammaSWad: 0.00002e18,
        lambdaWad: 0.001e18,
        qEpochMax: 100e6,
        pMinWad: 0.02e18
    });
    c.maxBudget = 10e6;
    c.minBudget = 1e6;
    c.ticker = ticker;
}

contract DeployTracksHarness is DeployTracks {
    address internal immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function _startBroadcast() internal override returns (address) {
        vm.startBroadcast(signer);
        return signer;
    }

    function stage(string memory path, TrackSpec[] memory specs) external returns (Tracks memory, bytes32) {
        return _stage(path, specs);
    }

    function recordAt(string memory path, TrackSpec[] memory specs, uint256 landedBlock, uint256 landedAt) external {
        _record(path, specs, landedBlock, landedAt);
    }

    function specsFor(bool ethOnly) external view returns (TrackSpec[] memory) {
        return _trackSpecs(ethOnly);
    }

    function configLines(IMarketScheduler.Config memory c, IMarketScheduler.Config memory d)
        external
        pure
        returns (string[] memory)
    {
        return _configLines(c, d);
    }

    function withoutKey(string memory json, string memory key) external view returns (string memory) {
        return _withoutKey(json, key);
    }
}

contract RenounceOracleHarness is RenounceOracle {
    address internal immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function _startBroadcast() internal override returns (address) {
        vm.startBroadcast(signer);
        return signer;
    }

    function renounceAt(string memory path) external {
        _renounce(path);
    }
}

/// @notice DeployTracks on a local PoolManager and mock oracles, one deployments file per test as tests run in parallel
contract DeployTracksTest is Test, Deployers {
    uint256 internal constant T0 = 1_790_400_000;
    uint256 internal constant QUARTER = 1_790_400_600;
    uint256 internal constant BLOCK = 4321;
    uint64 internal constant NONCE = 7;
    address internal constant WETH = address(0xE001);
    address internal constant DSOL = address(0x501A);
    address internal constant DUSDC = address(0x0DC0);

    address internal deployer = makeAddr("deployer");
    address internal oldScheduler = makeAddr("oldScheduler");
    MockUSDC internal usdc;
    MockOracle internal ethOracle;
    MockOracle internal solOracle;
    address internal legacyHook;
    DeployTracksHarness internal script;
    string internal dir;

    function setUp() public {
        vm.warp(T0);
        vm.roll(BLOCK);
        deployFreshManagerAndRouters();
        usdc = new MockUSDC();
        ethOracle = new MockOracle();
        ethOracle.setLnSpot(F.lnWad(2690.13e18));
        solOracle = new MockOracle();
        solOracle.setLnSpot(F.lnWad(150.25e18));
        legacyHook = address(uint160(0x2AA8) | (uint160(0x4444) << 144));
        deployCodeTo("src/PredictionHook.sol:PredictionHook", abi.encode(manager, address(usdc), deployer), legacyHook);
        script = new DeployTracksHarness(deployer);
        vm.setNonce(deployer, NONCE);
        dir = string.concat(vm.projectRoot(), "/deployments/.run/test");
        vm.createDir(dir, true);
    }

    /* Helpers */

    function _pool(address token, address oracle) internal pure returns (PoolKey memory) {
        (address c0, address c1) = token < DUSDC ? (token, DUSDC) : (DUSDC, token);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), 500, 10, IHooks(oracle));
    }

    function _poolJson(PoolKey memory k) internal pure returns (string memory) {
        return string.concat(
            '{"currency0":"',
            vm.toString(Currency.unwrap(k.currency0)),
            '","currency1":"',
            vm.toString(Currency.unwrap(k.currency1)),
            '","fee":500,"tickSpacing":10,"hooks":"',
            vm.toString(address(k.hooks)),
            '"}'
        );
    }

    /// @dev One `underlyings` entry in the format DeployUnderlying records
    function _entry(string memory symbol, address token, address oracle) internal pure returns (string memory) {
        PoolKey memory k = _pool(token, oracle);
        return string.concat(
            '{"symbol":"',
            symbol,
            '","token":"',
            vm.toString(token),
            '","oracle":"',
            vm.toString(oracle),
            '","pool":',
            _poolJson(k),
            ',"poolId":"',
            vm.toString(keccak256(abi.encode(k))),
            '"}'
        );
    }

    function _underlyings() internal view returns (string memory) {
        return string.concat(
            ',"underlyings":[',
            _entry("ETH", WETH, address(ethOracle)),
            ",",
            _entry("SOL", DSOL, address(solOracle)),
            "]"
        );
    }

    function _seed(string memory name, string memory extra) internal returns (string memory path) {
        path = string.concat(dir, "/deploy-tracks-", name, ".json");
        vm.writeFile(
            path,
            string.concat(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"network":"test","deployBlock":1,"deployedAt":2,"keeper":"',
                vm.toString(deployer),
                '","poolManager":"',
                vm.toString(address(manager)),
                '","usdc":"',
                vm.toString(address(usdc)),
                '","underlyingOracle":"',
                vm.toString(address(ethOracle)),
                '","predictionHook":"',
                vm.toString(legacyHook),
                '","demoWeth":"',
                vm.toString(WETH),
                '","underlyingPoolId":"',
                vm.toString(keccak256(abi.encode(_pool(WETH, address(ethOracle))))),
                '"',
                extra,
                ',"underlyingPool":',
                _poolJson(_pool(WETH, address(ethOracle))),
                "}"
            )
        );
        string memory pending = _pending(path);
        if (vm.exists(pending)) vm.removeFile(pending);
    }

    /// @dev A deployments file as it is before the migration, one scheduler and a SOL underlying
    function _seedLive(string memory name) internal returns (string memory) {
        return _seed(name, string.concat(',"marketScheduler":"', vm.toString(oldScheduler), '"', _underlyings()));
    }

    function _pending(string memory path) internal pure returns (string memory) {
        return string.concat(vm.replace(path, ".json", ""), ".tracks.pending.json");
    }

    function _cleanup(string memory path) internal {
        if (vm.exists(path)) vm.removeFile(path);
        if (vm.exists(_pending(path))) vm.removeFile(_pending(path));
    }

    function _specs() internal view returns (TrackSet.TrackSpec[] memory) {
        return script.demoTracks();
    }

    function _expected() internal pure returns (IMarketScheduler.Config[4] memory c) {
        c[0] = demoConfig("ETH", 60, 10);
        c[1] = demoConfig("ETH15M", 900, 30);
        c[2] = demoConfig("SOL", 60, 10);
        c[3] = demoConfig("SOL15M", 900, 30);
    }

    function _fund(address hook, uint256 amount) internal {
        address lp = makeAddr("lp");
        usdc.mint(lp, amount);
        vm.startPrank(lp);
        usdc.approve(hook, amount);
        PredictionHook(hook).deposit(amount);
        vm.stopPrank();
    }

    /* Deployment */

    function test_deploysTracksAtNoncePredictedAddresses() public {
        string memory path = _seedLive("addresses");
        address predicted = vm.computeCreateAddress(deployer, NONCE);

        (TrackSet.Tracks memory t,) = script.stage(path, _specs());

        assertEq(t.gatekeeper, predicted, "gatekeeper is the CREATE at the deployer's nonce");
        assertEq(vm.getNonce(deployer), NONCE + 2, "exactly two deployer transactions");
        assertEq(uint160(t.hook) & Hooks.ALL_HOOK_MASK, 0x2AA8, "hook permission bits");
        PredictionHook hook = PredictionHook(t.hook);
        assertEq(hook.owner(), t.gatekeeper, "hook owner is the gatekeeper");
        assertEq(hook.keeper(), address(0), "hook keeper stays zero");
        assertEq(hook.usdc(), address(usdc), "hook usdc");
        assertEq(address(hook.poolManager()), address(manager), "hook pool manager");
        IMarketGatekeeper g = IMarketGatekeeper(t.gatekeeper);
        assertEq(address(g.hook()), t.hook, "gatekeeper hook");
        assertEq(g.schedulers(), t.schedulers, "gatekeeper schedulers");
        assertEq(t.schedulers.length, 4, "four tracks");
        IMarketScheduler.Config[4] memory want = _expected();
        address[4] memory oracles = [address(ethOracle), address(ethOracle), address(solOracle), address(solOracle)];
        for (uint256 i; i < 4; ++i) {
            MarketScheduler s = MarketScheduler(t.schedulers[i]);
            assertEq(address(s), vm.computeCreateAddress(t.gatekeeper, i + 1), "scheduler i is the gatekeeper's CREATE i+1");
            assertEq(address(s.hook()), t.hook, "scheduler hook");
            assertEq(address(s.gatekeeper()), t.gatekeeper, "scheduler gatekeeper");
            assertEq(s.oracle(), oracles[i], "ETH tracks read the ETH oracle, SOL tracks the SOL oracle");
            assertEq(keccak256(abi.encode(s.config())), keccak256(abi.encode(want[i])), "scheduler config");
        }
        _cleanup(path);
    }

    function test_deployedTracksOpenMarketsOnceFunded() public {
        string memory path = _seedLive("opens");
        (TrackSet.Tracks memory t,) = script.stage(path, _specs());
        _fund(t.hook, 100e6);
        vm.warp(QUARTER);

        string[4] memory yes = ["ETHUP", "ETH15MUP", "SOLUP", "SOL15MUP"];
        for (uint256 i; i < 4; ++i) {
            vm.prank(address(0xBEEF));
            uint256 id = IMarketScheduler(t.schedulers[i]).open();
            assertEq(id, i + 1, "ids follow the call order");
            assertEq(IMarketGatekeeper(t.gatekeeper).schedulerOf(id), t.schedulers[i], "schedulerOf");
            IPredictionHook.MarketParams memory p = PredictionHook(t.hook).marketParams(id);
            assertEq(p.yesSymbol, yes[i], "track ticker in the symbol");
            assertEq(p.oracle, i < 2 ? address(ethOracle) : address(solOracle), "market reads its track's oracle");
            assertEq(p.budget, 10e6, "budget is maxBudget");
        }
        assertEq(PredictionHook(t.hook).vaultIdle(), 60e6);
        _cleanup(path);
    }

    function test_refusesSolTracksWithoutASolUnderlying() public {
        string memory path = _seed("no-sol", "");
        vm.expectRevert(
            bytes(
                "no SOL oracle in the deployments file for track SOL, deploy the underlying first (script/sepolia.sh underlying) or set TRACKS_ETH_ONLY=1"
            )
        );
        script.stage(path, _specs());
        _cleanup(path);
    }

    function test_ethOnlyDeploysTheTwoEthTracks() public {
        string memory path = _seed("eth-only", "");

        (TrackSet.Tracks memory t,) = script.stage(path, script.specsFor(true));

        assertEq(t.schedulers.length, 2);
        assertEq(IMarketGatekeeper(t.gatekeeper).schedulerCount(), 2);
        assertEq(vm.getNonce(deployer), NONCE + 2);
        assertEq(IMarketScheduler(t.schedulers[0]).config().ticker, "ETH");
        assertEq(IMarketScheduler(t.schedulers[1]).config().ticker, "ETH15M");
        assertEq(IMarketScheduler(t.schedulers[1]).oracle(), address(ethOracle));
        _cleanup(path);
    }

    function test_rejectsATenorNotAboveWindowPlusBuffer() public {
        string memory path = _seedLive("short-tenor");
        TrackSet.TrackSpec[] memory specs = _specs();
        specs[0].config.tenor = 12;
        vm.expectRevert(
            bytes("TRACK_ETH_MARKET_TENOR_SEC must exceed MARKET_WINDOW_SEC + MARKET_CUTOFF_BUFFER_SEC, up to 365 days")
        );
        script.stage(path, specs);
        _cleanup(path);
    }

    function test_rejectsDuplicateTickers() public {
        string memory path = _seedLive("duplicate");
        TrackSet.TrackSpec[] memory specs = _specs();
        specs[3].config.ticker = "SOL";
        vm.expectRevert(bytes("track ticker SOL appears twice"));
        script.stage(path, specs);
        _cleanup(path);
    }

    function test_rejectsAnOracleWithoutAStrike() public {
        string memory path = _seedLive("zero-strike");
        solOracle.setLnSpot(F.lnWad(0.001e18));
        vm.expectRevert(bytes("SOL oracle spot rounds to a zero strike"));
        script.stage(path, _specs());
        _cleanup(path);
    }

    function test_trackSpecsDefaultsAreTheDemoValues() public {
        string[12] memory names = [
            "SCHEDULER_PERIOD_SEC",
            "MARKET_TENOR_SEC",
            "MARKET_WINDOW_SEC",
            "MARKET_CUTOFF_BUFFER_SEC",
            "MARKET_N_SAMPLES",
            "QUOTE_H0",
            "QUOTE_GAMMA_S",
            "QUOTE_LAMBDA",
            "QUOTE_Q_EPOCH_MAX",
            "QUOTE_P_MIN",
            "MARKET_BUDGET_USDC",
            "SCHEDULER_MIN_BUDGET_USDC"
        ];
        string[4] memory tickers = ["ETH", "ETH15M", "SOL", "SOL15M"];
        for (uint256 i; i < tickers.length; ++i) {
            for (uint256 j; j < names.length; ++j) {
                string memory name = string.concat("TRACK_", tickers[i], "_", names[j]);
                if (vm.envExists(name)) vm.skip(true, string.concat(name, " is set in the environment"));
            }
        }
        if (vm.envExists("TRACKS_ETH_ONLY")) vm.skip(true, "TRACKS_ETH_ONLY is set in the environment");
        assertEq(keccak256(abi.encode(script.trackSpecs())), keccak256(abi.encode(script.demoTracks())));
    }

    function test_demoTracksAreTheApprovedValues() public view {
        TrackSet.TrackSpec[] memory d = script.demoTracks();
        IMarketScheduler.Config[4] memory want = _expected();
        assertEq(d.length, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(d[i].underlying, i < 2 ? string("ETH") : string("SOL"));
            assertEq(keccak256(abi.encode(d[i].config)), keccak256(abi.encode(want[i])), want[i].ticker);
        }
    }

    function test_returnedSaltIsTheHookCreate2Salt() public {
        string memory path = _seedLive("salt");
        (TrackSet.Tracks memory t, bytes32 salt) = script.stage(path, _specs());
        bytes memory init = abi.encodePacked(
            vm.getCode("src/PredictionHook.sol:PredictionHook"), abi.encode(address(manager), address(usdc), t.gatekeeper)
        );
        assertEq(vm.computeCreate2Address(salt, keccak256(init), CREATE2_FACTORY), t.hook);
        _cleanup(path);
    }

    function test_configLinesFlagExactlyTheFieldsThatDifferFromTheDemoDefaults() public view {
        IMarketScheduler.Config memory d = demoConfig("ETH15M", 900, 30);
        string[] memory plain = script.configLines(d, d);
        assertEq(plain.length, 13, "one line per field");
        for (uint256 j; j < plain.length; ++j) {
            assertFalse(LibString.contains(plain[j], "(env override)"), plain[j]);
        }
        for (uint256 i; i < 13; ++i) {
            string[] memory lines = script.configLines(_changed(d, i), d);
            for (uint256 j; j < lines.length; ++j) {
                assertEq(LibString.contains(lines[j], "(env override)"), i == j, lines[j]);
            }
        }
        assertEq(script.configLines(_changed(d, 6), d)[6], "gammaS: 0.00005000 (env override)");
        assertEq(plain[6], "gammaS: 0.00002000");
        assertEq(plain[2], "window s: 30");
    }

    /// @dev `c` with field `i` changed, in the order the config lines are logged
    function _changed(IMarketScheduler.Config memory d, uint256 i)
        internal
        pure
        returns (IMarketScheduler.Config memory c)
    {
        c = abi.decode(abi.encode(d), (IMarketScheduler.Config));
        if (i == 0) c.period = 30;
        else if (i == 1) c.tenor = 180;
        else if (i == 2) c.window = 5;
        else if (i == 3) c.cutoffBuffer = 3;
        else if (i == 4) c.nSamples = 20;
        else if (i == 5) c.quote.h0Wad = 0.01e18;
        else if (i == 6) c.quote.gammaSWad = 0.00005e18;
        else if (i == 7) c.quote.lambdaWad = 0.002e18;
        else if (i == 8) c.quote.qEpochMax = 50e6;
        else if (i == 9) c.quote.pMinWad = 0.03e18;
        else if (i == 10) c.maxBudget = 20e6;
        else if (i == 11) c.minBudget = 2e6;
        else c.ticker = "BTC";
    }

    /* Deployments file */

    function test_stageLeavesTheDeploymentsFileUntilRecord() public {
        string memory path = _seedLive("stage");
        string memory before = vm.readFile(path);

        script.stage(path, _specs());

        assertEq(vm.readFile(path), before, "stage does not write the deployments file");
        assertTrue(vm.exists(_pending(path)), "stage writes the pending file");
        _cleanup(path);
    }

    function test_recordWritesTheVerifiedTracks() public {
        string memory path = _seedLive("record");
        (TrackSet.Tracks memory t,) = script.stage(path, _specs());
        vm.warp(T0 + 30);
        vm.roll(BLOCK + 30);

        script.recordAt(path, _specs(), BLOCK + 2, T0 + 4);

        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonAddress(json, ".predictionHook"), t.hook, "predictionHook");
        assertEq(vm.parseJsonAddress(json, ".marketGatekeeper"), t.gatekeeper, "marketGatekeeper");
        assertEq(vm.parseJsonAddressArray(json, ".marketSchedulers"), t.schedulers, "marketSchedulers");
        assertFalse(vm.keyExistsJson(json, ".marketScheduler"), "marketScheduler is removed");
        address[] memory legacySchedulers = vm.parseJsonAddressArray(json, ".legacyMarketSchedulers");
        assertEq(legacySchedulers.length, 1, "one legacy scheduler");
        assertEq(legacySchedulers[0], oldScheduler, "old marketScheduler moved to legacy");
        address[] memory legacy = vm.parseJsonAddressArray(json, ".legacyPredictionHooks");
        assertEq(legacy.length, 1, "one legacy hook");
        assertEq(legacy[0], legacyHook, "old predictionHook moved to legacy");
        assertEq(vm.parseJsonUint(json, ".deployBlock"), BLOCK + 2, "deployBlock is the landing block");
        assertEq(vm.parseJsonUint(json, ".deployedAt"), T0 + 4, "deployedAt is the landing time");
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonString(json, ".network"), "test");
        assertEq(vm.parseJsonAddress(json, ".keeper"), deployer);
        assertEq(vm.parseJsonAddress(json, ".poolManager"), address(manager));
        assertEq(vm.parseJsonAddress(json, ".usdc"), address(usdc));
        assertEq(vm.parseJsonAddress(json, ".underlyingOracle"), address(ethOracle));
        assertEq(vm.parseJsonAddress(json, ".underlyings[1].oracle"), address(solOracle), "underlyings kept");
        assertEq(vm.parseJsonString(json, ".underlyings[1].symbol"), "SOL");
        assertEq(vm.parseJsonUint(json, ".underlyingPool.fee"), 500);
        assertEq(vm.parseJsonUint(json, ".underlyingPool.tickSpacing"), 10);
        assertFalse(vm.exists(_pending(path)), "record removes the pending file");
        _cleanup(path);
    }

    function test_recordKeepsTheStagingBlockWithoutALandingBlock() public {
        string memory path = _seedLive("staging-block");
        script.stage(path, _specs());
        vm.warp(T0 + 30);
        vm.roll(BLOCK + 30);

        script.recordAt(path, _specs(), 0, 0);

        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonUint(json, ".deployBlock"), BLOCK);
        assertEq(vm.parseJsonUint(json, ".deployedAt"), T0);
        _cleanup(path);
    }

    function test_recordRefusesALandingBlockOutsideTheWindow() public {
        string memory path = _seedLive("landing-window");
        script.stage(path, _specs());
        vm.roll(BLOCK + 30);
        vm.expectRevert(bytes("TRACKS_DEPLOY_BLOCK must lie between the staging block and the current block"));
        script.recordAt(path, _specs(), BLOCK - 1, 0);
        vm.expectRevert(bytes("TRACKS_DEPLOY_BLOCK must lie between the staging block and the current block"));
        script.recordAt(path, _specs(), BLOCK + 31, 0);
        _cleanup(path);
    }

    function test_recordAppendsToExistingLegacyLists() public {
        address olderHook = address(0xA11CE);
        address olderScheduler = address(0xB0B);
        string memory path = _seed(
            "legacy",
            string.concat(
                ',"legacyPredictionHooks":["',
                vm.toString(olderHook),
                '"],"legacyMarketSchedulers":["',
                vm.toString(olderScheduler),
                '"],"marketScheduler":"',
                vm.toString(oldScheduler),
                '"',
                _underlyings()
            )
        );
        script.stage(path, _specs());

        script.recordAt(path, _specs(), 0, 0);

        string memory json = vm.readFile(path);
        address[] memory hooks = vm.parseJsonAddressArray(json, ".legacyPredictionHooks");
        assertEq(hooks.length, 2);
        assertEq(hooks[0], olderHook);
        assertEq(hooks[1], legacyHook);
        address[] memory schedulers = vm.parseJsonAddressArray(json, ".legacyMarketSchedulers");
        assertEq(schedulers.length, 2);
        assertEq(schedulers[0], olderScheduler);
        assertEq(schedulers[1], oldScheduler);
        _cleanup(path);
    }

    function test_recordWithoutAnOldSchedulerWritesAnEmptyLegacyList() public {
        string memory path = _seed("no-old-scheduler", _underlyings());
        script.stage(path, _specs());

        script.recordAt(path, _specs(), 0, 0);

        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonAddressArray(json, ".legacyMarketSchedulers").length, 0);
        assertFalse(vm.keyExistsJson(json, ".marketScheduler"));
        _cleanup(path);
    }

    function test_aSecondTrackDeployMovesTheCurrentSchedulersToLegacy() public {
        string memory path = _seedLive("redeploy");
        (TrackSet.Tracks memory first,) = script.stage(path, _specs());
        script.recordAt(path, _specs(), 0, 0);

        (TrackSet.Tracks memory second,) = script.stage(path, _specs());
        script.recordAt(path, _specs(), 0, 0);

        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonAddress(json, ".predictionHook"), second.hook);
        assertEq(vm.parseJsonAddressArray(json, ".marketSchedulers"), second.schedulers);
        address[] memory schedulers = vm.parseJsonAddressArray(json, ".legacyMarketSchedulers");
        assertEq(schedulers.length, 5);
        assertEq(schedulers[0], oldScheduler);
        for (uint256 i; i < 4; ++i) {
            assertEq(schedulers[i + 1], first.schedulers[i]);
        }
        address[] memory hooks = vm.parseJsonAddressArray(json, ".legacyPredictionHooks");
        assertEq(hooks.length, 2);
        assertEq(hooks[1], first.hook);
        _cleanup(path);
    }

    function test_recordRequiresStagedTracks() public {
        string memory path = _seedLive("unstaged");
        vm.expectRevert(
            bytes(string.concat("no staged tracks at ", _pending(path), ", run DeployTracks with --broadcast first"))
        );
        script.recordAt(path, _specs(), 0, 0);
        _cleanup(path);
    }

    function test_stageRefusesWhileTracksAwaitRecord() public {
        string memory path = _seedLive("twice");
        script.stage(path, _specs());
        vm.expectRevert(bytes(string.concat("staged tracks await record(): ", _pending(path))));
        script.stage(path, _specs());
        _cleanup(path);
    }

    function test_recordRefusesAChangedDeploymentsFile() public {
        string memory path = _seedLive("changed");
        script.stage(path, _specs());
        vm.writeFile(path, vm.replace(vm.readFile(path), vm.toString(oldScheduler), vm.toString(address(0xB0B))));

        vm.expectRevert(bytes("deployments file changed since the tracks were staged"));
        script.recordAt(path, _specs(), 0, 0);
        _cleanup(path);
    }

    function test_recordRefusesTracksThatFailTheOnChainChecks() public {
        string memory path = _seedLive("unverified");
        (TrackSet.Tracks memory t,) = script.stage(path, _specs());
        string memory pending = _pending(path);
        vm.writeFile(pending, vm.replace(vm.readFile(pending), vm.toString(t.gatekeeper), vm.toString(address(ethOracle))));

        vm.expectRevert(bytes("hook owner is not the gatekeeper"));
        script.recordAt(path, _specs(), 0, 0);
        assertEq(vm.parseJsonAddress(vm.readFile(path), ".predictionHook"), legacyHook, "nothing recorded");
        _cleanup(path);
    }

    function test_recordRefusesAConfigThatDiffersFromTheDeployedOne() public {
        string memory path = _seedLive("config");
        script.stage(path, _specs());
        TrackSet.TrackSpec[] memory specs = _specs();
        specs[1].config.quote.h0Wad = 0.01e18;

        vm.expectRevert(bytes("ETH15M scheduler config differs from the env config"));
        script.recordAt(path, specs, 0, 0);
        _cleanup(path);
    }

    function test_recordRefusesAnUnderlyingOracleThatChanged() public {
        string memory path = _seedLive("oracle-changed");
        script.stage(path, _specs());
        MockOracle other = new MockOracle();
        other.setLnSpot(F.lnWad(151e18));
        vm.writeFile(
            path,
            vm.replace(
                vm.readFile(path), _entry("SOL", DSOL, address(solOracle)), _entry("SOL", DSOL, address(other))
            )
        );

        vm.expectRevert(bytes("SOL scheduler oracle"));
        script.recordAt(path, _specs(), 0, 0);
        _cleanup(path);
    }

    function test_withoutKeyDropsOnlyThatTopLevelField() public view {
        assertEq(script.withoutKey('{"a":1,"m":"0xAb","z":2}', "m"), '{"a":1,"z":2}');
        assertEq(script.withoutKey('{"m":"0xAb","z":2}', "m"), '{"z":2}');
        assertEq(script.withoutKey('{"a":1,"m":"0xAb"}', "m"), '{"a":1}');
        assertEq(script.withoutKey('{"a":1}', "m"), '{"a":1}');
    }
}

/// @notice RenounceOracle against a real UnderlyingOracleHook on a local PoolManager.
contract RenounceOracleTest is OracleTestBase {
    address internal owner = makeAddr("oracleOwner");
    UnderlyingOracleHook internal oracle;
    RenounceOracleHarness internal script;
    string internal dir;

    function usdcIsCurrency0() internal pure override returns (bool) {
        return false;
    }

    function setUp() public {
        _setUpEnv();
        oracle = _deployHook(_defaultParams());
        script = new RenounceOracleHarness(owner);
        dir = string.concat(vm.projectRoot(), "/deployments/.run/test");
        vm.createDir(dir, true);
    }

    function _scheduler(address schedulerOracle, string memory ticker) internal returns (address) {
        return address(
            new MarketScheduler(
                IPredictionHook(address(0x1234)),
                IMarketGatekeeper(address(0x5678)),
                schedulerOracle,
                demoConfig(ticker, 60, 10)
            )
        );
    }

    /// @dev A tracks layout whose first scheduler reads `firstOracle` and second the deployment's oracle when `bound`
    function _seed(string memory name, address firstOracle, bool bound) internal returns (string memory path) {
        address a = _scheduler(firstOracle, "SOL");
        address b = _scheduler(bound ? address(oracle) : address(0xDEAD), "ETH");
        path = string.concat(dir, "/renounce-oracle-", name, ".json");
        vm.writeFile(
            path,
            string.concat(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"underlyingOracle":"',
                vm.toString(address(oracle)),
                '","marketSchedulers":["',
                vm.toString(a),
                '","',
                vm.toString(b),
                '"]}'
            )
        );
    }

    function test_renouncesABoundOracle() public {
        _initPool(address(oracle), 2700e18);
        oracle.transferOwnership(owner);
        string memory path = _seed("bound", address(0xDEAD), true);

        script.renounceAt(path);

        assertEq(oracle.owner(), address(0));
        vm.removeFile(path);
    }

    function test_acceptsTheSingleSchedulerLayout() public {
        _initPool(address(oracle), 2700e18);
        oracle.transferOwnership(owner);
        address s = _scheduler(address(oracle), "ETH");
        string memory path = string.concat(dir, "/renounce-oracle-single.json");
        vm.writeFile(
            path,
            string.concat(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"underlyingOracle":"',
                vm.toString(address(oracle)),
                '","marketScheduler":"',
                vm.toString(s),
                '"}'
            )
        );

        script.renounceAt(path);

        assertEq(oracle.owner(), address(0));
        vm.removeFile(path);
    }

    function test_refusesAnUnboundOracle() public {
        oracle.transferOwnership(owner);
        string memory path = _seed("unbound", address(oracle), true);
        vm.expectRevert(bytes("oracle pool is not bound"));
        script.renounceAt(path);
        vm.removeFile(path);
    }

    function test_refusesASignerThatIsNotTheOwner() public {
        _initPool(address(oracle), 2700e18);
        string memory path = _seed("signer", address(oracle), true);
        vm.expectRevert(bytes("signer is not the oracle owner"));
        script.renounceAt(path);
        vm.removeFile(path);
    }

    function test_refusesAnAlreadyRenouncedOracle() public {
        _initPool(address(oracle), 2700e18);
        oracle.renounceOwnership();
        string memory path = _seed("renounced", address(oracle), true);
        vm.expectRevert(bytes("oracle ownership is already renounced"));
        script.renounceAt(path);
        vm.removeFile(path);
    }

    function test_refusesWhenNoSchedulerReadsTheOracle() public {
        _initPool(address(oracle), 2700e18);
        oracle.transferOwnership(owner);
        string memory path = _seed("other-oracle", address(0xDEAD), false);
        vm.expectRevert(bytes("no recorded market scheduler reads this oracle"));
        script.renounceAt(path);
        vm.removeFile(path);
    }
}
