// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {IUnderlyingOracle} from "../../src/interfaces/IUnderlyingOracle.sol";
import {ISealedPoolOracle} from "../../src/interfaces/ISealedPoolOracle.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
import {PredictionHook} from "../../src/PredictionHook.sol";
import {SealedPoolOracle} from "../../src/oracle/SealedPoolOracle.sol";
import {TickAccumulator} from "../../src/oracle/TickAccumulator.sol";
import {PoolStateProof} from "../../src/oracle/PoolStateProof.sol";
import {BlockHashes} from "../../src/oracle/BlockHashes.sol";
import {OracleTestBase} from "./OracleTestBase.sol";

/// @notice Exposes the proven-state entry point so tests can feed end-of-block states without Merkle proofs
contract SealedPoolOracleHarness is SealedPoolOracle {
    constructor(
        IPoolManager pm,
        PoolKey memory key,
        int8 sign_,
        int16 shift,
        uint32 blockTime_,
        uint16 maxStale,
        OracleTestBase.HookParams memory p
    )
        SealedPoolOracle(
            pm,
            key,
            sign_,
            shift,
            blockTime_,
            maxStale,
            p.h,
            p.nWindows,
            p.minWindows,
            p.winsorTicks,
            p.varMin,
            p.varMax,
            p.fallbackVar,
            p.cardinality
        )
    {}

    function applyProven(uint256 n, uint160 sqrtPriceX96, int24 rawTick) external {
        _applyProven(n, sqrtPriceX96, rawTick);
    }
}

/// @notice Local PoolManager with a hookless 5 bp WETH/USDC pool, a SealedPoolOracle harness and a record of every
///         end-of-block pool state, kept by rolling blocks only through _roll
abstract contract SealedTestBase is OracleTestBase {
    using StateLibrary for IPoolManager;

    int16 internal constant SHIFT = 12;
    uint256 internal constant LN_TOL = 100;

    PoolKey internal pk;
    SealedPoolOracleHarness internal oracle;
    HookParams internal cfg;
    uint32 internal bt = 1;
    uint16 internal maxStale = 3;

    mapping(uint256 => uint160) internal endSp;
    mapping(uint256 => int24) internal endRaw;

    function _setUpSealed() internal {
        _setUpEnv();
        weth.approve(address(donateRouter), type(uint256).max);
        usdcToken.approve(address(donateRouter), type(uint256).max);
        pk = _initPool(address(0), 2700e18);
        if (cfg.h == 0) cfg = _defaultParams();
        oracle = _deploy(pk);
    }

    function _deploy(PoolKey memory k) internal returns (SealedPoolOracleHarness) {
        return new SealedPoolOracleHarness(manager, k, int8(sign), SHIFT, bt, maxStale, cfg);
    }

    /// @dev Records the end state of each block left behind, then advances number and time together
    function _roll(uint256 blocks) internal {
        for (uint256 i; i < blocks; i++) {
            _recordEnd(vm.getBlockNumber());
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + bt);
        }
    }

    function _recordEnd(uint256 n) internal virtual {
        (endSp[n], endRaw[n]) = _slot0();
    }

    function _slot0() internal view returns (uint160 sp, int24 raw) {
        (sp, raw,,) = manager.getSlot0(pk.toId());
    }

    function _fg() internal view returns (uint256 g0, uint256 g1) {
        return manager.getFeeGrowthGlobals(pk.toId());
    }

    function _norm(int24 raw) internal view returns (int256) {
        return sign > 0 ? int256(raw) : -int256(raw) - 1;
    }

    function _endNorm(uint256 n) internal view returns (int256) {
        return _norm(endRaw[n]);
    }

    function _t(uint256 n) internal view returns (uint32) {
        return oracle.blockTimeOf(n);
    }

    function _swapTicks(int256 d) internal {
        _swapToNormTick(pk, _normTick(pk) + d);
    }

    /// @dev An idle block sealed between two pokes starts the oracle with frontier b0
    function _start() internal returns (uint256 b0) {
        b0 = vm.getBlockNumber();
        oracle.poke();
        _roll(1);
        assertTrue(oracle.poke(), "idle block seals");
        assertEq(oracle.frontier(), b0, "started at the first snapshot");
    }

    /// @dev Starts the oracle, then breaks the seal so block b0 + 1 is a gap and the snapshot is taken at b0 + 2
    function _startWithGap() internal returns (uint256 b0) {
        b0 = _start();
        _swapTicks(40);
        _roll(1);
        assertFalse(oracle.poke(), "swap after the poke breaks the seal");
    }
}

