// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../integration/StackFixture.sol";
import {StrikeMath} from "../../src/hook/StrikeMath.sol";
import {SandwichAttacker} from "./mocks/SandwichAttacker.sol";
import {LiveSlot0Oracle} from "./mocks/LiveSlot0Oracle.sol";

/// @notice Mallory against the real stack: funds, a sandwich bot, a LIVE-slot0 oracle adapter for negative controls
abstract contract AttackBase is StackFixture {
    LiveSlot0Oracle internal live;
    SandwichAttacker internal atk;

    struct PnL {
        int256 usdc;
        int256 demo;
        uint256 q;
    }

    function setUp() public virtual override {
        super.setUp();
        live = new LiveSlot0Oracle(manager, IUnderlyingOracle(address(oracle)), ethKey.toId(), int8(sign));
        atk = new SandwichAttacker(manager, mallory);
        vm.label(address(live), "LiveSlot0Oracle");
        vm.label(address(atk), "MalloryBot");
        _fundUsdc(liam, 1_000_000 * E6);
        _deposit(liam, 1_000_000 * E6);
        _fundUsdc(mallory, 100_000 * E6);
        weth.mint(address(atk), 100e18);
        dusdc.mint(address(atk), 1_000_000e6);
        weth.mint(mallory, 10_000e18);
        dusdc.mint(mallory, 100_000_000e6);
        vm.startPrank(mallory);
        weth.approve(address(swapRouter), type(uint256).max);
        dusdc.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
        _nextBlock(1);
    }

    /// @dev Demo market shape (60 s, window 10 s, cutoff 2 s, 10 samples, oracle sigma) on oracle `o`
    function _market(address o, uint256 budget, uint128 qMax, uint128 lambda) internal returns (uint256 id) {
        IPredictionHook.MarketParams memory p = _demoParams();
        p.oracle = o;
        p.budget = budget;
        p.quote.qEpochMax = qMax;
        p.quote.lambdaWad = lambda;
        id = _create(p);
        _approveOutcomes(mallory, id);
    }

    /// @dev The demo market scaled 100x in size (budget 1,000 USDC, 10,000-token epoch cap, impact / 100)
    function _scaledMarket(address o) internal returns (uint256) {
        return _market(o, 1_000 * E6, uint128(10_000 * E6), 0.00001e18);
    }

    /// @dev Mallory's USDC and her demo tokens valued at `fairUsd`, both in 6-decimal USD
    function _wealth(uint256 fairUsd) internal view returns (int256 u, int256 demo) {
        u = int256(usdc.balanceOf(mallory) + usdc.balanceOf(address(atk)));
        uint256 w = weth.balanceOf(mallory) + weth.balanceOf(address(atk));
        uint256 d = dusdc.balanceOf(mallory) + dusdc.balanceOf(address(atk));
        demo = int256(d + F.fullMulDiv(w, fairUsd, 1e30));
    }

    /// @dev A plain (non-atomic) push of the ETH pool by Mallory through PoolSwapTest
    function _pushAsMallory(uint160 target) internal {
        uint160 sp = _slot0();
        if (sp == target) return;
        SwapParams memory p = SwapParams({zeroForOne: target < sp, amountSpecified: -1e36, sqrtPriceLimitX96: target});
        PoolSwapTest.TestSettings memory ts = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        vm.prank(mallory);
        swapRouter.swap(ethKey, p, ts, "");
        _recordPath();
    }

    function _pushedSqrt(uint256 fairUsd, int256 bps) internal pure returns (uint160) {
        return _sqrtPriceForUsd(uint256(int256(fairUsd) * (10_000 + bps) / 10_000));
    }

    /// @dev Atomic sandwich now, then the YES is sold at the next block's fair bid. `qModel` is the fill the model
    ///      gives on the market oracle's pre-attack reading in the attack block.
    function _atomicSandwich(uint256 id, uint256 usdcIn, int256 pushBps)
        internal
        returns (PnL memory r, uint256 qModel)
    {
        uint160 sp0 = _slot0();
        uint256 fair = _usdForSqrtPrice(sp0);
        (int256 u0, int256 d0) = _wealth(fair);
        (qModel,) = _modelFill(id, true, true, true, usdcIn);
        PoolKey memory yesKey = _poolKey(id, true);
        uint160 pushTo = _pushedSqrt(fair, pushBps);
        vm.prank(mallory);
        usdc.transfer(address(atk), usdcIn);
        vm.prank(mallory);
        atk.attack(ethKey, pushTo, yesKey, CIRCLE_USDC, usdcIn);
        r.q = atk.lastOut();
        assertEq(_slot0(), sp0, "pool restored inside the same unlock");
        address yesTok = address(_outcome(id, true));
        vm.prank(mallory);
        atk.sweep(yesTok);
        _nextBlock(1);
        _trade("  Mallory", mallory, id, true, false, true, r.q, true);
        (int256 u1, int256 d1) = _wealth(fair);
        r.usdc = u1 - u0;
        r.demo = d1 - d0;
    }

    struct SettleCase {
        uint256 id;
        uint32 expiry;
        int256 kHold;
        int256 marginWad;
    }

    /// @dev A demo-shaped market whose window holds ETH exactly 3 ticks above the strike's tick: YES by a known margin
    function _heldMarket(uint256 budget) internal returns (SettleCase memory c) {
        c.id = _market(address(oracle), budget, uint128(1_000 * E6), 0.0001e18);
        IPredictionHook.MarketParams memory p = hook.marketParams(c.id);
        c.expiry = uint32(p.expiry);
        int256 strikeTick = StrikeMath.strikeTickWad(p.lnStrikeWad, 12);
        c.kHold = (strikeTick >= 0 ? strikeTick : strikeTick - 1e18 + 1) / 1e18 + 3;
        _warpTo(c.expiry - p.window);
        _steerNormTick(c.kHold);
        c.marginWad = c.kHold * int256(uint256(p.window)) * 1e18 - hook.settleThresholdOf(c.id);
        assertGt(c.marginWad, 25e18, "margin above 2.5 ticks x window");
        assertLe(c.marginWad, 35e18);
    }

    function _settleOutcome(uint256 id) internal returns (bool) {
        vm.prank(keeper);
        hook.settle(id);
        return hook.marketInfo(id).yesWon;
    }

    /// @dev Pushes ETH down `ticks` for the final second, the mirror restores it at T, the keeper settles
    function _lastSecondPush(SettleCase memory c, int256 ticks) internal returns (bool yesWon, int256 cost) {
        _warpTo(c.expiry - 1);
        uint256 fair = _spotUsd();
        (int256 u0, int256 d0) = _wealth(fair);
        _pushAsMallory(_sqrtAtNormTick(c.kHold - ticks));
        uint256 pushedUsd = _spotUsd();
        _warpTo(c.expiry);
        assertEq(_refD(c.expiry - 10, c.expiry), c.kHold * 10 - ticks);
        _steerNormTick(c.kHold);
        yesWon = _settleOutcome(c.id);
        (int256 u1, int256 d1) = _wealth(fair);
        assertEq(u1, u0, "no USDC involved");
        cost = d0 - d1;
        console2.log(
            string.concat(
                "  push ",
                vm.toString(ticks),
                " ticks for the last second: ETH $",
                _dec(fair, 18, 2),
                " -> $",
                _dec(pushedUsd, 18, 2),
                ", restored at T; cost ",
                _dec(uint256(cost), 6, 2),
                " USD -> ",
                yesWon ? "YES" : "NO"
            )
        );
    }

    function _logPnl(string memory what, PnL memory r) internal pure {
        console2.log(
            string.concat(
                "  ",
                what,
                ": ",
                _dec(r.q, 6, 2),
                " YES, USDC P&L ",
                _sdec(r.usdc, 6, 4),
                ", ETH-pool P&L ",
                _sdec(r.demo, 6, 4),
                ", total ",
                _sdec(r.usdc + r.demo, 6, 4)
            )
        );
    }
}

