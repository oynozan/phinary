// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUnderlyingOracle} from "./IUnderlyingOracle.sol";

/// @title ISealedPoolOracle
/// @notice IUnderlyingOracle over a hookless v4 pool, fed end-of-block states proven by fee-growth seals or proofs
interface ISealedPoolOracle is IUnderlyingOracle {
    struct BlockProof {
        bytes header;
        bytes[] accountProof;
        bytes[] slotProof;
    }

    error NotNextBlock(uint256 expected, uint256 got);
    error BadTimestamp(uint256 expected, uint256 got);
    error StaleSpot(uint256 frontier, uint256 blockNumber);
    error NotStarted();
    error InvalidPool();

    event Sealed(uint256 fromBlock, uint256 toBlock, int24 normTick);
    event Queued(uint256 fromBlock, uint256 toBlock);
    event Proven(uint256 blockNumber, int24 normTick);

    function poke() external returns (bool sealedRun);
    function prove(BlockProof calldata p) external;
    function proveMany(BlockProof[] calldata ps) external;
    function frontier() external view returns (uint256); // K, 0 before start
    function snapshot()
        external
        view
        returns (uint64 blockNumber, uint160 sqrtPriceX96, uint256 fg0, uint256 fg1, uint128 liquidity);
    function queueLength() external view returns (uint256);
    function blockTimeOf(uint256 n) external view returns (uint32); // anchorTs + (n - anchorBlock) * blockTime
}
