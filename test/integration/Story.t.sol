// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./StackFixture.sol";
import {SandwichAttacker} from "../security/mocks/SandwichAttacker.sol";

/// @notice The Alice / Bob / Mallory / Liam walkthrough on the real stack, as a 1-day market (K = $2,800, S = $2,700,
///         sigma 60%, 4 h geometric TWAP) and as the keeper's 1-minute demo market (oracle sigma, 10 s window).
///         Every fill is checked against BinaryPricer + QuoteMath on the oracle's start-of-block inputs and against the
///         V4Quoter; ETH moves only through PriceSteerer; settlement uses the oracle cumulative, re-derived from an
///         independent record of the steered path; redemption is a swap at exactly 1.0; and the Circle USDC of all
///         four actors is conserved up to rounding in the vault's favour.
///         Run with -vv to read the narration.
contract StoryTest is StackFixture {
    address[4] internal actors;
    string[4] internal names;
    int256[4] internal startUsdc;
    SandwichAttacker internal atk;

    uint256 internal mkt;
    uint256 internal t0;
    uint256 internal expiry;
    uint256 internal window;
    uint256 internal malloryYes;
    uint256 internal malloryUsdc0;

    function setUp() public override {
        super.setUp();
        actors = [liam, alice, bob, mallory];
        names = ["Liam (LP)", "Alice", "Bob", "Mallory"];
        atk = new SandwichAttacker(manager, mallory);
        vm.label(address(atk), "MalloryBot");
    }

    /* Narrative helpers */

    function _say(string memory s) internal pure {
        console2.log(s);
    }

    function _at(string memory s) internal view {
        console2.log(string.concat(_clock(t0), " ", s));
    }

    function _usdcOf(address who) internal view returns (uint256 b) {
        b = usdc.balanceOf(who);
        if (who == mallory) b += usdc.balanceOf(address(atk));
    }

    function _snapshotStart() internal {
        for (uint256 i; i < 4; ++i) {
            startUsdc[i] = int256(_usdcOf(actors[i]));
        }
    }

    function _open(IPredictionHook.MarketParams memory p) internal {
        mkt = _create(p);
        t0 = p.openTime;
        expiry = p.expiry;
        window = p.window;
        _approveOutcomes(alice, mkt);
        _approveOutcomes(bob, mkt);
        _approveOutcomes(mallory, mkt);
    }

    /// @dev The mirror steers ETH to `usd`, the next block starts, and the oracle's SoB input is that price
    function _mirror(uint256 usd, uint256 dt) internal {
        _steerUsd(usd);
        _nextBlock(dt);
        assertApproxEqRel(_sobUsd(), usd, 1e6, "S_sob is the mirrored price");
    }

    /// @dev Mallory's demo-token wealth at the fair ETH price, in 6-decimal USD
    function _malloryDemoWealth(uint256 fairUsdWad) internal view returns (uint256) {
        uint256 w = weth.balanceOf(mallory) + weth.balanceOf(address(atk));
        uint256 d = dusdc.balanceOf(mallory) + dusdc.balanceOf(address(atk));
        return d + F.fullMulDiv(w, fairUsdWad, 1e30);
    }

    function _armMallory(uint256 usdcIn) internal {
        vm.startPrank(mallory);
        weth.faucet(1e18);
        dusdc.faucet(10_000e6);
        weth.transfer(address(atk), 1e18);
        dusdc.transfer(address(atk), 10_000e6);
        usdc.transfer(address(atk), usdcIn);
        vm.stopPrank();
    }

    /// @dev Mallory's atomic sandwich; asserts that her fill is the model fill on the (unmoved) SoB inputs
    function _malloryAtomicSandwich(uint256 usdcIn, uint256 pushBps) internal returns (uint256 yesOut, int256 demoPnl) {
        _armMallory(usdcIn);
        uint160 sp0 = _slot0();
        uint256 fair = _usdForSqrtPrice(sp0);
        uint256 demo0 = _malloryDemoWealth(fair);
        (uint256 eq,) = _modelFill(mkt, true, true, true, usdcIn);
        uint160 pushTo = _sqrtPriceForUsd(fair * (10_000 - pushBps) / 10_000);
        PoolKey memory yesKey = _poolKey(mkt, true);

        vm.prank(mallory);
        atk.attack(ethKey, pushTo, yesKey, CIRCLE_USDC, usdcIn);
        yesOut = atk.lastOut();
        _recordPath();
        uint256 pushedUsd = _usdForSqrtPrice(atk.pushedSqrtPrice());
        _say(
            string.concat(
                "  Mallory, in ONE unlock: pushes ETH $",
                _dec(fair, 18, 2),
                " -> $",
                _dec(pushedUsd, 18, 2),
                ", buys YES with ",
                _dec(usdcIn, 6, 2),
                " USDC, pushes back"
            )
        );
        _say(string.concat("    fill: ", _dec(yesOut, 6, 4), " YES, avg ", _dec(usdcIn * WAD / yesOut, 18, 4)));
        _logModel(mkt);
        assertEq(yesOut, eq, "sandwich fill == model on the start-of-block price");
        assertEq(_slot0(), sp0, "pool restored");
        assertLt(pushedUsd, fair * (10_000 - pushBps + 1) / 10_000, "the push really happened");
        demoPnl = int256(_malloryDemoWealth(fair)) - int256(demo0);
        vm.startPrank(mallory);
        atk.sweep(address(usdc));
        atk.sweep(address(_outcome(mkt, true)));
        vm.stopPrank();
    }

    function _redeemWinnings(string memory who_, address who) internal {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(mkt);
        uint256 bal = OutcomeToken(i.yesWon ? i.yes : i.no).balanceOf(who);
        if (bal != 0) {
            assertEq(_quoteV4(_poolKey(mkt, i.yesWon), false, true, bal), bal, "V4Quoter: redemption 1:1");
            (uint256 q, uint256 cash) = _swap(who, mkt, i.yesWon, false, true, bal, true);
            assertEq(cash, q, "redemption via swap at exactly 1.0");
            _say(string.concat("  ", who_, " swaps ", _dec(q, 6, 4), " winning tokens -> ", _dec(cash, 6, 4), " USDC"));
        }
        uint256 lb = OutcomeToken(i.yesWon ? i.no : i.yes).balanceOf(who);
        if (lb != 0) {
            _expectSwapRevert(who, _poolKey(mkt, !i.yesWon), false, lb, _wrapped(PredictionHook.MarketClosed.selector));
            _say(string.concat("  ", who_, "'s ", _dec(lb, 6, 4), " losing tokens are worthless: the sell reverts"));
        }
    }

    function _settleAgainstReference() internal returns (bool yesWins) {
        int256 dRef = _refD(uint32(expiry - window), uint32(expiry));
        yesWins = dRef * 1e18 > hook.settleThresholdOf(mkt);
        int256 avgLn = dRef * 99995000333308 / int256(window) + 12 * 2302585092994045684;
        _at(
            string.concat(
                "expiry. Geometric TWAP over the window $",
                _dec(uint256(F.expWad(avgLn)), 18, 2),
                " -> ",
                yesWins ? "YES wins" : "NO wins"
            )
        );
        assertEq(
            int256(oracle.cumulativeAt(uint32(expiry))) - int256(oracle.cumulativeAt(uint32(expiry - window))),
            dRef,
            "oracle cumulative == independent path integral"
        );
        vm.expectEmit(true, true, true, true, address(hook));
        emit IPredictionHook.MarketSettled(mkt, yesWins, dRef, false);
        vm.prank(keeper);
        hook.settle(mkt);
        _checkLedger();
    }

    function _closeOutAndConserve() internal {
        _say("-- Redemption: a swap at exactly 1.0 in the same swap box");
        _redeemWinnings("Alice", alice);
        _redeemWinnings("Bob", bob);
        _redeemWinnings("Mallory", mallory);
        _say("-- Close-out");
        uint256 swept = hook.sweep(mkt);
        _say(string.concat("  keeper sweeps ", _dec(swept, 6, 4), " USDC back to the vault"));
        assertEq(hook.marketInfo(mkt).bucket, 0, "every winner redeemed, bucket empty");
        _checkLedger();
        uint256 shares = hook.sharesOf(liam);
        vm.prank(liam);
        uint256 got = hook.withdraw(shares);
        _say(string.concat("  Liam withdraws all shares: ", _dec(got, 6, 6), " USDC"));
        assertEq(hook.totalShares(), 0);
        _assertConservation();
    }

    function _assertConservation() internal view {
        int256 sum;
        for (uint256 i; i < 4; ++i) {
            int256 pnl = int256(_usdcOf(actors[i])) - startUsdc[i];
            sum += pnl;
            _say(string.concat("  P&L ", names[i], ": ", _sdec(pnl, 6, 6), " USDC"));
        }
        uint256 dust = usdc.balanceOf(address(manager));
        _say(string.concat("  sum of P&L ", _sdec(sum, 6, 6), " USDC, rounding left in the vault: ", vm.toString(dust)));
        assertEq(sum + int256(dust), 0, "USDC conservation across all actors");
        assertLe(sum, 0, "rounding favours the vault");
        assertLe(dust, 2, "only the virtual-share dust stays");
        assertEq(dust, hook.vaultIdle(), "the dust is vault idle");
        _checkLedger();
    }

    /* 1-day market */

    function _oneDayParams() internal view returns (IPredictionHook.MarketParams memory p) {
        p.oracle = address(oracle);
        p.lnStrikeWad = F.lnWad(2800e18);
        p.openTime = uint64(_now());
        p.expiry = uint64(_now() + 1 days);
        p.window = 4 hours;
        p.cutoffBuffer = 5 minutes;
        p.nSamples = 4 hours;
        p.budget = 10_000 * E6;
        p.quote = IPredictionHook.QuoteParams({
            h0Wad: 0.02e18,
            gammaSWad: 0.0005e18,
            lambdaWad: 0.000005e18,
            qEpochMax: uint128(50_000 * E6),
            pMinWad: 0.02e18
        });
        p.sigmaMode = 1;
        p.fixedVarE36 = VAR_60;
        p.yesName = "YES ETH>2800 in 24h";
        p.yesSymbol = "YES-2800";
        p.noName = "NO ETH>2800 in 24h";
        p.noSymbol = "NO-2800";
    }

    function _dayOpen() internal {
        _say("=== Will ETH be above $2,800 in 24 hours? (S = $2,700, sigma 60%, settled on a 4 h geometric TWAP) ===");
        _fundUsdc(liam, 20_000 * E6);
        _fundUsdc(alice, 2_000 * E6);
        _fundUsdc(bob, 2_000 * E6);
        _fundUsdc(mallory, 2_000 * E6);
        _snapshotStart();
        _deposit(liam, 20_000 * E6);
        _say("  Liam deposits 20,000 USDC into the LP vault");
        _open(_oneDayParams());
        _say("  keeper creates the market: K $2800, expiry t+24h, window 4h, cutoff t+19h55m, budget 10,000 USDC");
    }

    function _dayTrading() internal {
        _mirror(2700e18, 10 minutes);
        _at("ETH $2700. Alice thinks ETH will rally.");
        _trade("Alice", alice, mkt, true, true, true, 300 * E6, true);
        _checkLedger();

        _warpTo(t0 + 2 hours - 1);
        _mirror(2720e18, 1);
        _at("ETH $2720. Bob takes the other side: exactly 500 NO.");
        _trade("Bob", bob, mkt, false, true, false, 500 * E6, false);

        _warpTo(t0 + 6 hours - 1);
        _mirror(2760e18, 1);
        _at("ETH $2760. Alice adds exactly 1,000 YES.");
        _trade("Alice", alice, mkt, true, true, false, 1_000 * E6, true);
        _checkLedger();
    }

    function _dayMallory() internal {
        _warpTo(t0 + 10 hours - 1);
        _mirror(2795e18, 1);
        _at("ETH $2795. Mallory tries an atomic sandwich through the ETH pool (-3%).");
        uint256 m0 = _usdcOf(mallory);
        (uint256 yesOut, int256 demoPnl) = _malloryAtomicSandwich(400 * E6, 300);
        _nextBlock(1);
        _at("next block, ETH still $2795: Mallory dumps her YES");
        _trade("Mallory", mallory, mkt, true, false, true, yesOut, true);
        int256 mPnl = int256(_usdcOf(mallory)) - int256(m0);
        _say(
            string.concat(
                "  Mallory: ",
                _sdec(mPnl, 6, 4),
                " USDC on the round trip, ",
                _sdec(demoPnl, 6, 4),
                " USD of ETH-pool fees"
            )
        );
        assertLt(mPnl, 0, "the sandwich loses the spread");
        assertLe(demoPnl, 0, "and the ETH-pool round trip costs fees");
        _checkLedger();
    }

    function _dayLate() internal {
        _warpTo(t0 + 14 hours - 1);
        _mirror(2830e18, 1);
        _at("ETH $2830. Alice takes some profit.");
        _trade("Alice", alice, mkt, true, false, true, 1_500 * E6, false);

        _warpTo(t0 + 18 hours - 1);
        _mirror(2815e18, 1);
        _at("ETH $2815. Bob doubles down on NO.");
        _trade("Bob", bob, mkt, false, true, true, 200 * E6, true);
        _checkLedger();

        uint256 cutoff = expiry - window - 5 minutes;
        _warpTo(cutoff - 1);
        _at("the last tradable second");
        _trade("Alice", alice, mkt, true, true, true, 50 * E6, true);
        _warpTo(cutoff);
        _at("cutoff (T - 4h - 5m): Bob's buy halts");
        _expectSwapRevert(bob, _poolKey(mkt, false), true, 10 * E6, _wrapped(PredictionHook.NotTradable.selector));
        assertFalse(hook.quote(mkt).tradable, "quote: not tradable");
    }

    function _dayWindow() internal {
        _at("settlement window: the mirror follows ETH every 20 minutes");
        uint256[12] memory path = [
            uint256(2840e18),
            2855e18,
            2830e18,
            2862e18,
            2848e18,
            2870e18,
            2851e18,
            2839e18,
            2866e18,
            2858e18,
            2845e18,
            2872e18
        ];
        for (uint256 i; i < path.length; ++i) {
            _warpTo(expiry - window + i * 20 minutes);
            _steerUsd(path[i]);
        }
        _warpTo(expiry);
    }

    function test_story_oneDayMarket() public {
        _dayOpen();
        _dayTrading();
        _dayMallory();
        _dayLate();
        _dayWindow();
        assertTrue(_settleAgainstReference(), "story path settles YES");
        _closeOutAndConserve();
    }

    /* 1-minute demo market */

    /// @dev Mirror pre-history: a +/- sigma*sqrt(dt) walk at 60% so the oracle's variance estimator is warm
    function _preHistory(uint256 steps, uint256 dt, uint256 seed) internal {
        uint256 s = _spotUsd();
        uint256 stepWad = F.sqrt(uint256(0.36e36) * dt / YEAR);
        for (uint256 i; i < steps; ++i) {
            _nextBlock(dt);
            bool up = uint256(keccak256(abi.encode(seed, i))) & 1 == 1;
            s = up ? s * (WAD + stepWad) / WAD : s * (WAD - stepWad) / WAD;
            _steerUsd(s);
        }
    }

    /// @dev Offset from the strike in 0.1 bp: a gentle wiggle while trading, +3 bp through the settlement window
    function _demoOffset(uint256 t) internal pure returns (int256) {
        int8[12] memory wiggle = [int8(0), 5, 10, 15, 10, 5, 0, -5, -10, -15, -10, -5];
        if (t >= 48) return 30;
        return wiggle[t % 12];
    }

    function _demoOpen() internal returns (uint256 strikeUsd) {
        _say("=== The live demo: a keeper-made 1-minute market (window 10 s, cutoff 2 s, 10 samples, oracle sigma) ===");
        _preHistory(300, 2, 42);
        (uint256 v, bool warm) = oracle.varianceE36();
        assertTrue(warm, "oracle variance warm after 10 minutes of mirror steps");
        _say(string.concat("  oracle sigma after 10 min of mirror steps: ", _dec(F.sqrt(v * YEAR) * 100, 18, 1), "%"));
        _fundUsdc(liam, 100 * E6);
        _fundUsdc(alice, 20 * E6);
        _fundUsdc(bob, 20 * E6);
        _fundUsdc(mallory, 20 * E6);
        _snapshotStart();
        _deposit(liam, 100 * E6);
        _nextBlock(1);
        IPredictionHook.MarketParams memory p = _demoParams();
        _open(p);
        strikeUsd = uint256(F.expWad(p.lnStrikeWad));
        _say(
            string.concat(
                "  keeper creates: YES ETH>$", _dec(strikeUsd, 18, 2), " at t0+60s (strike = S_sob to the cent)"
            )
        );
    }

    function _demoSecond(uint256 s) internal {
        if (s == 3) {
            _at("Alice buys YES for 2 USDC");
            _trade("Alice", alice, mkt, true, true, true, 2 * E6, true);
        } else if (s == 8) {
            _at("Bob buys exactly 4 NO");
            _trade("Bob", bob, mkt, false, true, false, 4 * E6, false);
        } else if (s == 15) {
            _at("Mallory sandwiches through the ETH pool (-0.5%)");
            malloryUsdc0 = _usdcOf(mallory);
            (malloryYes,) = _malloryAtomicSandwich(1 * E6, 50);
        } else if (s == 16) {
            _at("Mallory dumps her YES at the fair bid");
            _trade("Mallory", mallory, mkt, true, false, true, malloryYes, true);
            int256 pnl = int256(_usdcOf(mallory)) - int256(malloryUsdc0);
            _say(string.concat("  Mallory: ", _sdec(pnl, 6, 4), " USDC"));
            assertLt(pnl, 0, "the sandwich loses the spread");
        } else if (s == 25) {
            _at("Alice sells 1 YES");
            _trade("Alice", alice, mkt, true, false, true, 1 * E6, false);
        } else if (s == 40) {
            _at("Bob buys NO for 1 USDC");
            _trade("Bob", bob, mkt, false, true, true, 1 * E6, true);
        } else if (s == 47) {
            _at("last tradable second: Alice buys YES for 0.5 USDC");
            _trade("Alice", alice, mkt, true, true, true, 0.5e6, true);
        } else if (s == 48) {
            _at("cutoff: trading halts");
            _expectSwapRevert(bob, _poolKey(mkt, false), true, 1 * E6, _wrapped(PredictionHook.NotTradable.selector));
        }
    }

    function test_story_oneMinuteDemoMarket() public {
        uint256 strikeUsd = _demoOpen();
        while (_now() < expiry) {
            _nextBlock(1);
            uint256 s = _now() - t0;
            uint256 prev = _spotUsd();
            _steerUsd(uint256(int256(strikeUsd) * (100_000 + _demoOffset(s)) / 100_000));
            assertApproxEqRel(_sobUsd(), prev, 1e6, "this block's steer is not in this block's S_sob");
            _demoSecond(s);
            if (_now() < expiry) _checkLedger();
        }
        assertEq(_now(), expiry, "at expiry");
        assertTrue(_settleAgainstReference(), "ETH held +3 bp through the window");
        _closeOutAndConserve();
    }
}
