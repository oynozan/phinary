// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {IMarketScheduler} from "../../src/interfaces/IMarketScheduler.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
import {ScriptBase, IPredictionHookAdmin} from "./ScriptBase.sol";

interface IHookPoolManager {
    function poolManager() external view returns (address);
}

/// @notice The MarketScheduler and the PredictionHook it owns, deployed and checked as one pair.
/// @dev The hook's constructor takes the scheduler as `owner` and the scheduler's takes the hook, so the scheduler is
///      predicted from the deployer's nonce, the hook salt is mined with that owner, and the scheduler (CREATE at that
///      nonce) lands before the hook (CREATE2 through the deterministic deployer). No other transaction from the
///      deployer may land in between. The config env and its Unichain Sepolia demo defaults are
///      SCHEDULER_PERIOD_SEC (60), MARKET_TENOR_SEC (120), MARKET_WINDOW_SEC (10), MARKET_CUTOFF_BUFFER_SEC (2),
///      MARKET_N_SAMPLES (10), QUOTE_H0 (0.02), QUOTE_GAMMA_S (0.00002), QUOTE_LAMBDA (0.001), QUOTE_Q_EPOCH_MAX (100),
///      QUOTE_P_MIN (0.02), MARKET_BUDGET_USDC (10, the max budget), SCHEDULER_MIN_BUDGET_USDC (1), MARKET_TICKER (ETH).
abstract contract SchedulerPair is ScriptBase {
    uint160 internal constant PREDICTION_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    struct Pair {
        address scheduler;
        address hook;
    }

    /// @notice The spec's Unichain Sepolia demo values, the default for every config field
    function demoDefaults() public pure returns (IMarketScheduler.Config memory c) {
        c.period = 60;
        c.tenor = 120;
        c.window = 10;
        c.cutoffBuffer = 2;
        c.nSamples = 10;
        c.quote = IPredictionHook.QuoteParams({
            h0Wad: 0.02e18,
            gammaSWad: 0.00002e18,
            lambdaWad: 0.001e18,
            qEpochMax: 100e6,
            pMinWad: 0.02e18
        });
        c.maxBudget = 10e6;
        c.minBudget = 1e6;
        c.ticker = "ETH";
    }

    function schedulerConfig() public view returns (IMarketScheduler.Config memory c) {
        c = demoDefaults();
        c.period = _envU32("SCHEDULER_PERIOD_SEC", c.period);
        c.tenor = _envU32("MARKET_TENOR_SEC", c.tenor);
        c.window = _envU32("MARKET_WINDOW_SEC", c.window);
        c.cutoffBuffer = _envU32("MARKET_CUTOFF_BUFFER_SEC", c.cutoffBuffer);
        c.nSamples = _envU32("MARKET_N_SAMPLES", c.nSamples);
        c.quote.h0Wad = SafeCastLib.toUint64(_envUnitsOr("QUOTE_H0", c.quote.h0Wad, 18));
        c.quote.gammaSWad = SafeCastLib.toUint64(_envUnitsOr("QUOTE_GAMMA_S", c.quote.gammaSWad, 18));
        c.quote.lambdaWad = SafeCastLib.toUint128(_envUnitsOr("QUOTE_LAMBDA", c.quote.lambdaWad, 18));
        c.quote.qEpochMax = SafeCastLib.toUint128(_envUnitsOr("QUOTE_Q_EPOCH_MAX", c.quote.qEpochMax, 6));
        c.quote.pMinWad = SafeCastLib.toUint64(_envUnitsOr("QUOTE_P_MIN", c.quote.pMinWad, 18));
        c.maxBudget = _envUnitsOr("MARKET_BUDGET_USDC", c.maxBudget, 6);
        c.minBudget = _envUnitsOr("SCHEDULER_MIN_BUDGET_USDC", c.minBudget, 6);
        c.ticker = vm.envOr("MARKET_TICKER", c.ticker);
    }

    /// @dev The scheduler constructor's InvalidConfig checks, each naming the env variable at fault
    function _checkConfig(IMarketScheduler.Config memory c) internal pure {
        require(c.period != 0, "SCHEDULER_PERIOD_SEC must be positive");
        require(c.window != 0, "MARKET_WINDOW_SEC must be positive");
        require(
            uint256(c.tenor) >= uint256(c.period) + c.window + c.cutoffBuffer,
            "MARKET_TENOR_SEC must be at least SCHEDULER_PERIOD_SEC + MARKET_WINDOW_SEC + MARKET_CUTOFF_BUFFER_SEC"
        );
        require(c.minBudget != 0 && c.minBudget <= c.maxBudget, "need 0 < SCHEDULER_MIN_BUDGET_USDC <= MARKET_BUDGET_USDC");
        require(bytes(c.ticker).length != 0 && bytes(c.ticker).length <= 6, "MARKET_TICKER must be 1 to 6 characters");
        require(c.quote.qEpochMax != 0, "QUOTE_Q_EPOCH_MAX must be positive");
        require(c.quote.pMinWad != 0 && c.quote.pMinWad < 0.5e18, "QUOTE_P_MIN must be in (0, 0.5)");
    }

    /// @dev Call inside a broadcast from `deployer` (exactly two transactions), `salt` redeploys a hook that failed
    function _deployPair(
        address deployer,
        address poolManager,
        address usdc,
        address oracle,
        IMarketScheduler.Config memory c
    ) internal returns (Pair memory p, bytes32 salt) {
        uint64 nonce = vm.getNonce(deployer);
        address scheduler = vm.computeCreateAddress(deployer, nonce);
        bytes memory init = abi.encodePacked(
            vm.getCode("src/PredictionHook.sol:PredictionHook"), abi.encode(poolManager, usdc, scheduler)
        );
        address hook;
        (salt, hook) = _mineHookSalt(PREDICTION_FLAGS, init);

        p.scheduler = deployCode("src/MarketScheduler.sol:MarketScheduler", abi.encode(hook, oracle, c));
        require(p.scheduler == scheduler, "scheduler address differs from the nonce prediction");
        _create2(salt, init, hook);
        p.hook = hook;
        require(vm.getNonce(deployer) == nonce + 2, "deployer nonce moved by more than the pair's two transactions");
    }

    /// @dev Reads the pair back from chain state, so it also serves as the on-chain check after a broadcast
    function _verifyPair(
        Pair memory p,
        address poolManager,
        address usdc,
        address oracle,
        IMarketScheduler.Config memory c
    ) internal view {
        require(p.scheduler.code.length != 0, "scheduler has no code");
        require(p.hook.code.length != 0, "hook has no code");
        require(uint160(p.hook) & Hooks.ALL_HOOK_MASK == 0x2AA8, "prediction hook flags");
        IPredictionHookAdmin hook = IPredictionHookAdmin(p.hook);
        require(hook.owner() == p.scheduler, "hook owner is not the scheduler");
        require(hook.keeper() == address(0), "hook keeper is set");
        require(hook.usdc() == usdc, "hook usdc");
        require(IHookPoolManager(p.hook).poolManager() == poolManager, "hook pool manager");
        IMarketScheduler s = IMarketScheduler(p.scheduler);
        require(address(s.hook()) == p.hook, "scheduler hook");
        require(s.oracle() == oracle, "scheduler oracle");
        require(keccak256(abi.encode(s.config())) == keccak256(abi.encode(c)), "scheduler config differs from the env config");
    }

    function _logConfig(IMarketScheduler.Config memory c) internal pure {
        string[] memory lines = _configLines(c);
        for (uint256 i; i < lines.length; ++i) {
            console2.log(string.concat("  ", lines[i]));
        }
    }

    /// @dev One line per field, marked "(env override)" where it differs from `demoDefaults()`
    function _configLines(IMarketScheduler.Config memory c) internal pure returns (string[] memory lines) {
        IMarketScheduler.Config memory d = demoDefaults();
        lines = new string[](13);
        lines[0] = _line("period s", vm.toString(c.period), c.period != d.period);
        lines[1] = _line("tenor s", vm.toString(c.tenor), c.tenor != d.tenor);
        lines[2] = _line("window s", vm.toString(c.window), c.window != d.window);
        lines[3] = _line("cutoff buffer s", vm.toString(c.cutoffBuffer), c.cutoffBuffer != d.cutoffBuffer);
        lines[4] = _line("samples", vm.toString(c.nSamples), c.nSamples != d.nSamples);
        lines[5] = _line("h0", _formatUnits(c.quote.h0Wad, 18, 8), c.quote.h0Wad != d.quote.h0Wad);
        lines[6] = _line("gammaS", _formatUnits(c.quote.gammaSWad, 18, 8), c.quote.gammaSWad != d.quote.gammaSWad);
        lines[7] = _line("lambda", _formatUnits(c.quote.lambdaWad, 18, 8), c.quote.lambdaWad != d.quote.lambdaWad);
        lines[8] =
            _line("qEpochMax tokens", _formatUnits(c.quote.qEpochMax, 6, 6), c.quote.qEpochMax != d.quote.qEpochMax);
        lines[9] = _line("pMin", _formatUnits(c.quote.pMinWad, 18, 8), c.quote.pMinWad != d.quote.pMinWad);
        lines[10] = _line("max budget USDC", _formatUnits(c.maxBudget, 6, 6), c.maxBudget != d.maxBudget);
        lines[11] = _line("min budget USDC", _formatUnits(c.minBudget, 6, 6), c.minBudget != d.minBudget);
        lines[12] = _line("ticker", c.ticker, keccak256(bytes(c.ticker)) != keccak256(bytes(d.ticker)));
    }

    function _line(string memory k, string memory v, bool overridden) internal pure returns (string memory) {
        return string.concat(k, ": ", v, overridden ? " (env override)" : "");
    }

    function _envU32(string memory name, uint256 def) internal view returns (uint32) {
        uint256 v = vm.envOr(name, def);
        if (v > type(uint32).max) revert(string.concat(name, " does not fit in uint32"));
        return uint32(v);
    }

    /// @dev `_envUnits` with a numeric default, so the defaults live only in `demoDefaults()`
    function _envUnitsOr(string memory name, uint256 def, uint8 decimals) internal view returns (uint256) {
        return vm.envExists(name) ? _parseUnits(vm.envString(name), decimals, name) : def;
    }

    /// @dev `path` with its trailing ".json" replaced by `suffix`
    function _withSuffix(string memory path, string memory suffix) internal pure returns (string memory) {
        if (LibString.endsWith(path, ".json")) path = LibString.slice(path, 0, bytes(path).length - 5);
        return string.concat(path, suffix);
    }
}
