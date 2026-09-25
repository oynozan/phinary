// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {MockV4Router} from "v4-periphery/test/mocks/MockV4Router.sol";
import {Planner, Plan} from "v4-periphery/test/shared/Planner.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {V4Quoter} from "v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {PredictionHook} from "../../src/PredictionHook.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
import {IUnderlyingOracle} from "../../src/interfaces/IUnderlyingOracle.sol";
import {UnderlyingOracleHook} from "../../src/oracle/UnderlyingOracleHook.sol";
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {DemoToken} from "../../src/demo/DemoToken.sol";
import {PriceSteerer} from "../../src/demo/PriceSteerer.sol";
import {BinaryPricer} from "../../src/math/BinaryPricer.sol";
import {QuoteMath} from "../../src/math/QuoteMath.sol";
import {CircleUSDC} from "./mocks/CircleUSDC.sol";

/// @notice The real demo stack on a fresh PoolManager. Circle-like USDC sits at the Unichain Sepolia address, demo WETH
///         and demo USDC form the ETH/USDC pool hooked by UnderlyingOracleHook and moved only by PriceSteerer (the
///         price mirror), and PredictionHook sits at its flagged address next to PoolSwapTest, a V4Router and the
///         V4Quoter.
/// @dev Time is read with vm.getBlockTimestamp() because via-IR may reuse an earlier block.timestamp after vm.warp.
///      Every underlying price change goes through `_steer*` or `_recordPath`, which feed an independent record of the
///      normalised tick path used to recompute the settlement statistic.
abstract contract StackFixture is Test, Deployers {
    using StateLibrary for IPoolManager;

    uint160 internal constant PREDICTION_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.BEFORE_DONATE_FLAG
    );
    uint160 internal constant ORACLE_FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
    address internal constant CIRCLE_USDC = 0x31d0220469e10c4E71834a79b1f276d740d3768F;
    address internal constant ADDR_LO = address(uint160(0x1000000000000000000000000000000000000000));
    address internal constant ADDR_HI = address(uint160(0xE000000000000000000000000000000000000000));
    uint24 internal constant ETH_FEE = 500;
    int24 internal constant ETH_SPACING = 10;
    uint256 internal constant YEAR = 31_557_600;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant E6 = 1e6;
    uint256 internal constant VAR_60 = uint256(0.36e36) / YEAR;
    uint32 internal constant T0 = 1_790_000_000;
    /// @dev Demo deploy depth (bot/README.md): about 19,200 dWETH and 52M dUSDC full range at $2,700
    uint128 internal constant DEMO_LIQUIDITY = 1e18;

    CircleUSDC internal usdc;
    DemoToken internal weth;
    DemoToken internal dusdc;
    PriceSteerer internal steerer;
    UnderlyingOracleHook internal oracle;
    PredictionHook internal hook;
    MockV4Router internal router;
    V4Quoter internal quoter;
    PoolKey internal ethKey;
    int256 internal sign;

    address internal keeper = makeAddr("keeper");
    address internal mirror = makeAddr("mirror");
    address internal liam = makeAddr("liam");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    uint32[] internal pathT;
    int256[] internal pathTick;

    struct ModelQuote {
        int256 x;
        uint256 varE36;
        uint256 tau;
        uint256 mid;
        uint256 ask;
        uint256 bid;
    }

    /* Configuration */

    function _wethIsCurrency0() internal pure virtual returns (bool) {
        return true;
    }

    function _ethLiquidity() internal pure virtual returns (uint128) {
        return DEMO_LIQUIDITY;
    }

    function _oracleCardinality() internal pure virtual returns (uint16) {
        return 4096;
    }

    function setUp() public virtual {
        vm.warp(T0);
        vm.roll(1_000);
        deployFreshManagerAndRouters();

        deployCodeTo("test/integration/mocks/CircleUSDC.sol:CircleUSDC", abi.encode(address(this)), CIRCLE_USDC);
        usdc = CircleUSDC(CIRCLE_USDC);
        (address wethAt, address dusdcAt) = _wethIsCurrency0() ? (ADDR_LO, ADDR_HI) : (ADDR_HI, ADDR_LO);
        deployCodeTo(
            "src/demo/DemoToken.sol:DemoToken",
            abi.encode("Demo Wrapped Ether", "dWETH", uint8(18), 1e18, 5e18, address(this)),
            wethAt
        );
        deployCodeTo(
            "src/demo/DemoToken.sol:DemoToken",
            abi.encode("Demo USD Coin", "dUSDC", uint8(6), 10_000e6, 50_000e6, address(this)),
            dusdcAt
        );
        weth = DemoToken(wethAt);
        dusdc = DemoToken(dusdcAt);
        sign = _wethIsCurrency0() ? int256(1) : int256(-1);

        steerer = new PriceSteerer(manager, mirror);
        weth.setMinter(address(steerer), true);
        dusdc.setMinter(address(steerer), true);

        address o = address(ORACLE_FLAGS | (uint160(0x5555) << 144));
        deployCodeTo(
            "src/oracle/UnderlyingOracleHook.sol:UnderlyingOracleHook",
            abi.encode(
                manager,
                dusdcAt,
                Currency.wrap(wethAt),
                uint32(60),
                uint16(60),
                uint16(3),
                uint32(400),
                _annualToE36(0.2e18),
                _annualToE36(2.5e18),
                _annualToE36(0.6e18),
                _oracleCardinality(),
                address(this)
            ),
            o
        );
        oracle = UnderlyingOracleHook(o);
        ethKey = PoolKey(Currency.wrap(ADDR_LO), Currency.wrap(ADDR_HI), ETH_FEE, ETH_SPACING, IHooks(o));
        manager.initialize(ethKey, _sqrtPriceForUsd(2700e18));
        vm.prank(mirror);
        steerer.addLiquidityFullRange(ethKey, _ethLiquidity());
        _recordPath();

        address h = address(PREDICTION_FLAGS | (uint160(0x4444) << 144));
        deployCodeTo("src/PredictionHook.sol:PredictionHook", abi.encode(manager, CIRCLE_USDC, address(this)), h);
        hook = PredictionHook(h);
        hook.setKeeper(keeper);
        router = new MockV4Router(manager);
        quoter = new V4Quoter(manager);

        vm.label(CIRCLE_USDC, "USDC");
        vm.label(wethAt, "dWETH");
        vm.label(dusdcAt, "dUSDC");
        vm.label(o, "UnderlyingOracleHook");
        vm.label(h, "PredictionHook");
        vm.label(address(steerer), "PriceSteerer");
    }

    /* Time */

    function _now() internal view returns (uint32) {
        return uint32(vm.getBlockTimestamp());
    }

    function _nextBlock(uint256 dt) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    function _warpTo(uint256 ts) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(ts);
    }

    /* Underlying price (ETH/USD) */

    function _annualToE36(uint256 sigmaWad) internal pure returns (uint256) {
        return sigmaWad * sigmaWad / YEAR;
    }

    function _sqrtPriceForUsd(uint256 usdWad) internal pure returns (uint160) {
        if (_wethIsCurrency0()) return uint160(F.sqrt(F.fullMulDiv(usdWad, 1 << 192, 1e30)));
        return uint160(F.sqrt(F.fullMulDiv(1e30, 1 << 192, usdWad)));
    }

    function _usdForSqrtPrice(uint160 sp) internal pure returns (uint256) {
        if (_wethIsCurrency0()) return F.fullMulDiv(uint256(sp) * 1e15, uint256(sp) * 1e15, 1 << 192);
        return F.fullMulDiv(F.fullMulDiv(1e30, 1 << 96, sp), 1 << 96, sp);
    }

    /// @dev One wei above the raw tick boundary, so the pool's tick is that tick whichever way the swap moved
    function _sqrtAtNormTick(int256 k) internal view returns (uint160) {
        return TickMath.getSqrtPriceAtTick(int24(sign > 0 ? k : -k - 1)) + 1;
    }

    function _slot0() internal view returns (uint160 sp) {
        (sp,,,) = manager.getSlot0(ethKey.toId());
    }

    function _normTick() internal view returns (int256) {
        (, int24 raw,,) = manager.getSlot0(ethKey.toId());
        return sign > 0 ? int256(raw) : -int256(raw) - 1;
    }

    function _spotUsd() internal view returns (uint256) {
        return _usdForSqrtPrice(_slot0());
    }

    function _sobUsd() internal view returns (uint256) {
        return uint256(F.expWad(oracle.lnSpotSoBWad()));
    }

    /// @dev The price mirror: PriceSteerer.steer to the exact sqrtPrice of `usdWad`
    function _steerUsd(uint256 usdWad) internal {
        vm.prank(mirror);
        steerer.steer(ethKey, _sqrtPriceForUsd(usdWad));
        _recordPath();
    }

    function _steerSqrt(uint160 sp) internal {
        vm.prank(mirror);
        steerer.steer(ethKey, sp);
        _recordPath();
    }

    function _steerNormTick(int256 k) internal {
        _steerSqrt(_sqrtAtNormTick(k));
        assertEq(_normTick(), k, "steered to tick");
    }

    /// @dev Records the tick that prevails from now on (the last change within a timestamp wins)
    function _recordPath() internal {
        uint32 t = _now();
        int256 k = _normTick();
        uint256 n = pathT.length;
        if (n != 0 && pathT[n - 1] == t) {
            pathTick[n - 1] = k;
        } else if (n == 0 || pathTick[n - 1] != k) {
            pathT.push(t);
            pathTick.push(k);
        }
    }

    /// @dev Reference settlement statistic: integral of the normalised tick over [a, b)
    function _refD(uint32 a, uint32 b) internal view returns (int256 d) {
        uint256 n = pathT.length;
        for (uint256 i; i < n; ++i) {
            uint32 s = pathT[i];
            uint32 e = i + 1 < n ? pathT[i + 1] : type(uint32).max;
            uint32 lo = s > a ? s : a;
            uint32 hi = e < b ? e : b;
            if (hi > lo) d += pathTick[i] * int256(uint256(hi - lo));
        }
    }

    /* Accounts */

    function _fundUsdc(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(swapRouter), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        usdc.approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    function _approveOutcomes(address who, uint256 id) internal {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        vm.startPrank(who);
        OutcomeToken(i.yes).approve(address(swapRouter), type(uint256).max);
        OutcomeToken(i.no).approve(address(swapRouter), type(uint256).max);
        OutcomeToken(i.yes).approve(address(router), type(uint256).max);
        OutcomeToken(i.no).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 amt) internal returns (uint256 shares) {
        vm.prank(who);
        shares = hook.deposit(amt);
    }

    /* Markets */

    /// @dev The keeper's 1-minute demo market (bot/src/config.ts defaults), struck at the oracle's SoB price in cents
    function _demoParams() internal view returns (IPredictionHook.MarketParams memory p) {
        uint256 cents = (_sobUsd() + 0.5e16) / 1e16;
        p.oracle = address(oracle);
        p.lnStrikeWad = F.lnWad(int256(cents * 1e16));
        p.openTime = uint64(_now());
        p.expiry = uint64(_now() + 60);
        p.window = 10;
        p.cutoffBuffer = 2;
        p.nSamples = 10;
        p.budget = 10 * E6;
        p.quote = IPredictionHook.QuoteParams({
            h0Wad: 0.02e18, gammaSWad: 0.00005e18, lambdaWad: 0.001e18, qEpochMax: uint128(100 * E6), pMinWad: 0.02e18
        });
        p.sigmaMode = 0;
        p.yesName = "YES ETH>strike";
        p.yesSymbol = "YES";
        p.noName = "NO ETH>strike";
        p.noSymbol = "NO";
    }

    function _create(IPredictionHook.MarketParams memory p) internal returns (uint256 id) {
        vm.prank(keeper);
        id = hook.createMarket(p);
    }

    function _outcome(uint256 id, bool isYes) internal view returns (OutcomeToken) {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        return OutcomeToken(isYes ? i.yes : i.no);
    }

    function _poolKey(uint256 id, bool isYes) internal view returns (PoolKey memory) {
        (PoolKey memory ky, PoolKey memory kn) = hook.poolKeys(id);
        return isYes ? ky : kn;
    }

    /* Independent model: BinaryPricer and QuoteMath on the oracle's start-of-block inputs (SPEC §3.3) */

    function _modelQuote(uint256 id) internal view returns (ModelQuote memory m) {
        IPredictionHook.MarketParams memory p = hook.marketParams(id);
        IUnderlyingOracle o = IUnderlyingOracle(p.oracle);
        m.x = o.lnSpotSoBWad() - p.lnStrikeWad;
        if (p.sigmaMode == 0) (m.varE36,) = o.varianceE36();
        else m.varE36 = p.fixedVarE36;
        m.tau = p.expiry - _now();
        BinaryPricer.Result memory r = BinaryPricer.price(m.x, m.varE36, m.tau, p.window, p.nSamples);
        (m.ask, m.bid) = BinaryPricer.askBid(r, p.quote.gammaSWad, p.quote.h0Wad);
        m.mid = r.mid;
    }

    function _flow(uint256 id) internal view returns (int256) {
        (uint64 ts, int256 f) = hook.epochOf(id);
        return ts == _now() ? f : int256(0);
    }

    /// @return q outcome tokens, cash USDC of the fill the model predicts
    function _modelFill(uint256 id, bool isYes, bool isBuy, bool exactIn, uint256 amt)
        internal
        view
        returns (uint256 q, uint256 cash)
    {
        ModelQuote memory m = _modelQuote(id);
        uint256 lam = hook.marketParams(id).quote.lambdaWad;
        int256 flow = _flow(id);
        uint256 price = isYes ? (isBuy ? m.ask : m.bid) : (isBuy ? WAD - m.bid : WAD - m.ask);
        int256 i0 = isYes ? flow : -flow;
        if (isBuy) {
            (q, cash) = exactIn
                ? (QuoteMath.buyExactIn(price, lam, i0, amt), amt)
                : (amt, QuoteMath.buyExactOut(price, lam, i0, amt));
        } else {
            (q, cash) = exactIn
                ? (amt, QuoteMath.sellExactIn(price, lam, i0, amt))
                : (QuoteMath.sellExactOut(price, lam, i0, amt), amt);
        }
    }

    /* Swaps */

    function _swapParams(PoolKey memory k, bool isBuy, bool exactIn, uint256 amt)
        internal
        pure
        returns (SwapParams memory p)
    {
        bool usdcIs0 = Currency.unwrap(k.currency0) == CIRCLE_USDC;
        bool zf1 = isBuy == usdcIs0;
        p = SwapParams({
            zeroForOne: zf1,
            amountSpecified: exactIn ? -int256(amt) : int256(amt),
            sqrtPriceLimitX96: zf1 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
    }

    function _routerPlan(PoolKey memory k, bool isBuy, bool exactIn, uint256 amt) internal pure returns (bytes memory) {
        bool zf1 = _swapParams(k, isBuy, exactIn, amt).zeroForOne;
        Currency inC = zf1 ? k.currency0 : k.currency1;
        Currency outC = zf1 ? k.currency1 : k.currency0;
        Plan memory plan = Planner.init();
        if (exactIn) {
            plan = plan.add(
                Actions.SWAP_EXACT_IN_SINGLE,
                abi.encode(IV4Router.ExactInputSingleParams(k, zf1, uint128(amt), 0, 0, ""))
            );
        } else {
            plan = plan.add(
                Actions.SWAP_EXACT_OUT_SINGLE,
                abi.encode(IV4Router.ExactOutputSingleParams(k, zf1, uint128(amt), type(uint128).max, 0, ""))
            );
        }
        plan = plan.add(Actions.SETTLE_ALL, abi.encode(inC, type(uint256).max));
        plan = plan.add(Actions.TAKE_ALL, abi.encode(outC, 0));
        return plan.encode();
    }

    /// @dev The V4Quoter answer: output for exact-in, input for exact-out
    function _quoteV4(PoolKey memory k, bool isBuy, bool exactIn, uint256 amt) internal returns (uint256 r) {
        IV4Quoter.QuoteExactSingleParams memory qp = IV4Quoter.QuoteExactSingleParams({
            poolKey: k,
            zeroForOne: _swapParams(k, isBuy, exactIn, amt).zeroForOne,
            exactAmount: uint128(amt),
            hookData: ""
        });
        (r,) = exactIn ? quoter.quoteExactInputSingle(qp) : quoter.quoteExactOutputSingle(qp);
    }

    struct Order {
        uint256 id;
        bool isYes;
        bool isBuy;
        bool exactIn;
        uint256 amt;
        bool useRouter;
    }

    /// @dev Raw swap through PoolSwapTest (useRouter false) or the V4Router; returns the measured fill
    function _swap(address who, uint256 id, bool isYes, bool isBuy, bool exactIn, uint256 amt, bool useRouter)
        internal
        returns (uint256 q, uint256 cash)
    {
        return _swapO(who, Order(id, isYes, isBuy, exactIn, amt, useRouter));
    }

    function _swapO(address who, Order memory o) internal returns (uint256 q, uint256 cash) {
        PoolKey memory k = _poolKey(o.id, o.isYes);
        OutcomeToken tok = _outcome(o.id, o.isYes);
        uint256 u0 = usdc.balanceOf(who);
        uint256 t0 = tok.balanceOf(who);
        vm.prank(who);
        if (o.useRouter) {
            router.executeActions(_routerPlan(k, o.isBuy, o.exactIn, o.amt));
        } else {
            swapRouter.swap(
                k,
                _swapParams(k, o.isBuy, o.exactIn, o.amt),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
        }
        (q, cash) = o.isBuy
            ? (tok.balanceOf(who) - t0, u0 - usdc.balanceOf(who))
            : (t0 - tok.balanceOf(who), usdc.balanceOf(who) - u0);
    }

    /// @dev The model fill, after checking that the V4Quoter quotes exactly that
    function _quotedFill(Order memory o) internal returns (uint256 eq, uint256 ecash) {
        (eq, ecash) = _modelFill(o.id, o.isYes, o.isBuy, o.exactIn, o.amt);
        uint256 viaQuoter = _quoteV4(_poolKey(o.id, o.isYes), o.isBuy, o.exactIn, o.amt);
        assertEq(viaQuoter, o.exactIn == o.isBuy ? eq : ecash, "V4Quoter == model");
    }

    function _tradeO(string memory who_, address who, Order memory o) internal returns (uint256 q, uint256 cash) {
        (uint256 eq, uint256 ecash) = _quotedFill(o);
        (q, cash) = _swapO(who, o);
        assertEq(q, eq, "executed tokens == BinaryPricer/QuoteMath on SoB inputs");
        assertEq(cash, ecash, "executed USDC == BinaryPricer/QuoteMath on SoB inputs");
        _logFill(who_, o, q, cash);
        _logModel(o.id);
    }

    function _logFill(string memory who_, Order memory o, uint256 q, uint256 cash) internal pure {
        string memory head = string.concat("  ", who_, o.isBuy ? " buys " : " sells ", _dec(q, 6, 4));
        string memory tail =
            string.concat(" USDC, avg ", _dec(cash * WAD / q, 18, 4), o.useRouter ? " (V4Router)" : " (PoolSwapTest)");
        console2.log(string.concat(head, o.isYes ? " YES for " : " NO for ", _dec(cash, 6, 4), tail));
    }

    function _logModel(uint256 id) internal view {
        ModelQuote memory m = _modelQuote(id);
        string memory a =
            string.concat("    model: S_sob $", _dec(_sobUsd() + 0.005e18, 18, 2), "  x ", _sdec(m.x, 18, 5));
        string memory b =
            string.concat("  sigma ", _dec(F.sqrt(m.varE36 * YEAR) * 100, 18, 1), "%  tau ", vm.toString(m.tau));
        string memory c = string.concat("s  mid ", _dec(m.mid, 18, 4), "  ask ", _dec(m.ask, 18, 4));
        console2.log(string.concat(a, b, c, "  bid ", _dec(m.bid, 18, 4)));
    }

    /// @dev A trade that must execute at exactly the model price (and the V4Quoter's quote), with a narrated log line
    function _trade(
        string memory who_,
        address who,
        uint256 id,
        bool isYes,
        bool isBuy,
        bool exactIn,
        uint256 amt,
        bool useRouter
    ) internal returns (uint256 q, uint256 cash) {
        return _tradeO(who_, who, Order(id, isYes, isBuy, exactIn, amt, useRouter));
    }

    /* Revert helpers */

    /// @dev Every argument is computed before the expectation, so it binds to the swap itself
    function _expectSwapRevert(address who, PoolKey memory k, bool isBuy, uint256 amt, bytes memory err) internal {
        SwapParams memory sp = _swapParams(k, isBuy, true, amt);
        PoolSwapTest.TestSettings memory ts = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        vm.expectRevert(err);
        vm.prank(who);
        swapRouter.swap(k, sp, ts, "");
    }

    function _wrapped(bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            IHooks.beforeSwap.selector,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _wrapped(bytes4 sel) internal view returns (bytes memory) {
        return _wrapped(abi.encodeWithSelector(sel));
    }

    /* Invariants across all markets (SPEC §3.2, §3.6) */

    function _checkLedger() internal view {
        uint256 sumBucket;
        uint256 sumPlus;
        uint256 sumMinus;
        uint256 n = hook.marketCount();
        for (uint256 id = 1; id <= n; ++id) {
            IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
            uint256 hi = i.outYes > i.outNo ? i.outYes : i.outNo;
            uint256 lo = i.outYes > i.outNo ? i.outNo : i.outYes;
            uint256 req;
            if (i.status == IPredictionHook.Status.Trading) req = hi;
            else if (i.status == IPredictionHook.Status.Settled) req = i.yesWon ? i.outYes : i.outNo;
            else req = (i.outYes + i.outNo + 1) / 2;
            assertGe(i.bucket, req, "solvency");
            sumPlus += i.bucket - (i.status == IPredictionHook.Status.Trading ? lo : req);
            sumMinus += i.bucket - req;
            sumBucket += i.bucket;
            assertEq(i.outYes, OutcomeToken(i.yes).totalSupply() - i.invYes, "outYes");
            assertEq(i.outNo, OutcomeToken(i.no).totalSupply() - i.invNo, "outNo");
            assertEq(i.invYes, manager.balanceOf(address(hook), uint160(i.yes)), "invYes");
            assertEq(i.invNo, manager.balanceOf(address(hook), uint160(i.no)), "invNo");
        }
        assertEq(sumBucket + hook.vaultIdle(), manager.balanceOf(address(hook), uint160(CIRCLE_USDC)), "USDC claims");
        assertEq(usdc.balanceOf(address(manager)), manager.balanceOf(address(hook), uint160(CIRCLE_USDC)), "PM USDC");
        assertEq(hook.navPlus(), hook.vaultIdle() + sumPlus, "navPlus");
        assertEq(hook.navMinus(), hook.vaultIdle() + sumMinus, "navMinus");
    }

    /* Formatting */

    function _dec(uint256 v, uint256 decimals, uint256 shown) internal pure returns (string memory) {
        uint256 unit = 10 ** decimals;
        string memory frac = vm.toString(v % unit + unit);
        bytes memory fb = bytes(frac);
        bytes memory out = new bytes(shown);
        for (uint256 i; i < shown; ++i) {
            out[i] = fb[i + 1];
        }
        return shown == 0 ? vm.toString(v / unit) : string.concat(vm.toString(v / unit), ".", string(out));
    }

    function _sdec(int256 v, uint256 decimals, uint256 shown) internal pure returns (string memory) {
        return v < 0
            ? string.concat("-", _dec(uint256(-v), decimals, shown))
            : string.concat("+", _dec(uint256(v), decimals, shown));
    }

    function _clock(uint256 t0) internal view returns (string memory) {
        uint256 dt = _now() - t0;
        return string.concat(
            "[t+", vm.toString(dt / 3600), "h", vm.toString((dt % 3600) / 60), "m", vm.toString(dt % 60), "s]"
        );
    }
}
