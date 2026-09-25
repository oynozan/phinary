// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

/// @notice Stand-in for UnderlyingOracleHook's write path: on the first swap of each timestamp, beforeSwap records the
///         pre-swap sqrtPrice. Same flags as the oracle (AFTER_INITIALIZE | BEFORE_SWAP).
contract MockSobHook is BaseHook {
    using StateLibrary for IPoolManager;

    PoolId public poolId;
    PoolKey internal _key;
    uint160 public sobSqrtPriceX96;
    uint32 public lastWriteTime;
    uint256 public writes;

    constructor(IPoolManager poolManager_) BaseHook(poolManager_) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.afterInitialize = true;
        p.beforeSwap = true;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    /// @notice Start-of-block sqrtPrice: the recorded one within the block of the last write, slot0 otherwise.
    function sobSqrtPrice() external view returns (uint160 sp) {
        if (lastWriteTime == uint32(block.timestamp)) return sobSqrtPriceX96;
        (sp,,,) = poolManager.getSlot0(poolId);
    }

    function _afterInitialize(address, PoolKey calldata key, uint160 sqrtPriceX96, int24)
        internal
        override
        returns (bytes4)
    {
        poolId = key.toId();
        _key = key;
        sobSqrtPriceX96 = sqrtPriceX96;
        lastWriteTime = uint32(block.timestamp);
        return this.afterInitialize.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (lastWriteTime != uint32(block.timestamp)) {
            (uint160 sp,,,) = poolManager.getSlot0(key.toId());
            sobSqrtPriceX96 = sp;
            lastWriteTime = uint32(block.timestamp);
            writes++;
        }
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}
