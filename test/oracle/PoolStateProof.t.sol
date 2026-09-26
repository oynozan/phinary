// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {PoolStateProof} from "../../src/oracle/PoolStateProof.sol";
import {BlockHashes} from "../../src/oracle/BlockHashes.sol";
import {UnexpectedString} from "../../src/vendor/optimism/RLPErrors.sol";

/// @notice Exposes the proof stack the way SealedPoolOracle uses it, against the Unichain PoolManager
contract ProofHarness is BlockHashes {
    address internal constant POOL_MANAGER = 0x1F98400000000000000000000000000000000004;
    bytes32 internal constant DEEP_POOL = 0x3258f413c7a88cda2fa8709a589d221a80f6574f63df5a5b6774485d8acc39d9;

    function decodeHeader(bytes calldata rlp) external pure returns (PoolStateProof.Header memory) {
        return PoolStateProof.decodeHeader(rlp);
    }

    function slot0At(bytes32 stateRoot, bytes32 poolId, bytes[] calldata accountProof, bytes[] calldata slotProof)
        external
        pure
        returns (uint160, int24)
    {
        return PoolStateProof.slot0At(stateRoot, POOL_MANAGER, poolId, accountProof, slotProof);
    }

    function memoryGrowth(bytes calldata header, bytes[] calldata accountProof, bytes[] calldata slotProof)
        external
        pure
        returns (uint256 headerBytes, uint256 proofBytes)
    {
        uint256 p0 = _freeMemoryPointer();
        bytes32 stateRoot = PoolStateProof.decodeHeader(header).stateRoot;
        uint256 p1 = _freeMemoryPointer();
        PoolStateProof.slot0At(stateRoot, POOL_MANAGER, DEEP_POOL, accountProof, slotProof);
        (headerBytes, proofBytes) = (p1 - p0, _freeMemoryPointer() - p1);
    }

    function slot0AtTimes(bytes32 stateRoot, bytes[] calldata accountProof, bytes[] calldata slotProof, uint256 k)
        external
        pure
    {
        for (uint256 i; i < k; i++) {
            PoolStateProof.slot0At(stateRoot, POOL_MANAGER, DEEP_POOL, accountProof, slotProof);
        }
    }

    function _freeMemoryPointer() internal pure returns (uint256 p) {
        assembly ("memory-safe") {
            p := mload(0x40)
        }
    }

    function verify(bytes calldata header, bytes32 poolId, bytes[] calldata accountProof, bytes[] calldata slotProof)
        external
        view
        returns (uint256 number, uint160 sqrtPriceX96, int24 tick)
    {
        PoolStateProof.Header memory h = PoolStateProof.decodeHeader(header);
        bytes32 known = blockHashOf(h.number);
        if (known == 0) revert UnknownBlockHash(h.number);
        if (keccak256(header) != known) revert PoolStateProof.BadHeader();
        (sqrtPriceX96, tick) = PoolStateProof.slot0At(h.stateRoot, POOL_MANAGER, poolId, accountProof, slotProof);
        number = h.number;
    }
}

