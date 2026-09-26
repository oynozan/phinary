// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IUnderlyingOracle
/// @notice What the PredictionHook reads about the underlying (ETH/USDC). All ticks are NORMALIZED so that
///         "ETH price up" == "tick up": normTick = sign * rawTick with sign = -1 for pools where USDC is token0
///         (e.g. mainnet v3 USDC/WETH). Human $/ETH = 1.0001^normTick * 10^(decimalsShift).
///         Every read is O(1) (no binary search) and cannot be moved by swaps in the current block.
interface IUnderlyingOracle {
    struct FeedInfo {
        uint32 H; // grid length, seconds
        int8 sign; // +1 or -1 (raw -> normalized)
        int16 decimalsShift; // e.g. +12 for ETH(18)/USDC(6) when ETH is token0
        uint24 feeBandPips; // effective no-arbitrage band of the source pool (lp fee + protocol fee), 1e6 = 100%
        uint16 ringSize; // number of grid checkpoints retained
    }

    function feedInfo(bytes32 feed) external view returns (FeedInfo memory);

    /// @notice Start-of-block tick: the tick at the end of the previous block. Same-block swaps never change it.
    function sobTick(bytes32 feed) external view returns (int24 normTick, uint32 lastWriteTime);

    /// @notice Start-of-block RAW sqrtPriceX96 of the source pool (not normalized; apply `sign` to its log).
    ///         exact == false when only the tick is known (v3 source written this block): the half-tick midpoint
    ///         price getSqrtPriceAtTick(tick) * sqrt(1.0001)^(1/2) is returned instead (error <= 0.5 bp).
    function sobSqrtPriceX96(bytes32 feed) external view returns (uint160 sqrtPriceX96, bool exact);

    /// @notice sum(normTick * dt) up to block.timestamp (manipulation-safe: uses SoB tick for the open interval).
    function cumulativeNow(bytes32 feed) external view returns (int56 normCum);

    /// @notice sum(normTick * dt) up to grid time g*H (reverts CheckpointUnavailable if not retained).
    function cumulativeAtGrid(bytes32 feed, uint32 grid) external view returns (int56 normCum);

    /// @notice TWAP-return realized variance per second (1e36 scale) over the last nWindows complete windows,
    ///         before any policy (bias/floor/cap). dN = number of window differences actually used.
    function varianceE36(bytes32 feed, uint32 nWindows)
        external
        view
        returns (uint256 varPerSecE36, uint32 gStart, uint32 gEnd, uint32 dN);
}
