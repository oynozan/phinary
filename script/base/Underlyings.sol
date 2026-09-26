// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {LibString} from "solady/utils/LibString.sol";
import {ScriptBase} from "./ScriptBase.sol";

/// @notice The deployments file's `underlyings` list, one {symbol, token, oracle, pool, poolId} entry per price source.
/// @dev A file without the list reads as a single ETH entry built from the flat demoWeth, underlyingOracle,
///      underlyingPool and underlyingPoolId keys, so the first write seeds it. Every other key of the file is kept.
abstract contract Underlyings is ScriptBase {
    struct Underlying {
        string symbol;
        address token;
        address oracle;
        PoolKey pool;
    }

    string internal constant LIST_PLACEHOLDER = "__underlyings_list__";

    function _underlyings(string memory json) internal view returns (Underlying[] memory list) {
        if (!vm.keyExistsJson(json, ".underlyings")) {
            list = new Underlying[](1);
            list[0] = _ethSeed(json);
            return list;
        }
        uint256 n;
        while (vm.keyExistsJson(json, _at(n))) {
            ++n;
        }
        list = new Underlying[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = _parseUnderlying(json, _at(i));
        }
    }

    function _at(uint256 i) internal pure returns (string memory) {
        return string.concat(".underlyings[", vm.toString(i), "]");
    }

    function _ethSeed(string memory json) internal pure returns (Underlying memory u) {
        u.symbol = "ETH";
        u.token = vm.parseJsonAddress(json, ".demoWeth");
        u.oracle = vm.parseJsonAddress(json, ".underlyingOracle");
        u.pool = _parsePool(json, ".underlyingPool");
        _checkPoolId(u, vm.parseJsonBytes32(json, ".underlyingPoolId"));
    }

    function _parseUnderlying(string memory json, string memory k) internal pure returns (Underlying memory u) {
        u.symbol = vm.parseJsonString(json, string.concat(k, ".symbol"));
        u.token = vm.parseJsonAddress(json, string.concat(k, ".token"));
        u.oracle = vm.parseJsonAddress(json, string.concat(k, ".oracle"));
        u.pool = _parsePool(json, string.concat(k, ".pool"));
        _checkPoolId(u, vm.parseJsonBytes32(json, string.concat(k, ".poolId")));
    }

    function _parsePool(string memory json, string memory k) internal pure returns (PoolKey memory p) {
        p.currency0 = Currency.wrap(vm.parseJsonAddress(json, string.concat(k, ".currency0")));
        p.currency1 = Currency.wrap(vm.parseJsonAddress(json, string.concat(k, ".currency1")));
        p.fee = uint24(vm.parseJsonUint(json, string.concat(k, ".fee")));
        p.tickSpacing = int24(vm.parseJsonInt(json, string.concat(k, ".tickSpacing")));
        p.hooks = IHooks(vm.parseJsonAddress(json, string.concat(k, ".hooks")));
    }

    function _checkPoolId(Underlying memory u, bytes32 id) internal pure {
        if (PoolId.unwrap(_poolId(u.pool)) != id) {
            revert(string.concat("poolId of ", u.symbol, " does not match its pool"));
        }
        if (address(u.pool.hooks) != u.oracle) revert(string.concat("pool of ", u.symbol, " is not on its oracle"));
    }

    /// @dev Index of `symbol` in `list`, or type(uint256).max
    function _indexOf(Underlying[] memory list, string memory symbol) internal pure returns (uint256) {
        for (uint256 i; i < list.length; ++i) {
            if (LibString.eq(list[i].symbol, symbol)) return i;
        }
        return type(uint256).max;
    }

    function _appended(Underlying[] memory list, Underlying memory u) internal pure returns (Underlying[] memory out) {
        if (_indexOf(list, u.symbol) != type(uint256).max) {
            revert(string.concat("underlying ", u.symbol, " is already in the deployments file"));
        }
        out = new Underlying[](list.length + 1);
        for (uint256 i; i < list.length; ++i) {
            out[i] = list[i];
        }
        out[list.length] = u;
    }

    /// @dev `json` with `underlyings` set to `list`, every other key as it was
    function _withUnderlyings(string memory json, Underlying[] memory list) internal returns (string memory out) {
        string memory arr = "[";
        for (uint256 i; i < list.length; ++i) {
            arr = string.concat(
                arr, i == 0 ? "" : ",", _underlyingJson(list[i], string.concat("underlyings.", vm.toString(i)))
            );
        }
        // serializeString only nests JSON objects, so the array goes in through a placeholder
        string memory o = "underlyingsFile";
        vm.serializeJson(o, json);
        out = vm.serializeString(o, "underlyings", LIST_PLACEHOLDER);
        out = vm.replace(out, string.concat('"', LIST_PLACEHOLDER, '"'), string.concat(arr, "]"));
    }

    function _underlyingJson(Underlying memory u, string memory o) internal returns (string memory) {
        string memory po = string.concat(o, ".pool");
        vm.serializeAddress(po, "currency0", Currency.unwrap(u.pool.currency0));
        vm.serializeAddress(po, "currency1", Currency.unwrap(u.pool.currency1));
        vm.serializeUint(po, "fee", u.pool.fee);
        vm.serializeInt(po, "tickSpacing", u.pool.tickSpacing);
        string memory pool = vm.serializeAddress(po, "hooks", address(u.pool.hooks));

        vm.serializeString(o, "symbol", u.symbol);
        vm.serializeAddress(o, "token", u.token);
        vm.serializeAddress(o, "oracle", u.oracle);
        vm.serializeBytes32(o, "poolId", PoolId.unwrap(_poolId(u.pool)));
        return vm.serializeString(o, "pool", pool);
    }

    function _poolId(PoolKey memory k) internal pure returns (PoolId) {
        return PoolId.wrap(keccak256(abi.encode(k)));
    }

    function _withSuffix(string memory path, string memory suffix) internal pure returns (string memory) {
        if (LibString.endsWith(path, ".json")) path = LibString.slice(path, 0, bytes(path).length - 5);
        return string.concat(path, suffix);
    }
}
