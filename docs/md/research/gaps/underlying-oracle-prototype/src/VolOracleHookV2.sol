// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {HookBase} from "./HookBase.sol";
import {VolOracleV2} from "./VolOracleV2.sol";
import {IUnderlyingOracle} from "./IUnderlyingOracle.sol";

/// @title VolOracleHookV2 (research prototype, NOT audited)
/// @notice Oracle-only hook for an ETH/USDC v4 pool: permissions afterInitialize | beforeSwap (address bits 0x1080),
///         no return-delta flags, zero fee override. Records the SoB tick once per block, a TWAP-return RV accumulator
///         and an O(1) grid checkpoint ring. Serves any number of pools (feed id = PoolId).
contract VolOracleHookV2 is HookBase, IUnderlyingOracle {
    using VolOracleV2 for VolOracleV2.Oracle;
    using StateLibrary for IPoolManager;

    uint32 public immutable H;
    int24 public immutable WINDOW_CAP;
    uint16 public immutable RING;
    uint16 public immutable MAX_CATCHUP;
    int24 public constant BLOCK_CAP = 9116;

    mapping(PoolId => VolOracleV2.Oracle) internal oracles;
    mapping(PoolId => FeedInfo) internal infos;

    struct Sob {
        uint160 sqrtPriceX96; // pre-swap price of the first swap in block `ts` = end-of-previous-block price
        uint32 ts;
    }

    mapping(PoolId => Sob) internal sobs;

    constructor(IPoolManager pm, uint32 h, int24 windowCap, uint16 ring, uint16 maxCatchUp) HookBase(pm) {
        require(ring <= VolOracleV2.MAX_RING && ring > 0 && maxCatchUp > 0 && maxCatchUp <= ring);
        H = h;
        WINDOW_CAP = windowCap;
        RING = ring;
        MAX_CATCHUP = maxCatchUp;
    }

    function _p() internal view returns (VolOracleV2.Params memory) {
        return VolOracleV2.Params(H, BLOCK_CAP, WINDOW_CAP, MAX_CATCHUP, RING);
    }

    function afterInitialize(address, PoolKey calldata key, uint160, int24 tick)
        external
        override
        onlyManager
        returns (bytes4)
    {
        PoolId id = key.toId();
        oracles[id].initialize(uint32(block.timestamp), tick, _p());
        // native ETH is currency0 in every native ETH/USDC v4 pool -> ETH up == tick up
        infos[id] = FeedInfo(H, 1, 12, key.fee, RING);
        return this.afterInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        override
        onlyManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        (uint160 sp, int24 tick,,) = poolManager.getSlot0(id); // pre-swap state
        if (oracles[id].write(uint32(block.timestamp), tick, _p())) {
            sobs[id] = Sob(sp, uint32(block.timestamp));
        }
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @notice Permissionless: record an observation if none was written in this block. Safe because if no swap
    ///         happened yet in this block, the live tick IS the start-of-block tick (any earlier swap would have
    ///         written first). Used by keepers to guarantee settlement checkpoints and to bound catch-up gaps.
    function poke(PoolId id) external returns (bool w) {
        (uint160 sp, int24 tick,,) = poolManager.getSlot0(id);
        w = oracles[id].write(uint32(block.timestamp), tick, _p());
        if (w) sobs[id] = Sob(sp, uint32(block.timestamp));
    }

    function increaseObservationCardinalityNext(PoolId id, uint16 next) external {
        oracles[id].grow(next);
    }

    // ---------------------------------------------------------------- IUnderlyingOracle
    function feedInfo(bytes32 feed) external view returns (FeedInfo memory) {
        return infos[PoolId.wrap(feed)];
    }

    function _tick(PoolId id) internal view returns (int24 t) {
        (, t,,) = poolManager.getSlot0(id);
    }

    function sobTick(bytes32 feed) external view returns (int24, uint32) {
        PoolId id = PoolId.wrap(feed);
        VolOracleV2.Oracle storage o = oracles[id];
        // only touch PoolManager when needed (no write in this block)
        VolOracleV2.Observation memory last = o.obs[o.st.index];
        if (o.st.cardinality == 0) revert VolOracleV2.NotInitialized();
        if (last.blockTimestamp == uint32(block.timestamp)) return (last.tick, last.blockTimestamp);
        return (_tick(id), last.blockTimestamp);
    }

    function sobSqrtPriceX96(bytes32 feed) external view returns (uint160, bool) {
        PoolId id = PoolId.wrap(feed);
        Sob memory s = sobs[id];
        if (s.ts == uint32(block.timestamp)) return (s.sqrtPriceX96, true);
        (uint160 sp,,,) = poolManager.getSlot0(id); // no swap yet in this block -> live price == SoB price
        return (sp, true);
    }

    function cumulativeNow(bytes32 feed) external view returns (int56) {
        PoolId id = PoolId.wrap(feed);
        VolOracleV2.Oracle storage o = oracles[id];
        VolOracleV2.Observation memory last = o.obs[o.st.index];
        if (last.blockTimestamp == uint32(block.timestamp)) return last.tickCumulative;
        return last.tickCumulative + int56(_tick(id)) * int56(uint56(uint32(block.timestamp) - last.blockTimestamp));
    }

    function cumulativeAtGrid(bytes32 feed, uint32 grid) external view returns (int56) {
        PoolId id = PoolId.wrap(feed);
        VolOracleV2.Oracle storage o = oracles[id];
        int24 cur = grid <= o.st.lastGrid ? int24(0) : _tick(id); // live tick only needed for virtual checkpoints
        return o.checkpointAt(grid, uint32(block.timestamp), cur, _p()).cum;
    }

    function varianceE36(bytes32 feed, uint32 nWindows) external view returns (uint256, uint32, uint32, uint32) {
        PoolId id = PoolId.wrap(feed);
        VolOracleV2.Oracle storage o = oracles[id];
        uint32 gEnd = uint32(block.timestamp) / H;
        int24 cur = gEnd <= o.st.lastGrid ? int24(0) : _tick(id);
        return o.varianceE36(nWindows, uint32(block.timestamp), cur, _p());
    }

    // ---------------------------------------------------------------- diagnostics
    function latest(PoolId id)
        external
        view
        returns (VolOracleV2.Observation memory o, VolOracleV2.State memory s)
    {
        s = oracles[id].st;
        o = oracles[id].obs[s.index];
    }

    function checkpointSlot(PoolId id, uint32 grid) external view returns (VolOracleV2.Checkpoint memory) {
        return oracles[id].ckpt[grid % RING];
    }
}
