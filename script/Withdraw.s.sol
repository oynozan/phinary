// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {IPredictionHook} from "../src/interfaces/IPredictionHook.sol";
import {ScriptBase, IERC20Like} from "./base/ScriptBase.sol";

/// @title Withdraw
/// @notice Withdraws every vault share the signer holds in WITHDRAW_HOOK, once that hook is drained (no USDC locked in
///         markets, navMinus == vaultIdle).
/// @dev WITHDRAW_HOOK is required and must be the deployments file's predictionHook or one of its legacyPredictionHooks.
contract Withdraw is ScriptBase {
    function run() external returns (uint256 assets) {
        require(vm.envExists("WITHDRAW_HOOK"), "WITHDRAW_HOOK is required, the PredictionHook to withdraw from");
        (string memory json, string memory path) = _readDeployments();
        assets = _withdraw(json, path, vm.envAddress("WITHDRAW_HOOK"));
    }

    function _withdraw(string memory json, string memory path, address target) internal returns (uint256 assets) {
        require(_isRecordedHook(json, target), "WITHDRAW_HOOK is neither predictionHook nor in legacyPredictionHooks");
        require(target.code.length != 0, string.concat("WITHDRAW_HOOK has no code at ", vm.toString(target)));
        IPredictionHook hook = IPredictionHook(target);
        IERC20Like usdc = IERC20Like(hook.usdc());
        uint256 idle = hook.vaultIdle();
        uint256 nav = hook.navMinus();
        if (nav != idle) {
            revert(
                string.concat(
                    "hook is not drained, navMinus ",
                    _formatUnits(nav, 6, 6),
                    " USDC but vaultIdle ",
                    _formatUnits(idle, 6, 6),
                    " USDC, settle and sweep its markets first"
                )
            );
        }

        address lp = _startBroadcast();
        uint256 shares = hook.sharesOf(lp);
        require(shares != 0, "signer holds no shares in WITHDRAW_HOOK");
        uint256 before = usdc.balanceOf(lp);
        assets = hook.withdraw(shares);
        vm.stopBroadcast();

        require(hook.sharesOf(lp) == 0, "signer still holds shares");
        require(usdc.balanceOf(lp) == before + assets, "USDC balance did not grow by the withdrawn amount");
        console2.log(_isDryRun() ? "Vault withdrawal simulated (nothing broadcast)" : "Vault withdrawal");
        _log("deployments", path);
        _log("hook", target);
        _log("lp", lp);
        _log("shares burned", vm.toString(shares));
        _log("withdrawn USDC", _formatUnits(assets, 6, 6));
        _log("vault idle left USDC", _formatUnits(hook.vaultIdle(), 6, 6));
        _log("total shares left", vm.toString(hook.totalShares()));
    }

    function _isRecordedHook(string memory json, address target) internal view returns (bool) {
        if (target == address(0)) return false;
        if (vm.keyExistsJson(json, ".predictionHook") && vm.parseJsonAddress(json, ".predictionHook") == target) {
            return true;
        }
        if (!vm.keyExistsJson(json, ".legacyPredictionHooks")) return false;
        address[] memory legacy = vm.parseJsonAddressArray(json, ".legacyPredictionHooks");
        for (uint256 i; i < legacy.length; ++i) {
            if (legacy[i] == target) return true;
        }
        return false;
    }
}
