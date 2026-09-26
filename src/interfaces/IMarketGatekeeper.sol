// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IMarketScheduler} from "./IMarketScheduler.sol";
import {IPredictionHook} from "./IPredictionHook.sol";

/// @title IMarketGatekeeper
/// @notice External API of the ownerless PredictionHook `owner` that deploys a fixed set of MarketSchedulers (one per
///         track) and forwards `createMarket` from them only.
interface IMarketGatekeeper {
    error NotScheduler();
    error InvalidTracks();

    /// @notice One scheduler to deploy: the oracle it reads spot from and its config
    struct Track {
        address oracle;
        IMarketScheduler.Config config;
    }

    function hook() external view returns (IPredictionHook);
    /// @return The schedulers in constructor order, the i-th at `computeCreateAddress(gatekeeper, i + 1)`
    function schedulers() external view returns (address[] memory);
    function schedulerCount() external view returns (uint256);
    /// @return Whether `account` is one of this gatekeeper's schedulers, the only proof that a scheduler is genuine
    function isScheduler(address account) external view returns (bool);
    /// @return The scheduler that opened `marketId`, address(0) for ids this gatekeeper never created
    function schedulerOf(uint256 marketId) external view returns (address);
    function createMarket(IPredictionHook.MarketParams calldata p) external returns (uint256 marketId);
}
