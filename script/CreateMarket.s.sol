// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/Script.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {IPredictionHook} from "../src/interfaces/IPredictionHook.sol";
import {IUnderlyingOracle} from "../src/interfaces/IUnderlyingOracle.sol";
import {MarketNames} from "../src/lib/MarketNames.sol";
import {ScriptBase} from "./base/ScriptBase.sol";

/// @title CreateMarket
/// @notice One-off "ETH above K at T" market, with the keeper bot's env names and defaults (bot/.env.example): tickers
///         ETHUP / ETHDOWN and the names "ETH > $2684.00 26 Sep 14:31" (YES) / "ETH < $2684.00 26 Sep 14:31" (NO), UTC.
/// @dev STRIKE_USD defaults to the oracle's start-of-block price rounded half up to the cent. The signer must be the
///      hook owner or keeper, and the vault must hold MARKET_BUDGET_USDC idle.
contract CreateMarket is ScriptBase {
    function run() external returns (uint256 id) {
        (string memory json,) = _readDeployments();
        IPredictionHook hook = IPredictionHook(_deployed(json, "predictionHook", "PREDICTION_HOOK"));
        address oracle = _deployed(json, "underlyingOracle", "UNDERLYING_ORACLE");

        IPredictionHook.MarketParams memory p = params(oracle);
        require(hook.vaultIdle() >= p.budget, "vault idle below MARKET_BUDGET_USDC, run Fund first");

        _startBroadcast();
        id = hook.createMarket(p);
        vm.stopBroadcast();

        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        IPredictionHook.Quote memory q = hook.quote(id);
        console2.log(_isDryRun() ? "Market simulated (nothing broadcast)" : "Market created");
        _log("id", vm.toString(id));
        _log("name", p.yesName);
        _log("strike USD", MarketNames.formatCents(MarketNames.strikeCents(p.lnStrikeWad)));
        _log("YES", i.yes);
        _log("NO", i.no);
        _log("openTime", vm.toString(i.openTime));
        _log("expiry", vm.toString(i.expiry));
        _log("trading cutoff", vm.toString(i.expiry - i.window - i.cutoffBuffer));
        _log("budget USDC", _formatUnits(p.budget, 6, 2));
        _log("mid YES", _formatUnits(q.midYes, 18, 4));
        _log("ask/bid YES", string.concat(_formatUnits(q.askYes, 18, 4), " / ", _formatUnits(q.bidYes, 18, 4)));
        _log("sigma (annual)", _formatUnits(F.sqrt(q.varE36 * SECONDS_PER_YEAR), 18, 4));
    }

    function params(address oracle) public view returns (IPredictionHook.MarketParams memory p) {
        uint256 cents;
        string memory strikeEnv = vm.envOr("STRIKE_USD", string(""));
        if (bytes(strikeEnv).length != 0) {
            cents = _parseUnits(strikeEnv, 2, "STRIKE_USD");
        } else {
            uint256 spotWad = uint256(F.expWad(IUnderlyingOracle(oracle).lnSpotSoBWad()));
            cents = (spotWad + 0.5e16) / 1e16;
        }
        require(cents > 0, "strike must be positive");

        uint256 openTime = block.timestamp + vm.envOr("MARKET_OPEN_DELAY_SEC", uint256(0));
        uint256 expiry = openTime + vm.envOr("MARKET_TENOR_SEC", uint256(60));
        p.oracle = oracle;
        p.lnStrikeWad = MarketNames.lnStrikeWad(cents);
        p.openTime = uint64(openTime);
        p.expiry = uint64(expiry);
        p.window = uint32(vm.envOr("MARKET_WINDOW_SEC", uint256(10)));
        p.cutoffBuffer = uint32(vm.envOr("MARKET_CUTOFF_BUFFER_SEC", uint256(2)));
        p.nSamples = uint32(vm.envOr("MARKET_N_SAMPLES", uint256(10)));
        p.budget = _envUnits("MARKET_BUDGET_USDC", "10", 6);
        p.quote = IPredictionHook.QuoteParams({
            h0Wad: uint64(_envUnits("QUOTE_H0", "0.02", 18)),
            gammaSWad: uint64(_envUnits("QUOTE_GAMMA_S", "0.00005", 18)),
            lambdaWad: uint128(_envUnits("QUOTE_LAMBDA", "0.001", 18)),
            qEpochMax: uint128(_envUnits("QUOTE_Q_EPOCH_MAX", "100", 6)),
            pMinWad: uint64(_envUnits("QUOTE_P_MIN", "0.02", 18))
        });
        p.sigmaMode = uint8(vm.envOr("SIGMA_MODE", uint256(0)));
        p.fixedVarE36 = _varE36(_envUnits("FIXED_SIGMA_ANNUAL", "0.6", 18));
        p.kernel = 0;

        string memory ticker = vm.envOr("MARKET_TICKER", string("ETH"));
        (p.yesName, p.noName, p.yesSymbol, p.noSymbol) = MarketNames.names(ticker, cents, expiry);
    }

    /// @dev Exposed to test/script/CreateMarketNames.t.sol's harness, which checks these against the keeper bot's
    ///      date math directly; kept as thin delegations so that check still exercises MarketNames.
    function _date(uint256 t) internal pure returns (string memory) {
        return MarketNames.date(t);
    }

    function _hhmm(uint256 t) internal pure returns (string memory) {
        return MarketNames.hhmm(t);
    }
}