contract SealedPoolOracleTest is SealedTestBase {
    using StateLibrary for IPoolManager;

    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.BEFORE_DONATE_FLAG
    );

    function usdcIsCurrency0() internal pure override returns (bool) {
        return false;
    }

    function setUp() public {
        _setUpSealed();
    }

    /* Seal */

    function test_idleRunSeals() public {
        uint256 b0 = vm.getBlockNumber();
        int256 k = _normTick(pk);
        assertFalse(oracle.poke(), "the first poke only takes a snapshot");
        _roll(5);

        vm.expectEmit(address(oracle));
        emit ISealedPoolOracle.Sealed(b0, b0 + 4, int24(k));
        assertTrue(oracle.poke());

        assertEq(oracle.frontier(), b0 + 4, "frontier is b - 1");
        assertEq(oracle.oldestObservationTime(), _t(b0), "history starts at the snapshot block");
        assertEq(oracle.cumulativeAt(_t(b0 + 5)), k * 5, "tick * 5");
        assertEq(oracle.cumulativeAt(_t(b0 + 2)), k * 2);
        assertEq(oracle.blockTimeOf(b0 + 5), vm.getBlockTimestamp());
        (uint64 snapBlock,,,,) = oracle.snapshot();
        assertEq(snapBlock, b0 + 5, "snapshot replaced");
    }

    function test_swapBreaksSeal() public {
        oracle.poke();
        _swapTicks(30);
        _roll(3);
        assertFalse(oracle.poke(), "not started");
        assertEq(oracle.frontier(), 0);

        uint256 b0 = _start();
        _roll(1);
        _swapTicks(-30);
        _roll(3);
        assertFalse(oracle.poke());
        assertEq(oracle.frontier(), b0, "frontier holds");
        assertEq(oracle.queueLength(), 0);
    }

    function test_donateBreaksSeal() public {
        uint256 b0 = _start();
        (uint160 sp0,) = _slot0();
        _roll(1);
        donateRouter.donate(pk, 1, 0, ZERO_BYTES);
        (uint160 sp1,) = _slot0();
        assertEq(sp1, sp0, "donate leaves the price");
        _roll(1);
        assertFalse(oracle.poke());
        assertEq(oracle.frontier(), b0);
    }

    function test_pushRestoreSameTxBreaksSeal() public {
        uint256 b0 = _start();
        _roll(1);
        (uint160 sp0,) = _slot0();
        (uint256 f0, uint256 f1) = _fg();
        _swapTicks(200);
        assertTrue(_swapToSqrtPrice(pk, sp0), "restore with the original price as the limit");
        (uint160 sp1,) = _slot0();
        (uint256 g0, uint256 g1) = _fg();
        assertEq(sp1, sp0, "sqrtPriceX96 restored exactly");
        assertTrue(g0 != f0 && g1 != f1, "fee growth moved both ways");
        _roll(1);
        assertFalse(oracle.poke(), "no seal");
        assertEq(oracle.frontier(), b0);
    }

    function test_zeroLiquiditySnapshotNeverSeals() public {
        PoolKey memory k = _key(address(0));
        (k.fee, k.tickSpacing) = (3000, 60);
        manager.initialize(k, _sqrtPriceForUsd(2700e18));
        SealedPoolOracleHarness o = _deploy(k);

        assertFalse(o.poke());
        _roll(3);
        assertFalse(o.poke(), "zero-liquidity snapshot");
        assertEq(o.frontier(), 0);

        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams(TickMath.minUsableTick(60), TickMath.maxUsableTick(60), LIQUIDITY, 0), ZERO_BYTES
        );
        _roll(1);
        assertFalse(o.poke(), "the snapshot still had zero liquidity");
        _roll(1);
        assertTrue(o.poke(), "seals once the snapshot has liquidity");
    }

    function test_onePokePerBlock() public {
        uint256 b0 = vm.getBlockNumber();
        assertFalse(oracle.poke());
        (uint160 sp0,) = _slot0();
        _swapTicks(50);
        vm.recordLogs();
        assertFalse(oracle.poke(), "second poke in the block");
        assertEq(vm.getRecordedLogs().length, 0, "does nothing");
        (, uint160 snapSp,,,) = oracle.snapshot();
        assertEq(snapSp, sp0, "snapshot kept");

        _roll(1);
        assertFalse(oracle.poke(), "the first snapshot predates the swap");
        _roll(1);
        assertTrue(oracle.poke());
        assertFalse(oracle.poke(), "no second seal in the block");
        assertEq(oracle.frontier(), b0 + 1);
    }

    function test_pokeRejectsBadTimestamp() public {
        oracle.poke();
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 2);
        uint256 expected = oracle.blockTimeOf(vm.getBlockNumber());
        vm.expectRevert(
            abi.encodeWithSelector(ISealedPoolOracle.BadTimestamp.selector, expected, vm.getBlockTimestamp())
        );
        oracle.poke();
    }

    /* Queue and proofs */

    function test_gapThenProofDrainsQueue() public {
        uint256 b0 = _startWithGap();
        _roll(3);
        int24 k1 = int24(_endNorm(b0 + 1));

        vm.expectEmit(address(oracle));
        emit ISealedPoolOracle.Queued(b0 + 2, b0 + 4);
        assertTrue(oracle.poke(), "the run after the gap seals");
        assertEq(oracle.queueLength(), 1);
        assertEq(oracle.frontier(), b0);
        vm.expectRevert(abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, _t(b0 + 1) + 1));
        oracle.cumulativeAt(_t(b0 + 1) + 1);

        vm.expectEmit(address(oracle));
        emit ISealedPoolOracle.Proven(b0 + 1, k1);
        vm.expectEmit(address(oracle));
        emit ISealedPoolOracle.Sealed(b0 + 2, b0 + 4, k1);
        oracle.applyProven(b0 + 1, endSp[b0 + 1], endRaw[b0 + 1]);

        assertEq(oracle.frontier(), b0 + 4, "queue drained");
        assertEq(oracle.queueLength(), 0);
        assertEq(oracle.cumulativeAt(_t(b0 + 5)), _endNorm(b0) + 4 * int256(k1));
        assertEq(oracle.cumulativeAt(_t(b0 + 1)), _endNorm(b0));
    }

    function test_queueFullDropsOldest() public {
        uint256 b0 = _startWithGap();
        for (uint256 i; i < 257; i++) {
            _roll(1);
            assertTrue(oracle.poke());
        }
        assertEq(oracle.queueLength(), 256, "ring of 256");

        oracle.applyProven(b0 + 1, endSp[b0 + 1], endRaw[b0 + 1]);
        assertEq(oracle.frontier(), b0 + 1, "the dropped run is a gap again");
        assertEq(oracle.queueLength(), 256);

        oracle.applyProven(b0 + 2, endSp[b0 + 2], endRaw[b0 + 2]);
        assertEq(oracle.frontier(), b0 + 258);
        assertEq(oracle.queueLength(), 0);
        assertEq(oracle.cumulativeAt(_t(b0 + 259)), _endNorm(b0) + 258 * _endNorm(b0 + 1));
    }

    function test_applyProvenRequiresNextBlock() public {
        uint256 b0 = _startWithGap();
        vm.expectRevert(abi.encodeWithSelector(ISealedPoolOracle.NotNextBlock.selector, b0 + 1, b0 + 2));
        oracle.applyProven(b0 + 2, endSp[b0 + 2], endRaw[b0 + 2]);
        vm.expectRevert(abi.encodeWithSelector(ISealedPoolOracle.NotNextBlock.selector, b0 + 1, b0));
        oracle.applyProven(b0, endSp[b0], endRaw[b0]);
    }

    function test_proofStartsTheOracle() public {
        uint256 b0 = vm.getBlockNumber();
        _swapTicks(25);
        _roll(2);
        vm.expectEmit(address(oracle));
        emit ISealedPoolOracle.Proven(b0, int24(_endNorm(b0)));
        oracle.applyProven(b0, endSp[b0], endRaw[b0]);
        assertEq(oracle.frontier(), b0);
        assertEq(oracle.oldestObservationTime(), _t(b0));
        assertEq(oracle.cumulativeAt(_t(b0 + 1)), _endNorm(b0));
    }

    /* Views */

    function test_viewsRevertBeforeStart() public {
        assertEq(oracle.frontier(), 0);
        assertEq(oracle.decimalsShift(), SHIFT);
        vm.expectRevert(ISealedPoolOracle.NotStarted.selector);
        oracle.lnSpotSoBWad();
        vm.expectRevert(ISealedPoolOracle.NotStarted.selector);
        oracle.sobTick();
        vm.expectRevert(ISealedPoolOracle.NotStarted.selector);
        oracle.cumulativeAt(_now());
        vm.expectRevert(ISealedPoolOracle.NotStarted.selector);
        oracle.varianceE36();
        vm.expectRevert(ISealedPoolOracle.NotStarted.selector);
        oracle.oldestObservationTime();
    }

    function test_spotFreshWhenFrontierIsPreviousBlock() public {
        uint256 b0 = _start();
        (uint160 sp,) = _slot0();
        (int24 k, uint32 w) = oracle.sobTick();
        assertEq(k, _endNorm(b0));
        assertEq(w, _t(b0 + 1), "last write is time(K + 1)");
        assertApproxEqAbs(oracle.lnSpotSoBWad(), _lnUsd(sp), LN_TOL);

        _swapTicks(-80);
        (k,) = oracle.sobTick();
        assertEq(k, _endNorm(b0), "swaps earlier in the block do not move it");
        assertApproxEqAbs(oracle.lnSpotSoBWad(), _lnUsd(sp), LN_TOL);
    }

    function test_spotSealedView() public {
        uint256 b0 = _startWithGap();
        (uint160 sp1, int24 raw1) = _slot0();
        _roll(5);
        assertLt(b0 + 1 + maxStale, vm.getBlockNumber(), "E_K alone would be stale");

        (int24 k, uint32 w) = oracle.sobTick();
        assertEq(k, _norm(raw1), "snapshot tick");
        assertEq(w, _t(b0 + 1));
        assertApproxEqAbs(oracle.lnSpotSoBWad(), _lnUsd(sp1), LN_TOL, "snapshot price");
        assertTrue(k != _endNorm(b0), "differs from E_K");

        _swapTicks(-25);
        vm.expectRevert(abi.encodeWithSelector(ISealedPoolOracle.StaleSpot.selector, b0, vm.getBlockNumber()));
        oracle.lnSpotSoBWad();
    }

    function test_spotStaleWithinLimit() public {
        uint256 b0 = _startWithGap();
        _swapTicks(30);
        _roll(2);
        assertEq(b0 + 1 + maxStale, vm.getBlockNumber(), "at the limit");

        (int24 k,) = oracle.sobTick();
        assertEq(k, _endNorm(b0), "E_K");
        assertApproxEqAbs(oracle.lnSpotSoBWad(), _lnUsd(endSp[b0]), LN_TOL);

        assertFalse(oracle.poke(), "a poke in this block cannot seal");
        (k,) = oracle.sobTick();
        assertEq(k, _endNorm(b0), "a snapshot from this block is no sealed view");
    }

    function test_spotRevertsBeyondLimit() public {
        uint256 b0 = _start();
        PredictionHook hook = _deployPredictionHook();
        uint256 id = _createMarket(hook);
        assertGt(hook.quote(id).midYes, 0, "priced while fresh");

        _swapTicks(40);
        _roll(1);
        oracle.poke();
        _swapTicks(30);
        _roll(3);
        uint256 n = vm.getBlockNumber();
        assertEq(b0 + 1 + maxStale + 1, n, "one block past the limit");

        vm.expectRevert(abi.encodeWithSelector(ISealedPoolOracle.StaleSpot.selector, b0, n));
        oracle.lnSpotSoBWad();
        vm.expectRevert(abi.encodeWithSelector(ISealedPoolOracle.StaleSpot.selector, b0, n));
        oracle.sobTick();

        IPredictionHook.Quote memory q = hook.quote(id);
        assertEq(q.midYes, 0);
        assertEq(q.askYes, 0);
        assertEq(q.bidYes, 0);
        assertEq(q.askNo, 0);
        assertEq(q.bidNo, 0);
        assertEq(q.varE36, 0);
        assertEq(q.xWad, 0);
        assertFalse(q.tradable);
        assertGt(q.tau, 0);

        oracle.applyProven(b0 + 1, endSp[b0 + 1], endRaw[b0 + 1]);
        assertGt(hook.quote(id).midYes, 0, "a proof restores trading");
    }

    function test_cumulativeNeverExtrapolatesAcrossGap() public {
        uint256 b0 = _startWithGap();
        _roll(3);
        uint32 now_ = _now();
        oracle.sobTick();

        assertEq(oracle.cumulativeAt(_t(b0 + 1)), _endNorm(b0));
        vm.expectRevert(abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, _t(b0 + 1) + 1));
        oracle.cumulativeAt(_t(b0 + 1) + 1);
        vm.expectRevert(abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, now_));
        oracle.cumulativeAt(now_);
        oracle.varianceE36();
    }

    function test_cumulativeExtendsThroughSealedView() public {
        uint256 b0 = _start();
        int256 k0 = _normTick(pk);
        _roll(4);
        assertEq(oracle.frontier(), b0);

        assertEq(oracle.cumulativeAt(_t(b0 + 5)), 5 * k0, "the snapshot has held since K + 1");
        assertEq(oracle.cumulativeAt(_t(b0 + 3)), 3 * k0);
        vm.expectRevert(abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, _t(b0 + 5) + 1));
        oracle.cumulativeAt(_t(b0 + 5) + 1);

        _swapTicks(10);
        vm.expectRevert(abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, _t(b0 + 5)));
        oracle.cumulativeAt(_t(b0 + 5));
        assertEq(oracle.cumulativeAt(_t(b0 + 1)), k0);
    }

    /* Constructor */

    function test_constructorRejectsHookedOrDynamicOrZeroFee() public {
        PoolKey memory k = pk;
        k.hooks = IHooks(address(0x4444));
        vm.expectRevert(ISealedPoolOracle.InvalidPool.selector);
        _deploy(k);

        k = pk;
        k.fee = LPFeeLibrary.DYNAMIC_FEE_FLAG;
        vm.expectRevert(ISealedPoolOracle.InvalidPool.selector);
        _deploy(k);

        k = pk;
        k.fee = 0;
        vm.expectRevert(ISealedPoolOracle.InvalidPool.selector);
        _deploy(k);

        vm.expectRevert(TickAccumulator.InvalidParams.selector);
        new SealedPoolOracleHarness(manager, pk, 0, SHIFT, bt, maxStale, cfg);
        vm.expectRevert(TickAccumulator.InvalidParams.selector);
        new SealedPoolOracleHarness(manager, pk, 1, SHIFT, 0, maxStale, cfg);
    }

    function test_constructorStoresAnchor() public view {
        assertEq(oracle.anchorBlock(), vm.getBlockNumber());
        assertEq(oracle.anchorTimestamp(), vm.getBlockTimestamp());
        assertEq(oracle.blockTimeOf(vm.getBlockNumber() + 7), vm.getBlockTimestamp() + 7);
        assertEq(PoolId.unwrap(oracle.poolId()), PoolId.unwrap(pk.toId()));
    }

    /* Gas */

    function test_gasPoke() public {
        (cfg.nWindows, cfg.cardinality) = (60, 16);
        oracle = _deploy(pk);
        _poke("first poke, snapshot only");
        for (uint256 i; i < 40; i++) {
            _roll(1);
            oracle.poke();
        }
        assertEq(oracle.frontier(), vm.getBlockNumber() - 1, "warm, observation ring wrapped");

        _roll(1);
        uint256 sealedGas = _poke("poke that seals and applies a one-block run");
        _swapTicks(40);
        _roll(1);
        uint256 brokenGas = _poke("poke that finds a broken seal");
        _roll(1);
        uint256 queuedGas = _poke("poke that seals and queues a run");
        uint256 b = vm.getBlockNumber();
        vm.cool(address(oracle));
        oracle.applyProven(b - 2, endSp[b - 2], endRaw[b - 2]);
        uint256 drainGas = vm.lastFrameGas().gasTotalUsed;
        emit log_named_uint("applyProven that drains one queued run", drainGas);
        assertEq(oracle.frontier(), b - 1, "gap proven and run drained");

        assertLt(sealedGas, 80_000);
        assertLt(brokenGas, 80_000);
        assertLt(queuedGas, 130_000);
        assertLt(drainGas, 80_000);
    }

    /* Helpers */

    /// @dev Tx gas with 21k intrinsic, cooled accounts approximate a fresh transaction
    function _poke(string memory label) internal returns (uint256 used) {
        vm.cool(address(oracle));
        vm.cool(address(manager));
        oracle.poke();
        used = vm.lastFrameGas().gasTotalUsed;
        emit log_named_uint(label, used);
    }

    function _deployPredictionHook() internal returns (PredictionHook hook) {
        address h = address(HOOK_FLAGS | (uint160(0x5555) << 144));
        bytes memory args = abi.encode(manager, address(usdcToken), address(this));
        deployCodeTo("src/PredictionHook.sol:PredictionHook", args, h);
        hook = PredictionHook(h);
        usdcToken.approve(h, type(uint256).max);
        hook.deposit(100_000e6);
    }

    function _createMarket(PredictionHook hook) internal returns (uint256) {
        IPredictionHook.MarketParams memory p;
        p.oracle = address(oracle);
        p.lnStrikeWad = oracle.lnSpotSoBWad();
        p.openTime = uint64(_now());
        p.expiry = uint64(_now() + 1 hours);
        p.window = 60;
        p.cutoffBuffer = 10;
        p.nSamples = 60;
        p.budget = 10_000e6;
        p.quote = IPredictionHook.QuoteParams({
            h0Wad: 0.02e18, gammaSWad: 0.00002e18, lambdaWad: 0.001e18, qEpochMax: 100e6, pMinWad: 0.02e18
        });
        p.yesName = "YES";
        p.yesSymbol = "YES";
        p.noName = "NO";
        p.noSymbol = "NO";
        return hook.createMarket(p);
    }
}

