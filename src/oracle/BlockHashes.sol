// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolStateProof} from "./PoolStateProof.sol";

/// @title BlockHashes
/// @notice Trusted L2 block hashes from BLOCKHASH, then EIP-2935, then header chains checkpointed back from either
abstract contract BlockHashes {
    address internal constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;

    error UnknownBlockHash(uint256 n);

    event HeadersCheckpointed(uint256 oldest, uint256 newest);

    mapping(uint256 => bytes32) private _checkpoints;

    /// @notice BLOCKHASH within 256 blocks, else EIP-2935 within 8191, else a stored checkpoint, else 0
    function blockHashOf(uint256 n) public view returns (bytes32 hash) {
        if (n < block.number) {
            uint256 age = block.number - n;
            if (age <= 256) hash = blockhash(n);
            else if (age <= 8191) hash = _history(n);
        }
        if (hash == 0) hash = _checkpoints[n];
    }

    /// @notice Stores the hash of every header in a parent-linked chain, newest first, anchored at a known hash
    function checkpointHeaders(bytes[] calldata headersNewestFirst) external {
        if (headersNewestFirst.length == 0) revert PoolStateProof.BadHeader();
        PoolStateProof.Header memory h = PoolStateProof.decodeHeader(headersNewestFirst[0]);
        uint256 newest = h.number;
        bytes32 hash = blockHashOf(newest);
        if (hash == 0) revert UnknownBlockHash(newest);
        if (keccak256(headersNewestFirst[0]) != hash) revert PoolStateProof.BadHeader();
        _checkpoints[newest] = hash;

        for (uint256 i = 1; i < headersNewestFirst.length; i++) {
            hash = h.parentHash;
            if (keccak256(headersNewestFirst[i]) != hash) revert PoolStateProof.BadHeader();
            h = PoolStateProof.decodeHeader(headersNewestFirst[i]);
            _checkpoints[h.number] = hash;
        }
        emit HeadersCheckpointed(h.number, newest);
    }

    // The history contract reverts outside its window and returns zero for a slot it never wrote
    function _history(uint256 n) private view returns (bytes32 hash) {
        (bool ok, bytes memory ret) = HISTORY.staticcall(abi.encode(n));
        if (ok && ret.length == 32) hash = abi.decode(ret, (bytes32));
    }
}
