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
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {DemoToken} from "../src/demo/DemoToken.sol";
import {PriceSteerer} from "../src/demo/PriceSteerer.sol";
import {UnderlyingOracleHook} from "../src/oracle/UnderlyingOracleHook.sol";
import {Underlyings} from "./base/Underlyings.sol";

/// @title DeployUnderlying
/// @notice Adds another underlying price source to deployments/<NETWORK>.json (or DEPLOYMENTS_FILE), built the way
///         Deploy built the ETH one and reusing the file's PoolManager, demoUsdc and PriceSteerer: an 18-decimal
///         DemoToken, an UnderlyingOracleHook at a mined CREATE2 address with the file's oracleParams (checked against
///         the live ETH oracle), the token/demoUsdc pool (fee 500, spacing 10) initialised at UNDERLYING_PRICE_USD by
///         the oracle owner, and the steerer made a token minter. The pool gets its liquidity from SeedUnderlying,
///         signed by the steerer owner, and the oracle keeps its owner until RenounceUnderlyingOracle.
/// @dev Two steps like DeployScheduler, so `underlyings` only ever names a stack that was checked on-chain.
///      1. `forge script script/DeployUnderlying.s.sol --rpc-url <rpc> --broadcast` sends four transactions and stages
///         the entry as <file>.underlying.pending.json (without --broadcast, the merged file as <file>.dry-run.json).
///      2. `forge script script/DeployUnderlying.s.sol --sig 'record()' --rpc-url <rpc>` reads the entry back from the
///         chain and only then appends it to `underlyings`, seeding the ETH entry first if the list is missing.
///      Env: UNDERLYING_SYMBOL (required, 1 to 6 of A-Z0-9), UNDERLYING_PRICE_USD (required, the live USD price),
///      UNDERLYING_NAME ("Demo Wrapped <SYMBOL>"), UNDERLYING_TOKEN_SYMBOL ("d<SYMBOL>"), UNDERLYING_FAUCET_PER_CALL (20)
///      and UNDERLYING_FAUCET_PER_HOUR (100) in whole tokens.
contract DeployUnderlying is Underlyings {
    uint160 internal constant ORACLE_FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
    uint24 internal constant FEE = 500;
    int24 internal constant TICK_SPACING = 10;
    string internal constant PENDING_SUFFIX = ".underlying.pending.json";

    struct Params {
        string symbol;
        string name;
        string tokenSymbol;
        uint256 priceWad;
        uint256 faucetPerCall;
        uint256 faucetPerHour;
    }

    struct OracleParams {
        uint32 gridSeconds;
        uint16 nWindows;
        uint16 minWindows;
        uint32 winsorTicks;
        uint256 varMinE36;
        uint256 varMaxE36;
        uint256 fallbackVarE36;
        uint16 cardinality;
    }

    /// @dev What the deployments file already has and the new stack reuses
    struct Stack {
        address poolManager;
        address demoUsdc;
        address steerer;
        OracleParams oc;
    }

    function run() external returns (Underlying memory u) {
        (u,) = _stage(_deploymentsPath(), params());
    }

    function record() external {
        _record(_deploymentsPath());
    }

    function params() public view returns (Params memory p) {
        require(vm.envExists("UNDERLYING_SYMBOL"), "UNDERLYING_SYMBOL is required, e.g. SOL");
        require(vm.envExists("UNDERLYING_PRICE_USD"), "UNDERLYING_PRICE_USD is required, the live USD price");
        p.symbol = vm.envString("UNDERLYING_SYMBOL");
        p.name = vm.envOr("UNDERLYING_NAME", string.concat("Demo Wrapped ", p.symbol));
        p.tokenSymbol = vm.envOr("UNDERLYING_TOKEN_SYMBOL", string.concat("d", p.symbol));
        p.priceWad = _parseUnits(vm.envString("UNDERLYING_PRICE_USD"), 18, "UNDERLYING_PRICE_USD");
        p.faucetPerCall = _envUnits("UNDERLYING_FAUCET_PER_CALL", "20", 18);
        p.faucetPerHour = _envUnits("UNDERLYING_FAUCET_PER_HOUR", "100", 18);
    }

    /* Stage */

    function _stage(string memory path, Params memory p) internal returns (Underlying memory u, bytes32 salt) {
        string memory json = _readDeploymentsAt(path);
        string memory pending = _withSuffix(path, PENDING_SUFFIX);
        if (vm.exists(pending)) revert(string.concat("staged underlying awaits record(): ", pending));
        _checkParams(p);
        Underlying[] memory list = _underlyings(json);
        if (_indexOf(list, p.symbol) != type(uint256).max) {
            revert(string.concat("underlying ", p.symbol, " is already in the deployments file"));
        }
        Stack memory s = _stack(json);
        require(CREATE2_FACTORY.code.length != 0, "CREATE2 deployer missing");
        require(DemoToken(s.demoUsdc).isMinter(s.steerer), "priceSteerer is not a demoUsdc minter");
        uint256 deployBlock = block.number;

        address deployer = _startBroadcast();
        uint160 sqrtPriceX96;
        (u, salt, sqrtPriceX96) = _deploy(deployer, s, p);
        vm.stopBroadcast();

        _verify(u, s, deployer);
        _verifyFresh(u, s, p);

        string memory staged;
        if (_isDryRun()) {
            staged = _withSuffix(path, ".dry-run.json");
            vm.writeJson(_withUnderlyings(json, _appended(list, u)), staged);
        } else {
            staged = pending;
            vm.writeJson(_stagedJson(u, deployer, deployBlock, p), staged);
        }

        console2.log(
            _isDryRun()
                ? "Underlying simulated (nothing broadcast)"
                : "Underlying deployed, the deployments file changes only after record()"
        );
        _log("deployments", path);
        _log("staged", staged);
        _log("deployer", deployer);
        _log("symbol", p.symbol);
        _log(string.concat("token (", p.tokenSymbol, ")"), u.token);
        _log("oracle", u.oracle);
        _log("oracle salt", vm.toString(salt));
        _log("pool", vm.toString(PoolId.unwrap(_poolId(u.pool))));
        _log("currency0", Currency.unwrap(u.pool.currency0));
        _log("currency1", Currency.unwrap(u.pool.currency1));
        _log("price USD", _formatUnits(p.priceWad, 18, 4));
        _log("sqrtPriceX96", vm.toString(sqrtPriceX96));
        _log("priceSteerer (token minter)", s.steerer);
        _log("seed signer (steerer owner)", PriceSteerer(s.steerer).owner());
        _log("faucet per call", _formatUnits(p.faucetPerCall, 18, 2));
        _log("faucet per hour", _formatUnits(p.faucetPerHour, 18, 2));
    }

    function _checkParams(Params memory p) internal pure {
        bytes memory b = bytes(p.symbol);
        require(b.length != 0 && b.length <= 6, "UNDERLYING_SYMBOL must be 1 to 6 characters");
        for (uint256 i; i < b.length; ++i) {
            require(
                (b[i] >= "A" && b[i] <= "Z") || (b[i] >= "0" && b[i] <= "9"), "UNDERLYING_SYMBOL must be A-Z or 0-9"
            );
        }
        require(bytes(p.name).length != 0, "UNDERLYING_NAME is empty");
        require(bytes(p.tokenSymbol).length != 0, "UNDERLYING_TOKEN_SYMBOL is empty");
        require(p.priceWad >= 0.01e18 && p.priceWad <= 1e24, "UNDERLYING_PRICE_USD out of range");
        require(
            p.faucetPerCall != 0 && p.faucetPerCall <= p.faucetPerHour,
            "need 0 < UNDERLYING_FAUCET_PER_CALL <= UNDERLYING_FAUCET_PER_HOUR"
        );
    }

    function _stack(string memory json) internal view returns (Stack memory s) {
        s.poolManager = _jsonContract(json, "poolManager");
        s.demoUsdc = _jsonContract(json, "demoUsdc");
        s.steerer = _jsonContract(json, "priceSteerer");
        require(DemoToken(s.demoUsdc).decimals() == 6, "demoUsdc must have 6 decimals");
        require(
            address(PriceSteerer(s.steerer).poolManager()) == s.poolManager, "priceSteerer is on another PoolManager"
        );
        s.oc = _oracleParams(json);
        UnderlyingOracleHook eth = UnderlyingOracleHook(_jsonContract(json, "underlyingOracle"));
        require(_sameParams(eth, s.oc), "oracleParams differ from the live underlyingOracle");
    }

    function _oracleParams(string memory json) internal pure returns (OracleParams memory oc) {
        oc.gridSeconds = SafeCastLib.toUint32(vm.parseJsonUint(json, ".oracleParams.gridSeconds"));
        oc.nWindows = SafeCastLib.toUint16(vm.parseJsonUint(json, ".oracleParams.nWindows"));
        oc.minWindows = SafeCastLib.toUint16(vm.parseJsonUint(json, ".oracleParams.minWindows"));
        oc.winsorTicks = SafeCastLib.toUint32(vm.parseJsonUint(json, ".oracleParams.winsorTicks"));
        oc.varMinE36 = vm.parseJsonUint(json, ".oracleParams.varMinE36");
        oc.varMaxE36 = vm.parseJsonUint(json, ".oracleParams.varMaxE36");
        oc.fallbackVarE36 = vm.parseJsonUint(json, ".oracleParams.fallbackVarE36");
        oc.cardinality = SafeCastLib.toUint16(vm.parseJsonUint(json, ".oracleParams.cardinality"));
    }

    function _sameParams(UnderlyingOracleHook o, OracleParams memory oc) internal view returns (bool) {
        return o.gridSeconds() == oc.gridSeconds && o.nWindows() == oc.nWindows && o.minWindows() == oc.minWindows
            && o.winsorTicks() == oc.winsorTicks && o.cardinality() == oc.cardinality && o.varMinE36() == oc.varMinE36
            && o.varMaxE36() == oc.varMaxE36 && o.fallbackVarE36() == oc.fallbackVarE36;
    }

    /// @dev Call inside a broadcast from `deployer`, four transactions
    function _deploy(address deployer, Stack memory s, Params memory p)
        internal
        returns (Underlying memory u, bytes32 salt, uint160 sqrtPriceX96)
    {
        u.symbol = p.symbol;
        u.token = deployCode(
            "src/demo/DemoToken.sol:DemoToken",
            abi.encode(p.name, p.tokenSymbol, uint8(18), p.faucetPerCall, p.faucetPerHour, deployer)
        );

        bytes memory init = abi.encodePacked(
            vm.getCode("src/oracle/UnderlyingOracleHook.sol:UnderlyingOracleHook"),
            abi.encode(
                s.poolManager,
                s.demoUsdc,
                Currency.wrap(u.token),
                s.oc.gridSeconds,
                s.oc.nWindows,
                s.oc.minWindows,
                s.oc.winsorTicks,
                s.oc.varMinE36,
                s.oc.varMaxE36,
                s.oc.fallbackVarE36,
                s.oc.cardinality,
                deployer
            )
        );
        (salt, u.oracle) = _mineHookSalt(ORACLE_FLAGS, init);
        _create2(salt, init, u.oracle);

        bool tokenIs0 = u.token < s.demoUsdc;
        (address c0, address c1) = tokenIs0 ? (u.token, s.demoUsdc) : (s.demoUsdc, u.token);
        u.pool = PoolKey(Currency.wrap(c0), Currency.wrap(c1), FEE, TICK_SPACING, IHooks(u.oracle));
        sqrtPriceX96 = _sqrtPriceX96(p.priceWad, tokenIs0);
        // The oracle binds only a pool initialised by its owner, so this call must come from the deployer
        IPoolManager(s.poolManager).initialize(u.pool, sqrtPriceX96);

        DemoToken(u.token).setMinter(s.steerer, true);
    }

    /* Checks */

    /// @dev Reads the stack back from chain state, so it also serves as the on-chain check in record()
    function _verify(Underlying memory u, Stack memory s, address deployer) internal view {
        require(u.token.code.length != 0, "token has no code");
        require(u.oracle.code.length != 0, "oracle has no code");
        DemoToken token = DemoToken(u.token);
        require(token.decimals() == 18, "token decimals");
        require(token.owner() == deployer, "token owner");
        require(token.isMinter(s.steerer), "priceSteerer is not a token minter");

        require(uint160(u.oracle) & Hooks.ALL_HOOK_MASK == ORACLE_FLAGS, "oracle hook flags");
        UnderlyingOracleHook oracle = UnderlyingOracleHook(u.oracle);
        require(oracle.owner() == deployer, "oracle owner");
        require(oracle.usdc() == s.demoUsdc, "oracle usdc side");
        require(Currency.unwrap(oracle.underlying()) == u.token, "oracle underlying");
        require(address(oracle.poolManager()) == s.poolManager, "oracle pool manager");
        require(_sameParams(oracle, s.oc), "oracle params differ from oracleParams");

        (address c0, address c1) = u.token < s.demoUsdc ? (u.token, s.demoUsdc) : (s.demoUsdc, u.token);
        require(
            Currency.unwrap(u.pool.currency0) == c0 && Currency.unwrap(u.pool.currency1) == c1 && u.pool.fee == FEE
                && u.pool.tickSpacing == TICK_SPACING && address(u.pool.hooks) == u.oracle,
            "pool key"
        );
        require(PoolId.unwrap(oracle.poolId()) == PoolId.unwrap(_poolId(u.pool)), "oracle not bound to the pool");
    }

    /// @dev Right after deployment only, the price and variance a live pool may already have moved on from
    function _verifyFresh(Underlying memory u, Stack memory s, Params memory p) internal view {
        int256 diff = UnderlyingOracleHook(u.oracle).lnSpotSoBWad() - F.lnWad(SafeCastLib.toInt256(p.priceWad));
        require(diff < 1e12 && diff > -1e12, "oracle spot differs from UNDERLYING_PRICE_USD");
        (uint256 v, bool warm) = UnderlyingOracleHook(u.oracle).varianceE36();
        require(!warm && v == s.oc.fallbackVarE36, "oracle should start on the fallback variance");
    }

    /* Record */

    function _record(string memory path) internal {
        string memory pending = _withSuffix(path, PENDING_SUFFIX);
        if (!vm.exists(pending)) {
            revert(string.concat("no staged underlying at ", pending, ", run DeployUnderlying with --broadcast first"));
        }
        string memory staged = vm.readFile(pending);
        string memory json = _readDeploymentsAt(path);
        require(vm.parseJsonUint(staged, ".chainId") == block.chainid, "staged underlying is for another chain");
        Underlying memory u = _parseUnderlying(staged, ".underlying");
        Underlying[] memory list = _appended(_underlyings(json), u);

        _verify(u, _stack(json), vm.parseJsonAddress(staged, ".deployer"));
        vm.writeJson(_withUnderlyings(json, list), path);
        vm.removeFile(pending);

        console2.log("Underlying verified on-chain and recorded");
        _log("deployments", path);
        for (uint256 i; i < list.length; ++i) {
            _log(string.concat("underlyings[", vm.toString(i), "] ", list[i].symbol), list[i].oracle);
        }
    }

    function _stagedJson(Underlying memory u, address deployer, uint256 deployBlock, Params memory p)
        internal
        returns (string memory)
    {
        string memory o = "underlyingStaged";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeUint(o, "deployBlock", deployBlock);
        vm.serializeUint(o, "deployedAt", block.timestamp);
        vm.serializeString(o, "name", p.name);
        vm.serializeString(o, "tokenSymbol", p.tokenSymbol);
        vm.serializeString(o, "priceUsd", _formatUnits(p.priceWad, 18, 6));
        return vm.serializeString(o, "underlying", _underlyingJson(u, "underlyingStaged.entry"));
    }
}
