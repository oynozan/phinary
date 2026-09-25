// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUnderlyingOracle} from "../../../src/interfaces/IUnderlyingOracle.sol";

/// @notice Settable IUnderlyingOracle for bot integration tests.
contract MockUnderlyingOracle is IUnderlyingOracle {
    int256 public lnSpot;
    uint256 public varE36;
    bool public warm;

    function set(int256 lnSpot_, uint256 varE36_, bool warm_) external {
        lnSpot = lnSpot_;
        varE36 = varE36_;
        warm = warm_;
    }

    function lnSpotSoBWad() external view returns (int256) {
        return lnSpot;
    }

    function sobTick() external view returns (int24, uint32) {
        return (0, uint32(block.timestamp));
    }

    function cumulativeAt(uint32) external pure returns (int56) {
        return 0;
    }

    function varianceE36() external view returns (uint256, bool) {
        return (varE36, warm);
    }

    function decimalsShift() external pure returns (int16) {
        return 12;
    }

    function oldestObservationTime() external pure returns (uint32) {
        return 0;
    }
}
