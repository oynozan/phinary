// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IUnderlyingOracle
/// @notice What the PredictionHook reads about the underlying ETH/USD price, sourced from a Uniswap pool.
/// @dev Ticks are NORMALISED so that "ETH up" == "tick up": normTick = floor(sign * L_raw): rawTick if sign = +1, -rawTick - 1 if sign = -1.
///      Human USD per ETH = 1.0001^normTick * 10^decimalsShift.
///      No value returned here can be moved by swaps executed earlier in the current block.
interface IUnderlyingOracle {
    error ObservationUnavailable(uint32 t);

    /// @notice ln(USD per ETH) at the start of the current block, WAD, derived from sqrtPriceX96 (no tick flooring).
    function lnSpotSoBWad() external view returns (int256);

    /// @notice Normalised start-of-block tick and the timestamp of the last oracle write.
    function sobTick() external view returns (int24 normTick, uint32 lastWriteTime);

    /// @notice Normalised sum(tick * dt) at time `t` (t <= block.timestamp), v3 `observe` semantics.
    ///         Reverts ObservationUnavailable if `t` is older than the retained history.
    function cumulativeAt(uint32 t) external view returns (int56 normCum);

    /// @notice Per-second variance at 1e36 scale from the TWAP-return realised-variance estimator, after policy
    ///         (x3/2, winsorisation, clamps). `warm` is false while the fallback variance is being returned.
    function varianceE36() external view returns (uint256 varPerSecE36, bool warm);

    /// @notice Decimal shift so that human price = 1.0001^normTick * 10^decimalsShift.
    function decimalsShift() external view returns (int16);

    /// @notice Timestamp of the oldest retained observation.
    function oldestObservationTime() external view returns (uint32);
}