/// @notice prove() against real Unichain mainnet fixtures for the deep hookless ETH/USDC pool, with the oracle bound
///         to the real PoolManager address and pool key
contract SealedPoolOracleProofTest is Test {
    address internal constant PM = 0x1F98400000000000000000000000000000000004;
    address internal constant USDC = 0x078D782b760474a361dDA0AF3839290b0EF57AD6;
    bytes32 internal constant DEEP_POOL = 0x3258f413c7a88cda2fa8709a589d221a80f6574f63df5a5b6774485d8acc39d9;
    uint256 internal constant HEAD = 59663500;
    uint256 internal constant HEAD_TS = 1790411859;

    struct Fixture {
        uint256 number;
        uint256 timestamp;
        bytes32 blockHash;
        bytes header;
        bytes[] accountProof;
        bytes[] slotProof;
        uint160 sqrtPriceX96;
        int24 tick;
    }

    Fixture internal f50;
    Fixture internal f70;

    function setUp() public {
        f50 = _load(59663450);
        f70 = _load(59663470);
        vm.roll(HEAD);
        vm.warp(HEAD_TS);
        vm.setBlockhash(f50.number, f50.blockHash);
        vm.setBlockhash(f70.number, f70.blockHash);
    }

    function test_proveRealUnichainBlocks() public {
        SealedPoolOracleHarness o = _deploy(0);
        assertEq(PoolId.unwrap(o.poolId()), DEEP_POOL, "real pool id");

        vm.expectEmit(address(o));
        emit ISealedPoolOracle.Proven(f50.number, f50.tick);
        o.prove(_proof(f50));
        uint256 proveGas = vm.lastFrameGas().gasTotalUsed;

        assertEq(o.frontier(), f50.number);
        assertEq(o.oldestObservationTime(), f50.timestamp);
        assertEq(o.cumulativeAt(uint32(f50.timestamp + 1)), f50.tick);
        (int24 k,) = o.sobTick();
        assertEq(k, f50.tick, "stale E_K within the limit");
        uint256 usdWad = F.fullMulDiv(uint256(f50.sqrtPriceX96) * 1e15, uint256(f50.sqrtPriceX96) * 1e15, 1 << 192);
        assertApproxEqAbs(o.lnSpotSoBWad(), F.lnWad(int256(usdWad)), 100, "ln USD per ETH");

        for (uint256 n = f50.number + 1; n < f70.number; n++) {
            o.applyProven(n, f50.sqrtPriceX96, f50.tick);
        }
        int56 before = o.cumulativeAt(uint32(f70.timestamp));
        vm.cool(address(o));
        o.prove(_proof(f70));
        uint256 steadyGas = vm.lastFrameGas().gasTotalUsed;
        assertEq(o.frontier(), f70.number);
        assertEq(o.cumulativeAt(uint32(f70.timestamp + 1)), before + f70.tick);

        // Forge reports a state-changing call as a transaction, with 21k intrinsic gas and ~108k of proof calldata
        console.log("prove tx gas, first proof (starts the history)", proveGas);
        console.log("prove tx gas, steady state (observation ring wrapped)", steadyGas);
        assertLt(steadyGas, 780_000, "prove gas regression");
    }

    function test_proveRejectsWrongNumber() public {
        SealedPoolOracleHarness o = _deploy(0);
        o.prove(_proof(f50));
        vm.expectRevert(abi.encodeWithSelector(ISealedPoolOracle.NotNextBlock.selector, f50.number + 1, f70.number));
        o.prove(_proof(f70));
        vm.expectRevert(abi.encodeWithSelector(ISealedPoolOracle.NotNextBlock.selector, f50.number + 1, f50.number));
        o.prove(_proof(f50));

        vm.roll(f50.number + 300);
        vm.warp(f50.timestamp + 300);
        SealedPoolOracleHarness late = _deploy(0);
        vm.expectRevert(
            abi.encodeWithSelector(ISealedPoolOracle.NotNextBlock.selector, f50.number + 300 - 256, f50.number)
        );
        late.prove(_proof(f50));
    }

    function test_proveRejectsBadTimestamp() public {
        // Every block is one second later than a chain with the anchor's block time would stamp it
        SealedPoolOracleHarness o = _deploy(1);
        uint256 expected = o.blockTimeOf(f50.number);
        assertEq(expected, f50.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(ISealedPoolOracle.BadTimestamp.selector, expected, f50.timestamp));
        o.prove(_proof(f50));
        assertEq(o.frontier(), 0, "not started");

        o.applyProven(f50.number - 1, f50.sqrtPriceX96, f50.tick);
        uint32 last = o.blockTimeOf(f50.number);
        int56 cum = o.cumulativeAt(last);
        vm.expectRevert(abi.encodeWithSelector(ISealedPoolOracle.BadTimestamp.selector, expected, f50.timestamp));
        o.prove(_proof(f50));
        assertEq(o.frontier(), f50.number - 1, "frontier untouched");
        assertEq(o.cumulativeAt(last), cum, "cumulative untouched");
        vm.expectRevert(abi.encodeWithSelector(IUnderlyingOracle.ObservationUnavailable.selector, last + 1));
        o.cumulativeAt(last + 1);
    }

    function test_proveRejectsWrongOrUnknownHash() public {
        SealedPoolOracleHarness o = _deploy(0);
        vm.setBlockhash(f50.number, keccak256("another chain"));
        vm.expectRevert(PoolStateProof.BadHeader.selector);
        o.prove(_proof(f50));

        vm.roll(HEAD + 9000);
        vm.warp(HEAD_TS + 9000);
        vm.expectRevert(abi.encodeWithSelector(BlockHashes.UnknownBlockHash.selector, f50.number));
        o.prove(_proof(f50));
    }

    function test_proveRejectsProofOfAnotherBlock() public {
        SealedPoolOracleHarness o = _deploy(0);
        ISealedPoolOracle.BlockProof memory p = _proof(f50);
        p.accountProof = f70.accountProof;
        p.slotProof = f70.slotProof;
        vm.expectRevert(PoolStateProof.BadAccountProof.selector);
        o.prove(p);
    }

    function test_proveManySkipsCoveredProofs() public {
        SealedPoolOracleHarness o = _deploy(0);
        o.applyProven(f50.number - 1, f50.sqrtPriceX96, f50.tick);

        ISealedPoolOracle.BlockProof[] memory ps = new ISealedPoolOracle.BlockProof[](2);
        (ps[0], ps[1]) = (_proof(f50), _proof(f50));
        vm.recordLogs();
        o.proveMany(ps);
        assertEq(vm.getRecordedLogs().length, 1, "one Proven, the covered repeat is skipped");
        assertEq(o.frontier(), f50.number);

        ps = new ISealedPoolOracle.BlockProof[](1);
        ps[0] = _proof(f70);
        vm.expectRevert(abi.encodeWithSelector(ISealedPoolOracle.NotNextBlock.selector, f50.number + 1, f70.number));
        o.proveMany(ps);
    }

    /* Helpers */

    function _deploy(uint256 tsOffset) internal returns (SealedPoolOracleHarness) {
        uint256 ts = vm.getBlockTimestamp();
        vm.warp(ts + tsOffset);
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 500, 10, IHooks(address(0)));
        SealedPoolOracleHarness o = new SealedPoolOracleHarness(
            IPoolManager(PM),
            key,
            1,
            12,
            1,
            60,
            OracleTestBase.HookParams({
                h: 60,
                nWindows: 60,
                minWindows: 3,
                winsorTicks: 400,
                varMin: 1,
                varMax: type(uint128).max,
                fallbackVar: 1e20,
                cardinality: 16
            })
        );
        vm.warp(ts);
        return o;
    }

    function _proof(Fixture memory f) internal pure returns (ISealedPoolOracle.BlockProof memory) {
        return ISealedPoolOracle.BlockProof({header: f.header, accountProof: f.accountProof, slotProof: f.slotProof});
    }

    function _load(uint256 n) internal view returns (Fixture memory f) {
        string memory j = vm.readFile(string.concat("test/vectors/unichain/pool-proof-", vm.toString(n), ".json"));
        f.number = vm.parseJsonUint(j, ".number");
        f.timestamp = vm.parseJsonUint(j, ".timestamp");
        f.blockHash = vm.parseJsonBytes32(j, ".blockHash");
        f.header = vm.parseJsonBytes(j, ".header");
        f.accountProof = vm.parseJsonBytesArray(j, ".accountProof");
        f.slotProof = vm.parseJsonBytesArray(j, ".slotProof");
        f.sqrtPriceX96 = uint160(vm.parseJsonUint(j, ".sqrtPriceX96"));
        f.tick = int24(vm.parseJsonInt(j, ".tick"));
    }
}
