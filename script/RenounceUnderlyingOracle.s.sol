// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {UnderlyingOracleHook} from "../src/oracle/UnderlyingOracleHook.sol";
import {Underlyings} from "./base/Underlyings.sol";

/// @title RenounceUnderlyingOracle
/// @notice Renounces the ownership of an oracle recorded in the deployments file's `underlyings` by DeployUnderlying,
///         freezing its variance bounds. IRREVERSIBLE.
/// @dev UNDERLYING_ORACLE (address) or UNDERLYING_SYMBOL picks the entry, both must agree when both are set. Signed
///      by the oracle owner, and only once the oracle is bound to the entry's pool. The ETH oracle (`underlyingOracle`)
///      is refused here, RenounceOracle also checks the scheduler reads it.
contract RenounceUnderlyingOracle is Underlyings {
    function run() external {
        _renounce(
            _deploymentsPath(), vm.envOr("UNDERLYING_ORACLE", address(0)), vm.envOr("UNDERLYING_SYMBOL", string(""))
        );
    }

    function _renounce(string memory path, address want, string memory symbol) internal {
        string memory json = _readDeploymentsAt(path);
        Underlying memory u = _pick(_underlyings(json), want, symbol);
        require(
            u.oracle != vm.parseJsonAddress(json, ".underlyingOracle"), "that is the ETH oracle, use RenounceOracle"
        );
        require(u.oracle.code.length != 0, "oracle has no code");
        UnderlyingOracleHook oracle = UnderlyingOracleHook(u.oracle);
        address owner = oracle.owner();
        require(owner != address(0), "oracle ownership is already renounced");
        UnderlyingOracleHook.FeedInfo memory info;
        try oracle.feedInfo() returns (UnderlyingOracleHook.FeedInfo memory i) {
            info = i;
        } catch {
            revert("oracle pool is not bound");
        }
        require(info.lastWriteTime != 0, "oracle pool is not bound");
        require(PoolId.unwrap(info.poolId) == PoolId.unwrap(_poolId(u.pool)), "oracle is bound to another pool");

        address signer = _startBroadcast();
        require(signer == owner, "signer is not the oracle owner");
        oracle.renounceOwnership();
        vm.stopBroadcast();

        require(oracle.owner() == address(0), "oracle still has an owner");
        console2.log(_isDryRun() ? "Oracle renounce simulated (nothing broadcast)" : "Oracle ownership renounced");
        _log("deployments", path);
        _log("symbol", u.symbol);
        _log("oracle", u.oracle);
        _log("previous owner", owner);
        _log("pool", vm.toString(PoolId.unwrap(info.poolId)));
        _log("last write time", vm.toString(info.lastWriteTime));
        _log("observations", vm.toString(info.observationCount));
        _log("frozen varMinE36", vm.toString(oracle.varMinE36()));
        _log("frozen varMaxE36", vm.toString(oracle.varMaxE36()));
        _log("frozen fallbackVarE36", vm.toString(oracle.fallbackVarE36()));
    }

    function _pick(Underlying[] memory list, address want, string memory symbol)
        internal
        pure
        returns (Underlying memory u)
    {
        require(want != address(0) || bytes(symbol).length != 0, "set UNDERLYING_ORACLE or UNDERLYING_SYMBOL");
        for (uint256 i; i < list.length; ++i) {
            bool byOracle = want == address(0) || list[i].oracle == want;
            bool bySymbol = bytes(symbol).length == 0 || keccak256(bytes(list[i].symbol)) == keccak256(bytes(symbol));
            if (byOracle && bySymbol) return list[i];
        }
        revert("no underlyings entry matches UNDERLYING_ORACLE / UNDERLYING_SYMBOL");
    }
}
