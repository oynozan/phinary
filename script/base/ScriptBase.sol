// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

interface IPredictionHookAdmin {
    function owner() external view returns (address);
    function keeper() external view returns (address);
    function setKeeper(address keeper_) external;
    function usdc() external view returns (address);
}

/// @notice Chain-1301 constants, signer selection, hook-address mining and deployments-file I/O shared by the scripts.
abstract contract ScriptBase is Script {
    uint256 internal constant CHAIN_ID_1301 = 1301;
    address internal constant POOL_MANAGER_1301 = 0x00B036B58a818B1BC34d502D3fE730Db729e62AC;
    address internal constant V4_QUOTER_1301 = 0x56DCD40A3F2d466F48e7F48bDBE5Cc9B92Ae4472;
    address internal constant UNIVERSAL_ROUTER_1301 = 0xf70536B3bcC1bD1a972dc186A2cf84cC6da6Be5D;
    address internal constant STATE_VIEW_1301 = 0xc199F1072a74D4e905ABa1A84d9a45E2546B6222;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address internal constant CIRCLE_USDC_1301 = 0x31d0220469e10c4E71834a79b1f276d740d3768F;
    string internal constant EXPLORER_1301 = "https://sepolia.uniscan.xyz";
    string internal constant PUBLIC_RPC_1301 = "https://sepolia.unichain.org";

    uint256 internal constant SECONDS_PER_YEAR = 31_557_600;
    uint256 internal constant MAX_SALT_SEARCH = 1_000_000;

    /* Signer */

    /// @dev DEPLOYER_PRIVATE_KEY (forge loads the repo .env) wins, else the CLI signer (--account, --ledger, --private-key)
    function _startBroadcast() internal returns (address sender) {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk != 0) {
            vm.startBroadcast(pk);
            return vm.addr(pk);
        }
        vm.startBroadcast();
        (, sender,) = vm.readCallers();
    }

    function _isDryRun() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptDryRun);
    }

    /* Environment */

    function _envAddress(string memory name, address def) internal view returns (address) {
        return vm.envOr(name, def);
    }

    function _envUnits(string memory name, string memory def, uint8 decimals) internal view returns (uint256) {
        return _parseUnits(vm.envOr(name, def), decimals, name);
    }

    function _network() internal view returns (string memory) {
        return vm.envOr("NETWORK", string("unichain-sepolia"));
    }

    function _deploymentsPath() internal view returns (string memory) {
        string memory file = vm.envOr("DEPLOYMENTS_FILE", string(""));
        if (bytes(file).length == 0) return string.concat(vm.projectRoot(), "/deployments/", _network(), ".json");
        if (bytes(file)[0] == "/") return file;
        return string.concat(vm.projectRoot(), "/", file);
    }

    function _readDeployments() internal view returns (string memory json, string memory path) {
        path = _deploymentsPath();
        if (!vm.exists(path)) revert(string.concat("deployments file not found: ", path));
        json = vm.readFile(path);
        uint256 chainId = vm.parseJsonUint(json, ".chainId");
        if (chainId != block.chainid) {
            revert(string.concat("deployments file is for chain ", vm.toString(chainId), ", RPC is ", vm.toString(block.chainid)));
        }
    }

    function _deployed(string memory json, string memory key, string memory envName) internal view returns (address a) {
        a = vm.envOr(envName, address(0));
        if (a == address(0)) a = vm.parseJsonAddress(json, string.concat(".", key));
        if (a.code.length == 0) revert(string.concat(key, " has no code at ", vm.toString(a)));
    }

    /* Hook address mining */

    /// @dev First salt whose CREATE2 address through the deterministic deployer carries exactly `flags` and is empty
    function _mineHookSalt(uint160 flags, bytes memory initCode) internal view returns (bytes32 salt, address hook) {
        bytes32 initHash = keccak256(initCode);
        for (uint256 i; i < MAX_SALT_SEARCH; ++i) {
            hook = vm.computeCreate2Address(bytes32(i), initHash, CREATE2_FACTORY);
            if (uint160(hook) & Hooks.ALL_HOOK_MASK == flags && hook.code.length == 0) return (bytes32(i), hook);
        }
        revert("no hook salt found");
    }

    function _create2(bytes32 salt, bytes memory initCode, address expected) internal {
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
        require(ok && ret.length == 20 && address(bytes20(ret)) == expected, "CREATE2 deployment failed");
    }

    /* Pricing */

    /// @dev sqrtPriceX96 of a demo WETH (18 dec) / USDC (6 dec) pool at `priceWad` USD per ETH, for either ordering
    function _sqrtPriceX96(uint256 priceWad, bool wethIsCurrency0) internal pure returns (uint160) {
        uint256 ratioX192 = wethIsCurrency0
            ? FullMath.mulDiv(priceWad * 1e6, 1 << 192, 1e36)
            : FullMath.mulDiv(1e36, 1 << 192, priceWad * 1e6);
        return uint160(F.sqrt(ratioX192));
    }

    /// @dev Per-second variance at 1e36 from an annual volatility in WAD
    function _varE36(uint256 sigmaAnnualWad) internal pure returns (uint256) {
        return sigmaAnnualWad * sigmaAnnualWad / SECONDS_PER_YEAR;
    }

    /* Decimal strings */

    function _parseUnits(string memory s, uint8 decimals, string memory what) internal pure returns (uint256 v) {
        bytes memory b = bytes(s);
        bool dot;
        uint256 frac;
        if (b.length == 0) revert(string.concat(what, " is empty"));
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c == ".") {
                if (dot) revert(string.concat(what, " is not a decimal: ", s));
                dot = true;
            } else if (c >= "0" && c <= "9") {
                if (dot && ++frac > decimals) revert(string.concat(what, " has too many decimals: ", s));
                v = v * 10 + uint8(c) - 48;
            } else {
                revert(string.concat(what, " is not a decimal: ", s));
            }
        }
        v *= 10 ** (decimals - frac);
    }

    function _formatUnits(uint256 v, uint8 decimals, uint8 shown) internal pure returns (string memory) {
        uint256 unit = 10 ** decimals;
        uint256 whole = v / unit;
        if (shown == 0) return vm.toString(whole);
        uint256 f = (v % unit) / 10 ** (decimals - shown);
        bytes memory fs = bytes(vm.toString(f));
        bytes memory pad = new bytes(shown - fs.length);
        for (uint256 i; i < pad.length; ++i) {
            pad[i] = "0";
        }
        return string.concat(vm.toString(whole), ".", string(pad), string(fs));
    }

    function _log(string memory k, string memory v) internal pure {
        console2.log(string.concat("  ", k, ": ", v));
    }

    function _log(string memory k, address v) internal pure {
        _log(k, vm.toString(v));
    }
}
