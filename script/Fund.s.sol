// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {IPredictionHook} from "../src/interfaces/IPredictionHook.sol";
import {ScriptBase, IERC20Like} from "./base/ScriptBase.sol";

/// @notice LP deposit of Circle USDC into the PredictionHook vault: FUND_USDC (human units, default 500)
contract Fund is ScriptBase {
    function run() external returns (uint256 shares) {
        (string memory json, string memory path) = _readDeployments();
        IPredictionHook hook = IPredictionHook(_deployed(json, "predictionHook", "PREDICTION_HOOK"));
        address usdc = hook.usdc();
        uint256 amount = _envUnits("FUND_USDC", "500", 6);
        require(amount > 0, "FUND_USDC must be positive");

        address lp = _startBroadcast();
        uint256 bal = IERC20Like(usdc).balanceOf(lp);
        if (bal < amount) {
            revert(string.concat("LP holds ", _formatUnits(bal, 6, 2), " USDC, needs ", _formatUnits(amount, 6, 2)));
        }
        IERC20Like(usdc).approve(address(hook), amount);
        shares = hook.deposit(amount);
        vm.stopBroadcast();

        console2.log(_isDryRun() ? "Vault deposit simulated (nothing broadcast)" : "Vault deposit");
        _log("deployments", path);
        _log("hook", address(hook));
        _log("lp", lp);
        _log("deposited USDC", _formatUnits(amount, 6, 2));
        _log("shares", vm.toString(shares));
        _log("vault idle USDC", _formatUnits(hook.vaultIdle(), 6, 2));
        _log("NAV- USDC", _formatUnits(hook.navMinus(), 6, 2));
    }
}