/// @notice Real Unichain mainnet fixtures from script/fixtures/unichain-proof.sh for the deep hookless ETH/USDC v4 pool
contract PoolStateProofTest is Test {
    address internal constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    bytes32 internal constant DEEP_POOL = 0x3258f413c7a88cda2fa8709a589d221a80f6574f63df5a5b6774485d8acc39d9;
    // EIP-2935 runtime code, byte-equal to Unichain's deployment
    bytes internal constant HISTORY_CODE =
        hex"3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500";

    event HeadersCheckpointed(uint256 oldest, uint256 newest);

    struct Fixture {
        uint256 number;
        uint256 timestamp;
        bytes32 blockHash;
        bytes32 parentHash;
        bytes32 stateRoot;
        bytes header;
        bytes[] ancestors;
        bytes[] accountProof;
        bytes[] slotProof;
        uint160 sqrtPriceX96;
        int24 tick;
    }

    ProofHarness internal h;

    function setUp() public {
        h = new ProofHarness();
    }

    function _blocks() internal pure returns (uint256[3] memory) {
        return [uint256(59663450), 59663470, 59663490];
    }

    function _load(uint256 n) internal view returns (Fixture memory f) {
        string memory j = vm.readFile(string.concat("test/vectors/unichain/pool-proof-", vm.toString(n), ".json"));
        f.number = vm.parseJsonUint(j, ".number");
        f.timestamp = vm.parseJsonUint(j, ".timestamp");
        f.blockHash = vm.parseJsonBytes32(j, ".blockHash");
        f.parentHash = vm.parseJsonBytes32(j, ".parentHash");
        f.stateRoot = vm.parseJsonBytes32(j, ".stateRoot");
        f.header = vm.parseJsonBytes(j, ".header");
        f.ancestors = vm.parseJsonBytesArray(j, ".ancestorHeaders");
        f.accountProof = vm.parseJsonBytesArray(j, ".accountProof");
        f.slotProof = vm.parseJsonBytesArray(j, ".slotProof");
        f.sqrtPriceX96 = uint160(vm.parseJsonUint(j, ".sqrtPriceX96"));
        f.tick = int24(vm.parseJsonInt(j, ".tick"));
    }

    function _newest() internal view returns (Fixture memory) {
        return _load(_blocks()[2]);
    }

    function _knownByBlockhash(Fixture memory f) internal {
        vm.roll(f.number + 10);
        vm.setBlockhash(f.number, f.blockHash);
    }

    function _flip(bytes memory data, uint256 i) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        out[i] = out[i] ^ 0x01;
    }

    function _flipNode(bytes[] memory proof, uint256 i) internal pure returns (bytes[] memory) {
        return _flipNode(proof, i, proof[i].length / 2);
    }

    function _flipNode(bytes[] memory proof, uint256 i, uint256 at) internal pure returns (bytes[] memory out) {
        out = new bytes[](proof.length);
        for (uint256 k; k < proof.length; k++) {
            out[k] = proof[k];
        }
        out[i] = _flip(proof[i], at);
    }

    function _replaceWord(bytes memory data, bytes32 find, bytes32 repl) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        for (uint256 i; i + 32 <= out.length; i++) {
            bytes32 w;
            assembly ("memory-safe") {
                w := mload(add(add(out, 32), i))
            }
            if (w == find) {
                assembly ("memory-safe") {
                    mstore(add(add(out, 32), i), repl)
                }
                return out;
            }
        }
        revert("word not found");
    }

    function _chain(Fixture memory f) internal pure returns (bytes[] memory hs) {
        hs = new bytes[](3);
        (hs[0], hs[1], hs[2]) = (f.header, f.ancestors[0], f.ancestors[1]);
    }

    function test_decodeHeaderFields() public view {
        uint256[3] memory bs = _blocks();
        for (uint256 i; i < 3; i++) {
            Fixture memory f = _load(bs[i]);
            assertEq(keccak256(f.header), f.blockHash, "fixture header hash");
            PoolStateProof.Header memory d = h.decodeHeader(f.header);
            assertEq(d.number, f.number, "number");
            assertEq(d.timestamp, f.timestamp, "timestamp");
            assertEq(d.stateRoot, f.stateRoot, "stateRoot");
            assertEq(d.parentHash, f.parentHash, "parentHash");
            assertEq(keccak256(f.ancestors[0]), f.parentHash, "ancestor links to parentHash");
            assertEq(h.decodeHeader(f.ancestors[1]).number, f.number - 2, "ancestor number");
        }
    }

    function test_decodeHeaderRejectsMalformed() public {
        vm.expectRevert(PoolStateProof.BadHeader.selector);
        h.decodeHeader(hex"c0");
        vm.expectRevert(PoolStateProof.BadHeader.selector);
        h.decodeHeader(hex"cc010101010101010101010101");
        vm.expectRevert(UnexpectedString.selector);
        h.decodeHeader(hex"8180");
    }

    function test_slot0AtMatchesStateView() public {
        uint256[3] memory bs = _blocks();
        uint256 distinct;
        for (uint256 i; i < 3; i++) {
            Fixture memory f = _load(bs[i]);
            (uint160 sqrtP, int24 tick) = h.slot0At(f.stateRoot, DEEP_POOL, f.accountProof, f.slotProof);
            assertEq(sqrtP, f.sqrtPriceX96, "sqrtPriceX96");
            assertEq(tick, f.tick, "tick");

            _knownByBlockhash(f);
            (uint256 n, uint160 vSqrtP, int24 vTick) = h.verify(f.header, DEEP_POOL, f.accountProof, f.slotProof);
            assertEq(n, f.number, "verified number");
            assertEq(vSqrtP, f.sqrtPriceX96, "verified sqrtPriceX96");
            assertEq(vTick, f.tick, "verified tick");

            if (i > 0 && f.sqrtPriceX96 != _load(bs[i - 1]).sqrtPriceX96) distinct++;
        }
        assertGe(distinct, 1, "fixtures must cover a slot0 change");
    }

    function test_rejectsTamperedHeader() public {
        Fixture memory f = _newest();
        Fixture memory older = _load(_blocks()[0]);
        _knownByBlockhash(f);

        // Block N's header carrying block M's state root, with M's valid proofs
        bytes memory forged = _replaceWord(f.header, f.stateRoot, older.stateRoot);
        assertEq(h.decodeHeader(forged).stateRoot, older.stateRoot);
        h.slot0At(older.stateRoot, DEEP_POOL, older.accountProof, older.slotProof);
        vm.expectRevert(PoolStateProof.BadHeader.selector);
        h.verify(forged, DEEP_POOL, older.accountProof, older.slotProof);

        vm.expectRevert(PoolStateProof.BadHeader.selector);
        h.verify(_flip(f.header, f.header.length - 1), DEEP_POOL, f.accountProof, f.slotProof);
    }

    function test_rejectsTamperedAccountNode() public {
        Fixture memory f = _newest();
        uint256 last = f.accountProof.length - 1;

        vm.expectRevert(PoolStateProof.BadAccountProof.selector);
        h.slot0At(f.stateRoot, DEEP_POOL, _flipNode(f.accountProof, 0), f.slotProof);

        vm.expectRevert(bytes("MerkleTrie: invalid large internal hash"));
        h.slot0At(f.stateRoot, DEEP_POOL, _flipNode(f.accountProof, 1), f.slotProof);

        vm.expectRevert(bytes("MerkleTrie: invalid large internal hash"));
        h.slot0At(f.stateRoot, DEEP_POOL, _flipNode(f.accountProof, last), f.slotProof);

        vm.expectRevert(PoolStateProof.BadAccountProof.selector);
        h.slot0At(f.stateRoot, DEEP_POOL, new bytes[](0), f.slotProof);

        Fixture memory older = _load(_blocks()[0]);
        vm.expectRevert(PoolStateProof.BadAccountProof.selector);
        h.slot0At(f.stateRoot, DEEP_POOL, older.accountProof, f.slotProof);
    }

    function test_rejectsTamperedStorageNode() public {
        Fixture memory f = _newest();
        uint256 last = f.slotProof.length - 1;

        vm.expectRevert(PoolStateProof.BadStorageProof.selector);
        h.slot0At(f.stateRoot, DEEP_POOL, f.accountProof, _flipNode(f.slotProof, 0));

        vm.expectRevert(bytes("MerkleTrie: invalid large internal hash"));
        h.slot0At(f.stateRoot, DEEP_POOL, f.accountProof, _flipNode(f.slotProof, 1));

        // A forged sqrtPriceX96 in the leaf that holds the slot0 word
        vm.expectRevert(bytes("MerkleTrie: invalid large internal hash"));
        h.slot0At(f.stateRoot, DEEP_POOL, f.accountProof, _flipNode(f.slotProof, last, f.slotProof[last].length - 2));

        vm.expectRevert(PoolStateProof.BadStorageProof.selector);
        h.slot0At(f.stateRoot, DEEP_POOL, f.accountProof, new bytes[](0));

        Fixture memory older = _load(_blocks()[0]);
        vm.expectRevert(PoolStateProof.BadStorageProof.selector);
        h.slot0At(f.stateRoot, DEEP_POOL, f.accountProof, older.slotProof);
    }

    function test_rejectsWrongPoolId() public {
        Fixture memory f = _newest();
        vm.expectRevert(bytes("MerkleTrie: invalid large internal hash"));
        h.slot0At(f.stateRoot, keccak256("not the deep pool"), f.accountProof, f.slotProof);

        vm.expectRevert(bytes("MerkleTrie: invalid large internal hash"));
        h.slot0At(f.stateRoot, bytes32(uint256(DEEP_POOL) ^ 1), f.accountProof, f.slotProof);
    }

    function test_blockHashWindows() public {
        Fixture memory f = _newest();
        uint256 n = f.number;

        _knownByBlockhash(f);
        assertEq(h.blockHashOf(n), f.blockHash, "BLOCKHASH window");
        assertEq(h.blockHashOf(block.number), bytes32(0), "current block");
        assertEq(h.blockHashOf(block.number + 1), bytes32(0), "future block");
        vm.roll(n + 256);
        assertEq(h.blockHashOf(n), f.blockHash, "BLOCKHASH edge");

        vm.roll(n + 300);
        assertEq(h.blockHashOf(n), bytes32(0), "no history contract");
        vm.etch(HISTORY, HISTORY_CODE);
        assertEq(h.blockHashOf(n), bytes32(0), "empty history slot");
        vm.store(HISTORY, bytes32(n % 8191), f.blockHash);
        assertEq(h.blockHashOf(n), f.blockHash, "EIP-2935 window");
        (, uint160 sqrtP,) = h.verify(f.header, DEEP_POOL, f.accountProof, f.slotProof);
        assertEq(sqrtP, f.sqrtPriceX96, "proof through EIP-2935");

        vm.roll(n + 8191);
        assertEq(h.blockHashOf(n), f.blockHash, "EIP-2935 edge");

        vm.roll(n + 8192);
        assertEq(h.blockHashOf(n), bytes32(0), "past EIP-2935");

        vm.roll(n + 9000);
        assertEq(h.blockHashOf(n), bytes32(0), "unknown");
        vm.expectRevert(abi.encodeWithSelector(BlockHashes.UnknownBlockHash.selector, n));
        h.verify(f.header, DEEP_POOL, f.accountProof, f.slotProof);
    }

    function test_checkpointHeadersWalksBack() public {
        Fixture memory f = _newest();
        uint256 n = f.number;
        bytes[] memory hs = _chain(f);

        _knownByBlockhash(f);
        vm.expectEmit(address(h));
        emit HeadersCheckpointed(n - 2, n);
        h.checkpointHeaders(hs);

        vm.roll(n + 9000);
        assertEq(h.blockHashOf(n), f.blockHash, "newest stored");
        assertEq(h.blockHashOf(n - 1), keccak256(hs[1]), "parent stored");
        assertEq(h.blockHashOf(n - 2), keccak256(hs[2]), "grandparent stored");
        (, uint160 sqrtP, int24 tick) = h.verify(f.header, DEEP_POOL, f.accountProof, f.slotProof);
        assertEq(sqrtP, f.sqrtPriceX96, "proof through checkpoint");
        assertEq(tick, f.tick);
    }

    function test_checkpointHeadersContinuesFromCheckpoint() public {
        Fixture memory f = _newest();
        uint256 n = f.number;
        bytes[] memory hs = _chain(f);

        _knownByBlockhash(f);
        bytes[] memory first = new bytes[](2);
        (first[0], first[1]) = (hs[0], hs[1]);
        h.checkpointHeaders(first);

        vm.roll(n + 9000);
        assertEq(h.blockHashOf(n - 2), bytes32(0));
        bytes[] memory second = new bytes[](2);
        (second[0], second[1]) = (hs[1], hs[2]);
        vm.expectEmit(address(h));
        emit HeadersCheckpointed(n - 2, n - 1);
        h.checkpointHeaders(second);
        assertEq(h.blockHashOf(n - 2), keccak256(hs[2]));
    }

    function test_checkpointHeadersRejects() public {
        Fixture memory f = _newest();
        uint256 n = f.number;
        bytes[] memory hs = _chain(f);

        vm.roll(n + 9000);
        vm.expectRevert(abi.encodeWithSelector(BlockHashes.UnknownBlockHash.selector, n));
        h.checkpointHeaders(hs);

        vm.roll(n + 10);
        vm.setBlockhash(n, keccak256("another chain"));
        vm.expectRevert(PoolStateProof.BadHeader.selector);
        h.checkpointHeaders(hs);

        vm.setBlockhash(n, f.blockHash);
        bytes[] memory tampered = _chain(f);
        tampered[1] = _flip(hs[1], hs[1].length - 1);
        vm.expectRevert(PoolStateProof.BadHeader.selector);
        h.checkpointHeaders(tampered);

        bytes[] memory skipped = new bytes[](2);
        (skipped[0], skipped[1]) = (hs[0], hs[2]);
        vm.expectRevert(PoolStateProof.BadHeader.selector);
        h.checkpointHeaders(skipped);

        vm.expectRevert(PoolStateProof.BadHeader.selector);
        h.checkpointHeaders(new bytes[](0));

        vm.roll(n + 9000);
        assertEq(h.blockHashOf(n - 1), bytes32(0), "nothing stored on failure");
    }

    function test_gas() public {
        Fixture memory f = _newest();
        _knownByBlockhash(f);

        h.decodeHeader(f.header);
        uint256 headerGas = vm.lastFrameGas().gasTotalUsed;
        h.slot0At(f.stateRoot, DEEP_POOL, f.accountProof, f.slotProof);
        uint256 proofsGas = vm.lastFrameGas().gasTotalUsed;
        h.verify(f.header, DEEP_POOL, f.accountProof, f.slotProof);
        uint256 verifyGas = vm.lastFrameGas().gasTotalUsed;

        bytes memory cd = abi.encodeCall(ProofHarness.verify, (f.header, DEEP_POOL, f.accountProof, f.slotProof));
        uint256 calldataGas;
        for (uint256 i; i < cd.length; i++) {
            calldataGas += cd[i] == 0 ? 4 : 16;
        }

        h.slot0AtTimes(f.stateRoot, f.accountProof, f.slotProof, 16);
        uint256 batchGas = vm.lastFrameGas().gasTotalUsed;

        h.checkpointHeaders(_chain(f));
        uint256 checkpointGas = vm.lastFrameGas().gasTotalUsed;

        console.log("decodeHeader gas", headerGas);
        console.log("slot0At gas (account + storage proof)", proofsGas);
        console.log("verify gas (header + hash check + proofs)", verifyGas);
        console.log("verify calldata bytes", cd.length);
        console.log("verify calldata gas", calldataGas);
        console.log("slot0At gas per proof in a batch of 16", batchGas / 16);
        console.log("checkpointHeaders gas for 3 headers", checkpointGas);
        assertLt(verifyGas, 600_000, "verify gas regression");
        assertLt(batchGas / 16, proofsGas * 105 / 100, "batched proofs stay linear");
    }

    function test_proofsReleaseTheirMemory() public view {
        Fixture memory f = _newest();
        (uint256 headerBytes, uint256 proofBytes) = h.memoryGrowth(f.header, f.accountProof, f.slotProof);
        assertEq(headerBytes, 128, "decodeHeader keeps only the Header struct");
        assertEq(proofBytes, 0, "slot0At keeps nothing");
    }
}
