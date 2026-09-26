// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {LibString} from "solady/utils/LibString.sol";
import {DeployScheduler} from "../../script/DeployScheduler.s.sol";
import {RenounceOracle} from "../../script/RenounceOracle.s.sol";
import {SchedulerPair} from "../../script/base/SchedulerPair.sol";
import {PredictionHook} from "../../src/PredictionHook.sol";
import {MarketScheduler} from "../../src/MarketScheduler.sol";
import {IMarketScheduler} from "../../src/interfaces/IMarketScheduler.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
import {UnderlyingOracleHook} from "../../src/oracle/UnderlyingOracleHook.sol";
import {MockOracle} from "../hook/mocks/MockOracle.sol";
import {MockUSDC} from "../hook/mocks/MockUSDC.sol";
import {OracleTestBase} from "../oracle/OracleTestBase.sol";

/// @dev The spec's demo values (Unichain Sepolia), which are also the script defaults
function demoConfig() pure returns (IMarketScheduler.Config memory c) {
    c.period = 60;
    c.tenor = 120;
    c.window = 10;
    c.cutoffBuffer = 2;
    c.nSamples = 10;
    c.quote = IPredictionHook.QuoteParams({
        h0Wad: 0.02e18,
        gammaSWad: 0.00002e18,
        lambdaWad: 0.001e18,
        qEpochMax: 100e6,
        pMinWad: 0.02e18
    });
    c.maxBudget = 10e6;
    c.minBudget = 1e6;
    c.ticker = "ETH";
}