/// @notice C5: the start-of-block oracle makes an atomic sandwich through the underlying pool worthless, and a
///         negative control shows the same attack is profitable when the spot input is the live slot0. Also: the
///         settlement TWAP against last-second pushes, pushes in the settlement block, and the tie rule.
abstract contract ManipulationCases is AttackBase {
    /// @dev A pool shallow enough (about 1,000 dWETH and 2.7M dUSDC full range) that pushing it is cheap
    function _ethLiquidity() internal pure override returns (uint128) {
        return 5.2e16;
    }

    /* Atomic sandwich */

    function test_atomicSandwich_sobOracle_attackerLoses() public {
        uint256 id = _scaledMarket(address(oracle));
        _nextBlock(10);
        console2.log("Mallory: push ETH -0.5%, buy YES with 20 USDC, push back, all in one unlock (real SoB oracle)");
        (PnL memory r, uint256 qModel) = _atomicSandwich(id, 20 * E6, -50);
        _logPnl("SoB oracle", r);
        assertEq(r.q, qModel, "the fill ignores the push: model on the start-of-block price");
        assertLt(r.usdc, 0, "the round trip pays the spread");
        assertLe(r.demo, 0, "the ETH-pool round trip pays fees");
        assertLt(r.usdc + r.demo, 0, "attacker loses");
        _checkLedger();
    }

    function test_atomicSandwich_liveSlot0_negativeControl_profits() public {
        uint256 id = _scaledMarket(address(live));
        _nextBlock(10);
        console2.log("NEGATIVE CONTROL: the same attack against a market whose oracle reads the LIVE slot0");
        (PnL memory r, uint256 qModel) = _atomicSandwich(id, 20 * E6, -50);
        _logPnl("live slot0", r);
        assertGt(r.q, qModel * 10, "the push made YES more than 10x cheaper");
        assertGt(r.usdc + r.demo, int256(100 * E6), "attacker profits over 100 USDC");
        _checkLedger();
    }

    /// @dev Both markets side by side on one pool: identical parameters, only the spot input differs
    function test_atomicSandwich_sideBySide() public {
        uint256 real = _scaledMarket(address(oracle));
        uint256 ctl = _scaledMarket(address(live));
        _nextBlock(10);
        IPredictionHook.Quote memory a = hook.quote(real);
        IPredictionHook.Quote memory b = hook.quote(ctl);
        assertEq(a.midYes, b.midYes, "same quote before the attack");
        uint256 snap = vm.snapshotState();
        (PnL memory rs,) = _atomicSandwich(real, 20 * E6, -50);
        vm.revertToState(snap);
        (PnL memory rl,) = _atomicSandwich(ctl, 20 * E6, -50);
        _logPnl("SoB oracle ", rs);
        _logPnl("live slot0 ", rl);
        assertLt(rs.usdc + rs.demo, 0);
        assertGt(rl.usdc + rl.demo, 0);
    }

    /// @dev Any same-block push, up or down, leaves every input of the real market's quote unchanged
    function testFuzz_sameBlockPush_quoteInvariant(uint256 bpsSeed, bool up) public {
        uint256 real = _scaledMarket(address(oracle));
        uint256 ctl = _scaledMarket(address(live));
        _nextBlock(5);
        int256 bps = int256(bound(bpsSeed, 1, 2_000));
        if (!up) bps = -bps;
        IPredictionHook.Quote memory a0 = hook.quote(real);
        IPredictionHook.Quote memory b0 = hook.quote(ctl);
        uint256 q0 = _quoteV4(_poolKey(real, true), true, true, 10 * E6);
        _pushAsMallory(_pushedSqrt(_spotUsd(), bps));
        IPredictionHook.Quote memory a1 = hook.quote(real);
        assertEq(abi.encode(a1), abi.encode(a0), "SoB quote unchanged by the push");
        assertEq(_quoteV4(_poolKey(real, true), true, true, 10 * E6), q0, "V4Quoter unchanged");
        IPredictionHook.Quote memory b1 = hook.quote(ctl);
        assertTrue(b1.xWad != b0.xWad, "the live control moves");
        if (up) assertGt(b1.xWad, b0.xWad);
        else assertLt(b1.xWad, b0.xWad);
        _nextBlock(1);
        assertTrue(hook.quote(real).xWad != a0.xWad, "the next block sees the new price");
    }

    /* Settlement window */

    /// @dev With a 10 s window, a margin of M tick-seconds needs a push of M ticks held for the final second (10x the
    ///      3-tick price margin). One tick less and YES stands; the flipping push is paid to the mirror.
    function test_settlement_lastSecondPush_needsWindowTimesMargin() public {
        SettleCase memory c = _heldMarket(100 * E6);
        int256 flip = (c.marginWad + 1e18 - 1) / 1e18;
        console2.log(
            string.concat(
                "window 10 s held at ",
                vm.toString(c.kHold),
                ", 3 ticks above the strike: margin ",
                _sdec(c.marginWad, 18, 2)
            )
        );
        uint256 snap = vm.snapshotState();
        (bool yesWon, int256 cost) = _lastSecondPush(c, flip - 1);
        assertTrue(yesWon, "flip - 1 ticks: YES stands");
        vm.revertToState(snap);
        (yesWon, cost) = _lastSecondPush(c, flip);
        assertFalse(yesWon, "flip ticks: the outcome flips");
        assertGt(cost, 0, "the push is paid to the mirror");
        assertGe(flip, 25, "the push needs at least window x the price margin");
    }

    function test_settlement_pushesInOrAfterTheSettlementBlockDoNotCount() public {
        SettleCase memory c = _heldMarket(100 * E6);
        _warpTo(c.expiry);
        _pushAsMallory(_pushedSqrt(_spotUsd(), -1_000));
        assertTrue(_settleOutcome(c.id), "a -10% push at T, before settle in the same block, is ignored");

        SettleCase memory c2 = _heldMarket(100 * E6);
        _warpTo(c2.expiry + 1);
        _pushAsMallory(_pushedSqrt(_spotUsd(), -1_000));
        _warpTo(c2.expiry + 3);
        _pushAsMallory(_pushedSqrt(_spotUsd(), -500));
        int256 d = int256(oracle.cumulativeAt(c2.expiry)) - int256(oracle.cumulativeAt(c2.expiry - 10));
        assertEq(d, c2.kHold * 10, "only [T - window, T) counts");
        assertTrue(_settleOutcome(c2.id), "pushes after T are ignored");
    }

    function test_settlement_pushesBeforeTheWindowDoNotCount() public {
        uint256 id = _market(address(oracle), 100 * E6, uint128(1_000 * E6), 0.0001e18);
        uint32 exp = uint32(hook.marketInfo(id).expiry);
        int256 k = _normTick();
        _warpTo(exp - 11);
        _pushAsMallory(_pushedSqrt(_spotUsd(), -2_000));
        _warpTo(exp - 10);
        _steerNormTick(k + 2);
        _warpTo(exp);
        assertEq(_refD(exp - 10, exp), (k + 2) * 10);
        int256 d = int256(oracle.cumulativeAt(exp)) - int256(oracle.cumulativeAt(exp - 10));
        assertEq(d, (k + 2) * 10, "the -20% push that ended at T - window is outside the window");
        assertEq(_settleOutcome(id), d * 1e18 > hook.settleThresholdOf(id));
    }

    /* Tie rule with the real oracle */

    /// @dev ln(K) with strikeTickWad(ln K, 12) = -197624.4 exactly, so a 10 s window ties at D = -1976249
    int256 internal constant LN_K_TIE = 7869569172058688423;
    int256 internal constant D_TIE = -1976249;

    function _tieMarket() internal returns (uint256 id, uint32 exp) {
        _steerNormTick(-197625);
        _nextBlock(1);
        IPredictionHook.MarketParams memory p = _demoParams();
        p.lnStrikeWad = LN_K_TIE;
        id = _create(p);
        exp = uint32(p.expiry);
        assertEq(StrikeMath.strikeTickWad(LN_K_TIE, 12), -197624.4e18);
        assertEq(hook.settleThresholdOf(id), D_TIE * 1e18, "threshold is an exact integer D");
    }

    /// @dev Holds -197625 over the window except the last `s` seconds at -197624
    function _tiePath(uint32 exp, uint256 s) internal returns (bool yesWon, int256 d) {
        uint256 id = hook.marketCount();
        _warpTo(exp - 10);
        _steerNormTick(-197625);
        if (s != 0) {
            _warpTo(exp - s);
            _steerNormTick(-197624);
        }
        _warpTo(exp);
        d = int256(oracle.cumulativeAt(exp)) - int256(oracle.cumulativeAt(exp - 10));
        assertEq(d, _refD(exp - 10, exp));
        yesWon = _settleOutcome(id);
    }

    function test_settlement_tieResolvesNo_realOracle() public {
        (, uint32 exp) = _tieMarket();
        uint256 snap = vm.snapshotState();
        (bool y, int256 d) = _tiePath(exp, 1);
        assertEq(d, D_TIE, "exact tie");
        assertFalse(y, "tie -> NO");
        vm.revertToState(snap);
        (y, d) = _tiePath(exp, 2);
        assertEq(d, D_TIE + 1);
        assertTrue(y, "one tick-second above -> YES");
        vm.revertToState(snap);
        (y, d) = _tiePath(exp, 0);
        assertEq(d, D_TIE - 1);
        assertFalse(y, "one tick-second below -> NO");
    }
}

