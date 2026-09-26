// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPredictionHook} from "./IPredictionHook.sol";
import {IMarketGatekeeper} from "./IMarketGatekeeper.sol";

/// @title IMarketScheduler
/// @notice External API of the ownerless scheduler for one track, deployed by the MarketGatekeeper that owns a
///         PredictionHook. It opens at most one market per time slot, callable by anyone until the slot's deadline.
/// @dev A scheduler is genuine only if `IMarketGatekeeper(hook.owner()).isScheduler(scheduler)`. Anyone can deploy a
///      MarketScheduler whose `hook()` is the real hook behind a fake gatekeeper, and its `open()` then emits
///      MarketOpened for an existing market id, so neither `hook()` nor the MarketOpened topic proves anything alone.
interface IMarketScheduler {
    struct Config {
        uint32 period;
        uint32 tenor;
        uint32 window;
        uint32 cutoffBuffer;
        uint32 nSamples;
        IPredictionHook.QuoteParams quote;
        uint256 maxBudget;
        uint256 minBudget;
        string ticker; // 1..6 chars
    }

    error AlreadyOpened(uint256 slot);
    error TooLate(uint256 slot);
    error InsufficientIdle(uint256 budget, uint256 minBudget);
    error InvalidConfig();

    /// @dev Trust it only when the emitter is in `IMarketGatekeeper(hook.owner()).schedulers()`
    event MarketOpened(
        uint256 indexed marketId, uint256 indexed slot, address indexed caller, uint256 budget, uint256 strikeCents
    );

    function open() external returns (uint256 marketId);
    function canOpen() external view returns (bool);
    /// @return Start of the next slot `open()` can still serve, a value <= block.timestamp means it is due now
    function nextOpenTime() external view returns (uint256);
    /// @return The first second at which `open()` for `slot` reverts TooLate
    function openDeadline(uint256 slot) external view returns (uint256);
    function lastSlot() external view returns (uint256);
    /// @return The market opened for `slot`, 0 if none
    function marketOfSlot(uint256 slot) external view returns (uint256);
    function hook() external view returns (IPredictionHook);
    function gatekeeper() external view returns (IMarketGatekeeper);
    function oracle() external view returns (address);
    function config() external view returns (Config memory);
}
