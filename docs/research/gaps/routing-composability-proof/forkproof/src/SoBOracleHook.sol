// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTestHooks} from "v4-core/src/test/BaseTestHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

/// @notice Minimal oracle-only hook for the UNDERLYING ETH/USDC pool (flags: BEFORE_SWAP only, no return deltas,
///         so routers treat it like a vanilla pool). It records the start-of-block (SoB) sqrtPrice on the first
///         swap of each block, BEFORE that swap moves the price. Same read rule as the quote-function gap report:
///         sob = (sobTs == block.timestamp) ? stored : live slot0 (no swap yet this block => slot0 is still SoB).
contract SoBOracleHook is BaseTestHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable manager;

    struct Sob {
        uint160 sqrtPriceX96;
        uint40 ts;
    }

    mapping(PoolId => Sob) public sob;

    event SobRecorded(PoolId indexed id, uint160 sqrtPriceX96, uint40 ts);

    error NotPoolManager();

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(manager)) revert NotPoolManager();
        PoolId id = key.toId();
        Sob storage s = sob[id];
        if (s.ts != uint40(block.timestamp)) {
            (uint160 sp,,,) = manager.getSlot0(id);
            s.sqrtPriceX96 = sp;
            s.ts = uint40(block.timestamp);
            emit SobRecorded(id, sp, uint40(block.timestamp));
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function sobSqrtPriceX96(PoolId id) external view returns (uint160) {
        Sob memory s = sob[id];
        if (s.ts == uint40(block.timestamp)) return s.sqrtPriceX96;
        (uint160 sp,,,) = manager.getSlot0(id);
        return sp;
    }
}
