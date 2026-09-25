// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUnderlyingOracle} from "../../../src/interfaces/IUnderlyingOracle.sol";

/// @notice IUnderlyingOracle with settable values, cumulativeAt(t) is flatTick * t unless a value was set for t
contract MockOracle is IUnderlyingOracle {
    int256 public lnSpot;
    uint256 public varE36;
    bool public warm = true;
    int16 public shift;
    int24 public flatTick;
    uint32 public oldest;
    bool public unavailable;
    mapping(uint32 => int56) internal _cum;
    mapping(uint32 => bool) internal _cumSet;

    function setLnSpot(int256 v) external {
        lnSpot = v;
    }

    function setVar(uint256 v) external {
        varE36 = v;
    }

    function setWarm(bool v) external {
        warm = v;
    }

    function setShift(int16 v) external {
        shift = v;
    }

    function setFlatTick(int24 v) external {
        flatTick = v;
    }

    function setOldest(uint32 v) external {
        oldest = v;
    }

    function setUnavailable(bool v) external {
        unavailable = v;
    }

    function setCum(uint32 t, int56 v) external {
        _cum[t] = v;
        _cumSet[t] = true;
    }

    function lnSpotSoBWad() external view returns (int256) {
        return lnSpot;
    }

    function sobTick() external view returns (int24, uint32) {
        return (flatTick, uint32(block.timestamp));
    }

    function cumulativeAt(uint32 t) external view returns (int56) {
        if (unavailable || t < oldest || t > block.timestamp) revert ObservationUnavailable(t);
        if (_cumSet[t]) return _cum[t];
        return int56(flatTick) * int56(uint56(t));
    }

    function varianceE36() external view returns (uint256, bool) {
        return (varE36, warm);
    }

    function decimalsShift() external view returns (int16) {
        return shift;
    }

    function oldestObservationTime() external view returns (uint32) {
        return oldest;
    }
}
