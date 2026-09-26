// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LibString} from "solady/utils/LibString.sol";
import {IMarketGatekeeper} from "./interfaces/IMarketGatekeeper.sol";
import {IMarketScheduler} from "./interfaces/IMarketScheduler.sol";
import {IPredictionHook} from "./interfaces/IPredictionHook.sol";
import {IUnderlyingOracle} from "./interfaces/IUnderlyingOracle.sol";
import {MarketNames} from "./lib/MarketNames.sol";

/// @title MarketScheduler
/// @notice Ownerless scheduler for one track, deployed by the MarketGatekeeper that is a PredictionHook's `owner`.
///         Anyone may call `open()` once per `period`-second slot, until the slot's deadline, to open that slot's
///         market through the gatekeeper; there is no setter and no admin, every field is fixed at construction.
/// @dev `hook` is the real PredictionHook, read only for `vaultIdle()`; `gatekeeper` is the only path to
///      `createMarket`. A slot's market expires at `slot * period + tenor`, so `tenor == period` runs markets back to
///      back, a longer tenor overlaps them and a shorter one leaves gaps.
contract MarketScheduler is IMarketScheduler {
    uint256 internal constant WAD = 1e18;
    /// @dev Upper bound on `period` and `tenor`. It keeps slot 0 in the past (so the `lastSlot == 0` sentinel never
    ///      blocks a slot) and every expiry below the hook's uint32 limit until the year 2105.
    uint256 internal constant MAX_DURATION = 365 days;

    IPredictionHook public immutable hook;
    IMarketGatekeeper public immutable gatekeeper;
    address public immutable oracle;

    uint32 internal immutable _period;
    uint32 internal immutable _tenor;
    uint32 internal immutable _window;
    uint32 internal immutable _cutoffBuffer;
    uint32 internal immutable _nSamples;
    uint64 internal immutable _h0Wad;
    uint64 internal immutable _gammaSWad;
    uint128 internal immutable _lambdaWad;
    uint128 internal immutable _qEpochMax;
    uint64 internal immutable _pMinWad;
    uint256 internal immutable _maxBudget;
    uint256 internal immutable _minBudget;
    bytes32 internal immutable _tickerSmall;

    uint256 public lastSlot;
    mapping(uint256 slot => uint256 marketId) public marketOfSlot;

    /// @dev `tenor > window + cutoffBuffer` keeps every slot openable at its first second. The constructor never
    ///      calls `hook_`, so the gatekeeper and its schedulers may be deployed before the hook exists.
    constructor(IPredictionHook hook_, IMarketGatekeeper gatekeeper_, address oracle_, Config memory c) {
        uint256 tickerLen = bytes(c.ticker).length;
        if (
            c.period == 0 || c.period > MAX_DURATION || c.window == 0 || c.tenor > MAX_DURATION
                || c.tenor <= uint256(c.window) + c.cutoffBuffer || c.maxBudget == 0 || c.minBudget == 0
                || c.minBudget > c.maxBudget || tickerLen == 0 || tickerLen > 6 || address(gatekeeper_) == address(0)
                || oracle_ == address(0) || c.quote.qEpochMax == 0 || c.quote.pMinWad == 0 || c.quote.pMinWad >= WAD / 2
        ) revert InvalidConfig();

        hook = hook_;
        gatekeeper = gatekeeper_;
        oracle = oracle_;
        _period = c.period;
        _tenor = c.tenor;
        _window = c.window;
        _cutoffBuffer = c.cutoffBuffer;
        _nSamples = c.nSamples;
        _h0Wad = c.quote.h0Wad;
        _gammaSWad = c.quote.gammaSWad;
        _lambdaWad = c.quote.lambdaWad;
        _qEpochMax = c.quote.qEpochMax;
        _pMinWad = c.quote.pMinWad;
        _maxBudget = c.maxBudget;
        _minBudget = c.minBudget;
        _tickerSmall = LibString.toSmallString(c.ticker);
    }

    /// @inheritdoc IMarketScheduler
    /// @dev The TooLate check mirrors the hook's own `createMarket` rule, so a late call fails with the slot named
    function open() external returns (uint256 marketId) {
        uint256 slot = block.timestamp / _period;
        if (slot <= lastSlot) revert AlreadyOpened(slot);
        uint256 expiry = slot * _period + _tenor;
        if (block.timestamp + _window + _cutoffBuffer >= expiry) revert TooLate(slot);
        lastSlot = slot;

        uint256 budget = _budget();
        uint256 cents = MarketNames.strikeCents(IUnderlyingOracle(oracle).lnSpotSoBWad());
        (string memory yesName, string memory noName, string memory yesSymbol, string memory noSymbol) =
            MarketNames.names(_ticker(), cents, expiry);

        marketId = gatekeeper.createMarket(
            IPredictionHook.MarketParams({
                oracle: oracle,
                lnStrikeWad: MarketNames.lnStrikeWad(cents),
                openTime: uint64(block.timestamp),
                expiry: uint64(expiry),
                window: _window,
                cutoffBuffer: _cutoffBuffer,
                nSamples: _nSamples,
                budget: budget,
                quote: IPredictionHook.QuoteParams({
                    h0Wad: _h0Wad,
                    gammaSWad: _gammaSWad,
                    lambdaWad: _lambdaWad,
                    qEpochMax: _qEpochMax,
                    pMinWad: _pMinWad
                }),
                sigmaMode: 0,
                fixedVarE36: 0,
                kernel: 0,
                yesName: yesName,
                yesSymbol: yesSymbol,
                noName: noName,
                noSymbol: noSymbol
            })
        );
        marketOfSlot[slot] = marketId;

        emit MarketOpened(marketId, slot, msg.sender, budget, cents);
    }

    /// @inheritdoc IMarketScheduler
    /// @dev Mirrors every revert path in `open()`: the slot check, the deadline, the budget check and a strike that
    ///      `open()` could actually build (a reverting oracle read, or a spot low enough that `strikeCents` rounds to
    ///      0, which would make `MarketNames.lnStrikeWad` revert on `ln(0)`).
    function canOpen() external view returns (bool) {
        uint256 slot = block.timestamp / _period;
        if (slot <= lastSlot || block.timestamp >= openDeadline(slot)) return false;
        (, bool budgetOk) = _affordableBudget();
        if (!budgetOk) return false;
        try IUnderlyingOracle(oracle).lnSpotSoBWad() returns (int256 ln) {
            return MarketNames.strikeCents(ln) != 0;
        } catch {
            return false;
        }
    }

    /// @inheritdoc IMarketScheduler
    /// @dev Past the current slot's deadline the next slot's start is returned, since the current one is lost
    function nextOpenTime() external view returns (uint256) {
        uint256 slot = block.timestamp / _period;
        if (slot <= lastSlot) slot = lastSlot + 1;
        else if (block.timestamp >= openDeadline(slot)) slot += 1;
        return slot * _period;
    }

    /// @inheritdoc IMarketScheduler
    function openDeadline(uint256 slot) public view returns (uint256) {
        return slot * _period + _tenor - _window - _cutoffBuffer;
    }

    /// @inheritdoc IMarketScheduler
    function config() external view returns (Config memory c) {
        c.period = _period;
        c.tenor = _tenor;
        c.window = _window;
        c.cutoffBuffer = _cutoffBuffer;
        c.nSamples = _nSamples;
        c.quote = IPredictionHook.QuoteParams({
            h0Wad: _h0Wad,
            gammaSWad: _gammaSWad,
            lambdaWad: _lambdaWad,
            qEpochMax: _qEpochMax,
            pMinWad: _pMinWad
        });
        c.maxBudget = _maxBudget;
        c.minBudget = _minBudget;
        c.ticker = _ticker();
    }

    /// @return budget `min(maxBudget, hook.vaultIdle() / 2)`, reverting InsufficientIdle below `minBudget`.
    function _budget() internal view returns (uint256 budget) {
        bool ok;
        (budget, ok) = _affordableBudget();
        if (!ok) revert InsufficientIdle(budget, _minBudget);
    }

    /// @return budget `min(maxBudget, hook.vaultIdle() / 2)`; ok whether it clears `minBudget`. Non-reverting form
    ///         of `_budget`, shared with `canOpen()` so the two never disagree.
    function _affordableBudget() internal view returns (uint256 budget, bool ok) {
        uint256 half = hook.vaultIdle() / 2;
        budget = half < _maxBudget ? half : _maxBudget;
        ok = budget >= _minBudget;
    }

    function _ticker() internal view returns (string memory) {
        return LibString.fromSmallString(_tickerSmall);
    }
}
