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
import {LibString} from "solady/utils/LibString.sol";
import {IMarketGatekeeper} from "../src/interfaces/IMarketGatekeeper.sol";
import {IUnderlyingOracle} from "../src/interfaces/IUnderlyingOracle.sol";
import {TrackSet} from "./base/TrackSet.sol";

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
///         a PriceSteerer seeding full-range liquidity, the same oracle stack for demo SOL, and the MarketGatekeeper
///         with its four track schedulers and the PredictionHook it owns (flags 0x2AA8, no keeper).
/// @dev forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast. Every parameter has an env override, see
///      docs/md/RUNBOOK.md and TrackSet. TRACKS_ETH_ONLY=1 skips the SOL stack and its two tracks. A run without
///      --broadcast writes <NETWORK>.dry-run.json instead. KEEPER_ADDRESS only names the keeper bot's account in the
///      file, the hook grants it no role.
contract Deploy is TrackSet {
    uint160 internal constant ORACLE_FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
    string internal constant SOL = "SOL";

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
        address marketGatekeeper;
        address predictionHook;
        PoolKey underlyingPool;
        uint160 sqrtPriceX96;
        uint256 ethPriceWad;
        uint128 liquidity;
        uint256 deployBlock;
        address[] marketSchedulers;
        Underlying sol;
        uint160 solSqrtPriceX96;
        uint256 solPriceWad;
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
        TrackSpec[] memory specs = trackSpecs();
        _checkTracks(specs);
        bool withSol = _needs(specs, SOL);
        if (withSol) {
            d.sol.symbol = SOL;
            d.solPriceWad = _envUnits("SOL_PRICE_USD", "150", 18);
            require(d.solPriceWad >= 0.01e18 && d.solPriceWad <= 1e24, "SOL_PRICE_USD out of range");
        }

        d.deployer = _startBroadcast();
        d.keeper = _envAddress("KEEPER_ADDRESS", d.deployer);
        _deployUnderlying(d, oc, fee, spacing);
        if (withSol) _deploySol(d, oc, fee, spacing);
        IMarketGatekeeper.Track[] memory tracks = _resolve(specs, _symbols(), _oracles(d));
        (Tracks memory t,) = _deployTracks(d.deployer, d.poolManager, d.usdc, tracks);
        vm.stopBroadcast();
        d.marketGatekeeper = t.gatekeeper;
        d.predictionHook = t.hook;
        d.marketSchedulers = t.schedulers;

        _verify(d, oc, tracks);
        _write(d, oc);
        _logTracks(tracks, specs, t.schedulers);
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

    function _needs(TrackSpec[] memory specs, string memory symbol) internal pure returns (bool) {
        for (uint256 i; i < specs.length; ++i) {
            if (LibString.eq(specs[i].underlying, symbol)) return true;
        }
        return false;
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
        (d.underlyingOracle, d.underlyingPool, d.sqrtPriceX96) =
            _deployOracleAndPool(d, d.demoWeth, d.ethPriceWad, oc, fee, spacing);

        d.priceSteerer = deployCode("src/demo/PriceSteerer.sol:PriceSteerer", abi.encode(d.poolManager, d.deployer));
        IDemoToken(d.demoWeth).setMinter(d.priceSteerer, true);
        IDemoToken(d.demoUsdc).setMinter(d.priceSteerer, true);
        IPriceSteerer(d.priceSteerer).addLiquidityFullRange(d.underlyingPool, d.liquidity);
    }

    /// @dev The ETH stack again for demo SOL, faucet limits as DeployUnderlying's defaults
    function _deploySol(Deployment memory d, OracleConfig memory oc, uint24 fee, int24 spacing) internal {
        d.sol.token = deployCode(
            "src/demo/DemoToken.sol:DemoToken",
            abi.encode("Demo Wrapped SOL", "dSOL", uint8(18), 20 ether, 100 ether, d.deployer)
        );
        (d.sol.oracle, d.sol.pool, d.solSqrtPriceX96) =
            _deployOracleAndPool(d, d.sol.token, d.solPriceWad, oc, fee, spacing);
        IDemoToken(d.sol.token).setMinter(d.priceSteerer, true);
        IPriceSteerer(d.priceSteerer).addLiquidityFullRange(d.sol.pool, d.liquidity);
    }

    function _deployOracleAndPool(
        Deployment memory d,
        address token,
        uint256 priceWad,
        OracleConfig memory oc,
        uint24 fee,
        int24 spacing
    ) internal returns (address oracle, PoolKey memory pool, uint160 sqrtPriceX96) {
        bytes memory init = abi.encodePacked(
            vm.getCode("src/oracle/UnderlyingOracleHook.sol:UnderlyingOracleHook"),
            abi.encode(
                d.poolManager,
                d.demoUsdc,
                Currency.wrap(token),
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
        bytes32 salt;
        (salt, oracle) = _mineHookSalt(ORACLE_FLAGS, init);
        _create2(salt, init, oracle);

        bool tokenIs0 = token < d.demoUsdc;
        (address c0, address c1) = tokenIs0 ? (token, d.demoUsdc) : (d.demoUsdc, token);
        pool = PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(oracle));
        sqrtPriceX96 = _sqrtPriceX96(priceWad, tokenIs0);
        // The oracle binds only a pool initialised by its owner, so this call must come from the deployer
        IPoolManager(d.poolManager).initialize(pool, sqrtPriceX96);
    }

    function _symbols() internal pure returns (string[] memory s) {
        s = new string[](2);
        s[0] = ETH;
        s[1] = SOL;
    }

    function _oracles(Deployment memory d) internal pure returns (address[] memory o) {
        o = new address[](2);
        o[0] = d.underlyingOracle;
        o[1] = d.sol.oracle;
    }

    function _verify(Deployment memory d, OracleConfig memory oc, IMarketGatekeeper.Track[] memory tracks)
        internal
        view
    {
        _verifyTracks(Tracks(d.marketGatekeeper, d.predictionHook, d.marketSchedulers), d.poolManager, d.usdc, tracks);
        _verifyOracle(d, _ethUnderlying(d), d.ethPriceWad, oc);
        if (d.sol.oracle != address(0)) _verifyOracle(d, d.sol, d.solPriceWad, oc);
        require(IPriceSteerer(d.priceSteerer).owner() == d.deployer, "steerer owner");
    }

    function _verifyOracle(Deployment memory d, Underlying memory u, uint256 priceWad, OracleConfig memory oc)
        internal
        view
    {
        require(uint160(u.oracle) & Hooks.ALL_HOOK_MASK == ORACLE_FLAGS, string.concat(u.symbol, " oracle hook flags"));
        require(
            PoolId.unwrap(IOracleHookView(u.oracle).poolId()) == PoolId.unwrap(_poolId(u.pool)),
            string.concat(u.symbol, " oracle not bound")
        );
        require(IOracleHookView(u.oracle).owner() == d.deployer, string.concat(u.symbol, " oracle owner"));
        int256 diff = IUnderlyingOracle(u.oracle).lnSpotSoBWad() - F.lnWad(int256(priceWad));
        require(diff < 1e12 && diff > -1e12, string.concat(u.symbol, " oracle spot differs from ", u.symbol, "_PRICE_USD"));
        (uint256 v, bool warm) = IUnderlyingOracle(u.oracle).varianceE36();
        require(!warm && v == oc.fallbackVarE36, string.concat(u.symbol, " oracle should start on the fallback variance"));
    }

    function _ethUnderlying(Deployment memory d) internal pure returns (Underlying memory) {
        return Underlying(ETH, d.demoWeth, d.underlyingOracle, d.underlyingPool);
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
        vm.serializeAddress(o, "marketGatekeeper", d.marketGatekeeper);
        vm.serializeAddress(o, "marketSchedulers", d.marketSchedulers);
        vm.serializeAddress(o, "underlyingOracle", d.underlyingOracle);
        vm.serializeAddress(o, "priceSteerer", d.priceSteerer);
        vm.serializeAddress(o, "demoWeth", d.demoWeth);
        vm.serializeAddress(o, "demoUsdc", d.demoUsdc);
        vm.serializeBytes32(o, "underlyingPoolId", PoolId.unwrap(_poolId(d.underlyingPool)));
        vm.serializeString(o, "underlyingPool", _poolJson(d.underlyingPool));
        vm.serializeString(o, "initialEthPriceUsd", _formatUnits(d.ethPriceWad, 18, 2));
        vm.serializeString(o, "initialSqrtPriceX96", vm.toString(d.sqrtPriceX96));
        vm.serializeString(o, "demoLiquidity", vm.toString(d.liquidity));
        string memory json = _withUnderlyings(vm.serializeString(o, "oracleParams", _oracleJson(oc)), _list(d));

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
        _log("underlying pool", vm.toString(PoolId.unwrap(_poolId(d.underlyingPool))));
        _log("initial ETH price", _formatUnits(d.ethPriceWad, 18, 2));
        if (d.sol.oracle != address(0)) {
            _log("demo SOL (dSOL)", d.sol.token);
            _log("SOL oracle", d.sol.oracle);
            _log("SOL pool", vm.toString(PoolId.unwrap(_poolId(d.sol.pool))));
            _log("initial SOL price", _formatUnits(d.solPriceWad, 18, 2));
        }
        _log("predictionHook", d.predictionHook);
        _log("marketGatekeeper", d.marketGatekeeper);
        _log("written", path);
    }

    /// @dev The `underlyings` list, ETH first
    function _list(Deployment memory d) internal pure returns (Underlying[] memory list) {
        list = new Underlying[](d.sol.oracle == address(0) ? 1 : 2);
        list[0] = _ethUnderlying(d);
        if (list.length == 2) list[1] = d.sol;
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
