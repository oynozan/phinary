// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPredictionHook} from "./IPredictionHook.sol";

/// @title IMarketScheduler
/// @notice External API of the ownerless scheduler that becomes a PredictionHook's `owner` and opens one market per
///         time slot, callable by anyone.
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
    error InsufficientIdle(uint256 budget, uint256 minBudget);
    error InvalidConfig();

    event MarketOpened(
        uint256 indexed marketId, uint256 indexed slot, address indexed caller, uint256 budget, uint256 strikeCents
    );

    function open() external returns (uint256 marketId);
    function canOpen() external view returns (bool);
    function nextOpenTime() external view returns (uint256);
    function lastSlot() external view returns (uint256);
    function hook() external view returns (IPredictionHook);
    function oracle() external view returns (address);
    function config() external view returns (Config memory);
}
