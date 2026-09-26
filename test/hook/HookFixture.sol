// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
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
import {OutcomeToken} from "../../src/OutcomeToken.sol";
import {BinaryPricer} from "../../src/math/BinaryPricer.sol";
import {QuoteMath} from "../../src/math/QuoteMath.sol";
import {MockOracle} from "./mocks/MockOracle.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Fresh PoolManager, routers, V4Quoter, a funded vault and one market, USDC at an extreme address fixes ordering
abstract contract HookFixture is Test, Deployers {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.BEFORE_DONATE_FLAG
    );
    address internal constant USDC_LOW = address(0x0000000000000000000000000000000000100000);
    address internal constant USDC_HIGH = address(0xFFFfFFfFfFFffFFfFFFffffFfFfFffFFfFFFFF00);
    uint160 internal constant SQRT_1_1 = 1 << 96;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant E6 = 1e6;
    uint256 internal constant VAR_60 = uint256(0.36e36) / 31557600;
    uint256 internal constant T0 = 1_750_000_000;

    MockUSDC internal usdc;
    MockOracle internal oracle;
    PredictionHook internal hook;
    MockV4Router internal router;
    V4Quoter internal quoter;

    uint256 internal mId;
    OutcomeToken internal yes;
    OutcomeToken internal no;
    PoolKey internal kYes;
    PoolKey internal kNo;

    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");
    address internal keeperAddr = makeAddr("keeper");

    int256 internal lnK;

    function _outcomeIs0() internal pure virtual returns (bool) {
        return false;
    }

    function setUp() public virtual {
        vm.warp(T0);
        deployFreshManagerAndRouters();
        address u = _outcomeIs0() ? USDC_HIGH : USDC_LOW;
        deployCodeTo("test/hook/mocks/MockUSDC.sol:MockUSDC", u);
        usdc = MockUSDC(u);
        oracle = new MockOracle();
        lnK = F.lnWad(3000e18);
        oracle.setLnSpot(lnK);
        oracle.setVar(VAR_60);
        oracle.setFlatTick(80_000);

        address h = address(FLAGS | (uint160(0x4444) << 144));
        deployCodeTo("src/PredictionHook.sol:PredictionHook", abi.encode(manager, u, address(this)), h);
        hook = PredictionHook(h);
        hook.setKeeper(keeperAddr);
        router = new MockV4Router(manager);
        quoter = new V4Quoter(manager);

        _deposit(lp, 1_000_000 * E6);
        mId = hook.createMarket(_params());
        (yes, no, kYes, kNo) = _market(mId);
        assertEq(Currency.unwrap(kYes.currency0) == address(yes), _outcomeIs0(), "yes ordering");
        assertEq(Currency.unwrap(kNo.currency0) == address(no), _outcomeIs0(), "no ordering");

        _fund(trader, 1_000_000 * E6);
    }

    /* Setup helpers */

    function _params() internal view returns (IPredictionHook.MarketParams memory p) {
        p.oracle = address(oracle);
        p.lnStrikeWad = lnK;
        p.openTime = uint64(block.timestamp);
        p.expiry = uint64(block.timestamp + 1 days);
        p.window = 1 hours;
        p.cutoffBuffer = 5 minutes;
        p.nSamples = 1800;
        p.budget = 100_000 * E6;
        p.quote = IPredictionHook.QuoteParams({
            h0Wad: 0.02e18,
            gammaSWad: 0.0005e18,
            lambdaWad: 0.00002e18,
            qEpochMax: uint128(50_000 * E6),
            pMinWad: 0.02e18
        });
        p.yesName = "ETH above 3000 YES";
        p.yesSymbol = "YES";
        p.noName = "ETH above 3000 NO";
        p.noSymbol = "NO";
    }

    function _market(uint256 id)
        internal
        view
        returns (OutcomeToken y, OutcomeToken n, PoolKey memory ky, PoolKey memory kn)
    {
        IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
        y = OutcomeToken(i.yes);
        n = OutcomeToken(i.no);
        (ky, kn) = hook.poolKeys(id);
    }

    function _deposit(address who, uint256 amt) internal returns (uint256 shares) {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(hook), amt);
        shares = hook.deposit(amt);
        vm.stopPrank();
    }

    function _fund(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(swapRouter), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        vm.stopPrank();
        _approveTokens(who, yes, no);
    }

    function _approveTokens(address who, OutcomeToken y, OutcomeToken n) internal {
        vm.startPrank(who);
        y.approve(address(swapRouter), type(uint256).max);
        n.approve(address(swapRouter), type(uint256).max);
        y.approve(address(router), type(uint256).max);
        n.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    /* Swap helpers */

    function _swapParams(PoolKey memory k, bool isBuy, bool exactIn, uint256 amt)
        internal
        view
        returns (SwapParams memory p)
    {
        bool usdcIs0 = Currency.unwrap(k.currency0) == address(usdc);
        bool zf1 = isBuy == usdcIs0;
        p = SwapParams({
            zeroForOne: zf1,
            amountSpecified: exactIn ? -int256(amt) : int256(amt),
            sqrtPriceLimitX96: zf1 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
    }

    function _poolSwap(address who, PoolKey memory k, bool isBuy, bool exactIn, uint256 amt)
        internal
        returns (BalanceDelta d)
    {
        vm.prank(who);
        d = swapRouter.swap(
            k,
            _swapParams(k, isBuy, exactIn, amt),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _routerSwap(address who, PoolKey memory k, bool isBuy, bool exactIn, uint256 amt) internal {
        vm.prank(who);
        router.executeActions(_routerPlan(k, isBuy, exactIn, amt));
    }

    function _routerPlan(PoolKey memory k, bool isBuy, bool exactIn, uint256 amt) internal view returns (bytes memory) {
        return _routerPlan(k, isBuy, exactIn, amt, "");
    }

    function _routerPlan(PoolKey memory k, bool isBuy, bool exactIn, uint256 amt, bytes memory hookData)
        internal
        view
        returns (bytes memory)
    {
        bool zf1 = _swapParams(k, isBuy, exactIn, amt).zeroForOne;
        Currency inC = zf1 ? k.currency0 : k.currency1;
        Currency outC = zf1 ? k.currency1 : k.currency0;
        Plan memory plan = Planner.init();
        if (exactIn) {
            plan = plan.add(
                Actions.SWAP_EXACT_IN_SINGLE,
                abi.encode(IV4Router.ExactInputSingleParams(k, zf1, uint128(amt), 0, 0, hookData))
            );
        } else {
            plan = plan.add(
                Actions.SWAP_EXACT_OUT_SINGLE,
                abi.encode(IV4Router.ExactOutputSingleParams(k, zf1, uint128(amt), type(uint128).max, 0, hookData))
            );
        }
        plan = plan.add(Actions.SETTLE_ALL, abi.encode(inC, type(uint256).max));
        plan = plan.add(Actions.TAKE_ALL, abi.encode(outC, 0));
        return plan.encode();
    }

    /// @dev The quoter's answer, the output for exact-in and the input for exact-out
    function _quoteV4(PoolKey memory k, bool isBuy, bool exactIn, uint256 amt) internal returns (uint256 r) {
        IV4Quoter.QuoteExactSingleParams memory qp = IV4Quoter.QuoteExactSingleParams({
            poolKey: k,
            zeroForOne: _swapParams(k, isBuy, exactIn, amt).zeroForOne,
            exactAmount: uint128(amt),
            hookData: ""
        });
        (r,) = exactIn ? quoter.quoteExactInputSingle(qp) : quoter.quoteExactOutputSingle(qp);
    }

    /* Independent expectations (spec §3.3 table, same libraries) */

    function _flow(uint256 id) internal view returns (int256) {
        (uint64 ts, int256 f) = hook.epochOf(id);
        return ts == block.timestamp ? f : int256(0);
    }

    function _askBid(uint256 id) internal view returns (uint256 ask, uint256 bid, uint256 mid) {
        IPredictionHook.MarketParams memory p = hook.marketParams(id);
        uint256 v = p.sigmaMode == 0 ? oracle.varE36() : p.fixedVarE36;
        BinaryPricer.Result memory r =
            BinaryPricer.price(oracle.lnSpot() - p.lnStrikeWad, v, p.expiry - block.timestamp, p.window, p.nSamples);
        (ask, bid) = BinaryPricer.askBid(r, p.quote.gammaSWad, p.quote.h0Wad);
        mid = r.mid;
    }

    function _expect(uint256 id, bool isYes, bool isBuy, bool exactIn, uint256 amt)
        internal
        view
        returns (uint256 q, uint256 cash)
    {
        return _expectAt(id, isYes, isBuy, exactIn, amt, _flow(id));
    }

    function _expectAt(uint256 id, bool isYes, bool isBuy, bool exactIn, uint256 amt, int256 flow)
        internal
        view
        returns (uint256 q, uint256 cash)
    {
        (uint256 ask, uint256 bid,) = _askBid(id);
        uint256 lam = hook.marketParams(id).quote.lambdaWad;
        uint256 price = isYes ? (isBuy ? ask : bid) : (isBuy ? WAD - bid : WAD - ask);
        int256 i0 = isYes ? flow : -flow;
        if (isBuy) {
            if (exactIn) (q, cash) = (QuoteMath.buyExactIn(price, lam, i0, amt), amt);
            else (q, cash) = (amt, QuoteMath.buyExactOut(price, lam, i0, amt));
        } else {
            if (exactIn) (q, cash) = (amt, QuoteMath.sellExactIn(price, lam, i0, amt));
            else (q, cash) = (QuoteMath.sellExactOut(price, lam, i0, amt), amt);
        }
    }

    /* Revert helpers */

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

    /* Invariants */

    function _required(IPredictionHook.MarketInfo memory i) internal pure returns (uint256) {
        if (i.status == IPredictionHook.Status.Trading) return i.outYes > i.outNo ? i.outYes : i.outNo;
        if (i.status == IPredictionHook.Status.Settled) return i.yesWon ? i.outYes : i.outNo;
        return (i.outYes + i.outNo + 1) / 2;
    }

    function _checkInvariants() internal view {
        uint256 sumBucket;
        uint256 sumPlus;
        uint256 sumMinus;
        uint256 n = hook.marketCount();
        for (uint256 id = 1; id <= n; ++id) {
            IPredictionHook.MarketInfo memory i = hook.marketInfo(id);
            uint256 req = _required(i);
            assertGe(i.bucket, req, "solvency");
            if (i.status == IPredictionHook.Status.Trading) {
                assertGe(i.bucket, i.outYes > i.outNo ? i.outYes : i.outNo, "bucket >= max(out)");
                sumPlus += i.bucket - (i.outYes < i.outNo ? i.outYes : i.outNo);
                sumMinus += i.bucket - req;
            } else {
                sumPlus += i.bucket - req;
                sumMinus += i.bucket - req;
            }
            assertEq(i.outYes, OutcomeToken(i.yes).totalSupply() - i.invYes, "outYes == supply - inv");
            assertEq(i.outNo, OutcomeToken(i.no).totalSupply() - i.invNo, "outNo == supply - inv");
            assertEq(i.invYes, manager.balanceOf(address(hook), uint160(i.yes)), "invYes == claims");
            assertEq(i.invNo, manager.balanceOf(address(hook), uint160(i.no)), "invNo == claims");
            (PoolKey memory ky, PoolKey memory kn) = hook.poolKeys(id);
            (uint160 s0, int24 t0,,) = manager.getSlot0(ky.toId());
            (uint160 s1, int24 t1,,) = manager.getSlot0(kn.toId());
            assertEq(s0, SQRT_1_1, "yes slot0");
            assertEq(s1, SQRT_1_1, "no slot0");
            assertEq(t0, 0, "yes tick");
            assertEq(t1, 0, "no tick");
            sumBucket += i.bucket;
        }
        assertEq(sumBucket + hook.vaultIdle(), manager.balanceOf(address(hook), uint160(address(usdc))), "usdc claims");
        assertEq(hook.navPlus(), hook.vaultIdle() + sumPlus, "navPlus");
        assertEq(hook.navMinus(), hook.vaultIdle() + sumMinus, "navMinus");
    }
}
