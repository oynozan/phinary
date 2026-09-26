// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {ISealedPoolOracle} from "../interfaces/ISealedPoolOracle.sol";
import {BlockHashes} from "./BlockHashes.sol";
import {PoolStateProof} from "./PoolStateProof.sol";
import {TickAccumulator} from "./TickAccumulator.sol";

/// @title SealedPoolOracle
/// @notice Start-of-block oracle for a hookless v4 pool with no external oracle. It keeps a gap-free history of
///         end-of-block pool states E_j, each proven by a fee-growth seal between two pokes or by a state proof
///         against the chain's own block hash, so no value it returns can be moved by swaps earlier in the block.
/// @dev Applying E_j credits its normalised tick over (time(j), time(j + 1)], so the start-of-block tick of block j + 1
///      is E_j, as in UnderlyingOracleHook. The frontier K is the last applied block and every E_j with j <= K is
///      applied. A poke in block b whose (sqrtPriceX96, tick, feeGrowthGlobal0, feeGrowthGlobal1) equals the snapshot
///      of an earlier poke in block a proves E_a..E_{b-1} when the snapshot had liquidity and a price strictly inside
///      a tick, because with L > 0 and lpFee > 0 every price-moving swap step charges at least 1 wei of LP fee and
///      raises fee growth. On an exact tick price the first step can cross that tick for free into an empty range, so
///      such a snapshot never seals. Precondition, the seal is sound only while the pool's in-range liquidity never
///      reaches zero and is not controlled by one party. A sole in-range LP can remove it, move the price for free and
///      restore both, liquidity added and removed around a poke inside one unlock fakes the snapshot's L, and no pool
///      state reveals either. Deploy only on a deep pool with many independent LPs. A run that starts past K + 1
///      waits in a FIFO ring of 256 runs and is applied once proofs make it contiguous. Block times are
///      anchorTimestamp + (n - anchorBlock) * blockTime, and pokes and proofs that disagree with the chain revert, so a
///      change of the chain's block time halts the oracle for good.
contract SealedPoolOracle is TickAccumulator, BlockHashes, ISealedPoolOracle {
    using LPFeeLibrary for uint24;

    int256 internal constant LN10_WAD = 2302585092994045684;
    /// (18 ln10 - 96 ln2) * 1e18, so ln(sqrtPriceX96 / 2^96) = lnWad(sqrtPriceX96) + LN_WAD_TO_Q96
    int256 internal constant LN_WAD_TO_Q96 = -25095597659861927392;
    uint256 internal constant QUEUE_SIZE = 256;

    error BlockTimeOutOfRange(uint256 n);

    /// @dev Live or snapshotted pool state, tick raw
    struct Snapshot {
        uint160 sqrtPriceX96;
        int24 tick;
        uint64 blockNumber;
        uint256 feeGrowth0;
        uint256 feeGrowth1;
        uint128 liquidity;
    }

    /// @dev E_K and K
    struct Frontier {
        uint160 sqrtPriceX96;
        int24 normTick;
        uint64 number;
        bool started;
    }

    /// @dev E_j for every j in [fromBlock, toBlock], proven by a seal
    struct Run {
        uint64 fromBlock;
        uint64 toBlock;
        int24 normTick;
        uint160 sqrtPriceX96;
    }

    IPoolManager public immutable poolManager;
    PoolId public immutable poolId;
    int8 public immutable sign;
    int16 public immutable decimalsShift;
    uint32 public immutable blockTime;
    uint16 public immutable maxStaleBlocks;
    uint256 public immutable anchorBlock;
    uint256 public immutable anchorTimestamp;
    bytes32 internal immutable _stateSlot;

    Snapshot internal _snap;
    Frontier internal _front;
    uint16 internal _qHead;
    uint16 internal _qLen;
    Run[256] internal _queue;

    /// @param sign_ +1 when the ETH side is currency0, -1 when USDC is
    /// @param decimalsShift_ human USD per ETH = 1.0001^normTick * 10^decimalsShift
    /// @param blockTime_ seconds per block, constant on OP Stack chains
    /// @param maxStaleBlocks_ how many blocks the start-of-block spot may lag behind the previous block
    constructor(
        IPoolManager pm,
        PoolKey memory key,
        int8 sign_,
        int16 decimalsShift_,
        uint32 blockTime_,
        uint16 maxStaleBlocks_,
        uint32 h_,
        uint16 nWindows_,
        uint16 minWindows_,
        uint32 winsorTicks_,
        uint256 varMinE36_,
        uint256 varMaxE36_,
        uint256 fallbackVarE36_,
        uint16 cardinality_
    ) TickAccumulator(h_, nWindows_, minWindows_, winsorTicks_, varMinE36_, varMaxE36_, fallbackVarE36_, cardinality_) {
        if (address(key.hooks) != address(0) || key.fee.isDynamicFee() || key.fee == 0) revert InvalidPool();
        if ((sign_ != 1 && sign_ != -1) || blockTime_ == 0) revert InvalidParams();
        poolManager = pm;
        PoolId id = key.toId();
        poolId = id;
        _stateSlot = keccak256(abi.encodePacked(PoolId.unwrap(id), StateLibrary.POOLS_SLOT));
        sign = sign_;
        decimalsShift = decimalsShift_;
        blockTime = blockTime_;
        maxStaleBlocks = maxStaleBlocks_;
        anchorBlock = block.number;
        anchorTimestamp = block.timestamp;
    }

    /* Seal */

    /// @inheritdoc ISealedPoolOracle
    function poke() external returns (bool sealedRun) {
        uint256 b = block.number;
        Snapshot memory s = _snap;
        if (s.blockNumber == b) return false;
        uint32 tb = blockTimeOf(b);
        if (block.timestamp != tb) revert BadTimestamp(tb, block.timestamp);
        Snapshot memory live = _live();
        if (_sealed(s, live)) {
            sealedRun = true;
            _applyRun(s.blockNumber, b - 1, s.sqrtPriceX96, _norm(s.tick));
        }
        _snap = live;
    }

    /* Proofs */

    /// @inheritdoc ISealedPoolOracle
    function prove(BlockProof calldata p) external {
        _prove(p, false);
    }

    /// @inheritdoc ISealedPoolOracle
    /// @dev Skips proofs of blocks the frontier already covers, so a drain mid-batch does not revert the batch
    function proveMany(BlockProof[] calldata ps) external {
        for (uint256 i; i < ps.length; ++i) {
            _prove(ps[i], true);
        }
    }

    /* IUnderlyingOracle */

    function lnSpotSoBWad() external view returns (int256) {
        (uint160 sp,) = _sob();
        int256 lnRaw = 2 * (F.lnWad(int256(uint256(sp))) + LN_WAD_TO_Q96);
        return int256(sign) * lnRaw + int256(decimalsShift) * LN10_WAD;
    }

    function sobTick() external view returns (int24 normTick, uint32 lastWriteTime) {
        (, normTick) = _sob();
        lastWriteTime = _lastTime();
    }

    /// @dev Past time(K + 1) only while the sealed view proves the snapshot has held since block K + 1
    function cumulativeAt(uint32 t) external view returns (int56) {
        Frontier memory f = _started();
        uint32 last = _lastTime();
        if (t <= last) return _cumulativeAt(t);
        (bool ok, Snapshot memory s) = _sealedView();
        if (ok && s.blockNumber <= uint256(f.number) + 1) {
            uint256 end = blockTimeOf(block.number);
            if (end > block.timestamp) end = block.timestamp;
            if (t <= end) {
                return int56(int256(_cumulativeAt(last)) + int256(_norm(s.tick)) * int256(uint256(t - last)));
            }
        }
        revert ObservationUnavailable(t);
    }

    function varianceE36() external view returns (uint256 varPerSecE36, bool warm) {
        _started();
        uint32 last = _lastTime();
        return _variance(block.timestamp < last ? uint32(block.timestamp) : last);
    }

    function oldestObservationTime() external view returns (uint32) {
        _started();
        return _oldestTime();
    }

    /* Bot views */

    function frontier() external view returns (uint256) {
        return _front.number;
    }

    function snapshot()
        external
        view
        returns (uint64 blockNumber, uint160 sqrtPriceX96, uint256 fg0, uint256 fg1, uint128 liquidity)
    {
        Snapshot memory s = _snap;
        return (s.blockNumber, s.sqrtPriceX96, s.feeGrowth0, s.feeGrowth1, s.liquidity);
    }

    function queueLength() external view returns (uint256) {
        return _qLen;
    }

    function blockTimeOf(uint256 n) public view returns (uint32) {
        uint256 a = anchorBlock;
        uint256 t = anchorTimestamp;
        if (n >= a) {
            if (n - a > type(uint32).max) revert BlockTimeOutOfRange(n);
            t += (n - a) * blockTime;
        } else {
            uint256 back = (a - n) * blockTime;
            if (back > t) revert BlockTimeOutOfRange(n);
            t -= back;
        }
        if (t > type(uint32).max) revert BlockTimeOutOfRange(n);
        return uint32(t);
    }

    /* Internals */

    function _prove(BlockProof calldata p, bool skipCovered) internal {
        PoolStateProof.Header memory h = PoolStateProof.decodeHeader(p.header);
        uint256 n = h.number;
        Frontier memory f = _front;
        if (skipCovered && f.started && n <= f.number) return;
        _requireNext(f, n);
        bytes32 known = blockHashOf(n);
        if (known == 0) revert UnknownBlockHash(n);
        if (keccak256(p.header) != known) revert PoolStateProof.BadHeader();
        uint32 t = blockTimeOf(n);
        if (h.timestamp != t) revert BadTimestamp(t, h.timestamp);
        (uint160 sp, int24 tick) = PoolStateProof.slot0At(
            h.stateRoot, address(poolManager), PoolId.unwrap(poolId), p.accountProof, p.slotProof
        );
        _applyProven(n, sp, tick);
    }

    /// @dev Applies a verified E_n, n must be K + 1 or, before start, no older than 256 blocks before the anchor
    function _applyProven(uint256 n, uint160 sqrtPriceX96, int24 rawTick) internal {
        Frontier memory f = _front;
        _requireNext(f, n);
        int24 k = _norm(rawTick);
        if (!f.started) _init(blockTimeOf(n));
        _accrue(blockTimeOf(n + 1), k);
        _front = Frontier(sqrtPriceX96, k, uint64(n), true);
        emit Proven(n, k);
        _drain();
    }

    function _requireNext(Frontier memory f, uint256 n) internal view {
        if (f.started) {
            if (n != uint256(f.number) + 1) revert NotNextBlock(uint256(f.number) + 1, n);
        } else {
            uint256 lo = anchorBlock > 256 ? anchorBlock - 256 : 0;
            if (n < lo) revert NotNextBlock(lo, n);
        }
    }

    /// @dev Applies a sealed run that reaches the frontier, the first one starts the history, others are queued
    function _applyRun(uint256 from, uint256 to, uint160 sqrtPriceX96, int24 k) internal {
        Frontier memory f = _front;
        if (f.started && from > uint256(f.number) + 1) {
            _enqueue(Run(uint64(from), uint64(to), k, sqrtPriceX96));
            emit Queued(from, to);
            return;
        }
        if (!f.started) _init(blockTimeOf(from));
        if (!f.started || to > f.number) {
            _accrue(blockTimeOf(to + 1), k);
            _front = Frontier(sqrtPriceX96, k, uint64(to), true);
        }
        emit Sealed(from, to, k);
    }

    function _enqueue(Run memory r) internal {
        uint256 head = _qHead;
        uint256 len = _qLen;
        if (len == QUEUE_SIZE) {
            _queue[head] = r;
            _qHead = uint16((head + 1) % QUEUE_SIZE);
        } else {
            _queue[(head + len) % QUEUE_SIZE] = r;
            _qLen = uint16(len + 1);
        }
    }

    /// @dev Runs are queued in block order, so the contiguous ones are a prefix of the ring
    function _drain() internal {
        uint256 len = _qLen;
        if (len == 0) return;
        uint256 head = _qHead;
        Frontier memory f = _front;
        bool moved;
        while (len != 0) {
            Run memory r = _queue[head];
            if (r.fromBlock > uint256(f.number) + 1) break;
            if (r.toBlock > f.number) {
                _accrue(blockTimeOf(uint256(r.toBlock) + 1), r.normTick);
                f = Frontier(r.sqrtPriceX96, r.normTick, r.toBlock, true);
                moved = true;
            }
            emit Sealed(r.fromBlock, r.toBlock, r.normTick);
            head = (head + 1) % QUEUE_SIZE;
            --len;
        }
        if (moved) _front = f;
        (_qHead, _qLen) = (uint16(head), uint16(len));
    }

    /// @dev SoB from E_K at K = n - 1, then a queued run ending at n - 1, the sealed view, then E_K within the limit
    function _sob() internal view returns (uint160 sqrtPriceX96, int24 normTick) {
        Frontier memory f = _started();
        uint256 n = block.number;
        if (uint256(f.number) + 1 == n) return (f.sqrtPriceX96, f.normTick);
        uint256 len = _qLen;
        if (len != 0) {
            Run memory tail = _queue[(uint256(_qHead) + len - 1) % QUEUE_SIZE];
            if (uint256(tail.toBlock) + 1 == n) return (tail.sqrtPriceX96, tail.normTick);
        }
        (bool ok, Snapshot memory s) = _sealedView();
        if (ok) return (s.sqrtPriceX96, _norm(s.tick));
        if (uint256(f.number) + 1 + maxStaleBlocks >= n) return (f.sqrtPriceX96, f.normTick);
        revert StaleSpot(f.number, n);
    }

    /// @dev A snapshot from an earlier block that still equals the live state is E_{number-1}
    function _sealedView() internal view returns (bool ok, Snapshot memory s) {
        s = _snap;
        if (s.blockNumber >= block.number || s.liquidity == 0) return (false, s);
        ok = _sealed(s, _live());
    }

    function _sealed(Snapshot memory s, Snapshot memory live) internal pure returns (bool) {
        return s.liquidity != 0 && s.sqrtPriceX96 == live.sqrtPriceX96 && s.tick == live.tick
            && s.feeGrowth0 == live.feeGrowth0 && s.feeGrowth1 == live.feeGrowth1 && !_onTickPrice(s.sqrtPriceX96);
    }

    /// @dev True for an exact tick price, where either tick above or below may be the pool's tick
    function _onTickPrice(uint160 sqrtPriceX96) internal pure returns (bool) {
        if (sqrtPriceX96 < TickMath.MIN_SQRT_PRICE || sqrtPriceX96 >= TickMath.MAX_SQRT_PRICE) return true;
        return TickMath.getSqrtPriceAtTick(TickMath.getTickAtSqrtPrice(sqrtPriceX96)) == sqrtPriceX96;
    }

    /// @dev slot0, both fee-growth words and liquidity in one extsload
    function _live() internal view returns (Snapshot memory) {
        bytes32[] memory w = poolManager.extsload(_stateSlot, 4);
        uint256 w0 = uint256(w[0]);
        return Snapshot({
            sqrtPriceX96: uint160(w0),
            tick: int24(int256(w0 >> 160)),
            blockNumber: uint64(block.number),
            feeGrowth0: uint256(w[1]),
            feeGrowth1: uint256(w[2]),
            liquidity: uint128(uint256(w[3]))
        });
    }

    function _started() internal view returns (Frontier memory f) {
        f = _front;
        if (!f.started) revert NotStarted();
    }

    /// @dev floor(sign * L_raw) from rawTick = floor(L_raw), as UnderlyingOracleHook normalises
    function _norm(int24 rawTick) internal view returns (int24) {
        return sign > 0 ? rawTick : -rawTick - 1;
    }
}