contract DeploySchedulerHarness is DeployScheduler {
    address internal immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function _startBroadcast() internal override returns (address) {
        vm.startBroadcast(signer);
        return signer;
    }

    function stage(string memory path, IMarketScheduler.Config memory c) external returns (Pair memory, bytes32) {
        return _stage(path, c);
    }

    function configLines(IMarketScheduler.Config memory c) external pure returns (string[] memory) {
        return _configLines(c);
    }

    function recordAt(string memory path, IMarketScheduler.Config memory c) external {
        _record(path, c);
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

/// @notice DeployScheduler on a local PoolManager and mock oracle, one deployments file per test as tests run in parallel
contract DeploySchedulerTest is Test, Deployers {
    uint256 internal constant T0 = 1_790_400_000;
    uint256 internal constant BLOCK = 4321;
    uint64 internal constant NONCE = 7;

    address internal deployer = makeAddr("deployer");
    MockUSDC internal usdc;
    MockOracle internal oracle;
    address internal legacyHook;
    DeploySchedulerHarness internal script;
    string internal dir;

    function setUp() public {
        vm.warp(T0);
        vm.roll(BLOCK);
        deployFreshManagerAndRouters();
        usdc = new MockUSDC();
        oracle = new MockOracle();
        oracle.setLnSpot(F.lnWad(2690.13e18));
        legacyHook = address(uint160(0x2AA8) | (uint160(0x4444) << 144));
        deployCodeTo("src/PredictionHook.sol:PredictionHook", abi.encode(manager, address(usdc), deployer), legacyHook);
        script = new DeploySchedulerHarness(deployer);
        vm.setNonce(deployer, NONCE);
        dir = string.concat(vm.projectRoot(), "/deployments/.run/test");
        vm.createDir(dir, true);
    }

    /* Helpers */

    function _seed(string memory name, string memory extra) internal returns (string memory path) {
        path = string.concat(dir, "/deploy-scheduler-", name, ".json");
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
                vm.toString(address(oracle)),
                '","predictionHook":"',
                vm.toString(legacyHook),
                '"',
                extra,
                ',"underlyingPool":{"fee":500,"tickSpacing":10}}'
            )
        );
        string memory pending = _pending(path);
        if (vm.exists(pending)) vm.removeFile(pending);
    }

    function _pending(string memory path) internal pure returns (string memory) {
        return string.concat(vm.replace(path, ".json", ""), ".pending.json");
    }

    function _cleanup(string memory path) internal {
        if (vm.exists(path)) vm.removeFile(path);
        if (vm.exists(_pending(path))) vm.removeFile(_pending(path));
    }

    /* Deployment */

    function test_deploysPairAtNoncePredictedAddresses() public {
        string memory path = _seed("addresses", "");
        address predicted = vm.computeCreateAddress(deployer, NONCE);

        (SchedulerPair.Pair memory p,) = script.stage(path, demoConfig());

        assertEq(p.scheduler, predicted, "scheduler is the CREATE at the deployer's nonce");
        assertEq(vm.getNonce(deployer), NONCE + 2, "exactly two deployer transactions");
        assertEq(uint160(p.hook) & Hooks.ALL_HOOK_MASK, 0x2AA8, "hook permission bits");
        PredictionHook hook = PredictionHook(p.hook);
        assertEq(hook.owner(), p.scheduler, "hook owner is the scheduler");
        assertEq(hook.keeper(), address(0), "hook keeper stays zero");
        assertEq(hook.usdc(), address(usdc), "hook usdc");
        assertEq(address(hook.poolManager()), address(manager), "hook pool manager");
        MarketScheduler s = MarketScheduler(p.scheduler);
        assertEq(address(s.hook()), p.hook, "scheduler hook");
        assertEq(s.oracle(), address(oracle), "scheduler oracle");
        assertEq(keccak256(abi.encode(s.config())), keccak256(abi.encode(demoConfig())), "scheduler config");
        _cleanup(path);
    }

    function test_deployedPairOpensMarketsOnceFunded() public {
        string memory path = _seed("opens", "");
        (SchedulerPair.Pair memory p,) = script.stage(path, demoConfig());
        address lp = makeAddr("lp");
        usdc.mint(lp, 100e6);
        vm.startPrank(lp);
        usdc.approve(p.hook, 100e6);
        PredictionHook(p.hook).deposit(100e6);
        vm.stopPrank();

        vm.prank(address(0xBEEF));
        uint256 id = IMarketScheduler(p.scheduler).open();

        assertEq(id, 1);
        assertEq(PredictionHook(p.hook).marketCount(), 1);
        assertEq(PredictionHook(p.hook).vaultIdle(), 90e6, "budget is maxBudget");
        _cleanup(path);
    }

    function test_rejectsTenorShorterThanSlotPlusWindow() public {
        string memory path = _seed("short-tenor", "");
        IMarketScheduler.Config memory c = demoConfig();
        c.tenor = 71;
        vm.expectRevert(
            bytes("MARKET_TENOR_SEC must be at least SCHEDULER_PERIOD_SEC + MARKET_WINDOW_SEC + MARKET_CUTOFF_BUFFER_SEC")
        );
        script.stage(path, c);
        _cleanup(path);
    }

    function test_schedulerConfigDefaultsAreTheDemoValues() public {
        string[13] memory names = [
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
            "SCHEDULER_MIN_BUDGET_USDC",
            "MARKET_TICKER"
        ];
        for (uint256 i; i < names.length; ++i) {
            if (vm.envExists(names[i])) vm.skip(true, string.concat(names[i], " is set in the environment"));
        }
        assertEq(keccak256(abi.encode(script.schedulerConfig())), keccak256(abi.encode(demoConfig())));
    }

    function test_demoDefaultsAreTheSpecValues() public view {
        assertEq(keccak256(abi.encode(script.demoDefaults())), keccak256(abi.encode(demoConfig())));
    }

    function test_returnedSaltIsTheHookCreate2Salt() public {
        string memory path = _seed("salt", "");
        (SchedulerPair.Pair memory p, bytes32 salt) = script.stage(path, demoConfig());
        bytes memory init = abi.encodePacked(
            vm.getCode("src/PredictionHook.sol:PredictionHook"), abi.encode(address(manager), address(usdc), p.scheduler)
        );
        assertEq(vm.computeCreate2Address(salt, keccak256(init), CREATE2_FACTORY), p.hook);
        _cleanup(path);
    }

    function test_configLinesFlagExactlyTheFieldsThatDifferFromTheDemoDefaults() public view {
        string[] memory plain = script.configLines(demoConfig());
        assertEq(plain.length, 13, "one line per field");
        for (uint256 j; j < plain.length; ++j) {
            assertFalse(LibString.contains(plain[j], "(env override)"), plain[j]);
        }
        for (uint256 i; i < 13; ++i) {
            string[] memory lines = script.configLines(_changed(i));
            for (uint256 j; j < lines.length; ++j) {
                assertEq(LibString.contains(lines[j], "(env override)"), i == j, lines[j]);
            }
        }
        assertEq(script.configLines(_changed(6))[6], "gammaS: 0.00005000 (env override)");
        assertEq(plain[6], "gammaS: 0.00002000");
    }

    /// @dev The demo config with field `i` changed, in the order the config lines are logged
    function _changed(uint256 i) internal pure returns (IMarketScheduler.Config memory c) {
        c = demoConfig();
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
        string memory path = _seed("stage", "");
        string memory before = vm.readFile(path);

        script.stage(path, demoConfig());

        assertEq(vm.readFile(path), before, "stage does not write the deployments file");
        assertTrue(vm.exists(_pending(path)), "stage writes the pending file");
        _cleanup(path);
    }

    function test_recordWritesTheVerifiedPair() public {
        string memory path = _seed("record", "");
        (SchedulerPair.Pair memory p,) = script.stage(path, demoConfig());
        vm.warp(T0 + 30);
        vm.roll(BLOCK + 30);

        script.recordAt(path, demoConfig());

        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonAddress(json, ".predictionHook"), p.hook, "predictionHook");
        assertEq(vm.parseJsonAddress(json, ".marketScheduler"), p.scheduler, "marketScheduler");
        address[] memory legacy = vm.parseJsonAddressArray(json, ".legacyPredictionHooks");
        assertEq(legacy.length, 1, "one legacy hook");
        assertEq(legacy[0], legacyHook, "old predictionHook moved to legacy");
        assertEq(vm.parseJsonUint(json, ".deployBlock"), BLOCK, "deployBlock from the stage step");
        assertEq(vm.parseJsonUint(json, ".deployedAt"), T0, "deployedAt from the stage step");
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonString(json, ".network"), "test");
        assertEq(vm.parseJsonAddress(json, ".keeper"), deployer);
        assertEq(vm.parseJsonAddress(json, ".poolManager"), address(manager));
        assertEq(vm.parseJsonAddress(json, ".usdc"), address(usdc));
        assertEq(vm.parseJsonAddress(json, ".underlyingOracle"), address(oracle));
        assertEq(vm.parseJsonUint(json, ".underlyingPool.fee"), 500);
        assertEq(vm.parseJsonUint(json, ".underlyingPool.tickSpacing"), 10);
        assertFalse(vm.exists(_pending(path)), "record removes the pending file");
        _cleanup(path);
    }

    function test_recordAppendsToExistingLegacyHooks() public {
        address older = address(0xA11CE);
        string memory path = _seed("legacy", string.concat(',"legacyPredictionHooks":["', vm.toString(older), '"]'));
        script.stage(path, demoConfig());

        script.recordAt(path, demoConfig());

        address[] memory legacy = vm.parseJsonAddressArray(vm.readFile(path), ".legacyPredictionHooks");
        assertEq(legacy.length, 2);
        assertEq(legacy[0], older);
        assertEq(legacy[1], legacyHook);
        _cleanup(path);
    }

    function test_recordRequiresAStagedPair() public {
        string memory path = _seed("unstaged", "");
        vm.expectRevert(
            bytes(string.concat("no staged pair at ", _pending(path), ", run DeployScheduler with --broadcast first"))
        );
        script.recordAt(path, demoConfig());
        _cleanup(path);
    }

    function test_stageRefusesWhileAPairAwaitsRecord() public {
        string memory path = _seed("twice", "");
        script.stage(path, demoConfig());
        vm.expectRevert(bytes(string.concat("staged pair awaits record(): ", _pending(path))));
        script.stage(path, demoConfig());
        _cleanup(path);
    }

    function test_recordRefusesAChangedDeploymentsFile() public {
        string memory path = _seed("changed", "");
        script.stage(path, demoConfig());
        vm.writeFile(path, vm.replace(vm.readFile(path), vm.toString(legacyHook), vm.toString(address(0xB0B))));

        vm.expectRevert(bytes("deployments file changed since the pair was staged"));
        script.recordAt(path, demoConfig());
        _cleanup(path);
    }

    function test_recordRefusesAPairThatFailsTheOnChainChecks() public {
        string memory path = _seed("unverified", "");
        (SchedulerPair.Pair memory p,) = script.stage(path, demoConfig());
        string memory pending = _pending(path);
        vm.writeFile(pending, vm.replace(vm.readFile(pending), vm.toString(p.scheduler), vm.toString(address(oracle))));

        vm.expectRevert(bytes("hook owner is not the scheduler"));
        script.recordAt(path, demoConfig());
        assertEq(vm.parseJsonAddress(vm.readFile(path), ".predictionHook"), legacyHook, "nothing recorded");
        _cleanup(path);
    }

    function test_recordRefusesAConfigThatDiffersFromTheDeployedOne() public {
        string memory path = _seed("config", "");
        script.stage(path, demoConfig());
        IMarketScheduler.Config memory c = demoConfig();
        c.quote.h0Wad = 0.01e18;

        vm.expectRevert(bytes("scheduler config differs from the env config"));
        script.recordAt(path, c);
        _cleanup(path);
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

    function _seed(string memory name, address schedulerOracle) internal returns (string memory path) {
        address scheduler = address(new MarketScheduler(IPredictionHook(address(0x1234)), schedulerOracle, demoConfig()));
        path = string.concat(dir, "/renounce-oracle-", name, ".json");
        vm.writeFile(
            path,
            string.concat(
                '{"chainId":',
                vm.toString(block.chainid),
                ',"underlyingOracle":"',
                vm.toString(address(oracle)),
                '","marketScheduler":"',
                vm.toString(scheduler),
                '"}'
            )
        );
    }

    function test_renouncesABoundOracle() public {
        _initPool(address(oracle), 2700e18);
        oracle.transferOwnership(owner);
        string memory path = _seed("bound", address(oracle));

        script.renounceAt(path);

        assertEq(oracle.owner(), address(0));
        vm.removeFile(path);
    }

    function test_refusesAnUnboundOracle() public {
        oracle.transferOwnership(owner);
        string memory path = _seed("unbound", address(oracle));
        vm.expectRevert(bytes("oracle pool is not bound"));
        script.renounceAt(path);
        vm.removeFile(path);
    }

    function test_refusesASignerThatIsNotTheOwner() public {
        _initPool(address(oracle), 2700e18);
        string memory path = _seed("signer", address(oracle));
        vm.expectRevert(bytes("signer is not the oracle owner"));
        script.renounceAt(path);
        vm.removeFile(path);
    }

    function test_refusesAnAlreadyRenouncedOracle() public {
        _initPool(address(oracle), 2700e18);
        oracle.renounceOwnership();
        string memory path = _seed("renounced", address(oracle));
        vm.expectRevert(bytes("oracle ownership is already renounced"));
        script.renounceAt(path);
        vm.removeFile(path);
    }

    function test_refusesWhenTheSchedulerReadsAnotherOracle() public {
        _initPool(address(oracle), 2700e18);
        oracle.transferOwnership(owner);
        string memory path = _seed("other-oracle", address(0xDEAD));
        vm.expectRevert(bytes("marketScheduler reads a different oracle"));
        script.renounceAt(path);
        vm.removeFile(path);
    }
}
