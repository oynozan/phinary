// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {IMarketScheduler} from "../src/interfaces/IMarketScheduler.sol";
import {IUnderlyingOracle} from "../src/interfaces/IUnderlyingOracle.sol";
import {SchedulerPair} from "./base/SchedulerPair.sol";

interface IDemoToken {
    function setMinter(address account, bool allowed) external;
}

interface IPriceSteerer {
    function addLiquidityFullRange(PoolKey calldata key, uint128 liquidity) external returns (int256);
    function owner() external view returns (address);
}

interface IOracleHookView {
    function poolId() external view returns (PoolId);
    function owner() external view returns (address);
}

/// @title Deploy
/// @notice Deploys the demo stack on Unichain Sepolia (1301) or an anvil fork of it and writes deployments/<NETWORK>.json:
///         demo WETH/USDC, the UnderlyingOracleHook at a mined CREATE2 address, the owner-initialised underlying pool,
///         a PriceSteerer seeding full-range liquidity, and the MarketScheduler with the PredictionHook it owns
///         (flags 0x2AA8, no keeper).
/// @dev forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast. Every parameter has an env override, see
///      docs/RUNBOOK.md and SchedulerPair. A run without --broadcast writes <NETWORK>.dry-run.json instead.
///      KEEPER_ADDRESS only names the keeper bot's account in the file, the hook grants it no role.
contract Deploy is SchedulerPair {
    uint160 internal constant ORACLE_FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);

    struct OracleConfig {
        uint32 gridSeconds;
        uint16 nWindows;
        uint16 minWindows;
        uint32 winsorTicks;
        uint256 varMinE36;
        uint256 varMaxE36;
        uint256 fallbackVarE36;
        uint16 cardinality;
    }

    struct Deployment {
        address deployer;
        address keeper;
        address poolManager;
        address usdc;
        address demoWeth;
        address demoUsdc;
        address underlyingOracle;
        address priceSteerer;
        address marketScheduler;
        address predictionHook;
        PoolKey underlyingPool;
        uint160 sqrtPriceX96;
        uint256 ethPriceWad;
        uint128 liquidity;
        uint256 deployBlock;
    }

    function run() external returns (Deployment memory d) {
        _checkChain();
        OracleConfig memory oc = oracleConfig();
        d.poolManager = POOL_MANAGER_1301;
        d.usdc = CIRCLE_USDC_1301;
        d.ethPriceWad = _envUnits("ETH_PRICE_USD", "2700", 18);
        d.liquidity = uint128(vm.envOr("DEMO_LIQUIDITY", uint256(1e18)));
        d.deployBlock = block.number;
        uint24 fee = uint24(vm.envOr("UNDERLYING_FEE", uint256(500)));
        int24 spacing = int24(int256(vm.envOr("UNDERLYING_TICK_SPACING", uint256(10))));
        require(d.ethPriceWad >= 1e18 && d.ethPriceWad <= 1e24, "ETH_PRICE_USD out of range");
        IMarketScheduler.Config memory sc = schedulerConfig();
        _checkConfig(sc);

        d.deployer = _startBroadcast();
        d.keeper = _envAddress("KEEPER_ADDRESS", d.deployer);
        _deployUnderlying(d, oc, fee, spacing);
        _deployPredictionHook(d, sc);
        vm.stopBroadcast();

        _verify(d, oc, sc);
        _write(d, oc);
        _logConfig(sc);
    }

    /// @notice Oracle parameters for 1-minute demo markets: 10 s grid, 30 min lookback, 5 min warm-up, >= 2 h of history
    function oracleConfig() public view returns (OracleConfig memory oc) {
        oc.gridSeconds = uint32(vm.envOr("ORACLE_GRID_SECONDS", uint256(10)));
        oc.nWindows = uint16(vm.envOr("ORACLE_N_WINDOWS", uint256(180)));
        oc.minWindows = uint16(vm.envOr("ORACLE_MIN_WINDOWS", uint256(30)));
        // About 8 SD of a 10 s window-mean move at the 250% cap
        oc.winsorTicks = uint32(vm.envOr("ORACLE_WINSOR_TICKS", uint256(100)));
        oc.varMinE36 = _varE36(_envUnits("ORACLE_SIGMA_MIN", "0.2", 18));
        oc.varMaxE36 = _varE36(_envUnits("ORACLE_SIGMA_MAX", "2.5", 18));
        oc.fallbackVarE36 = _varE36(_envUnits("ORACLE_SIGMA_FALLBACK", "0.6", 18));
        oc.cardinality = uint16(vm.envOr("ORACLE_CARDINALITY", uint256(14_400)));
        require(oc.cardinality >= 7200, "ORACLE_CARDINALITY must cover 2 h of 1 s writes");
    }

    function _checkChain() internal view {
        require(block.chainid == CHAIN_ID_1301, "Deploy targets chain 1301 (Unichain Sepolia or an anvil fork of it)");
        require(POOL_MANAGER_1301.code.length != 0, "PoolManager missing");
        require(CIRCLE_USDC_1301.code.length != 0, "Circle USDC missing");
        require(CREATE2_FACTORY.code.length != 0, "CREATE2 deployer missing");
        require(PERMIT2.code.length != 0 && UNIVERSAL_ROUTER_1301.code.length != 0, "Permit2 or UniversalRouter missing");
    }

    function _deployUnderlying(Deployment memory d, OracleConfig memory oc, uint24 fee, int24 spacing) internal {
        d.demoWeth = deployCode(
            "src/demo/DemoToken.sol:DemoToken",
            abi.encode("Demo Wrapped Ether", "dWETH", uint8(18), 1 ether, 5 ether, d.deployer)
        );
        d.demoUsdc = deployCode(
            "src/demo/DemoToken.sol:DemoToken",
            abi.encode("Demo USD Coin", "dUSDC", uint8(6), 10_000e6, 50_000e6, d.deployer)
        );

        bytes memory init = abi.encodePacked(
            vm.getCode("src/oracle/UnderlyingOracleHook.sol:UnderlyingOracleHook"),
            abi.encode(
                d.poolManager,
                d.demoUsdc,
                Currency.wrap(d.demoWeth),
                oc.gridSeconds,
                oc.nWindows,
                oc.minWindows,
                oc.winsorTicks,
                oc.varMinE36,
                oc.varMaxE36,
                oc.fallbackVarE36,
                oc.cardinality,
                d.deployer
            )
        );
        (bytes32 salt, address oracle) = _mineHookSalt(ORACLE_FLAGS, init);
        _create2(salt, init, oracle);
        d.underlyingOracle = oracle;

        bool wethIs0 = d.demoWeth < d.demoUsdc;
        (address c0, address c1) = wethIs0 ? (d.demoWeth, d.demoUsdc) : (d.demoUsdc, d.demoWeth);
        d.underlyingPool = PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(oracle));
        d.sqrtPriceX96 = _sqrtPriceX96(d.ethPriceWad, wethIs0);
        // The oracle binds only a pool initialised by its owner, so this call must come from the deployer
        IPoolManager(d.poolManager).initialize(d.underlyingPool, d.sqrtPriceX96);

        d.priceSteerer = deployCode("src/demo/PriceSteerer.sol:PriceSteerer", abi.encode(d.poolManager, d.deployer));
        IDemoToken(d.demoWeth).setMinter(d.priceSteerer, true);
        IDemoToken(d.demoUsdc).setMinter(d.priceSteerer, true);
        IPriceSteerer(d.priceSteerer).addLiquidityFullRange(d.underlyingPool, d.liquidity);
    }

    function _deployPredictionHook(Deployment memory d, IMarketScheduler.Config memory sc) internal {
        (Pair memory p,) = _deployPair(d.deployer, d.poolManager, d.usdc, d.underlyingOracle, sc);
        d.marketScheduler = p.scheduler;
        d.predictionHook = p.hook;
    }

    function _verify(Deployment memory d, OracleConfig memory oc, IMarketScheduler.Config memory sc) internal view {
        _verifyPair(Pair(d.marketScheduler, d.predictionHook), d.poolManager, d.usdc, d.underlyingOracle, sc);
        require(uint160(d.underlyingOracle) & Hooks.ALL_HOOK_MASK == ORACLE_FLAGS, "oracle hook flags");
        require(PoolId.unwrap(IOracleHookView(d.underlyingOracle).poolId()) == PoolId.unwrap(_poolId(d.underlyingPool)), "oracle not bound");
        require(IOracleHookView(d.underlyingOracle).owner() == d.deployer, "oracle owner");
        require(IPriceSteerer(d.priceSteerer).owner() == d.deployer, "steerer owner");
        int256 lnSpot = IUnderlyingOracle(d.underlyingOracle).lnSpotSoBWad();
        int256 diff = lnSpot - F.lnWad(int256(d.ethPriceWad));
        require(diff < 1e12 && diff > -1e12, "oracle spot differs from ETH_PRICE_USD");
        (uint256 v, bool warm) = IUnderlyingOracle(d.underlyingOracle).varianceE36();
        require(!warm && v == oc.fallbackVarE36, "oracle should start on the fallback variance");
    }

    function _poolId(PoolKey memory k) internal pure returns (PoolId) {
        return PoolId.wrap(keccak256(abi.encode(k)));
    }

    /* Output */

    function _write(Deployment memory d, OracleConfig memory oc) internal {
        string memory o = "deployment";
        vm.serializeString(o, "network", _network());
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeString(o, "rpcUrl", vm.envOr("DEPLOYMENTS_RPC_URL", string(PUBLIC_RPC_1301)));
        vm.serializeString(o, "explorer", EXPLORER_1301);
        vm.serializeUint(o, "deployBlock", d.deployBlock);
        vm.serializeUint(o, "deployedAt", block.timestamp);
        vm.serializeAddress(o, "deployer", d.deployer);
        vm.serializeAddress(o, "keeper", d.keeper);
        vm.serializeAddress(o, "poolManager", d.poolManager);
        vm.serializeAddress(o, "v4Quoter", V4_QUOTER_1301);
        vm.serializeAddress(o, "universalRouter", UNIVERSAL_ROUTER_1301);
        vm.serializeAddress(o, "permit2", PERMIT2);
        vm.serializeAddress(o, "stateView", STATE_VIEW_1301);
        vm.serializeAddress(o, "multicall3", MULTICALL3);
        vm.serializeAddress(o, "usdc", d.usdc);
        vm.serializeAddress(o, "predictionHook", d.predictionHook);
        vm.serializeAddress(o, "marketScheduler", d.marketScheduler);
        vm.serializeAddress(o, "underlyingOracle", d.underlyingOracle);
        vm.serializeAddress(o, "priceSteerer", d.priceSteerer);
        vm.serializeAddress(o, "demoWeth", d.demoWeth);
        vm.serializeAddress(o, "demoUsdc", d.demoUsdc);
        vm.serializeBytes32(o, "underlyingPoolId", PoolId.unwrap(_poolId(d.underlyingPool)));
        vm.serializeString(o, "underlyingPool", _poolJson(d.underlyingPool));
        vm.serializeString(o, "initialEthPriceUsd", _formatUnits(d.ethPriceWad, 18, 2));
        vm.serializeString(o, "initialSqrtPriceX96", vm.toString(d.sqrtPriceX96));
        vm.serializeString(o, "demoLiquidity", vm.toString(d.liquidity));
        string memory json = vm.serializeString(o, "oracleParams", _oracleJson(oc));

        string memory path = _deploymentsPath();
        if (_isDryRun()) path = string.concat(vm.replace(path, ".json", ""), ".dry-run.json");
        vm.writeJson(json, path);

        console2.log(_isDryRun() ? "Dry run (nothing broadcast)" : "Deployed");
        _log("network", _network());
        _log("deployer", d.deployer);
        _log("keeper bot", d.keeper);
        _log("demoWeth (dWETH)", d.demoWeth);
        _log("demoUsdc (dUSDC)", d.demoUsdc);
        _log("underlyingOracle", d.underlyingOracle);
        _log("priceSteerer", d.priceSteerer);
        _log("predictionHook", d.predictionHook);
        _log("marketScheduler", d.marketScheduler);
        _log("underlying pool", vm.toString(PoolId.unwrap(_poolId(d.underlyingPool))));
        _log("initial ETH price", _formatUnits(d.ethPriceWad, 18, 2));
        _log("written", path);
    }

    function _poolJson(PoolKey memory k) internal returns (string memory) {
        string memory o = "underlyingPool";
        vm.serializeAddress(o, "currency0", Currency.unwrap(k.currency0));
        vm.serializeAddress(o, "currency1", Currency.unwrap(k.currency1));
        vm.serializeUint(o, "fee", k.fee);
        vm.serializeInt(o, "tickSpacing", k.tickSpacing);
        return vm.serializeAddress(o, "hooks", address(k.hooks));
    }

    function _oracleJson(OracleConfig memory oc) internal returns (string memory) {
        string memory o = "oracleParams";
        vm.serializeUint(o, "gridSeconds", oc.gridSeconds);
        vm.serializeUint(o, "nWindows", oc.nWindows);
        vm.serializeUint(o, "minWindows", oc.minWindows);
        vm.serializeUint(o, "winsorTicks", oc.winsorTicks);
        vm.serializeString(o, "varMinE36", vm.toString(oc.varMinE36));
        vm.serializeString(o, "varMaxE36", vm.toString(oc.varMaxE36));
        vm.serializeString(o, "fallbackVarE36", vm.toString(oc.fallbackVarE36));
        return vm.serializeUint(o, "cardinality", oc.cardinality);
    }
}
