// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {IMarketGatekeeper} from "../../src/interfaces/IMarketGatekeeper.sol";
import {IMarketScheduler} from "../../src/interfaces/IMarketScheduler.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
import {IUnderlyingOracle} from "../../src/interfaces/IUnderlyingOracle.sol";
import {MarketNames} from "../../src/lib/MarketNames.sol";
import {IPredictionHookAdmin} from "./ScriptBase.sol";
import {Underlyings} from "./Underlyings.sol";

interface IHookPoolManager {
    function poolManager() external view returns (address);
}

/// @notice The MarketGatekeeper, its MarketSchedulers (one per track) and the PredictionHook it owns, deployed and
///         checked as one set.
/// @dev The hook's constructor takes the gatekeeper as `owner` and the gatekeeper's takes the hook, so the gatekeeper
///      is predicted from the deployer's nonce, the hook salt is mined with that owner, and the gatekeeper (CREATE at
///      that nonce, deploying every scheduler in its constructor) lands before the hook (CREATE2 through the
///      deterministic deployer). Exactly two deployer transactions, and no other one may land in between.
///      The four demo tracks are ETH, ETH15M, SOL and SOL15M (`demoTracks()`). ETH tracks read the file's flat
///      `underlyingOracle`, SOL tracks the oracle of the `underlyings` entry with symbol SOL. TRACKS_ETH_ONLY=1 keeps
///      only the ETH tracks. Every config field has a per-track env override named TRACK_<TICKER>_ plus one of
///      SCHEDULER_PERIOD_SEC, MARKET_TENOR_SEC, MARKET_WINDOW_SEC, MARKET_CUTOFF_BUFFER_SEC, MARKET_N_SAMPLES,
///      QUOTE_H0, QUOTE_GAMMA_S, QUOTE_LAMBDA, QUOTE_Q_EPOCH_MAX (tokens), QUOTE_P_MIN, MARKET_BUDGET_USDC (the max
///      budget) and SCHEDULER_MIN_BUDGET_USDC, for example TRACK_ETH15M_MARKET_BUDGET_USDC=5.
abstract contract TrackSet is Underlyings {
    uint160 internal constant PREDICTION_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 internal constant MAX_TRACKS = 8;
    uint256 internal constant MAX_DURATION = 365 days;
    string internal constant ETH = "ETH";
    uint256 internal constant NOT_FOUND = type(uint256).max;

    /// @notice A track before its oracle is known, `underlying` names the price source
    struct TrackSpec {
        string underlying;
        IMarketScheduler.Config config;
    }

    /// @notice The deployed set, `schedulers` in gatekeeper order
    struct Tracks {
        address gatekeeper;
        address hook;
        address[] schedulers;
    }

    /// @notice The four Unichain Sepolia tracks, in gatekeeper order
    function demoTracks() public pure returns (TrackSpec[] memory t) {
        t = new TrackSpec[](4);
        t[0] = TrackSpec(ETH, _demoConfig(ETH, 60, 10));
        t[1] = TrackSpec(ETH, _demoConfig("ETH15M", 900, 30));
        t[2] = TrackSpec("SOL", _demoConfig("SOL", 60, 10));
        t[3] = TrackSpec("SOL", _demoConfig("SOL15M", 900, 30));
    }

    /// @notice `demoTracks()` with the TRACK_<TICKER>_* env overrides, only the ETH tracks under TRACKS_ETH_ONLY=1
    function trackSpecs() public view returns (TrackSpec[] memory) {
        uint256 ethOnly = vm.envOr("TRACKS_ETH_ONLY", uint256(0));
        require(ethOnly <= 1, "TRACKS_ETH_ONLY must be 0 or 1");
        return _trackSpecs(ethOnly == 1);
    }

    function _trackSpecs(bool ethOnly) internal view returns (TrackSpec[] memory t) {
        TrackSpec[] memory all = demoTracks();
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            if (!ethOnly || LibString.eq(all[i].underlying, ETH)) all[n++] = TrackSpec(all[i].underlying, _withEnv(all[i].config));
        }
        t = new TrackSpec[](n);
        for (uint256 i; i < n; ++i) {
            t[i] = all[i];
        }
    }

    function _demoConfig(string memory ticker, uint32 period, uint32 window)
        internal
        pure
        returns (IMarketScheduler.Config memory c)
    {
        c.period = period;
        c.tenor = period;
        c.window = window;
        c.cutoffBuffer = 2;
        c.nSamples = window;
        c.quote = IPredictionHook.QuoteParams({
            h0Wad: 0.02e18,
            gammaSWad: 0.00002e18,
            lambdaWad: 0.001e18,
            qEpochMax: 100e6,
            pMinWad: 0.02e18
        });
        c.maxBudget = 10e6;
        c.minBudget = 1e6;
        c.ticker = ticker;
    }

    function _withEnv(IMarketScheduler.Config memory c) internal view returns (IMarketScheduler.Config memory) {
        string memory p = _envPrefix(c);
        c.period = _envU32(string.concat(p, "SCHEDULER_PERIOD_SEC"), c.period);
        c.tenor = _envU32(string.concat(p, "MARKET_TENOR_SEC"), c.tenor);
        c.window = _envU32(string.concat(p, "MARKET_WINDOW_SEC"), c.window);
        c.cutoffBuffer = _envU32(string.concat(p, "MARKET_CUTOFF_BUFFER_SEC"), c.cutoffBuffer);
        c.nSamples = _envU32(string.concat(p, "MARKET_N_SAMPLES"), c.nSamples);
        c.quote.h0Wad = SafeCastLib.toUint64(_envUnitsOr(string.concat(p, "QUOTE_H0"), c.quote.h0Wad, 18));
        c.quote.gammaSWad = SafeCastLib.toUint64(_envUnitsOr(string.concat(p, "QUOTE_GAMMA_S"), c.quote.gammaSWad, 18));
        c.quote.lambdaWad = SafeCastLib.toUint128(_envUnitsOr(string.concat(p, "QUOTE_LAMBDA"), c.quote.lambdaWad, 18));
        c.quote.qEpochMax =
            SafeCastLib.toUint128(_envUnitsOr(string.concat(p, "QUOTE_Q_EPOCH_MAX"), c.quote.qEpochMax, 6));
        c.quote.pMinWad = SafeCastLib.toUint64(_envUnitsOr(string.concat(p, "QUOTE_P_MIN"), c.quote.pMinWad, 18));
        c.maxBudget = _envUnitsOr(string.concat(p, "MARKET_BUDGET_USDC"), c.maxBudget, 6);
        c.minBudget = _envUnitsOr(string.concat(p, "SCHEDULER_MIN_BUDGET_USDC"), c.minBudget, 6);
        return c;
    }

    function _envPrefix(IMarketScheduler.Config memory c) internal pure returns (string memory) {
        return string.concat("TRACK_", c.ticker, "_");
    }

    /* Checks */

    /// @dev The gatekeeper's InvalidTracks and the scheduler's InvalidConfig checks, each naming the env variable at fault
    function _checkTracks(TrackSpec[] memory specs) internal pure {
        require(specs.length != 0 && specs.length <= MAX_TRACKS, "need 1 to 8 tracks");
        for (uint256 i; i < specs.length; ++i) {
            _checkConfig(specs[i].config);
            for (uint256 j; j < i; ++j) {
                require(
                    !LibString.eq(specs[j].config.ticker, specs[i].config.ticker),
                    string.concat("track ticker ", specs[i].config.ticker, " appears twice")
                );
            }
        }
    }

    function _checkConfig(IMarketScheduler.Config memory c) internal pure {
        uint256 len = bytes(c.ticker).length;
        require(len != 0 && len <= 6, "track tickers must be 1 to 6 characters");
        string memory p = _envPrefix(c);
        require(c.period != 0 && c.period <= MAX_DURATION, string.concat(p, "SCHEDULER_PERIOD_SEC must be 1 s to 365 days"));
        require(c.window != 0, string.concat(p, "MARKET_WINDOW_SEC must be positive"));
        require(
            c.tenor <= MAX_DURATION && uint256(c.tenor) > uint256(c.window) + c.cutoffBuffer,
            string.concat(p, "MARKET_TENOR_SEC must exceed MARKET_WINDOW_SEC + MARKET_CUTOFF_BUFFER_SEC, up to 365 days")
        );
        require(
            c.minBudget != 0 && c.minBudget <= c.maxBudget,
            string.concat("need 0 < ", p, "SCHEDULER_MIN_BUDGET_USDC <= ", p, "MARKET_BUDGET_USDC")
        );
        require(c.quote.qEpochMax != 0, string.concat(p, "QUOTE_Q_EPOCH_MAX must be positive"));
        require(c.quote.pMinWad != 0 && c.quote.pMinWad < 0.5e18, string.concat(p, "QUOTE_P_MIN must be in (0, 0.5)"));
    }

    /* Oracles */

    /// @dev Each spec with the oracle of its underlying from `symbols` / `oracles`, whose spot must give a strike
    function _resolve(TrackSpec[] memory specs, string[] memory symbols, address[] memory oracles)
        internal
        view
        returns (IMarketGatekeeper.Track[] memory tracks)
    {
        _checkTracks(specs);
        tracks = new IMarketGatekeeper.Track[](specs.length);
        for (uint256 i; i < specs.length; ++i) {
            string memory sym = specs[i].underlying;
            uint256 k = NOT_FOUND;
            for (uint256 j; j < symbols.length && k == NOT_FOUND; ++j) {
                if (LibString.eq(symbols[j], sym)) k = j;
            }
            if (k == NOT_FOUND || oracles[k] == address(0)) {
                revert(
                    string.concat(
                        "no ",
                        sym,
                        " oracle in the deployments file for track ",
                        specs[i].config.ticker,
                        ", deploy the underlying first (script/sepolia.sh underlying) or set TRACKS_ETH_ONLY=1"
                    )
                );
            }
            require(oracles[k].code.length != 0, string.concat(sym, " oracle has no code at ", vm.toString(oracles[k])));
            require(_strikeCents(oracles[k]) != 0, string.concat(sym, " oracle spot rounds to a zero strike"));
            tracks[i] = IMarketGatekeeper.Track(oracles[k], specs[i].config);
        }
    }

    function _strikeCents(address oracle) internal view returns (uint256) {
        return MarketNames.strikeCents(IUnderlyingOracle(oracle).lnSpotSoBWad());
    }

    /* Deploy and verify */

    /// @dev Call inside a broadcast from `deployer`, exactly two transactions
    function _deployTracks(
        address deployer,
        address poolManager,
        address usdc,
        IMarketGatekeeper.Track[] memory tracks
    ) internal returns (Tracks memory t, bytes32 salt) {
        uint64 nonce = vm.getNonce(deployer);
        address gatekeeper = vm.computeCreateAddress(deployer, nonce);
        bytes memory init = abi.encodePacked(
            vm.getCode("src/PredictionHook.sol:PredictionHook"), abi.encode(poolManager, usdc, gatekeeper)
        );
        address hook;
        (salt, hook) = _mineHookSalt(PREDICTION_FLAGS, init);

        t.gatekeeper = deployCode("src/MarketGatekeeper.sol:MarketGatekeeper", abi.encode(hook, tracks));
        require(t.gatekeeper == gatekeeper, "gatekeeper address differs from the nonce prediction");
        _create2(salt, init, hook);
        t.hook = hook;
        require(vm.getNonce(deployer) == nonce + 2, "deployer nonce moved by more than the two track transactions");
        t.schedulers = new address[](tracks.length);
        for (uint256 i; i < tracks.length; ++i) {
            t.schedulers[i] = vm.computeCreateAddress(gatekeeper, i + 1);
        }
    }

    /// @dev Reads the set back from chain state, so it also serves as the on-chain check after a broadcast
    function _verifyTracks(
        Tracks memory t,
        address poolManager,
        address usdc,
        IMarketGatekeeper.Track[] memory tracks
    ) internal view {
        require(t.gatekeeper.code.length != 0, "gatekeeper has no code");
        require(t.hook.code.length != 0, "hook has no code");
        require(uint160(t.hook) & Hooks.ALL_HOOK_MASK == PREDICTION_FLAGS, "prediction hook flags");
        IPredictionHookAdmin hook = IPredictionHookAdmin(t.hook);
        require(hook.owner() == t.gatekeeper, "hook owner is not the gatekeeper");
        require(hook.keeper() == address(0), "hook keeper is set");
        require(hook.usdc() == usdc, "hook usdc");
        require(IHookPoolManager(t.hook).poolManager() == poolManager, "hook pool manager");

        IMarketGatekeeper g = IMarketGatekeeper(t.gatekeeper);
        require(address(g.hook()) == t.hook, "gatekeeper hook");
        require(g.schedulerCount() == tracks.length, "gatekeeper runs a different number of tracks");
        require(
            t.schedulers.length == tracks.length
                && keccak256(abi.encode(g.schedulers())) == keccak256(abi.encode(t.schedulers)),
            "gatekeeper schedulers differ from the staged list"
        );
        for (uint256 i; i < tracks.length; ++i) {
            address a = t.schedulers[i];
            string memory ticker = tracks[i].config.ticker;
            require(a == vm.computeCreateAddress(t.gatekeeper, i + 1), string.concat(ticker, " scheduler address"));
            require(a.code.length != 0 && g.isScheduler(a), string.concat(ticker, " scheduler is not deployed"));
            IMarketScheduler s = IMarketScheduler(a);
            require(address(s.hook()) == t.hook, string.concat(ticker, " scheduler hook"));
            require(address(s.gatekeeper()) == t.gatekeeper, string.concat(ticker, " scheduler gatekeeper"));
            require(s.oracle() == tracks[i].oracle, string.concat(ticker, " scheduler oracle"));
            require(
                keccak256(abi.encode(s.config())) == keccak256(abi.encode(tracks[i].config)),
                string.concat(ticker, " scheduler config differs from the env config")
            );
        }
    }

    /* Logging */

    function _logTracks(IMarketGatekeeper.Track[] memory tracks, TrackSpec[] memory specs, address[] memory schedulers)
        internal
        view
    {
        for (uint256 i; i < tracks.length; ++i) {
            IMarketScheduler.Config memory c = tracks[i].config;
            console2.log(
                string.concat(
                    "  track ",
                    vm.toString(i),
                    " ",
                    c.ticker,
                    " on ",
                    specs[i].underlying,
                    " oracle ",
                    vm.toString(tracks[i].oracle),
                    ", strike now USD ",
                    MarketNames.formatCents(_strikeCents(tracks[i].oracle))
                )
            );
            if (i < schedulers.length) _log("  scheduler", schedulers[i]);
            string[] memory lines = _configLines(c, _demoFor(c));
            for (uint256 j; j < lines.length; ++j) {
                console2.log(string.concat("    ", lines[j]));
            }
        }
    }

    /// @dev The demo config with `c`'s ticker, or `c` itself when the ticker is not a demo track
    function _demoFor(IMarketScheduler.Config memory c) internal pure returns (IMarketScheduler.Config memory) {
        TrackSpec[] memory d = demoTracks();
        for (uint256 i; i < d.length; ++i) {
            if (LibString.eq(d[i].config.ticker, c.ticker)) return d[i].config;
        }
        return c;
    }

    /// @dev One line per field, marked "(env override)" where it differs from `d`
    function _configLines(IMarketScheduler.Config memory c, IMarketScheduler.Config memory d)
        internal
        pure
        returns (string[] memory lines)
    {
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
        lines[12] = _line("ticker", c.ticker, !LibString.eq(c.ticker, d.ticker));
    }

    function _line(string memory k, string memory v, bool overridden) internal pure returns (string memory) {
        return string.concat(k, ": ", v, overridden ? " (env override)" : "");
    }

    /* Env */

    function _envU32(string memory name, uint256 def) internal view returns (uint32) {
        uint256 v = vm.envOr(name, def);
        if (v > type(uint32).max) revert(string.concat(name, " does not fit in uint32"));
        return uint32(v);
    }

    /// @dev `_envUnits` with a numeric default, so the defaults live only in `demoTracks()`
    function _envUnitsOr(string memory name, uint256 def, uint8 decimals) internal view returns (uint256) {
        return vm.envExists(name) ? _parseUnits(vm.envString(name), decimals, name) : def;
    }
}
