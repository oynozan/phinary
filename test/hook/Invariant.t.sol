// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./HookFixture.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Random trades, same-epoch round trips and complete sets, warps, oracle moves, minute-long market
///         lifecycles (trade, settle or INVALID, redeem through swaps and redeem(), sweep), random settlement actions
///         and vault flows. Calls that must succeed are made directly, so fail_on_revert catches them; calls that may
///         legitimately halt are caught and their revert reason must be on an allowlist, otherwise `unexpected` grows.
contract HookHandler is Test {
    PredictionHook internal hook;
    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    MockV4Router internal router;
    MockUSDC internal usdc;
    MockOracle internal oracle;
    int256 internal lnK;

    uint256 internal constant MAX_RANDOM_MARKETS = 12;
    uint256 internal constant MAX_MARKETS = 80;
    uint256 internal constant E6 = 1e6;

    address[] public actors;
    address[] public lps;
    uint256 public roundTripViolations;
    uint256 public roundTrips;
    uint256 public setViolations;
    uint256 public sets;
    uint256 public unexpected;
    bytes public lastUnexpected;
    mapping(bytes32 => uint256) public ok;
    mapping(bytes32 => uint256) public ko;
    mapping(bytes32 => uint256) public okRandom;
    bool internal _inLifecycle;

    constructor(
        PredictionHook hook_,
        IPoolManager manager_,
        PoolSwapTest swapRouter_,
        MockV4Router router_,
        MockUSDC usdc_,
        MockOracle oracle_,
        int256 lnK_
    ) {
        hook = hook_;
        manager = manager_;
        swapRouter = swapRouter_;
        router = router_;
        usdc = usdc_;
        oracle = oracle_;
        lnK = lnK_;
        for (uint256 i; i < 3; ++i) {
            address a = address(uint160(0xA11CE0 + i));
            actors.push(a);
            usdc.mint(a, 2_000_000e6);
            vm.startPrank(a);
            usdc.approve(address(swapRouter), type(uint256).max);
            usdc.approve(address(router), type(uint256).max);
            manager.setOperator(address(swapRouter), true);
            vm.stopPrank();
        }
        for (uint256 i; i < 2; ++i) {
            address l = address(uint160(0x1B0 + i));
            lps.push(l);
            usdc.mint(l, 5_000_000e6);
            vm.prank(l);
            usdc.approve(address(hook), type(uint256).max);
        }
    }

    function approveMarket(uint256 id) public {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        for (uint256 j; j < actors.length; ++j) {
            vm.startPrank(actors[j]);
            OutcomeToken(i.yes).approve(address(swapRouter), type(uint256).max);
            OutcomeToken(i.no).approve(address(swapRouter), type(uint256).max);
            OutcomeToken(i.yes).approve(address(router), type(uint256).max);
            OutcomeToken(i.no).approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    /* Revert classification */

    function _inner(bytes memory err) internal pure returns (bytes4 sel) {
        if (err.length < 4) return bytes4(0);
        sel = bytes4(err);
        if (sel != CustomRevert.WrappedError.selector) return sel;
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = err[i + 4];
        }
        (,, bytes memory reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
        return reason.length < 4 ? bytes4(0) : bytes4(reason);
    }

    function _expected(bytes memory err, bytes4[] memory allowed) internal returns (bool) {
        bytes4 sel = _inner(err);
        for (uint256 i; i < allowed.length; ++i) {
            if (sel == allowed[i]) return true;
        }
        unexpected++;
        lastUnexpected = err;
        return false;
    }

    function _swapHalts() internal pure returns (bytes4[] memory a) {
        a = new bytes4[](8);
        a[0] = PredictionHook.OutOfBand.selector;
        a[1] = PredictionHook.EpochCapExceeded.selector;
        a[2] = PredictionHook.Insolvent.selector;
        a[3] = PredictionHook.ZeroAmount.selector;
        a[4] = PredictionHook.NotTradable.selector;
        a[5] = PredictionHook.MarketClosed.selector;
        a[6] = QuoteMath.Band.selector;
        a[7] = QuoteMath.Unreachable.selector;
    }

    function _one(bytes4 s) internal pure returns (bytes4[] memory a) {
        a = new bytes4[](1);
        a[0] = s;
    }

    function _two(bytes4 s, bytes4 t) internal pure returns (bytes4[] memory a) {
        a = new bytes4[](2);
        a[0] = s;
        a[1] = t;
    }

    /* Helpers */

    function _id(uint256 seed) internal view returns (uint256) {
        return 1 + seed % hook.marketCount();
    }

    function _tradable(uint256 id) internal view returns (bool) {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        return i.status == IPredictionHook.Status.Trading && block.timestamp >= i.openTime
            && block.timestamp + i.window + i.cutoffBuffer < i.expiry;
    }

    /// @dev The first tradable market at or after the seeded one, else a fresh minute-scale market while under the cap
    function _liveId(uint256 seed) internal returns (uint256) {
        uint256 n = hook.marketCount();
        for (uint256 j; j < n; ++j) {
            uint256 id = 1 + (seed % n + j) % n;
            if (_tradable(id)) return id;
        }
        if (n >= MAX_MARKETS) return _id(seed);
        _ensureIdle();
        uint256 fresh = hook.createMarket(_shortMarket(seed, oracle.lnSpot() + int256(seed % 11) * 1e13 - 5e13));
        approveMarket(fresh);
        ok["create"]++;
        return fresh;
    }

    /// @dev A tradable market where `a` holds at least `min` of the token (ERC-20, or claims when `claims`), else 0
    function _heldLiveId(uint256 seed, address a, bool isYes, bool claims, uint256 min) internal view returns (uint256) {
        uint256 n = hook.marketCount();
        for (uint256 j; j < n; ++j) {
            uint256 id = 1 + (seed % n + j) % n;
            if (!_tradable(id)) continue;
            OutcomeToken t = _tok(id, isYes);
            uint256 bal = claims ? manager.balanceOf(a, uint160(address(t))) : t.balanceOf(a);
            if (bal >= min) return id;
        }
        return 0;
    }

    function _ensureIdle() internal {
        if (hook.vaultIdle() < 80_000e6) {
            vm.prank(lps[0]);
            hook.deposit(200_000e6);
        }
    }

    function _key(uint256 id, bool isYes) internal view returns (PoolKey memory) {
        (PoolKey memory ky, PoolKey memory kn) = hook.poolKeys(id);
        return isYes ? ky : kn;
    }

    function _tok(uint256 id, bool isYes) internal view returns (OutcomeToken) {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        return OutcomeToken(isYes ? i.yes : i.no);
    }

    function _params(PoolKey memory k, bool isBuy, bool exactIn, uint256 amt)
        internal
        view
        returns (SwapParams memory)
    {
        bool zf1 = isBuy == (Currency.unwrap(k.currency0) == address(usdc));
        return SwapParams({
            zeroForOne: zf1,
            amountSpecified: exactIn ? -int256(amt) : int256(amt),
            sqrtPriceLimitX96: zf1 ? 4295128740 : 1461446703485210103287273052203988822378723970341
        });
    }

    function _plan(PoolKey memory k, bool isBuy, bool exactIn, uint256 amt) internal view returns (bytes memory) {
        SwapParams memory p = _params(k, isBuy, exactIn, amt);
        Currency inC = p.zeroForOne ? k.currency0 : k.currency1;
        Currency outC = p.zeroForOne ? k.currency1 : k.currency0;
        Plan memory plan = Planner.init();
        if (exactIn) {
            plan = plan.add(
                Actions.SWAP_EXACT_IN_SINGLE,
                abi.encode(IV4Router.ExactInputSingleParams(k, p.zeroForOne, uint128(amt), 0, 0, ""))
            );
        } else {
            plan = plan.add(
                Actions.SWAP_EXACT_OUT_SINGLE,
                abi.encode(IV4Router.ExactOutputSingleParams(k, p.zeroForOne, uint128(amt), type(uint128).max, 0, ""))
            );
        }
        plan = plan.add(Actions.SETTLE_ALL, abi.encode(inC, type(uint256).max));
        plan = plan.add(Actions.TAKE_ALL, abi.encode(outC, 0));
        return plan.encode();
    }

    function _topUp(address a) internal {
        if (usdc.balanceOf(a) < 500_000e6) usdc.mint(a, 1_000_000e6);
    }

    function _held(address a, OutcomeToken t) internal view returns (uint256) {
        return t.balanceOf(a) + manager.balanceOf(a, uint160(address(t)));
    }

    /// @dev via 0: PoolSwapTest with ERC-20s, 1: PoolSwapTest with ERC-6909 claims, 2: V4Router
    function _swapCall(address a, PoolKey memory k, bool isBuy, bool exactIn, uint256 amt, uint8 via)
        internal
        returns (bool success, bytes memory err)
    {
        vm.startPrank(a);
        if (via == 2) {
            try router.executeActions(_plan(k, isBuy, exactIn, amt)) {
                success = true;
            } catch (bytes memory e) {
                err = e;
            }
        } else {
            PoolSwapTest.TestSettings memory ts = PoolSwapTest.TestSettings(via == 1 && isBuy, via == 1 && !isBuy);
            try swapRouter.swap(k, _params(k, isBuy, exactIn, amt), ts, "") {
                success = true;
            } catch (bytes memory e) {
                err = e;
            }
        }
        vm.stopPrank();
    }

    /// @dev A swap that may halt; returns success and the actor's absolute USDC and token movements
    function _swap(address a, uint256 id, bool isYes, bool isBuy, bool exactIn, uint256 amt, uint8 via)
        internal
        returns (bool success, uint256 dUsdc, uint256 dTok)
    {
        OutcomeToken t = _tok(id, isYes);
        _topUp(a);
        uint256 u0 = usdc.balanceOf(a) + manager.balanceOf(a, uint160(address(usdc)));
        uint256 t0 = _held(a, t);
        bytes memory err;
        (success, err) = _swapCall(a, _key(id, isYes), isBuy, exactIn, amt, via);
        uint256 u1 = usdc.balanceOf(a) + manager.balanceOf(a, uint160(address(usdc)));
        uint256 t1 = _held(a, t);
        dUsdc = u1 > u0 ? u1 - u0 : u0 - u1;
        dTok = t1 > t0 ? t1 - t0 : t0 - t1;
        bytes32 tag = keccak256(abi.encode(isBuy, exactIn));
        if (success) {
            ok[tag]++;
            if (!_inLifecycle) okRandom[tag]++;
        } else {
            ko[tag]++;
            _expected(err, _swapHalts());
        }
    }

    /// @dev A swap that must succeed; returns the actor's absolute USDC and token movements
    function _mustSwap(address a, uint256 id, bool isYes, bool isBuy, bool exactIn, uint256 amt, uint8 via)
        internal
        returns (uint256 dUsdc, uint256 dTok)
    {
        bool success;
        (success, dUsdc, dTok) = _swap(a, id, isYes, isBuy, exactIn, amt, via);
        if (!success) revert("required swap failed");
    }

    /// @dev Sell size for an exact-out sell that the balance always covers: avg price >= pMin = 0.02, so q <= 50 * cash
    function _exactOutSellCap(uint256 bal) internal pure returns (uint256) {
        return bal / 51;
    }

    /* Trading actions */

    function buy(uint256 who, uint256 m, bool isYes, bool exactIn, uint256 amt, uint8 via) public {
        uint256 id = _liveId(m);
        amt = bound(amt, 1, exactIn ? 20_000e6 : 30_000e6);
        _swap(actors[who % actors.length], id, isYes, true, exactIn, amt, via % 3);
    }

    function buyAgain(uint256 who, uint256 m, bool isYes, bool exactIn, uint256 amt, uint8 via) external {
        buy(who, m, isYes, exactIn, amt, via);
    }

    function sell(uint256 who, uint256 m, bool isYes, bool exactIn, uint256 amt, uint8 via) public {
        address a = actors[who % actors.length];
        via = via % 3;
        uint256 id = _heldLiveId(m, a, isYes, via == 1, exactIn ? 1 : 51);
        if (id == 0) return;
        OutcomeToken t = _tok(id, isYes);
        uint256 bal = via == 1 ? manager.balanceOf(a, uint160(address(t))) : t.balanceOf(a);
        uint256 cap = exactIn ? bal : _exactOutSellCap(bal);
        if (cap == 0) return;
        _swap(a, id, isYes, false, exactIn, bound(amt, 1, cap), via);
    }

    /// @dev Same token, same epoch: buy then sell back what was bought, or sell then buy back what was sold
    function sellAgain(uint256 who, uint256 m, bool isYes, bool exactIn, uint256 amt, uint8 via) external {
        sell(who, m, isYes, exactIn, amt, via);
    }

    function roundTrip(uint256 who, uint256 m, bool isYes, uint256 amt, uint8 mode) public {
        address a = actors[who % actors.length];
        mode = mode % 4;
        uint256 id = mode < 2 ? _liveId(m) : _heldLiveId(m, a, isYes, false, 51);
        if (id == 0) return;
        OutcomeToken t = _tok(id, isYes);
        bool s1;
        bool s2;
        uint256 paid;
        uint256 got;
        uint256 q;
        if (mode == 0) {
            (s1, paid, q) = _swap(a, id, isYes, true, true, bound(amt, 1e6, 5_000e6), 0);
            if (!s1 || q == 0) return;
            (s2, got,) = _swap(a, id, isYes, false, true, q, 2);
        } else if (mode == 1) {
            (s1, paid, q) = _swap(a, id, isYes, true, false, bound(amt, 1e6, 8_000e6), 2);
            if (!s1) return;
            (s2, got,) = _swap(a, id, isYes, false, true, q, 0);
        } else if (mode == 2) {
            uint256 bal = t.balanceOf(a);
            if (bal == 0) return;
            (s1, got, q) = _swap(a, id, isYes, false, true, bound(amt, 1, bal), 2);
            if (!s1) return;
            (s2, paid,) = _swap(a, id, isYes, true, false, q, 0);
        } else {
            uint256 cap = _exactOutSellCap(t.balanceOf(a));
            if (cap == 0) return;
            (s1, got, q) = _swap(a, id, isYes, false, false, bound(amt, 1, cap), 0);
            if (!s1) return;
            (s2, paid,) = _swap(a, id, isYes, true, false, q, 2);
        }
        if (!s2) return;
        roundTrips++;
        if (got > paid) roundTripViolations++;
    }

    /// @dev Opposite tokens, same epoch: a complete set bought costs >= q, a complete set sold returns <= q
    function roundTripAgain(uint256 who, uint256 m, bool isYes, uint256 amt, uint8 mode) external {
        roundTrip(who, m, isYes, amt, mode);
    }

    function completeSet(uint256 who, uint256 m, uint256 amt, bool isBuy, bool yesFirst, bool firstExactIn, uint8 via)
        public
    {
        address a = actors[who % actors.length];
        uint256 id = isBuy ? _liveId(m) : _heldLiveId(m, a, yesFirst, false, 51);
        if (id == 0 || (!isBuy && _tok(id, !yesFirst).balanceOf(a) < 51)) return;
        uint8 v1 = via % 2 == 0 ? 0 : 2;
        uint8 v2 = (via >> 1) % 2 == 0 ? 0 : 2;
        bool s1;
        bool s2;
        uint256 c1;
        uint256 c2;
        uint256 q;
        uint256 q2;
        if (isBuy) {
            amt = bound(amt, 1e6, firstExactIn ? 3_000e6 : 8_000e6);
            (s1, c1, q) = _swap(a, id, yesFirst, true, firstExactIn, amt, v1);
            if (!s1 || q == 0) return;
            (s2, c2, q2) = _swap(a, id, !yesFirst, true, false, q, v2);
        } else {
            uint256 by = _tok(id, yesFirst).balanceOf(a);
            uint256 bn = _tok(id, !yesFirst).balanceOf(a);
            uint256 bal = by < bn ? by : bn;
            uint256 cap = firstExactIn ? bal : _exactOutSellCap(bal);
            if (cap == 0) return;
            (s1, c1, q) = _swap(a, id, yesFirst, false, firstExactIn, bound(amt, 1, cap), v1);
            if (!s1 || q > bn) return;
            (s2, c2, q2) = _swap(a, id, !yesFirst, false, true, q, v2);
        }
        if (!s2) return;
        sets++;
        if (q2 != q || (isBuy ? c1 + c2 < q : c1 + c2 > q)) setViolations++;
    }

    function completeSetAgain(
        uint256 who,
        uint256 m,
        uint256 amt,
        bool isBuy,
        bool yesFirst,
        bool firstExactIn,
        uint8 via
    ) external {
        completeSet(who, m, amt, isBuy, yesFirst, firstExactIn, via);
    }

    function warp(uint256 dt) external {
        dt = bound(dt, 1, 3 minutes);
        vm.warp(block.timestamp + dt);
        ok["warp"]++;
    }

    function moveOracle(int256 dx, uint256 v) external {
        oracle.setLnSpot(lnK + bound(dx, -0.08e18, 0.08e18));
        oracle.setVar(bound(v, uint256(0.04e36) / 31557600, uint256(4e36) / 31557600));
        ok["oracle"]++;
    }

    /* Settlement actions on random markets */

    function settle(uint256 m, int256 tick) external {
        uint256 id = _id(m);
        oracle.setFlatTick(int24(bound(tick, 79_000, 81_000)));
        try hook.settle(id) {
            ok["settle"]++;
        } catch (bytes memory e) {
            ko["settle"]++;
            _expected(e, _two(PredictionHook.TooEarly.selector, PredictionHook.MarketClosed.selector));
        }
    }

    function settleInvalid(uint256 m) external {
        uint256 id = _id(m);
        oracle.setUnavailable(true);
        try hook.settleInvalid(id) {
            ok["invalid"]++;
        } catch (bytes memory e) {
            ko["invalid"]++;
            _expected(e, _two(PredictionHook.TooEarly.selector, PredictionHook.MarketClosed.selector));
        }
        oracle.setUnavailable(false);
    }

    /// @dev Redemption of a resolved market never fails for a held amount with a nonzero payout
    function redeem(uint256 who, uint256 m, uint256 amt) external {
        uint256 id = _id(m);
        address a = actors[who % actors.length];
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        uint256 bal;
        if (i.status == IPredictionHook.Status.Settled) {
            bal = OutcomeToken(i.yesWon ? i.yes : i.no).balanceOf(a);
        } else if (i.status == IPredictionHook.Status.Invalid) {
            bal = OutcomeToken(i.yes).balanceOf(a) + OutcomeToken(i.no).balanceOf(a);
        }
        bool inv = i.status == IPredictionHook.Status.Invalid;
        if (bal < (inv ? 2 : 1)) return;
        amt = bound(amt, inv ? 2 : 1, bal);
        uint256 u0 = usdc.balanceOf(a);
        vm.prank(a);
        uint256 payout = hook.redeem(id, amt);
        assertEq(payout, inv ? amt / 2 : amt, "redeem payout");
        assertEq(usdc.balanceOf(a) - u0, payout, "redeem paid");
        ok["redeem"]++;
    }

    function sweep(uint256 m) external {
        uint256 id = _id(m);
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        if (i.status == IPredictionHook.Status.Trading) {
            try hook.sweep(id) {
                revert("swept a trading market");
            } catch (bytes memory e) {
                _expected(e, _one(PredictionHook.NotSettled.selector));
            }
            return;
        }
        _sweepChecked(id);
    }

    function _sweepChecked(uint256 id) internal {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        uint256 req = i.status == IPredictionHook.Status.Settled
            ? (i.yesWon ? i.outYes : i.outNo)
            : (i.outYes + i.outNo + 1) / 2;
        uint256 idle = hook.vaultIdle();
        uint256 amount = hook.sweep(id);
        assertEq(amount, i.bucket - req, "sweep amount");
        assertEq(hook.vaultIdle(), idle + amount, "sweep to idle");
        assertEq(hook.marketInfo(id).bucket, req, "bucket left == requirement");
        ok["sweep"]++;
    }

    /* Vault actions */

    function deposit(uint256 who, uint256 amt) external {
        amt = bound(amt, 1, 500_000e6);
        vm.prank(lps[who % lps.length]);
        try hook.deposit(amt) {
            ok["deposit"]++;
        } catch (bytes memory e) {
            ko["deposit"]++;
            _expected(e, _one(PredictionHook.ZeroAmount.selector));
        }
    }

    function withdraw(uint256 who, uint256 shares) external {
        address l = lps[who % lps.length];
        uint256 s = hook.sharesOf(l);
        if (s == 0) return;
        shares = bound(shares, 1, s);
        vm.prank(l);
        try hook.withdraw(shares) {
            ok["withdraw"]++;
        } catch (bytes memory e) {
            ko["withdraw"]++;
            _expected(e, _two(PredictionHook.InsufficientIdle.selector, PredictionHook.ZeroAmount.selector));
        }
    }

    /* Markets */

    /// @dev Minute-scale markets: window 10-129 s, cutoff 5-34 s, 30-929 s of trading
    function _shortMarket(uint256 seed, int256 lnStrike) internal view returns (IPredictionHook.MarketParams memory p) {
        p.oracle = address(oracle);
        p.lnStrikeWad = lnStrike;
        p.openTime = uint64(block.timestamp);
        p.window = uint32(10 + seed % 120);
        p.cutoffBuffer = uint32(5 + (seed >> 8) % 30);
        p.expiry = uint64(block.timestamp + p.window + p.cutoffBuffer + 30 + (seed >> 16) % 900);
        p.nSamples = uint32((seed >> 40) % 2 == 0 ? 0 : p.window / 2);
        p.budget = 20_000e6 + (seed >> 48) % 40_000e6;
        p.quote = IPredictionHook.QuoteParams({
            h0Wad: uint64(0.005e18 + (seed >> 80) % 0.03e18),
            gammaSWad: 0.0005e18,
            lambdaWad: uint128(1e11 + (seed >> 96) % 1e13),
            qEpochMax: uint128(20_000e6 + (seed >> 112) % 30_000e6),
            pMinWad: 0.02e18
        });
        p.sigmaMode = uint8((seed >> 140) % 2);
        p.fixedVarE36 = uint256(0.5e36) / 31557600;
        p.yesName = "Y";
        p.yesSymbol = "Y";
        p.noName = "N";
        p.noSymbol = "N";
    }

    function createMarket(uint256 seed) external {
        if (hook.marketCount() >= MAX_RANDOM_MARKETS) return;
        IPredictionHook.MarketParams memory p =
            _shortMarket(seed, oracle.lnSpot() + int256(seed % 41) * 1e14 - 20e14);
        try hook.createMarket(p) returns (uint256 id) {
            approveMarket(id);
            ok["create"]++;
        } catch (bytes memory e) {
            ko["create"]++;
            _expected(e, _one(PredictionHook.InsufficientIdle.selector));
        }
    }

    /* Full lifecycle of a fresh market, every step required to succeed and checked exactly */

    struct Life {
        uint256 id;
        IPredictionHook.MarketInfo info;
        bool invalid;
        bool yesWon;
        uint8 v0;
        uint8 v1;
    }

    function lifecycle(uint256 seed, uint256 amt, int256 tickOff) public {
        if (hook.marketCount() >= MAX_MARKETS) return;
        ok["lifecycle"]++;
        _inLifecycle = true;
        Life memory l;
        l.invalid = ok["lifecycle"] % 2 == 0;
        l.v0 = seed % 2 == 0 ? 0 : 2;
        l.v1 = (seed >> 1) % 2 == 0 ? 0 : 2;
        _ensureIdle();
        oracle.setVar(uint256(0.36e36) / 31557600);
        IPredictionHook.MarketParams memory p = _shortMarket(seed, oracle.lnSpot() + int256(seed % 11) * 1e13 - 5e13);
        l.id = hook.createMarket(p);
        approveMarket(l.id);

        amt = bound(amt, 10e6, 3_000e6);
        _mustSwap(actors[0], l.id, true, true, false, amt, l.v0);
        _mustSwap(actors[1], l.id, false, true, false, amt + 1e6, l.v1);
        _mustSwap(actors[2], l.id, true, true, true, amt / 2, l.v1);
        _mustSwap(actors[2], l.id, false, true, true, amt / 3, l.v0);
        vm.warp(block.timestamp + 1 + seed % 20);
        _mustSwap(actors[0], l.id, true, false, true, amt / 4, l.v1);
        _mustSwap(actors[1], l.id, false, false, false, amt / 60, l.v0);
        ok["lifeSellExactOut"]++;

        vm.warp(p.expiry + (seed >> 24) % 30);
        if (l.invalid) {
            oracle.setUnavailable(true);
            vm.warp(block.timestamp + hook.GRACE() + 1);
            hook.settleInvalid(l.id);
            oracle.setUnavailable(false);
            ok["invalid"]++;
        } else {
            int256 t0 = hook.settleThresholdOf(l.id) / (int256(uint256(p.window)) * 1e18);
            oracle.setFlatTick(int24(t0 + bound(tickOff, -2, 2)));
            hook.settle(l.id);
            ok["settle"]++;
        }
        l.info = hook.marketInfo(l.id);
        l.yesWon = l.info.yesWon;
        _redeemAll(l);
        _sweepChecked(l.id);
        uint256 again = hook.sweep(l.id);
        assertEq(again, 0, "second sweep");
        _inLifecycle = false;
    }

    function lifecycleAgain(uint256 seed, uint256 amt, int256 tickOff) external {
        lifecycle(seed, amt, tickOff);
    }

    function lifecycleThird(uint256 seed, uint256 amt, int256 tickOff) external {
        lifecycle(seed, amt, tickOff);
    }

    function _redeemAll(Life memory l) internal {
        if (l.invalid) {
            _invalidExits(l);
            return;
        }
        bool w = l.yesWon;
        address holder = actors[w ? 0 : 1];
        OutcomeToken win = _tok(l.id, w);
        uint256 bal = win.balanceOf(holder);
        (uint256 d1, uint256 q1) = _mustSwap(holder, l.id, w, false, true, bal / 3, l.v0);
        assertEq(d1, q1, "winner exact-in pays 1:1");
        ok["redeemSwapIn"]++;
        (uint256 d2, uint256 q2) = _mustSwap(holder, l.id, w, false, false, bal / 4, l.v1);
        assertEq(d2, q2, "winner exact-out pays 1:1");
        ok["redeemSwapOut"]++;
        uint256 rest = win.balanceOf(holder);
        vm.prank(holder);
        assertEq(hook.redeem(l.id, rest), rest, "redeem 1:1");
        ok["redeem"]++;

        address loser = actors[w ? 1 : 0];
        uint256 lb = _tok(l.id, !w).balanceOf(loser);
        (bool s,) = _swapCall(loser, _key(l.id, !w), false, true, lb, l.v0);
        assertFalse(s, "losing token sold after settlement");
    }

    function _invalidExits(Life memory l) internal {
        address a0 = actors[0];
        uint256 by = _tok(l.id, true).balanceOf(a0);
        (uint256 d1, uint256 q1) = _mustSwap(a0, l.id, true, false, true, by / 2, l.v0);
        assertEq(d1, q1 / 2, "invalid exact-in pays half");
        ok["redeemSwapIn"]++;
        address a1 = actors[1];
        uint256 bn = _tok(l.id, false).balanceOf(a1);
        (uint256 d2, uint256 q2) = _mustSwap(a1, l.id, false, false, false, bn / 5, l.v1);
        assertEq(q2, 2 * d2, "invalid exact-out takes two");
        ok["redeemSwapOut"]++;
        address a2 = actors[2];
        uint256 both = _tok(l.id, true).balanceOf(a2) + _tok(l.id, false).balanceOf(a2);
        vm.prank(a2);
        assertEq(hook.redeem(l.id, both), both / 2, "invalid redeem pays half");
        assertEq(_tok(l.id, true).balanceOf(a2) + _tok(l.id, false).balanceOf(a2), 0, "burned YES then NO");
        ok["redeem"]++;
    }
}

contract HookInvariantTest is HookFixture {
    HookHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new HookHandler(hook, manager, swapRouter, router, usdc, oracle, lnK);
        hook.setKeeper(address(h));
        h.approveMarket(mId);

        bytes4[] memory sel = new bytes4[](21);
        sel[0] = HookHandler.buy.selector;
        sel[1] = HookHandler.buyAgain.selector;
        sel[2] = HookHandler.sell.selector;
        sel[3] = HookHandler.sellAgain.selector;
        sel[4] = HookHandler.roundTrip.selector;
        sel[5] = HookHandler.roundTripAgain.selector;
        sel[6] = HookHandler.completeSet.selector;
        sel[7] = HookHandler.completeSetAgain.selector;
        sel[8] = HookHandler.warp.selector;
        sel[9] = HookHandler.moveOracle.selector;
        sel[10] = HookHandler.settle.selector;
        sel[11] = HookHandler.settleInvalid.selector;
        sel[12] = HookHandler.redeem.selector;
        sel[13] = HookHandler.sweep.selector;
        sel[14] = HookHandler.deposit.selector;
        sel[15] = HookHandler.withdraw.selector;
        sel[16] = HookHandler.createMarket.selector;
        sel[17] = HookHandler.createMarket.selector;
        sel[18] = HookHandler.lifecycle.selector;
        sel[19] = HookHandler.lifecycleAgain.selector;
        sel[20] = HookHandler.lifecycleThird.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: ci.invariant.fail-on-revert = true
    function invariant_ledgerAndSolvency() public view {
        _checkInvariants();
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: ci.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(h.unexpected(), 0, string(h.lastUnexpected()));
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: ci.invariant.fail-on-revert = true
    function invariant_noProfitableSameEpochRoundTripOrSet() public view {
        assertEq(h.roundTripViolations(), 0, "round trip");
        assertEq(h.setViolations(), 0, "complete set");
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: ci.invariant.fail-on-revert = true
    function invariant_poolManagerBacksClaims() public view {
        uint256 userUsdcClaims;
        for (uint256 i; i < 3; ++i) {
            userUsdcClaims += manager.balanceOf(h.actors(i), uint160(address(usdc)));
        }
        assertEq(
            usdc.balanceOf(address(manager)),
            manager.balanceOf(address(hook), uint160(address(usdc))) + userUsdcClaims,
            "PM USDC == claims"
        );
        uint256 n = hook.marketCount();
        for (uint256 id = 1; id <= n; ++id) {
            IPredictionHook.MarketInfo memory mi = hook.marketInfo(id);
            uint256 cy;
            uint256 cn;
            for (uint256 i; i < 3; ++i) {
                cy += manager.balanceOf(h.actors(i), uint160(mi.yes));
                cn += manager.balanceOf(h.actors(i), uint160(mi.no));
            }
            assertEq(OutcomeToken(mi.yes).balanceOf(address(manager)), mi.invYes + cy, "PM YES == claims");
            assertEq(OutcomeToken(mi.no).balanceOf(address(manager)), mi.invNo + cn, "PM NO == claims");
        }
    }

    /// forge-config: default.invariant.fail-on-revert = true
    /// forge-config: ci.invariant.fail-on-revert = true
    function invariant_navOrdering() public view {
        assertGe(hook.navPlus(), hook.navMinus());
    }

    function _okCount(bool isBuy, bool exactIn) internal view returns (uint256) {
        return h.ok(keccak256(abi.encode(isBuy, exactIn)));
    }

    function _rnd(bool isBuy, bool exactIn) internal view returns (uint256) {
        return h.okRandom(keccak256(abi.encode(isBuy, exactIn)));
    }

    function _koCount(bool isBuy, bool exactIn) internal view returns (uint256) {
        return h.ko(keccak256(abi.encode(isBuy, exactIn)));
    }

    /// @dev A run that never reached the post-settlement paths or never traded fails instead of passing vacuously
    function afterInvariant() public view {
        uint256 life = h.ok("lifecycle");
        console2.log("markets", hook.marketCount(), "lifecycles", life);
        console2.log("round trips", h.roundTrips(), "complete sets", h.sets());
        console2.log("random buy in / out ok", _rnd(true, true), _rnd(true, false));
        console2.log("random sell in / out ok", _rnd(false, true), _rnd(false, false));
        console2.log("buy in / out ok", _okCount(true, true), _okCount(true, false));
        console2.log("buy in / out halted", _koCount(true, true), _koCount(true, false));
        console2.log("sell in / out ok", _okCount(false, true), _okCount(false, false));
        console2.log("sell in / out halted", _koCount(false, true), _koCount(false, false));
        console2.log("settle / invalid / redeem", h.ok("settle"), h.ok("invalid"), h.ok("redeem"));
        console2.log("redeem via swap in / out, sweep", h.ok("redeemSwapIn"), h.ok("redeemSwapOut"), h.ok("sweep"));
        assertGe(life, 2, "lifecycles");
        assertGe(h.ok("settle"), 1, "settle");
        assertGe(h.ok("invalid"), 1, "invalid");
        assertGe(h.ok("redeem"), 2, "redeem");
        assertGe(h.ok("redeemSwapIn"), 2, "redeem via exact-in swap");
        assertGe(h.ok("redeemSwapOut"), 2, "redeem via exact-out swap");
        assertGe(h.ok("sweep"), 2, "sweep");
        assertGe(h.ok("lifeSellExactOut"), 2, "exact-out sell while trading");
    }
}
