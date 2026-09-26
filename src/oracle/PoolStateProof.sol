// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {RLPReader} from "../vendor/optimism/RLPReader.sol";
import {SecureMerkleTrie} from "../vendor/optimism/SecureMerkleTrie.sol";

/// @title PoolStateProof
/// @notice A v4 pool's end-of-block slot0 from a block header's state root, via account and storage Merkle proofs
/// @dev Decoding does not authenticate a header, the caller checks keccak256(header) against BlockHashes first
library PoolStateProof {
    struct Header {
        bytes32 parentHash;
        bytes32 stateRoot;
        uint256 number;
        uint256 timestamp;
    }

    error BadHeader();
    error BadAccountProof();
    error BadStorageProof();

    /// @notice RLP list fields 0, 3, 8 and 11 of the 21-field Isthmus header
    function decodeHeader(bytes calldata rlp) internal pure returns (Header memory h) {
        uint256 freeMemory = _freeMemoryPointer();
        RLPReader.RLPItem[] memory fields = RLPReader.readList(rlp);
        if (fields.length < 12) revert BadHeader();
        bytes memory parentHash = RLPReader.readBytes(fields[0]);
        bytes memory stateRoot = RLPReader.readBytes(fields[3]);
        bytes memory number = RLPReader.readBytes(fields[8]);
        bytes memory timestamp = RLPReader.readBytes(fields[11]);
        if (parentHash.length != 32 || stateRoot.length != 32 || number.length > 32 || timestamp.length > 32) {
            revert BadHeader();
        }
        (h.parentHash, h.stateRoot) = (bytes32(parentHash), bytes32(stateRoot));
        (h.number, h.timestamp) = (_uint(number), _uint(timestamp));
        _setFreeMemoryPointer(freeMemory);
    }

    /// @notice Storage root of `account` from its account proof, then pools[poolId].slot0 from the storage proof
    function slot0At(
        bytes32 stateRoot,
        address account,
        bytes32 poolId,
        bytes[] calldata accountProof,
        bytes[] calldata slotProof
    ) internal pure returns (uint160 sqrtPriceX96, int24 tick) {
        uint256 freeMemory = _freeMemoryPointer();
        if (accountProof.length == 0 || keccak256(accountProof[0]) != stateRoot) revert BadAccountProof();
        RLPReader.RLPItem[] memory fields =
            RLPReader.readList(SecureMerkleTrie.get(abi.encodePacked(account), accountProof, stateRoot));
        if (fields.length != 4) revert BadAccountProof();
        bytes memory storageRoot = RLPReader.readBytes(fields[2]);
        if (storageRoot.length != 32) revert BadAccountProof();

        if (slotProof.length == 0 || keccak256(slotProof[0]) != bytes32(storageRoot)) revert BadStorageProof();
        bytes32 slot = keccak256(abi.encodePacked(poolId, StateLibrary.POOLS_SLOT));
        bytes memory value =
            RLPReader.readBytes(SecureMerkleTrie.get(abi.encodePacked(slot), slotProof, bytes32(storageRoot)));
        if (value.length > 32) revert BadStorageProof();

        // Same packing as StateLibrary.getSlot0, tick sign-extends from bit 160
        uint256 word = _uint(value);
        sqrtPriceX96 = uint160(word);
        tick = int24(int256(word >> 160));
        if (sqrtPriceX96 == 0) revert BadStorageProof();
        _setFreeMemoryPointer(freeMemory);
    }

    function _uint(bytes memory bigEndian) private pure returns (uint256) {
        return uint256(bytes32(bigEndian)) >> (256 - 8 * bigEndian.length);
    }

    function _freeMemoryPointer() private pure returns (uint256 p) {
        assembly ("memory-safe") {
            p := mload(0x40)
        }
    }

    // Parsing leaves ~90 kB of dead memory per proof, and memory cost is quadratic across a batch
    function _setFreeMemoryPointer(uint256 p) private pure {
        assembly ("memory-safe") {
            mstore(0x40, p)
        }
    }
}
