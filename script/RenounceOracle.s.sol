// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IMarketScheduler} from "../src/interfaces/IMarketScheduler.sol";
import {UnderlyingOracleHook} from "../src/oracle/UnderlyingOracleHook.sol";
import {ScriptBase} from "./base/ScriptBase.sol";

/// @title RenounceOracle
/// @notice Renounces the deployment's UnderlyingOracleHook ownership, freezing its variance bounds. IRREVERSIBLE.
/// @dev Signed by the oracle owner, and only once the pool is bound and the file records a scheduler on this oracle.
contract RenounceOracle is ScriptBase {
    function run() external {
        _renounce(_deploymentsPath());
    }

    function _renounce(string memory path) internal {
        string memory json = _readDeploymentsAt(path);
        UnderlyingOracleHook oracle = UnderlyingOracleHook(_jsonContract(json, "underlyingOracle"));
        address owner = oracle.owner();
        require(owner != address(0), "oracle ownership is already renounced");
        UnderlyingOracleHook.FeedInfo memory info;
        try oracle.feedInfo() returns (UnderlyingOracleHook.FeedInfo memory i) {
            info = i;
        } catch {
            revert("oracle pool is not bound");
        }
        require(info.lastWriteTime != 0, "oracle pool is not bound");
        IMarketScheduler scheduler = IMarketScheduler(_jsonContract(json, "marketScheduler"));
        require(scheduler.oracle() == address(oracle), "marketScheduler reads a different oracle");

        address signer = _startBroadcast();
        require(signer == owner, "signer is not the oracle owner");
        oracle.renounceOwnership();
        vm.stopBroadcast();

        require(oracle.owner() == address(0), "oracle still has an owner");
        console2.log(_isDryRun() ? "Oracle renounce simulated (nothing broadcast)" : "Oracle ownership renounced");
        _log("deployments", path);
        _log("underlyingOracle", address(oracle));
        _log("previous owner", owner);
        _log("pool", vm.toString(PoolId.unwrap(info.poolId)));
        _log("last write time", vm.toString(info.lastWriteTime));
        _log("observations", vm.toString(info.observationCount));
        _log("marketScheduler", address(scheduler));
        _log("frozen varMinE36", vm.toString(oracle.varMinE36()));
        _log("frozen varMaxE36", vm.toString(oracle.varMaxE36()));
        _log("frozen fallbackVarE36", vm.toString(oracle.fallbackVarE36()));
    }
}
