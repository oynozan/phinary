// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {IUnderlyingOracle} from "../../../src/interfaces/IUnderlyingOracle.sol";

/// @notice NEGATIVE CONTROL. The same ETH/USDC pool read as the LIVE slot0 price instead of the start-of-block price.
///         Everything except the spot input (variance, cumulative, decimals) is delegated to the real oracle, so a
///         market on this adapter differs from a real one only in S. Never deploy this.
contract LiveSlot0Oracle is IUnderlyingOracle {
    using StateLibrary for IPoolManager;

    int256 internal constant LN10_WAD = 2302585092994045684;
    int256 internal constant LN_WAD_TO_Q96 = -25095597659861927392;

    IPoolManager public immutable pm;
    IUnderlyingOracle public immutable inner;
    PoolId public immutable poolId;
    int8 public immutable sign;

    constructor(IPoolManager pm_, IUnderlyingOracle inner_, PoolId poolId_, int8 sign_) {
        pm = pm_;
        inner = inner_;
        poolId = poolId_;
        sign = sign_;
    }

    function lnSpotSoBWad() external view returns (int256) {
        (uint160 sp,,,) = pm.getSlot0(poolId);
        int256 lnRaw = 2 * (F.lnWad(int256(uint256(sp))) + LN_WAD_TO_Q96);
        return int256(sign) * lnRaw + int256(inner.decimalsShift()) * LN10_WAD;
    }

    function sobTick() external view returns (int24, uint32) {
        (, int24 raw,,) = pm.getSlot0(poolId);
        return (sign > 0 ? raw : -raw - 1, uint32(block.timestamp));
    }

    function cumulativeAt(uint32 t) external view returns (int56) {
        return inner.cumulativeAt(t);
    }

    function varianceE36() external view returns (uint256, bool) {
        return inner.varianceE36();
    }

    function decimalsShift() external view returns (int16) {
        return inner.decimalsShift();
    }

    function oldestObservationTime() external view returns (uint32) {
        return inner.oldestObservationTime();
    }
}
