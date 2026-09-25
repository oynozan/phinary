// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";
import {PathKey} from "v4-periphery/src/libraries/PathKey.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {QuoterRevert} from "v4-periphery/src/libraries/QuoterRevert.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SoBOracleHook} from "../src/SoBOracleHook.sol";
import {MiniPredictionHook, OutcomeToken} from "../src/MiniPredictionHook.sol";

interface IUR {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// Fork proof: the PredictionHook pools are traded through the DEPLOYED Universal Router 2.1.2 and quoted by the
/// DEPLOYED V4Quoter on Ethereum mainnet (same bytecode family on Base/Arbitrum/Unichain, see ur_probe.py).
/// UR v2.0 / periphery 444c526 layout (no minHopPriceX36)
struct LegacyExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

contract RoutingForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Per-chain deployed addresses (Uniswap v4 deployments page, fetched 2026-09-25); selected by FORK_CHAIN.
    IPoolManager PM;
    address UR; // UniversalRouter 2.1.2
    IV4Quoter QUOTER;
    IPermit2 constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address USDC_ADDR;
    PoolId CANONICAL_ETH_USDC_500;
    Currency USDC;

    uint256 constant V4_SWAP = 0x10;
    uint256 constant PERMIT2_TRANSFER_FROM = 0x02;
    uint256 constant EXECUTE_SUB_PLAN = 0x21;
    uint256 constant FLAG_ALLOW_REVERT = 0x80;

    Currency constant ETH = Currency.wrap(address(0));

    SoBOracleHook oracle;
    MiniPredictionHook hook;
    PoolKey underKey;
    PoolKey yesKey;
    PoolKey noKey;
    OutcomeToken yes;
    OutcomeToken no;
    address trader = makeAddr("trader");
    address other = makeAddr("other");

    receive() external payable {}

    function setUp() public {
        string memory chain = vm.envOr("FORK_CHAIN", string("mainnet"));
        if (keccak256(bytes(chain)) == keccak256("unichain")) {
            vm.createSelectFork("https://unichain-rpc.publicnode.com", vm.envOr("FORK_BLOCK", uint256(59602400)));
            PM = IPoolManager(0x1F98400000000000000000000000000000000004);
            UR = 0xD1b797D92d87B688193A2B976eFc8D577D204343;
            QUOTER = IV4Quoter(0x333E3C607B141b18fF6de9f258db6e77fE7491E0);
            USDC_ADDR = 0x078D782b760474a361dDA0AF3839290b0EF57AD6;
            CANONICAL_ETH_USDC_500 = PoolId.wrap(0x3258f413c7a88cda2fa8709a589d221a80f6574f63df5a5b6774485d8acc39d9);
        } else {
            vm.createSelectFork("https://ethereum-rpc.publicnode.com", vm.envOr("FORK_BLOCK", uint256(26055400)));
            PM = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
            UR = 0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85;
            QUOTER = IV4Quoter(0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203);
            USDC_ADDR = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
            CANONICAL_ETH_USDC_500 = PoolId.wrap(0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27);
        }
        USDC = Currency.wrap(USDC_ADDR);
        console2.log("fork chain:", chain, "block:", block.number);

        // 1. Oracle-only hook (BEFORE_SWAP) on a new ETH/USDC pool, seeded at the canonical pool's price.
        address oracleAddr = address(uint160(0x5555000000000000000000000000000000000000) | uint160(Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo("SoBOracleHook.sol:SoBOracleHook", abi.encode(PM), oracleAddr);
        oracle = SoBOracleHook(oracleAddr);
        underKey = PoolKey(ETH, USDC, 500, 10, IHooks(oracleAddr));
        (uint160 sp, int24 tick,,) = PM.getSlot0(CANONICAL_ETH_USDC_500);
        PM.initialize(underKey, sp);
        PoolModifyLiquidityTest lpr = new PoolModifyLiquidityTest(PM);
        deal(address(this), 10_000 ether);
        deal(USDC_ADDR, address(this), 10_000_000e6);
        ERC20(USDC_ADDR).approve(address(lpr), type(uint256).max);
        int24 c = (tick / 10) * 10;
        lpr.modifyLiquidity{value: 1_000 ether}(
            underKey, ModifyLiquidityParams(c - 3000, c + 3000, 5e16, 0), ""
        );

        // 2. Prediction hook (BEFORE_INITIALIZE | BEFORE_ADD_LIQUIDITY | BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA).
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        );
        address hookAddr = address(uint160(0x7777000000000000000000000000000000000000) | flags);
        deployCodeTo(
            "MiniPredictionHook.sol:MiniPredictionHook", abi.encode(PM, oracle, underKey.toId(), USDC), hookAddr
        );
        hook = MiniPredictionHook(hookAddr);
        uint256 s = hook.spotWad(); // ~ current ETH price
        hook.createMarket(s, block.timestamp + 30 days); // ATM strike
        yesKey = hook.yesKey();
        noKey = hook.noKey();
        yes = hook.yes();
        no = hook.no();
        ERC20(USDC_ADDR).approve(address(hook), type(uint256).max);
        hook.fund(1_000_000e6); // LP collateral

        // 3. Trader funds + Permit2 approvals for UR (standard Uniswap flow).
        deal(trader, 1_000 ether);
        deal(USDC_ADDR, trader, 1_000_000e6);
        vm.startPrank(trader);
        address[3] memory toks = [USDC_ADDR, address(yes), address(no)];
        for (uint256 i; i < 3; i++) {
            ERC20(toks[i]).approve(address(PERMIT2), type(uint256).max);
            PERMIT2.approve(toks[i], UR, type(uint160).max, type(uint48).max);
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers
    function _single(PoolKey memory key, Currency inC, uint128 amtIn, bytes memory hookData)
        internal
        pure
        returns (bytes memory)
    {
        bool zeroForOne = key.currency0 == inC;
        return abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: amtIn,
                amountOutMinimum: 0,
                minHopPriceX36: 0,
                hookData: hookData
            })
        );
    }