contract Manipulation_WethCurrency0 is ManipulationCases {}

contract Manipulation_WethCurrency1 is ManipulationCases {
    function _wethIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

/// @notice Multi-block push cost vs gain, at the demo deploy depth and the keeper's exact demo parameters.
///         A: the mirror backruns the push inside block N, so block N+1 starts at the fair price.
///         B: the push survives into block N+1 (its start-of-block price); Mallory buys YES first, the mirror
///            restores the pool in N+1 (it steers every block), Mallory sells at the fair bid in N+2.
///         C: as B, but nobody arbitrages and Mallory pushes the pool back herself (fees only).
contract MultiBlockPushTest is AttackBase {
    struct Row {
        int256 gain;
        int256 cost;
    }

    /// @dev Largest YES quantity the market can back at `ask`, within the epoch cap and the band
    function _maxQ(uint256 id, uint256 ask) internal view returns (uint256) {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        IPredictionHook.MarketParams memory p = hook.marketParams(id);
        if (ask + p.quote.pMinWad >= WAD) return 0;
        uint256 q = F.fullMulDiv(i.bucket - i.outYes, WAD, WAD - ask);
        uint256 band = (WAD - p.quote.pMinWad - ask) * E6 / p.quote.lambdaWad;
        if (band < q) q = band;
        if (p.quote.qEpochMax < q) q = p.quote.qEpochMax;
        return q * 9 / 10;
    }

    function _scenario(uint256 id, int256 bps, uint8 kind) internal returns (Row memory r) {
        uint160 sp0 = _slot0();
        uint256 fair = _usdForSqrtPrice(sp0);
        (int256 u0, int256 d0) = _wealth(fair);
        _pushAsMallory(_pushedSqrt(fair, bps));
        if (kind == 0) _steerSqrt(sp0);
        _nextBlock(1);
        uint256 q = _maxQ(id, _modelQuote(id).ask);
        if (q != 0) _swap(mallory, id, true, true, false, q, true);
        if (kind == 1) _steerSqrt(sp0);
        if (kind == 2) _pushAsMallory(sp0);
        _nextBlock(1);
        if (q != 0) _swap(mallory, id, true, false, true, q, true);
        (int256 u1, int256 d1) = _wealth(fair);
        r.gain = u1 - u0;
        r.cost = d0 - d1;
    }

    /// @dev Scenarios A, B and C from the same state, logged as one table row
    function _row(uint256 id, int256 bps) internal returns (Row memory a, Row memory b, Row memory c) {
        uint256 snap = vm.snapshotState();
        a = _scenario(id, bps, 0);
        vm.revertToState(snap);
        b = _scenario(id, bps, 1);
        vm.revertToState(snap);
        c = _scenario(id, bps, 2);
        vm.revertToState(snap);
        string memory ra = string.concat(_sdec(a.gain, 6, 2), " ", _sdec(a.cost, 6, 2));
        string memory rb =
            string.concat(_sdec(b.gain, 6, 2), " ", _sdec(b.cost, 6, 2), " ", _sdec(b.gain - b.cost, 6, 2));
        string memory rc =
            string.concat(_sdec(c.gain, 6, 2), " ", _sdec(c.cost, 6, 2), " ", _sdec(c.gain - c.cost, 6, 2));
        console2.log(string.concat("  ", vm.toString(bps), " | ", ra, " | ", rb, " | ", rc));
    }

    function _header(string memory what) internal pure {
        console2.log(what);
        console2.log("  push bps | A: gain cost | B: gain cost net | C: gain cost net   (USD)");
    }

    function test_multiBlockPush_costVsGain_demoConfig() public {
        uint256 id = _market(address(oracle), 10 * E6, uint128(100 * E6), 0.001e18);
        _nextBlock(10);
        int16[6] memory pushes = [int16(-3), -5, -10, -25, -50, -100];
        _header("demo depth (L = 1e18), the keeper's demo market (budget 10 USDC, 100-token cap)");
        int256 prevCostB;
        for (uint256 i; i < pushes.length; ++i) {
            (Row memory a, Row memory b, Row memory c) = _row(id, pushes[i]);
            assertLt(a.gain, 0, "A: a backrun push leaves a fair start-of-block price, the spread is lost");
            assertGt(a.cost, 0);
            assertLt(b.gain - b.cost, 0, "B: unprofitable at demo depth and budget");
            assertLt(c.gain - c.cost, 0, "C: unprofitable at demo depth and budget, even paying fees only");
            assertLe(b.gain, int256(10 * E6), "gain capped by the 10 USDC budget");
            assertGe(b.cost, prevCostB, "cost grows with the push");
            prevCostB = b.cost;
        }
    }

    /// @dev RESIDUAL RISK, kept as an explicit expectation: on a thin pool with a 100x budget, a push that survives a
    ///      block boundary (B, C) pays. The SoB oracle removes the atomic attack only; what bounds this one is the
    ///      budget and epoch cap (gain saturates near 387 USDC here) against pool depth (cost grows ~quadratically).
    function test_multiBlockPush_thinPool_residualRisk() public {
        _thinPool();
        uint256 id = _scaledMarket(address(oracle));
        _nextBlock(10);
        int16[5] memory pushes = [int16(-3), -10, -25, -50, -100];
        _header("thin pool (L = 5.2e16), 100x demo market (budget 1,000 USDC)");
        for (uint256 i; i < pushes.length; ++i) {
            (Row memory a, Row memory b, Row memory c) = _row(id, pushes[i]);
            assertLt(a.gain, 0, "A: backrun -> fair SoB -> spread lost");
            assertLe(b.gain, int256(1_000 * E6), "B: gain capped by the budget");
            assertGt(b.cost, 0);
            assertGt(c.cost, 0);
            if (pushes[i] <= -10) {
                assertGt(b.gain - b.cost, 0, "known: a cross-block push pays on a thin pool with a large budget");
            }
        }
    }

    /// @dev At demo depth, flipping a demo market whose TWAP sits 3 ticks (0.03%) past the strike with a last-second
    ///      push costs several times the market's whole 10 USDC budget, the most any outcome can pay the attacker
    function test_settlementFlip_costAtDemoDepth() public {
        SettleCase memory c = _heldMarket(10 * E6);
        int256 flip = (c.marginWad + 1e18 - 1) / 1e18;
        (bool yesWon, int256 cost) = _lastSecondPush(c, flip);
        assertFalse(yesWon, "flipped");
        assertGt(cost, int256(5 * 10 * E6), "flip costs over 5x the market budget");
    }

    /// @dev Replaces the demo-depth position with a thin one (the steerer owns it)
    function _thinPool() internal {
        (int24 lo, int24 hi) = steerer.fullRange(ETH_SPACING);
        vm.startPrank(mirror);
        steerer.removeLiquidity(ethKey, lo, hi, DEMO_LIQUIDITY - 5.2e16);
        vm.stopPrank();
    }
}
