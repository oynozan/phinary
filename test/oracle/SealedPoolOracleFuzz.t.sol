// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IUnderlyingOracle} from "../../src/interfaces/IUnderlyingOracle.sol";
import {ISealedPoolOracle} from "../../src/interfaces/ISealedPoolOracle.sol";
import {SealedTestBase} from "./SealedPoolOracle.t.sol";
import {TickAccumulatorHarness} from "./TickAccumulatorDiff.t.sol";

/// @notice Random blocks of poke, swap, push-restore, donate, liquidity and harness-proof events, then a roll of one or
///         more blocks. Every view is checked against a brute-force reference built from the pool's end-of-block
///         states, recorded as each block ends.
abstract contract SealedPoolOracleFuzzTest is SealedTestBase {
    uint256 internal constant BLOCKS = 40;

    uint256 internal deployBlock;
    uint256 internal lastFrontier;
    // prefix[n] is the sum of E_j * blockTime over deployBlock <= j < n
    mapping(uint256 => int256) internal prefix;

    int24 internal posLo;
    int24 internal posHi;
    int128 internal posL;

    uint256 internal nSealed;
    uint256 internal nQueued;
    uint256 internal nDrained;
    uint256 internal nFreshBySeal;
    uint256 internal nExtended;
    uint256 internal nStaleWithin;
    uint256 internal nStaleRevert;

    function setUp() public {
        cfg = _exactParams(5, 12, 400, 4096);
        _setUpSealed();
        deployBlock = vm.getBlockNumber();
    }

    function _recordEnd(uint256 n) internal override {
        super._recordEnd(n);
        prefix[n + 1] = prefix[n] + _endNorm(n) * int256(uint256(bt));
    }

    function testFuzz_matchesEndOfBlockHistory(uint256 seed) public {
        _run(seed);
    }

    function test_matchesEndOfBlockHistoryFixedSeeds() public {
        for (uint256 s = 1; s <= 6; s++) {
            _run(s);
        }
        emit log_named_uint("runs applied by pokes", nSealed);
        emit log_named_uint("runs queued", nQueued);
        emit log_named_uint("proofs that drained the queue", nDrained);
        emit log_named_uint("sealed-view spots", nFreshBySeal);
        emit log_named_uint("sealed-view cumulatives", nExtended);
        emit log_named_uint("stale E_K spots", nStaleWithin);
        emit log_named_uint("StaleSpot reverts", nStaleRevert);
        assertGt(nSealed, 0, "runs applied by pokes");
        assertGt(nQueued, 0, "runs queued behind a gap");
        assertGt(nDrained, 0, "queues drained by proofs");
        assertGt(nFreshBySeal, 0, "sealed-view spot");
        assertGt(nExtended, 0, "sealed-view cumulative");
        assertGt(nStaleWithin, 0, "stale E_K spot");
        assertGt(nStaleRevert, 0, "stale spot reverts");
    }

    function _run(uint256 seed) internal {
        for (uint256 i; i < BLOCKS; i++) {
            uint256 r = _rand(seed, i);
            uint256 events = 1 + r % 4;
            for (uint256 e; e < events; e++) {
                uint256 x = _rand(r, e);
                _act(x);
                _check(x >> 128);
            }
            _roll((r >> 8) % 10 < 7 ? 1 : 1 + (r >> 16) % (uint256(maxStale) + 6));
        }
        _roll(1);
        _proveToHead();
        _checkFull();
    }

    /* Actions */

    function _act(uint256 r) internal {
        uint256 a = r % 16;
        r >>= 8;
        if (a < 6) {
            _poke();
        } else if (a < 8) {
            _swapTicks(int256(r % 121) - 60);
        } else if (a == 8) {
            (uint160 sp,) = _slot0();
            _swapTicks(int256(r % 81) - 40);
            _swapToSqrtPrice(pk, sp);
        } else if (a == 9) {
            if (r % 2 == 0) donateRouter.donate(pk, 1, 0, ZERO_BYTES);
            else donateRouter.donate(pk, 0, 1000, ZERO_BYTES);
        } else if (a == 10) {
            _toggleLiquidity(r);
        } else {
            _prove(r);
        }
    }

    function _poke() internal {
        uint256 k0 = oracle.frontier();
        uint256 q0 = oracle.queueLength();
        if (!oracle.poke()) return;
        if (oracle.queueLength() > q0) nQueued++;
        else if (oracle.frontier() > k0) nSealed++;
    }

    function _prove(uint256 r) internal {
        uint256 n = vm.getBlockNumber();
        uint256 k = oracle.frontier();
        if (k == 0) {
            if (n == deployBlock) return;
            uint256 target = deployBlock + r % (n - deployBlock);
            oracle.applyProven(target, endSp[target], endRaw[target]);
            return;
        }
        uint256 count = 1 + r % 4;
        for (uint256 c; c < count && k + 1 < n; c++) {
            uint256 q0 = oracle.queueLength();
            oracle.applyProven(k + 1, endSp[k + 1], endRaw[k + 1]);
            if (oracle.queueLength() < q0) nDrained++;
            k = oracle.frontier();
        }
    }

    function _proveToHead() internal {
        uint256 n = vm.getBlockNumber();
        uint256 k = oracle.frontier();
        if (k == 0) {
            oracle.applyProven(deployBlock, endSp[deployBlock], endRaw[deployBlock]);
            k = deployBlock;
        }
        while (k + 1 < n) {
            oracle.applyProven(k + 1, endSp[k + 1], endRaw[k + 1]);
            k = oracle.frontier();
        }
        assertEq(oracle.queueLength(), 0, "every queued run drained");
    }

    // Liquidity changes never move the price, so a seal across them stays sound
    function _toggleLiquidity(uint256 r) internal {
        if (posL == 0) {
            (, int24 raw) = _slot0();
            int24 w = int24(int256(1 + r % 20)) * SPACING;
            int24 c = raw / SPACING * SPACING;
            (posLo, posHi, posL) = (c - w, c + w, int128(int256(1e15 + (r >> 8) % 1e17)));
            modifyLiquidityRouter.modifyLiquidity(pk, ModifyLiquidityParams(posLo, posHi, posL, 0), ZERO_BYTES);
        } else {
            modifyLiquidityRouter.modifyLiquidity(pk, ModifyLiquidityParams(posLo, posHi, -posL, 0), ZERO_BYTES);
            posL = 0;
        }
    }

    /* Checks */

    function _check(uint256 r) internal {
        uint256 n = vm.getBlockNumber();
        uint256 k = oracle.frontier();
        assertGe(k, lastFrontier, "frontier never decreases");
        lastFrontier = k;
        assertLe(oracle.queueLength(), 256);
        if (k == 0) return;
        assertLt(k, n, "the frontier is a finished block");

        uint256 s = _startBlock();
        uint32 t0 = _t(s);
        uint32 tK = _t(k + 1);
        assertEq(oracle.cumulativeAt(tK), _ref(s, tK), "cumulative at time(K + 1)");
        uint32 tr = t0 + uint32(r % (tK - t0 + 1));
        assertEq(oracle.cumulativeAt(tr), _ref(s, tr), "cumulative at a random time");
        _checkSpot(k, n);
        _checkExtension(s, k, n);
    }

    function _checkSpot(uint256 k, uint256 n) internal {
        (bool sealedView,) = _sealedNow(n);
        bool fresh = k + 1 == n || sealedView;
        try oracle.sobTick() returns (int24 tick, uint32 w) {
            uint256 src = fresh ? n - 1 : k;
            assertEq(tick, _endNorm(src), "SoB is E_(n-1), or E_K within the limit");
            assertTrue(fresh || k + 1 + maxStale >= n, "stale beyond the limit");
            assertEq(w, _t(k + 1));
            assertApproxEqAbs(oracle.lnSpotSoBWad(), _lnUsd(endSp[src]), LN_TOL);
            if (k + 1 != n) {
                if (sealedView) nFreshBySeal++;
                else nStaleWithin++;
            }
        } catch (bytes memory err) {
            assertFalse(fresh, "fresh SoB must answer");
            assertLt(k + 1 + maxStale, n, "within the limit must answer");
            assertEq(err, abi.encodeWithSelector(ISealedPoolOracle.StaleSpot.selector, k, n));
            nStaleRevert++;
        }
    }

    function _checkExtension(uint256 s, uint256 k, uint256 n) internal {
        if (k + 1 == n) return;
        uint32 tn = _t(n);
        (bool sealedView, uint256 snapBlock) = _sealedNow(n);
        if (sealedView && snapBlock <= k + 1) {
            assertEq(oracle.cumulativeAt(tn), _ref(s, tn), "sealed extension equals the true history");
            nExtended++;
        } else {
            vm.expectRevert(abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, tn));
            oracle.cumulativeAt(tn);
        }
    }

    function _checkFull() internal {
        uint256 k = oracle.frontier();
        uint256 s = _startBlock();
        uint32 tK = _t(k + 1);
        for (uint32 t = _t(s); t <= tK; t++) {
            assertEq(oracle.cumulativeAt(t), _ref(s, t), "cumulative over the whole history");
        }

        TickAccumulatorHarness acc = new TickAccumulatorHarness(cfg);
        acc.init(_t(s));
        for (uint256 j = s; j <= k; j++) {
            acc.accrue(_t(j + 1), _endNorm(j));
        }
        uint32 now_ = _now() < tK ? _now() : tK;
        (uint256 v, bool w) = oracle.varianceE36();
        (uint256 rv, bool rw) = acc.variance(now_);
        assertEq(v, rv, "variance equals one accrual per end-of-block state");
        assertEq(w, rw);
    }

    /* Reference */

    function _startBlock() internal view returns (uint256) {
        return oracle.anchorBlock() + (oracle.oldestObservationTime() - oracle.anchorTimestamp()) / bt;
    }

    /// @dev Sum of E_j over (time(s), t], each E_j prevailing over (time(j), time(j + 1)]
    function _ref(uint256 s, uint32 t) internal view returns (int256 c) {
        uint256 dt = t - _t(s);
        uint256 m = s + dt / bt;
        c = prefix[m] - prefix[s];
        uint256 rem = dt % bt;
        if (rem > 0) c += _endNorm(m) * int256(rem);
    }

    function _sealedNow(uint256 n) internal view returns (bool sealedView, uint256 snapBlock) {
        (uint64 b, uint160 ssp, uint256 s0, uint256 s1, uint128 sl) = oracle.snapshot();
        (uint160 sp,) = _slot0();
        (uint256 g0, uint256 g1) = _fg();
        snapBlock = b;
        sealedView = b < n && sl > 0 && sp == ssp && g0 == s0 && g1 == s1;
    }
}

contract SealedPoolOracleFuzzEth0Test is SealedPoolOracleFuzzTest {
    function usdcIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

contract SealedPoolOracleFuzzUsdc0TwoSecondTest is SealedPoolOracleFuzzTest {
    constructor() {
        bt = 2;
    }

    function usdcIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}