    function _v4Swap(bytes memory swapParam, uint8 swapAction, Currency inC, uint256 maxIn, Currency outC)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory actions = abi.encodePacked(swapAction, uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = swapParam;
        params[1] = abi.encode(inC, maxIn);
        params[2] = abi.encode(outC, uint256(0));
        return abi.encode(actions, params);
    }

    function _exec1(bytes memory v4input, uint256 value) internal {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = v4input;
        IUR(UR).execute{value: value}(abi.encodePacked(uint8(V4_SWAP)), inputs, vm.getBlockTimestamp() + 60);
    }

    function _buyYesViaUR(address who, uint128 cash) internal returns (uint256 got) {
        uint256 b0 = yes.balanceOf(who);
        vm.prank(who);
        _exec1(_v4Swap(_single(yesKey, USDC, cash, ""), uint8(Actions.SWAP_EXACT_IN_SINGLE), USDC, cash, Currency.wrap(address(yes))), 0);
        got = yes.balanceOf(who) - b0;
    }

    function _nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 12);
    }

    function _spotFromSqrt(uint160 sp) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(sp, sp, 1 << 96), 1e30, 1 << 96);
    }

    function _pathEthToYes() internal view returns (PathKey[] memory path) {
        path = new PathKey[](2);
        path[0] = PathKey(USDC, 500, 10, IHooks(address(oracle)), "");
        path[1] = PathKey(Currency.wrap(address(yes)), 0, 1, IHooks(address(hook)), "");
    }

    // ------------------------------------------------------------------ (a) single-hop through deployed UR 2.1.2
    function test_UR212_singleHop_buyYes_matchesQuoterAndHookQuote() public {
        _nextBlock();
        uint128 cash = 10_000e6;
        uint256 expected = hook.quoteBuyExactIn(true, cash);
        (uint256 q,) = QUOTER.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams(yesKey, yesKey.currency0 == USDC, cash, "")
        );
        uint256 g0 = gasleft();
        uint256 got = _buyYesViaUR(trader, cash);
        console2.log("gas: UR.execute buy YES (mint path, incl. Permit2 pull):", g0 - gasleft());
        console2.log("YES out (UR 2.1.2):", got, "quoter:", q);
        assertEq(got, expected, "execution == hook quote");
        assertEq(got, q, "execution == deployed V4Quoter");
        (uint160 sp,,,) = PM.getSlot0(yesKey.toId());
        assertEq(sp, 79228162514264337593543950336, "prediction pool slot0 never moves (full NoOp)");
        assertEq(PM.getLiquidity(yesKey.toId()), 0);
    }

    function test_UR212_singleHop_sellYes() public {
        uint256 got = _buyYesViaUR(trader, 10_000e6);
        _nextBlock();
        uint256 expected = hook.quoteSellExactIn(true, got);
        uint256 u0 = ERC20(USDC_ADDR).balanceOf(trader);
        vm.prank(trader);
        _exec1(_v4Swap(_single(yesKey, Currency.wrap(address(yes)), uint128(got), ""), uint8(Actions.SWAP_EXACT_IN_SINGLE), Currency.wrap(address(yes)), got, USDC), 0);
        assertEq(ERC20(USDC_ADDR).balanceOf(trader) - u0, expected);
        assertEq(yes.balanceOf(trader), 0);
    }

    // ------------------------------------------------------------------ (a) encoding mismatch fails closed on our pool
    function test_UR212_fiveFieldEncoding_revertsWithoutData() public {
        bytes memory legacy = abi.encode(LegacyExactInputSingleParams(yesKey, yesKey.currency0 == USDC, uint128(1e6), uint128(0), bytes(""))); // UR v2.0 layout
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _v4Swap(legacy, uint8(Actions.SWAP_EXACT_IN_SINGLE), USDC, 1e6, Currency.wrap(address(yes)));
        vm.prank(trader);
        (bool ok, bytes memory ret) = UR.call(
            abi.encodeCall(IUR.execute, (abi.encodePacked(uint8(V4_SWAP)), inputs, vm.getBlockTimestamp() + 60))
        );
        assertFalse(ok);
        assertEq(ret.length, 0, "calldata-bounds revert, no error data");
    }

    // ------------------------------------------------------------------ (b) multi-hop ETH -> USDC (oracle pool) -> YES
    function test_UR212_multiHop_ETH_USDC_YES_pricedAtSoB() public {
        _nextBlock(); // fresh block: no swap on the underlying yet, SoB == live slot0
        (uint160 sp0,,,) = PM.getSlot0(underKey.toId());
        uint128 ethIn = 100 ether;

        (uint256 quoted,) = QUOTER.quoteExactInput(IV4Quoter.QuoteExactParams(ETH, _pathEthToYes(), ethIn));

        IV4Router.ExactInputParams memory p = IV4Router.ExactInputParams({
            currencyIn: ETH,
            path: _pathEthToYes(),
            minHopPriceX36: new uint256[](0),
            amountIn: ethIn,
            amountOutMinimum: 0
        });
        uint256 u0 = ERC20(USDC_ADDR).balanceOf(trader);
        vm.recordLogs();
        vm.prank(trader);
        _exec1(_v4Swap(abi.encode(p), uint8(Actions.SWAP_EXACT_IN), ETH, ethIn, Currency.wrap(address(yes))), ethIn);
        uint256 got = yes.balanceOf(trader);
        assertEq(ERC20(USDC_ADDR).balanceOf(trader), u0, "no USDC leaks to trader: intermediate netted inside PM");

        // hop-1 output (USDC into the prediction pool) from the hook's HookSwap event
        uint256 usdcIntoHook;
        bytes32 sig = keccak256("HookSwap(bytes32,address,int256,int256,uint24)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == sig) {
                (int256 a0, int256 a1,) = abi.decode(logs[i].data, (int256, int256, uint24));
                usdcIntoHook = uint256(yesKey.currency0 == USDC ? a0 : a1);
            }
        }
        (uint160 sp1,,,) = PM.getSlot0(underKey.toId());
        uint256 s0 = _spotFromSqrt(sp0);
        uint256 s1 = _spotFromSqrt(sp1);
        uint256 k = hook.strikeWad();
        uint256 atSoB = FullMath.mulDiv(usdcIntoHook, 1e18, FullMath.mulDiv(s0, 1e18, s0 + k) + hook.halfSpread());
        uint256 atLive = FullMath.mulDiv(usdcIntoHook, 1e18, FullMath.mulDiv(s1, 1e18, s1 + k) + hook.halfSpread());
        console2.log("S_SoB (USD/ETH e18):", s0);
        console2.log("S_after_hop1       :", s1);
        console2.log("USDC into hook     :", usdcIntoHook);
        console2.log("YES out            :", got);
        console2.log("YES if priced live :", atLive);
        console2.log("quoter             :", quoted);
        assertLt(s1 * 100, s0 * 99, "hop 1 moved the underlying by >1%");
        assertEq(got, atSoB, "YES priced at start-of-block S, not at the post-hop-1 S");
        assertGt(atLive, got, "live pricing would have given the trader more YES (LP loss) - SoB prevents it");
        assertEq(got, quoted, "deployed V4Quoter multi-hop quote == execution");
        assertEq(address(UR).balance, 0);
    }

    function test_UR212_multiHop_afterEarlierSwapInSameBlock_stillSoB() public {
        _nextBlock();
        (uint160 sp0,,,) = PM.getSlot0(underKey.toId());
        // someone else dumps ETH on the underlying first, in the same block
        deal(other, 100 ether);
        vm.prank(other);
        _exec1(_v4Swap(_single(underKey, ETH, 50 ether, ""), uint8(Actions.SWAP_EXACT_IN_SINGLE), ETH, 50 ether, USDC), 50 ether);
        (uint160 spMid,,,) = PM.getSlot0(underKey.toId());
        assertLt(spMid, sp0);
        assertEq(oracle.sobSqrtPriceX96(underKey.toId()), sp0, "SoB recorded pre-swap");
        uint256 expectedPerUsdc = hook.quoteBuyExactIn(true, 1e6);
        // price the YES leg from SoB even though the pool has already moved
        uint256 s0 = _spotFromSqrt(sp0);
        uint256 manual = FullMath.mulDiv(1e6, 1e18, FullMath.mulDiv(s0, 1e18, s0 + hook.strikeWad()) + hook.halfSpread());
        assertEq(expectedPerUsdc, manual);
    }

    // ------------------------------------------------------------------ (b') YES -> USDC -> NO in one V4_SWAP
    function test_UR212_multiHop_YES_USDC_NO_noProfit() public {
        uint256 y = _buyYesViaUR(trader, 10_000e6);
        _nextBlock();
        PathKey[] memory path = new PathKey[](2);
        path[0] = PathKey(USDC, 0, 1, IHooks(address(hook)), "");
        path[1] = PathKey(Currency.wrap(address(no)), 0, 1, IHooks(address(hook)), "");
        (uint256 quoted,) = QUOTER.quoteExactInput(IV4Quoter.QuoteExactParams(Currency.wrap(address(yes)), path, uint128(y)));
        uint256 expected = hook.quoteBuyExactIn(false, hook.quoteSellExactIn(true, y)); // sell YES at bid, buy NO at ask
        IV4Router.ExactInputParams memory p = IV4Router.ExactInputParams(Currency.wrap(address(yes)), path, new uint256[](0), uint128(y), 0);
        vm.prank(trader);
        _exec1(_v4Swap(abi.encode(p), uint8(Actions.SWAP_EXACT_IN), Currency.wrap(address(yes)), y, Currency.wrap(address(no))), 0);
        uint256 n = no.balanceOf(trader);
        assertEq(n, quoted, "quoter == execution");
        assertEq(n, expected, "path-independent: equals sell-then-buy priced separately");
        // no free lunch: the USDC value of n NO at the NO bid never exceeds the USDC value of y YES at the YES bid
        assertLe(hook.quoteSellExactIn(false, n), hook.quoteSellExactIn(true, y));
    }

    // ------------------------------------------------------------------ (c) halts: quoter + router revert data
    function _wrapped(uint8 code) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(MiniPredictionHook.MarketHalted.selector, code),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _halt(uint8 code) internal {
        if (code == 1) hook.setParams(0.6e18, hook.cutoff(), type(uint256).max); // empty band [0.6,0.4]: any p halts
        if (code == 2) hook.setParams(0.02e18, block.timestamp, type(uint256).max); // cutoff reached
        if (code == 3) hook.setParams(0.02e18, hook.cutoff(), 1e6); // cap 1 token per trade
    }

    function test_halts_quoterAndRouterRevertData() public {
        for (uint8 code = 1; code <= 3; code++) {
            uint256 snap = vm.snapshotState();
            _halt(code);
            bytes memory inner = _wrapped(code);
            // Deployed V4Quoter: UnexpectedRevertBytes(WrappedError(hook, beforeSwap, MarketHalted(code), HookCallFailed))
            vm.expectRevert(abi.encodeWithSelector(QuoterRevert.UnexpectedRevertBytes.selector, inner));
            QUOTER.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(yesKey, yesKey.currency0 == USDC, 10_000e6, ""));
            // Deployed UR 2.1.2: V4_SWAP bubbles the PoolManager's WrappedError verbatim (no ExecutionFailed wrapper)
            vm.expectRevert(inner);
            this.buyExternal(10_000e6);
            vm.revertToState(snap);
        }
    }

    function buyExternal(uint128 cash) external {
        _buyYesViaUR(trader, cash);
    }

    function test_halt_softFailInsideSubPlan() public {
        _halt(2);
        bytes[] memory subInputs = new bytes[](1);
        subInputs[0] = _v4Swap(_single(yesKey, USDC, 1_000e6, ""), uint8(Actions.SWAP_EXACT_IN_SINGLE), USDC, 1_000e6, Currency.wrap(address(yes)));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(uint8(V4_SWAP)), subInputs);
        uint256 u0 = ERC20(USDC_ADDR).balanceOf(trader);
        vm.prank(trader);
        IUR(UR).execute(abi.encodePacked(uint8(EXECUTE_SUB_PLAN | FLAG_ALLOW_REVERT)), inputs, vm.getBlockTimestamp() + 60);
        assertEq(ERC20(USDC_ADDR).balanceOf(trader), u0, "halted leg skipped, tx continues, nothing charged");
    }

    // ------------------------------------------------------------------ (d) split / merge composed inside UR
    function test_UR212_split_inV4Swap() public {
        uint128 a = 5_000e6;
        bytes memory hd = abi.encode(uint8(1), trader);
        (uint256 q,) = QUOTER.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(yesKey, yesKey.currency0 == USDC, a, hd));
        assertEq(q, a, "quoter sees split at par");
        uint256 u0 = ERC20(USDC_ADDR).balanceOf(trader);
        vm.prank(trader);
        _exec1(_v4Swap(_single(yesKey, USDC, a, hd), uint8(Actions.SWAP_EXACT_IN_SINGLE), USDC, a, Currency.wrap(address(yes))), 0);
        assertEq(u0 - ERC20(USDC_ADDR).balanceOf(trader), a);
        assertEq(yes.balanceOf(trader), a);
        assertEq(no.balanceOf(trader), a);
    }

    function test_UR212_merge_permit2TransferThenV4Swap() public {
        uint128 a = 5_000e6;
        vm.prank(trader);
        _exec1(_v4Swap(_single(yesKey, USDC, a, abi.encode(uint8(1), trader)), uint8(Actions.SWAP_EXACT_IN_SINGLE), USDC, a, Currency.wrap(address(yes))), 0);
        _nextBlock();
        // one UR tx: PERMIT2_TRANSFER_FROM(NO -> hook, a) ; V4_SWAP{ YES -> USDC exact-in, hookData = MERGE }
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(address(no), address(hook), uint160(a));
        inputs[1] = _v4Swap(_single(yesKey, Currency.wrap(address(yes)), a, abi.encode(uint8(2))), uint8(Actions.SWAP_EXACT_IN_SINGLE), Currency.wrap(address(yes)), a, USDC);
        uint256 u0 = ERC20(USDC_ADDR).balanceOf(trader);
        vm.prank(trader);
        IUR(UR).execute(abi.encodePacked(uint8(PERMIT2_TRANSFER_FROM), uint8(V4_SWAP)), inputs, vm.getBlockTimestamp() + 60);
        assertEq(ERC20(USDC_ADDR).balanceOf(trader) - u0, a, "merge at par");
        assertEq(yes.balanceOf(trader), 0);
        assertEq(no.balanceOf(trader), 0);
        assertEq(hook.outYes(), 0);
        assertEq(hook.outNo(), 0);
    }

    function test_merge_withoutPrefund_reverts() public {
        uint128 a = 1_000e6;
        vm.prank(trader);
        _exec1(_v4Swap(_single(yesKey, USDC, a, abi.encode(uint8(1), trader)), uint8(Actions.SWAP_EXACT_IN_SINGLE), USDC, a, Currency.wrap(address(yes))), 0);
        vm.expectRevert(); // WrappedError(... MergeNotFunded(0, a) ...)
        vm.prank(trader);
        _exec1(_v4Swap(_single(yesKey, Currency.wrap(address(yes)), a, abi.encode(uint8(2))), uint8(Actions.SWAP_EXACT_IN_SINGLE), Currency.wrap(address(yes)), a, USDC), 0);
    }

    // ------------------------------------------------------------------ guards
    function test_foreignInitialize_reverts() public {
        PoolKey memory k = PoolKey(USDC, Currency.wrap(address(0xdead)), 0, 1, IHooks(address(hook)));
        vm.expectRevert();
        PM.initialize(k, 79228162514264337593543950336);
    }
}

import {Vm} from "forge-std/Vm.sol";
