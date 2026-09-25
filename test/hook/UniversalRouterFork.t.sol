// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./HookFixture.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PathKey} from "v4-periphery/src/libraries/PathKey.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {PermitHash} from "permit2/src/libraries/PermitHash.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2Full is IAllowanceTransfer {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @dev UniversalRouter 2.0 / periphery 444c526 layouts (no minHopPriceX36), as deployed on chain 1301
struct ExactInputSingleV20 {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

struct ExactOutputSingleV20 {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountOut;
    uint128 amountInMaximum;
    bytes hookData;
}

struct ExactInputV20 {
    Currency currencyIn;
    PathKey[] path;
    uint128 amountIn;
    uint128 amountOutMinimum;
}

/// @notice The hook on a Unichain Sepolia fork, traded through the DEPLOYED UniversalRouter 2.0 (5-field structs, the
///         router the web app uses) and 2.1.2 (6-field), paid with Permit2 allowances or a PERMIT2_PERMIT signature
///         (commands 0x10 and 0x0a10), and quoted by the deployed V4Quoter. Skipped when the RPC is unreachable.
///         RPC: env UNICHAIN_SEPOLIA_RPC (default https://sepolia.unichain.org), block: env FORK_BLOCK_1301.
abstract contract UniversalRouterForkCases is HookFixture {
    IPoolManager internal constant PM_1301 = IPoolManager(0x00B036B58a818B1BC34d502D3fE730Db729e62AC);
    address internal constant UR_V2_0 = 0xf70536B3bcC1bD1a972dc186A2cf84cC6da6Be5D;
    address internal constant UR_V2_1_2 = 0xDf38F24fE153761634Be942F9d859f3DBA857E95;
    IV4Quoter internal constant QUOTER_1301 = IV4Quoter(0x56DCD40A3F2d466F48e7F48bDBE5Cc9B92Ae4472);
    IPermit2Full internal constant PERMIT2 = IPermit2Full(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    uint256 internal constant DEFAULT_BLOCK = 63_514_000;

    uint8 internal constant V4_SWAP = 0x10;
    uint8 internal constant PERMIT2_PERMIT = 0x0a;

    uint256 internal traderKey;

    function setUp() public virtual override {
        string memory rpc = vm.envOr("UNICHAIN_SEPOLIA_RPC", string("https://sepolia.unichain.org"));
        try vm.createSelectFork(rpc, vm.envOr("FORK_BLOCK_1301", DEFAULT_BLOCK)) {}
        catch {
            vm.skip(true, "Unichain Sepolia RPC unreachable");
            return;
        }
        assertEq(block.chainid, 1301);
        manager = PM_1301;
        quoter = V4Quoter(address(QUOTER_1301));

        address u = _outcomeIs0() ? USDC_HIGH : USDC_LOW;
        deployCodeTo("test/hook/mocks/MockUSDC.sol:MockUSDC", u);
        usdc = MockUSDC(u);
        oracle = new MockOracle();
        lnK = F.lnWad(3000e18);
        oracle.setLnSpot(lnK);
        oracle.setVar(VAR_60);
        oracle.setFlatTick(80_000);

        address h = address(FLAGS | (uint160(0x4d2f) << 144));
        deployCodeTo("src/PredictionHook.sol:PredictionHook", abi.encode(manager, u, address(this)), h);
        hook = PredictionHook(h);
        _deposit(lp, 1_000_000 * E6);
        mId = hook.createMarket(_params());
        (yes, no, kYes, kNo) = _market(mId);
        assertEq(Currency.unwrap(kYes.currency0) == address(yes), _outcomeIs0(), "yes ordering");

        (trader, traderKey) = makeAddrAndKey("ur-trader");
        usdc.mint(trader, 1_000_000 * E6);
        vm.deal(trader, 100 ether);
        _permit2Approve(address(usdc), UR_V2_0);
        _permit2Approve(address(usdc), UR_V2_1_2);
        _permit2Approve(address(yes), UR_V2_0);
        _permit2Approve(address(no), UR_V2_0);
        _permit2Approve(address(yes), UR_V2_1_2);
        _permit2Approve(address(no), UR_V2_1_2);
    }

    function _permit2Approve(address token, address spender) internal {
        vm.prank(trader);
        PERMIT2.approve(token, spender, type(uint160).max, type(uint48).max);
    }

    /* Encoding */

    function _swapParam(bool v20, PoolKey memory k, bool zf1, bool exactIn, uint256 amt)
        internal
        pure
        returns (bytes memory)
    {
        if (v20) {
            return exactIn
                ? abi.encode(ExactInputSingleV20(k, zf1, uint128(amt), 0, ""))
                : abi.encode(ExactOutputSingleV20(k, zf1, uint128(amt), type(uint128).max, ""));
        }
        return exactIn
            ? abi.encode(IV4Router.ExactInputSingleParams(k, zf1, uint128(amt), 0, 0, ""))
            : abi.encode(IV4Router.ExactOutputSingleParams(k, zf1, uint128(amt), type(uint128).max, 0, ""));
    }

    /// @dev V4_SWAP input: [SWAP_EXACT_{IN,OUT}_SINGLE, SETTLE_ALL, TAKE_ALL]
    function _v4Input(bool v20, PoolKey memory k, bool isBuy, bool exactIn, uint256 amt)
        internal
        view
        returns (bytes memory)
    {
        bool zf1 = _swapParams(k, isBuy, exactIn, amt).zeroForOne;
        Currency inC = zf1 ? k.currency0 : k.currency1;
        Currency outC = zf1 ? k.currency1 : k.currency0;
        bytes memory actions = abi.encodePacked(
            uint8(exactIn ? Actions.SWAP_EXACT_IN_SINGLE : Actions.SWAP_EXACT_OUT_SINGLE),
            uint8(Actions.SETTLE_ALL),
            uint8(Actions.TAKE_ALL)
        );
        bytes[] memory params = new bytes[](3);
        params[0] = _swapParam(v20, k, zf1, exactIn, amt);
        params[1] = abi.encode(inC, type(uint256).max);
        params[2] = abi.encode(outC, uint256(0));
        return abi.encode(actions, params);
    }

    function _execute(address ur, bytes memory commands, bytes[] memory inputs, uint256 value) internal {
        vm.prank(trader);
        IUniversalRouter(ur).execute{value: value}(commands, inputs, block.timestamp + 60);
    }

    function _urSwap(address ur, PoolKey memory k, bool isBuy, bool exactIn, uint256 amt) internal {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _v4Input(ur == UR_V2_0, k, isBuy, exactIn, amt);
        _execute(ur, abi.encodePacked(V4_SWAP), inputs, 0);
    }

    /* The 8 cases through both deployed routers */

    function _case(address ur, bool isYes, bool isBuy, bool exactIn, uint256 amt) internal {
        PoolKey memory k = isYes ? kYes : kNo;
        OutcomeToken t = isYes ? yes : no;
        (uint256 q, uint256 cash) = _expect(mId, isYes, isBuy, exactIn, amt);
        uint256 quoted = _quoteV4(k, isBuy, exactIn, amt);
        assertEq(quoted, exactIn ? (isBuy ? q : cash) : (isBuy ? cash : q), "deployed V4Quoter == expectation");
        uint256 u0 = usdc.balanceOf(trader);
        uint256 t0 = t.balanceOf(trader);
        _urSwap(ur, k, isBuy, exactIn, amt);
        assertEq(usdc.balanceOf(trader), isBuy ? u0 - cash : u0 + cash, "usdc");
        assertEq(t.balanceOf(trader), isBuy ? t0 + q : t0 - q, "token");
        assertEq(usdc.balanceOf(ur), 0, "router keeps no usdc");
        assertEq(t.balanceOf(ur), 0, "router keeps no token");
    }

    function _all8(address ur) internal {
        for (uint256 pass; pass < 2; ++pass) {
            for (uint256 j; j < 8; ++j) {
                uint256 c = pass == 0 ? j : 7 - j;
                bool isYes = c < 4;
                bool isBuy = c % 4 < 2;
                bool exactIn = c % 2 == 0;
                uint256 amt = isBuy ? (exactIn ? 2_000 * E6 : 1_500 * E6) : (exactIn ? 700 * E6 : 300 * E6);
                _case(ur, isYes, isBuy, exactIn, amt);
            }
            vm.warp(block.timestamp + 1);
        }
        _checkInvariants();
    }

    function test_UR20_all8() public {
        _all8(UR_V2_0);
    }

    function test_UR212_all8() public {
        _all8(UR_V2_1_2);
    }

    /// @dev The web-app flow for a brand-new outcome token: PERMIT2_PERMIT signature + V4_SWAP (0x0a10), no approve tx
    function test_UR20_permit2PermitThenSwap_sellNewToken() public {
        _urSwap(UR_V2_0, kNo, true, false, 1_000 * E6);
        vm.prank(trader);
        PERMIT2.approve(address(no), UR_V2_0, 0, 0);
        vm.warp(block.timestamp + 1);
        assertEq(no.allowance(trader, address(PERMIT2)), type(uint256).max, "Solady Permit2 allowance");

        (,, uint48 nonce) = PERMIT2.allowance(trader, address(no), UR_V2_0);
        IAllowanceTransfer.PermitSingle memory ps = IAllowanceTransfer.PermitSingle({
            details: IAllowanceTransfer.PermitDetails({
                token: address(no),
                amount: type(uint160).max,
                expiration: uint48(block.timestamp + 1 days),
                nonce: nonce
            }),
            spender: UR_V2_0,
            sigDeadline: block.timestamp + 600
        });
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", PERMIT2.DOMAIN_SEPARATOR(), PermitHash.hash(ps)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(traderKey, digest);

        (, uint256 cash) = _expect(mId, false, false, true, 400 * E6);
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(ps, abi.encodePacked(r, s, v));
        inputs[1] = _v4Input(true, kNo, false, true, 400 * E6);
        uint256 u0 = usdc.balanceOf(trader);
        _execute(UR_V2_0, abi.encodePacked(PERMIT2_PERMIT, V4_SWAP), inputs, 0);
        assertEq(usdc.balanceOf(trader), u0 + cash);
        assertEq(no.balanceOf(trader), 600 * E6);
        _checkInvariants();
    }

    /// @dev ETH -> USDC (plain v4 pool) -> YES in one V4_SWAP; the intermediate USDC never leaves the PoolManager
    function test_UR20_multiHop_ETH_USDC_YES() public {
        PoolKey memory ethKey = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdc)), 500, 10, IHooks(address(0)));
        manager.initialize(ethKey, 4339505179874779489431521);
        PoolModifyLiquidityTest lpr = new PoolModifyLiquidityTest(manager);
        usdc.mint(address(this), 100_000_000 * E6);
        usdc.approve(address(lpr), type(uint256).max);
        vm.deal(address(this), 100_000 ether);
        lpr.modifyLiquidity{value: 50_000 ether}(ethKey, ModifyLiquidityParams(-887_270, 887_270, 1e16, 0), "");

