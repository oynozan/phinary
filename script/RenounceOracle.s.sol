// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IMarketScheduler} from "../src/interfaces/IMarketScheduler.sol";
import {UnderlyingOracleHook} from "../src/oracle/UnderlyingOracleHook.sol";
import {ScriptBase} from "./base/ScriptBase.sol";

/// @title RenounceOracle
/// @notice Renounces the deployment's UnderlyingOracleHook ownership, freezing its variance bounds. IRREVERSIBLE.
/// @dev Signed by the oracle owner, and only once the pool is bound and one of the file's `marketSchedulers` (or the
///      older single `marketScheduler`) reads this oracle.
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
        address scheduler = _schedulerOn(json, address(oracle));

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
        _log("scheduler on it", scheduler);
        _log("frozen varMinE36", vm.toString(oracle.varMinE36()));
        _log("frozen varMaxE36", vm.toString(oracle.varMaxE36()));
        _log("frozen fallbackVarE36", vm.toString(oracle.fallbackVarE36()));
    }

    /// @dev The first recorded scheduler reading `oracle`, from `marketSchedulers` or else the older `marketScheduler`
    function _schedulerOn(string memory json, address oracle) internal view returns (address) {
        address[] memory list;
        if (vm.keyExistsJson(json, ".marketSchedulers")) {
            list = vm.parseJsonAddressArray(json, ".marketSchedulers");
        } else {
            list = new address[](1);
            list[0] = _jsonContract(json, "marketScheduler");
        }
        for (uint256 i; i < list.length; ++i) {
            if (list[i].code.length == 0) revert(string.concat("market scheduler has no code at ", vm.toString(list[i])));
            if (IMarketScheduler(list[i]).oracle() == oracle) return list[i];
        }
        revert("no recorded market scheduler reads this oracle");
    }
}
