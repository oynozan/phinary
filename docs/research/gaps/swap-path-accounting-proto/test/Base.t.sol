// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PredictionHookProto} from "../src/PredictionHookProto.sol";
import {OutcomeToken, MockUSDC} from "../src/OutcomeToken.sol";

abstract contract ProtoBase is Test, Deployers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint160 constant FLAGS = uint160((1 << 13) | (1 << 11) | (1 << 7) | (1 << 3)); // 0x2888
    uint256 constant E6 = 1e6;
    uint160 constant SQRT_1_1 = 79228162514264337593543950336;

    MockUSDC usdc;
    PredictionHookProto hook;
    uint256 mId;
    OutcomeToken yes;
    OutcomeToken no;
    PoolKey kYes;
    PoolKey kNo;
    address trader = makeAddr("trader");
    uint256 hookSalt;

    function _deploy(PredictionHookProto.Mode mode, bool outcomeIs0) internal {
        deployFreshManagerAndRouters(); // FRESH PoolManager: holds zero of every token (catches T23 / take-before-pay)
        usdc = new MockUSDC();
        address where = address(FLAGS | (uint160(0x4444 + hookSalt++) << 144));
        deployCodeTo(
            "PredictionHookProto.sol:PredictionHookProto",
            abi.encode(address(manager), Currency.wrap(address(usdc)), mode),
            where
        );
        hook = PredictionHookProto(where);
        mId = hook.createMarket(outcomeIs0, 0.40e18, 0.01e18);
        (yes, no,,,,,,,,,) = hook.markets(mId);
        kYes = _k(true);
        kNo = _k(false);
        assertEq(Currency.unwrap(kYes.currency0) == address(yes), outcomeIs0, "ordering YES");
        assertEq(Currency.unwrap(kNo.currency0) == address(no), outcomeIs0, "ordering NO");

        usdc.mint(address(this), 1_000_000 * E6);
        usdc.approve(address(hook), type(uint256).max);
        hook.fund(mId, 1_000_000 * E6);

        usdc.mint(trader, 100_000 * E6);
        vm.startPrank(trader);
        usdc.approve(address(swapRouter), type(uint256).max);
        yes.approve(address(swapRouter), type(uint256).max);
        no.approve(address(swapRouter), type(uint256).max);
        usdc.approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    function _k(bool isYes) internal view returns (PoolKey memory k) {
        Currency c0;
        Currency c1;
        uint24 fee;
        int24 ts;
        IHooks h;
        if (isYes) (c0, c1, fee, ts, h) = hook.yesKey(mId);
        else (c0, c1, fee, ts, h) = hook.noKey(mId);
        k = PoolKey(c0, c1, fee, ts, h);
    }

    /// buying = USDC -> outcome. exactIn: amt is input; else amt is output.
    function _params(PoolKey memory k, bool buying, bool exactIn, uint256 amt)
        internal
        view
        returns (SwapParams memory p)
    {
        bool usdcIs0 = Currency.unwrap(k.currency0) == address(usdc);
        bool zf1 = buying ? usdcIs0 : !usdcIs0;
        p = SwapParams({
            zeroForOne: zf1,
            amountSpecified: exactIn ? -int256(amt) : int256(amt),
            sqrtPriceLimitX96: zf1 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
    }

    function _swap(bool isYes, bool buying, bool exactIn, uint256 amt) internal returns (BalanceDelta d) {
        PoolKey memory k = isYes ? kYes : kNo;
        SwapParams memory p = _params(k, buying, exactIn, amt);
        vm.prank(trader);
        d = swapRouter.swap(k, p, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    /// Solidity-level invariants (report §5). Called after every step.
    function _checkInvariants() internal view {
        (,, uint256 bucket, uint256 invY, uint256 invN, uint256 outY, uint256 outN,,, PredictionHookProto.Status st, bool yw) =
            hook.markets(mId);
        // S1 outstanding counters == ERC20 supply minus hook inventory
        assertEq(outY, yes.totalSupply() - invY, "S1 outYes");
        assertEq(outN, no.totalSupply() - invN, "S1 outNo");
        // S2 inventory counters == hook's ERC-6909 claim balances
        assertEq(invY, manager.balanceOf(address(hook), uint160(address(yes))), "S2 invYes");
        assertEq(invN, manager.balanceOf(address(hook), uint160(address(no))), "S2 invNo");
        // S3 per-market solvency
        uint256 req = st == PredictionHookProto.Status.Resolved ? (yw ? outY : outN) : _max(outY, outN);
        assertGe(bucket, req, "S3 solvency");
        // S4 sum of buckets == hook USDC claims (single market here)
        assertEq(hook.totalBuckets(), bucket, "S4a");
        assertEq(hook.totalBuckets(), manager.balanceOf(address(hook), uint160(address(usdc))), "S4 claims");
        // S5 PoolManager physically backs every claim (no other claim holders in these tests)
        assertGe(usdc.balanceOf(address(manager)), hook.totalBuckets(), "S5 usdc backing");
        assertGe(yes.balanceOf(address(manager)), invY, "S5 yes backing");
        assertGe(no.balanceOf(address(manager)), invN, "S5 no backing");
        // S6 virtual complete-set identities (05 I1, I4, I5 restated)
        if (st != PredictionHookProto.Status.Resolved) {
            uint256 C = _max(outY, outN);
            uint256 Yv = C - outY;
            uint256 Nv = C - outN;
            assertEq(Yv < Nv ? Yv : Nv, 0, "I4 netting");
            assertGe(bucket, C, "I5 U>=0");
        }
        // S7 no CL fall-through: cosmetic price never moves
        (uint160 sp0,,,) = manager.getSlot0(kYes.toId());
        (uint160 sp1,,,) = manager.getSlot0(kNo.toId());
        assertEq(sp0, SQRT_1_1, "S7 yes slot0");
        assertEq(sp1, SQRT_1_1, "S7 no slot0");
    }
}

