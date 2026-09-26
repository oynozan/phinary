// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {LibString} from "solady/utils/LibString.sol";
import {IMarketGatekeeper} from "../src/interfaces/IMarketGatekeeper.sol";
import {TrackSet} from "./base/TrackSet.sol";

/// @title DeployTracks
/// @notice Replaces the PredictionHook of deployments/<NETWORK>.json (or DEPLOYMENTS_FILE) with a fresh hook owned by a
///         new MarketGatekeeper and its per-track MarketSchedulers, on the file's existing PoolManager and USDC.
/// @dev Two steps, so the deployments file only ever names a set that was checked on-chain.
///      1. `forge script script/DeployTracks.s.sol --rpc-url <rpc> --broadcast` sends the two transactions and stages
///         the updated file as <file>.tracks.pending.json (<file>.dry-run.json without --broadcast).
///      2. `forge script script/DeployTracks.s.sol --sig 'record()' --rpc-url <rpc>` reads the set back from the chain
///         and only then rewrites <file>. The new hook becomes `predictionHook`, the gatekeeper `marketGatekeeper` and
///         its schedulers `marketSchedulers`. The old hook moves into `legacyPredictionHooks`, the old
///         `marketScheduler` (then removed) and `marketSchedulers` into `legacyMarketSchedulers`. TRACKS_DEPLOY_BLOCK
///         and TRACKS_DEPLOYED_AT set `deployBlock` / `deployedAt` to the hook's landing block, else step 1's
///         simulation block is kept. Every other key is kept.
///      record() rebuilds the tracks from the same env (TRACKS_ETH_ONLY, TRACK_*), see TrackSet.
///      script/sepolia.sh tracks runs both steps.
contract DeployTracks is TrackSet {
    string internal constant PENDING_SUFFIX = ".tracks.pending.json";

    struct Target {
        address poolManager;
        address usdc;
    }

    function run() external returns (Tracks memory t) {
        (t,) = _stage(_deploymentsPath(), trackSpecs());
    }

    function record() external {
        _record(
            _deploymentsPath(),
            trackSpecs(),
            vm.envOr("TRACKS_DEPLOY_BLOCK", uint256(0)),
            vm.envOr("TRACKS_DEPLOYED_AT", uint256(0))
        );
    }

    function _stage(string memory path, TrackSpec[] memory specs) internal returns (Tracks memory t, bytes32 salt) {
        string memory json = _readDeploymentsAt(path);
        string memory pending = _withSuffix(path, PENDING_SUFFIX);
        if (vm.exists(pending)) revert(string.concat("staged tracks await record(): ", pending));
        Target memory tg = _target(json);
        IMarketGatekeeper.Track[] memory tracks = _tracksFrom(json, specs);
        require(CREATE2_FACTORY.code.length != 0, "CREATE2 deployer missing");
        uint256 simBlock = block.number;

        address deployer = _startBroadcast();
        (t, salt) = _deployTracks(deployer, tg.poolManager, tg.usdc, tracks);
        vm.stopBroadcast();

        _verifyTracks(t, tg.poolManager, tg.usdc, tracks);
        string memory staged = _isDryRun() ? _withSuffix(path, ".dry-run.json") : pending;
        vm.writeJson(_merged(json, t, simBlock, block.timestamp), staged);

        console2.log(
            _isDryRun()
                ? "Tracks simulated (nothing broadcast)"
                : "Tracks deployed, the deployments file changes only after record()"
        );
        _log("deployments", path);
        _log("staged", staged);
        _log("deployer", deployer);
        _log("marketGatekeeper", t.gatekeeper);
        _log("predictionHook", t.hook);
        _log("hook salt", vm.toString(salt));
        if (vm.keyExistsJson(json, ".predictionHook")) _log("replaces", vm.parseJsonAddress(json, ".predictionHook"));
        _log("usdc", tg.usdc);
        _log("poolManager", tg.poolManager);
        _logTracks(tracks, specs, t.schedulers);
    }

    function _record(string memory path, TrackSpec[] memory specs, uint256 landedBlock, uint256 landedAt) internal {
        string memory pending = _withSuffix(path, PENDING_SUFFIX);
        if (!vm.exists(pending)) {
            revert(string.concat("no staged tracks at ", pending, ", run DeployTracks with --broadcast first"));
        }
        string memory staged = vm.readFile(pending);
        string memory json = _readDeploymentsAt(path);
        Target memory tg = _target(json);
        require(
            vm.parseJsonUint(staged, ".chainId") == block.chainid
                && vm.parseJsonAddress(staged, ".poolManager") == tg.poolManager
                && vm.parseJsonAddress(staged, ".usdc") == tg.usdc
                && _sameList(staged, ".legacyPredictionHooks", _legacyHooks(json))
                && _sameList(staged, ".legacyMarketSchedulers", _legacySchedulers(json)),
            "deployments file changed since the tracks were staged"
        );
        Tracks memory t = Tracks(
            vm.parseJsonAddress(staged, ".marketGatekeeper"),
            vm.parseJsonAddress(staged, ".predictionHook"),
            vm.parseJsonAddressArray(staged, ".marketSchedulers")
        );
        IMarketGatekeeper.Track[] memory tracks = _tracksFrom(json, specs);
        _verifyTracks(t, tg.poolManager, tg.usdc, tracks);

        uint256 deployBlock = vm.parseJsonUint(staged, ".deployBlock");
        uint256 deployedAt = vm.parseJsonUint(staged, ".deployedAt");
        if (landedBlock != 0) {
            require(
                landedBlock >= deployBlock && landedBlock <= block.number,
                "TRACKS_DEPLOY_BLOCK must lie between the staging block and the current block"
            );
            deployBlock = landedBlock;
        }
        if (landedAt != 0) {
            require(
                landedAt >= deployedAt && landedAt <= block.timestamp,
                "TRACKS_DEPLOYED_AT must lie between the staging time and now"
            );
            deployedAt = landedAt;
        }
        vm.writeJson(_merged(json, t, deployBlock, deployedAt), path);
        vm.removeFile(pending);

        console2.log("Tracks verified on-chain and recorded");
        _log("deployments", path);
        _log("marketGatekeeper", t.gatekeeper);
        _log("predictionHook", t.hook);
        for (uint256 i; i < t.schedulers.length; ++i) {
            _log(string.concat("marketSchedulers[", vm.toString(i), "] ", tracks[i].config.ticker), t.schedulers[i]);
        }
        _log(
            "deployBlock",
            string.concat(vm.toString(deployBlock), landedBlock != 0 ? " (landing block)" : " (staging block)")
        );
    }

    function _target(string memory json) internal view returns (Target memory t) {
        t.poolManager = _jsonContract(json, "poolManager");
        t.usdc = _jsonContract(json, "usdc");
    }

    /// @dev ETH from the flat `underlyingOracle`, every other symbol from the `underlyings` list
    function _tracksFrom(string memory json, TrackSpec[] memory specs)
        internal
        view
        returns (IMarketGatekeeper.Track[] memory)
    {
        address eth = _jsonContract(json, "underlyingOracle");
        Underlying[] memory list = _underlyings(json);
        string[] memory symbols = new string[](list.length + 1);
        address[] memory oracles = new address[](list.length + 1);
        symbols[0] = ETH;
        oracles[0] = eth;
        for (uint256 i; i < list.length; ++i) {
            symbols[i + 1] = list[i].symbol;
            oracles[i + 1] = list[i].oracle;
            if (LibString.eq(list[i].symbol, ETH)) {
                require(list[i].oracle == eth, "underlyings ETH oracle differs from underlyingOracle");
            }
        }
        return _resolve(specs, symbols, oracles);
    }

    /* Deployments file */

    /// @dev The file's legacyPredictionHooks with its current predictionHook appended (once)
    function _legacyHooks(string memory json) internal view returns (address[] memory list) {
        list = _list(json, ".legacyPredictionHooks");
        if (vm.keyExistsJson(json, ".predictionHook")) list = _appendOnce(list, vm.parseJsonAddress(json, ".predictionHook"));
    }

    /// @dev The file's legacyMarketSchedulers with its current marketScheduler and marketSchedulers appended (once)
    function _legacySchedulers(string memory json) internal view returns (address[] memory list) {
        list = _list(json, ".legacyMarketSchedulers");
        if (vm.keyExistsJson(json, ".marketScheduler")) {
            list = _appendOnce(list, vm.parseJsonAddress(json, ".marketScheduler"));
        }
        address[] memory current = _list(json, ".marketSchedulers");
        for (uint256 i; i < current.length; ++i) {
            list = _appendOnce(list, current[i]);
        }
    }

    function _list(string memory json, string memory key) internal view returns (address[] memory) {
        return vm.keyExistsJson(json, key) ? vm.parseJsonAddressArray(json, key) : new address[](0);
    }

    function _sameList(string memory json, string memory key, address[] memory expected) internal view returns (bool) {
        return keccak256(abi.encode(_list(json, key))) == keccak256(abi.encode(expected));
    }

    function _appendOnce(address[] memory list, address a) internal pure returns (address[] memory out) {
        if (a == address(0)) return list;
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == a) return list;
        }
        out = new address[](list.length + 1);
        for (uint256 i; i < list.length; ++i) {
            out[i] = list[i];
        }
        out[list.length] = a;
    }

    function _merged(string memory json, Tracks memory t, uint256 deployBlock, uint256 deployedAt)
        internal
        returns (string memory)
    {
        string memory o = "tracksDeployment";
        vm.serializeJson(o, json);
        vm.serializeAddress(o, "legacyPredictionHooks", _legacyHooks(json));
        vm.serializeAddress(o, "legacyMarketSchedulers", _legacySchedulers(json));
        vm.serializeAddress(o, "marketGatekeeper", t.gatekeeper);
        vm.serializeAddress(o, "marketSchedulers", t.schedulers);
        vm.serializeUint(o, "deployBlock", deployBlock);
        vm.serializeUint(o, "deployedAt", deployedAt);
        return _withoutKey(vm.serializeAddress(o, "predictionHook", t.hook), "marketScheduler");
    }

    /// @dev `json` (compact, as the serialize cheatcodes return it) without the top-level string field `key`
    function _withoutKey(string memory json, string memory key) internal view returns (string memory out) {
        if (!vm.keyExistsJson(json, string.concat(".", key))) return json;
        string memory needle = string.concat('"', key, '":"');
        uint256 start = LibString.indexOf(json, needle);
        require(start != LibString.NOT_FOUND, string.concat(key, " is not a string field"));
        uint256 end = LibString.indexOf(json, '"', start + bytes(needle).length);
        require(end != LibString.NOT_FOUND, string.concat("unterminated ", key));
        ++end;
        bytes memory b = bytes(json);
        if (b[start - 1] == ",") --start;
        else if (b[end] == ",") ++end;
        out = string.concat(LibString.slice(json, 0, start), LibString.slice(json, end, b.length));
        require(
            !vm.keyExistsJson(out, string.concat(".", key))
                && vm.parseJsonKeys(out, "$").length + 1 == vm.parseJsonKeys(json, "$").length,
            string.concat("could not drop ", key, " from the deployments file")
        );
    }
}
