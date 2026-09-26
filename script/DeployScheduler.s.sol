// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {IMarketScheduler} from "../src/interfaces/IMarketScheduler.sol";
import {IUnderlyingOracle} from "../src/interfaces/IUnderlyingOracle.sol";
import {MarketNames} from "../src/lib/MarketNames.sol";
import {SchedulerPair} from "./base/SchedulerPair.sol";

/// @title DeployScheduler
/// @notice Replaces the PredictionHook of deployments/<NETWORK>.json (or DEPLOYMENTS_FILE) with a fresh hook owned by a
///         new MarketScheduler, on the file's existing PoolManager, USDC and underlying oracle.
/// @dev Two steps, so the deployments file only ever names a pair that was checked on-chain.
///      1. `forge script script/DeployScheduler.s.sol --rpc-url <rpc> --broadcast` deploys the pair and stages the
///         updated file as <file>.pending.json (<file>.dry-run.json without --broadcast).
///      2. `forge script script/DeployScheduler.s.sol --sig 'record()' --rpc-url <rpc>` reads the pair back from the
///         chain and only then rewrites <file>. The new hook and scheduler become `predictionHook` and
///         `marketScheduler`, the old hook moves into `legacyPredictionHooks`, and `deployBlock` / `deployedAt` are
///         those of step 1. Every other key is kept.
///      Scheduler config env is documented on SchedulerPair. script/sepolia.sh scheduler runs both steps.
contract DeployScheduler is SchedulerPair {
    struct Target {
        address poolManager;
        address usdc;
        address oracle;
    }

    function run() external returns (Pair memory) {
        return _stage(_deploymentsPath(), schedulerConfig());
    }

    function record() external {
        _record(_deploymentsPath(), schedulerConfig());
    }

    function _stage(string memory path, IMarketScheduler.Config memory c) internal returns (Pair memory p) {
        string memory json = _readDeploymentsAt(path);
        string memory pending = _withSuffix(path, ".pending.json");
        if (vm.exists(pending)) revert(string.concat("staged pair awaits record(): ", pending));
        Target memory t = _target(json);
        _checkConfig(c);
        require(CREATE2_FACTORY.code.length != 0, "CREATE2 deployer missing");
        uint256 cents = MarketNames.strikeCents(IUnderlyingOracle(t.oracle).lnSpotSoBWad());
        require(cents != 0, "oracle spot rounds to a zero strike");
        uint256 deployBlock = block.number;

        address deployer = _startBroadcast();
        p = _deployPair(deployer, t.poolManager, t.usdc, t.oracle, c);
        vm.stopBroadcast();

        _verifyPair(p, t.poolManager, t.usdc, t.oracle, c);
        string memory staged = _isDryRun() ? _withSuffix(path, ".dry-run.json") : pending;
        vm.writeJson(_merged(json, p, deployBlock, block.timestamp), staged);

        console2.log(
            _isDryRun()
                ? "Scheduler pair simulated (nothing broadcast)"
                : "Scheduler pair deployed, the deployments file changes only after record()"
        );
        _log("deployments", path);
        _log("staged", staged);
        _log("deployer", deployer);
        _log("marketScheduler", p.scheduler);
        _log("predictionHook", p.hook);
        address[] memory legacy = _legacyHooks(json);
        if (legacy.length != 0) _log("replaces", legacy[legacy.length - 1]);
        _log("underlyingOracle", t.oracle);
        _log("usdc", t.usdc);
        _log("poolManager", t.poolManager);
        _log("strike now USD", MarketNames.formatCents(cents));
        _logConfig(c);
    }

    function _record(string memory path, IMarketScheduler.Config memory c) internal {
        string memory pending = _withSuffix(path, ".pending.json");
        if (!vm.exists(pending)) {
            revert(string.concat("no staged pair at ", pending, ", run DeployScheduler with --broadcast first"));
        }
        string memory staged = vm.readFile(pending);
        string memory json = _readDeploymentsAt(path);
        Target memory t = _target(json);
        require(
            vm.parseJsonUint(staged, ".chainId") == block.chainid
                && vm.parseJsonAddress(staged, ".poolManager") == t.poolManager
                && vm.parseJsonAddress(staged, ".usdc") == t.usdc
                && vm.parseJsonAddress(staged, ".underlyingOracle") == t.oracle
                && keccak256(abi.encode(vm.parseJsonAddressArray(staged, ".legacyPredictionHooks")))
                    == keccak256(abi.encode(_legacyHooks(json))),
            "deployments file changed since the pair was staged"
        );
        Pair memory p = Pair(vm.parseJsonAddress(staged, ".marketScheduler"), vm.parseJsonAddress(staged, ".predictionHook"));

        _verifyPair(p, t.poolManager, t.usdc, t.oracle, c);
        vm.writeJson(
            _merged(json, p, vm.parseJsonUint(staged, ".deployBlock"), vm.parseJsonUint(staged, ".deployedAt")), path
        );
        vm.removeFile(pending);

        console2.log("Scheduler pair verified on-chain and recorded");
        _log("deployments", path);
        _log("marketScheduler", p.scheduler);
        _log("predictionHook", p.hook);
    }

    function _target(string memory json) internal view returns (Target memory t) {
        t.poolManager = _jsonContract(json, "poolManager");
        t.usdc = _jsonContract(json, "usdc");
        t.oracle = _jsonContract(json, "underlyingOracle");
    }

    /// @dev The file's legacyPredictionHooks with its current predictionHook appended (once)
    function _legacyHooks(string memory json) internal view returns (address[] memory hooks) {
        address[] memory prev = vm.keyExistsJson(json, ".legacyPredictionHooks")
            ? vm.parseJsonAddressArray(json, ".legacyPredictionHooks")
            : new address[](0);
        address old = vm.keyExistsJson(json, ".predictionHook") ? vm.parseJsonAddress(json, ".predictionHook") : address(0);
        bool known = old == address(0);
        for (uint256 i; i < prev.length && !known; ++i) {
            known = prev[i] == old;
        }
        if (known) return prev;
        hooks = new address[](prev.length + 1);
        for (uint256 i; i < prev.length; ++i) {
            hooks[i] = prev[i];
        }
        hooks[prev.length] = old;
    }

    function _merged(string memory json, Pair memory p, uint256 deployBlock, uint256 deployedAt)
        internal
        returns (string memory)
    {
        string memory o = "schedulerDeployment";
        vm.serializeJson(o, json);
        vm.serializeAddress(o, "legacyPredictionHooks", _legacyHooks(json));
        vm.serializeAddress(o, "marketScheduler", p.scheduler);
        vm.serializeUint(o, "deployBlock", deployBlock);
        vm.serializeUint(o, "deployedAt", deployedAt);
        return vm.serializeAddress(o, "predictionHook", p.hook);
    }
}