        PathKey[] memory path = new PathKey[](2);
        path[0] = PathKey(Currency.wrap(address(usdc)), 500, 10, IHooks(address(0)), "");
        path[1] = PathKey(Currency.wrap(address(yes)), 0, 60, IHooks(address(hook)), "");
        uint256 amountIn = 0.5 ether;
        (uint256 usdcMid,) = QUOTER_1301.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams(ethKey, true, uint128(amountIn), "")
        );
        (uint256 wantYes,) = _expect(mId, true, true, true, usdcMid);
        (uint256 quotedYes,) = QUOTER_1301.quoteExactInput(
            IV4Quoter.QuoteExactParams(Currency.wrap(address(0)), path, uint128(amountIn))
        );
        assertEq(quotedYes, wantYes, "multi-hop quote");

        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputV20(Currency.wrap(address(0)), path, uint128(amountIn), 0));
        params[1] = abi.encode(Currency.wrap(address(0)), amountIn);
        params[2] = abi.encode(Currency.wrap(address(yes)), uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        uint256 u0 = usdc.balanceOf(trader);
        uint256 e0 = trader.balance;
        uint256 bucket0 = hook.marketInfo(mId).bucket;
        _execute(UR_V2_0, abi.encodePacked(V4_SWAP), inputs, amountIn);
        assertEq(yes.balanceOf(trader), wantYes, "YES out");
        assertEq(trader.balance, e0 - amountIn, "ETH in");
        assertEq(usdc.balanceOf(trader), u0, "no USDC to trader");
        assertEq(UR_V2_0.balance, 0, "router keeps no ETH");
        assertEq(hook.marketInfo(mId).bucket, bucket0 + usdcMid, "hop-1 USDC is collateral");
        _checkInvariants();
    }

    /// @dev A halt reaches the UR caller as the raw PoolManager WrappedError (no ExecutionFailed wrapper)
    function test_UR20_haltBubblesWrappedError() public {
        vm.warp(hook.marketInfo(mId).expiry - 1 hours);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _v4Input(true, kYes, true, true, 100 * E6);
        vm.expectRevert(_wrapped(PredictionHook.NotTradable.selector));
        _execute(UR_V2_0, abi.encodePacked(V4_SWAP), inputs, 0);
    }

    /// @dev A struct-layout mismatch fails closed on our pools (currency0 is never native): a revert with no data
    function test_structMismatch_revertsWithoutData() public {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = _v4Input(false, kYes, true, true, 100 * E6);
        vm.prank(trader);
        (bool ok20, bytes memory r20) = UR_V2_0.call(
            abi.encodeCall(IUniversalRouter.execute, (abi.encodePacked(V4_SWAP), inputs, block.timestamp + 60))
        );
        inputs[0] = _v4Input(true, kYes, true, true, 100 * E6);
        vm.prank(trader);
        (bool ok212, bytes memory r212) = UR_V2_1_2.call(
            abi.encodeCall(IUniversalRouter.execute, (abi.encodePacked(V4_SWAP), inputs, block.timestamp + 60))
        );
        assertFalse(ok20);
        assertFalse(ok212);
        assertEq(r20.length, 0);
        assertEq(r212.length, 0);
        assertEq(yes.balanceOf(trader), 0);
    }
}

contract UniversalRouterFork_OutcomeIsCurrency0 is UniversalRouterForkCases {
    function _outcomeIs0() internal pure override returns (bool) {
        return true;
    }
}

contract UniversalRouterFork_OutcomeIsCurrency1 is UniversalRouterForkCases {
    function _outcomeIs0() internal pure override returns (bool) {
        return false;
    }
}
