// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {DemoToken} from "../src/demo/DemoToken.sol";
import {PriceSteerer} from "../src/demo/PriceSteerer.sol";
import {UnderlyingOracleHook} from "../src/oracle/UnderlyingOracleHook.sol";
import {Underlyings} from "./base/Underlyings.sol";

/// @title SeedUnderlying
/// @notice Adds the file's full-range demoLiquidity to the empty pool of an `underlyings` entry recorded by
///         DeployUnderlying, through the file's PriceSteerer and signed by the steerer owner (the mirror key).
/// @dev UNDERLYING_SYMBOL picks the entry. With UNDERLYING_PRICE_USD set, the steerer first moves the still empty
///      pool to that price, which costs nothing, so a pool swapped away from its initial price is seeded where it
///      should be. The signer is MIRROR_PRIVATE_KEY or the CLI signer, never DEPLOYER_PRIVATE_KEY.
contract SeedUnderlying is Underlyings {
    using StateLibrary for IPoolManager;

    struct Target {
        Underlying u;
        IPoolManager pm;
        PriceSteerer steerer;
        uint128 liquidity;
        bool tokenIs0;
    }

    function run() external {
        require(vm.envExists("UNDERLYING_SYMBOL"), "UNDERLYING_SYMBOL is required, e.g. SOL");
        uint256 priceWad = vm.envExists("UNDERLYING_PRICE_USD")
            ? _parseUnits(vm.envString("UNDERLYING_PRICE_USD"), 18, "UNDERLYING_PRICE_USD")
            : 0;
        _seed(_deploymentsPath(), vm.envString("UNDERLYING_SYMBOL"), priceWad);
    }

    function _startBroadcast() internal virtual override returns (address sender) {
        uint256 pk = vm.envOr("MIRROR_PRIVATE_KEY", uint256(0));
        if (pk != 0) {
            vm.startBroadcast(pk);
            return vm.addr(pk);
        }
        vm.startBroadcast();
        (, sender,) = vm.readCallers();
    }

    function _seed(string memory path, string memory symbol, uint256 priceWad) internal {
        string memory json = _readDeploymentsAt(path);
        Target memory t = _target(json, symbol);
        require(priceWad == 0 || (priceWad >= 0.01e18 && priceWad <= 1e24), "UNDERLYING_PRICE_USD out of range");
        PoolId id = _poolId(t.u.pool);
        uint256 before = _poolPriceWad(t);

        address signer = _startBroadcast();
        require(signer == t.steerer.owner(), "signer is not the priceSteerer owner");
        if (priceWad != 0) t.steerer.steer(t.u.pool, _sqrtPriceX96(priceWad, t.tokenIs0));
        t.steerer.addLiquidityFullRange(t.u.pool, t.liquidity);
        vm.stopBroadcast();

        require(t.pm.getLiquidity(id) == t.liquidity, "pool liquidity after seeding");
        (int24 lower, int24 upper) = t.steerer.fullRange(t.u.pool.tickSpacing);
        (uint128 pos,,) = t.pm.getPositionInfo(id, address(t.steerer), lower, upper, bytes32(0));
        require(pos == t.liquidity, "steerer full-range position");

        console2.log(_isDryRun() ? "Seeding simulated (nothing broadcast)" : "Pool seeded");
        _log("deployments", path);
        _log("symbol", symbol);
        _log("signer (steerer owner)", signer);
        _log("priceSteerer", address(t.steerer));
        _log("pool", vm.toString(PoolId.unwrap(id)));
        _log("liquidity", vm.toString(t.liquidity));
        _log("pool price USD before", _formatUnits(before, 18, 4));
        _log(priceWad != 0 ? "steered to USD" : "not steered, seeded at USD", _formatUnits(_poolPriceWad(t), 18, 4));
    }

    function _target(string memory json, string memory symbol) internal view returns (Target memory t) {
        Underlying[] memory list = _underlyings(json);
        uint256 i = _indexOf(list, symbol);
        if (i == type(uint256).max) revert(string.concat("underlying ", symbol, " is not in the deployments file"));
        t.u = list[i];
        t.pm = IPoolManager(_jsonContract(json, "poolManager"));
        t.steerer = PriceSteerer(_jsonContract(json, "priceSteerer"));
        t.liquidity = SafeCastLib.toUint128(vm.parseJsonUint(json, ".demoLiquidity"));
        address demoUsdc = _jsonContract(json, "demoUsdc");
        t.tokenIs0 = Currency.unwrap(t.u.pool.currency0) == t.u.token;
        require(
            Currency.unwrap(t.tokenIs0 ? t.u.pool.currency1 : t.u.pool.currency0) == demoUsdc
                && Currency.unwrap(t.tokenIs0 ? t.u.pool.currency0 : t.u.pool.currency1) == t.u.token,
            "pool is not token/demoUsdc"
        );
        require(t.liquidity != 0, "demoLiquidity is zero");
        require(address(t.steerer.poolManager()) == address(t.pm), "priceSteerer is on another PoolManager");
        require(DemoToken(t.u.token).isMinter(address(t.steerer)), "priceSteerer is not a token minter");
        require(DemoToken(demoUsdc).isMinter(address(t.steerer)), "priceSteerer is not a demoUsdc minter");
        PoolId id = _poolId(t.u.pool);
        require(
            PoolId.unwrap(UnderlyingOracleHook(t.u.oracle).poolId()) == PoolId.unwrap(id),
            "oracle not bound to the pool"
        );
        require(t.pm.getLiquidity(id) == 0, string.concat("pool of ", symbol, " already has liquidity"));
    }

    /// @dev USD per token (18 decimals) against 6-decimal demoUsdc, at 1e18
    function _poolPriceWad(Target memory t) internal view returns (uint256) {
        (uint160 sp,,,) = t.pm.getSlot0(_poolId(t.u.pool));
        if (t.tokenIs0) return F.fullMulDiv(uint256(sp) * 1e15, uint256(sp) * 1e15, 1 << 192);
        return F.fullMulDiv(F.fullMulDiv(1e30, 1 << 96, sp), 1 << 96, sp);
    }
}
