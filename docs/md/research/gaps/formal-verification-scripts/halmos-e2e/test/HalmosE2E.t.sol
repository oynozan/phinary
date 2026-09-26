// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {ProtoBase} from "./Base.t.sol";
import {PredictionHookProto} from "../src/PredictionHookProto.sol";
import {MockUSDC} from "../src/OutcomeToken.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// End-to-end symbolic check through the REAL v4 PoolManager + PoolSwapTest router + hook (flash accounting,
/// transient-storage deltas, ERC-6909 claims, sync/settle on-demand mint). One symbolic swap from a concrete
/// funded state, symbolic price (mid, halfSpread), all 8 cases (isYes x buying x exactIn).
contract HalmosE2E is ProtoBase {
    function setUp() public {
        // same as ProtoBase._deploy, but etches the hook (all-immutable constructor) instead of deployCodeTo,
        // because halmos 0.3.3 lacks vm.deployCode
        trader = address(0xBEEF); // makeAddr() is symbolic under halmos -> multiple setUp paths
        deployFreshManagerAndRouters();
        usdc = new MockUSDC();
        address where = address(FLAGS | (uint160(0x4444) << 144));
        PredictionHookProto tmp = new PredictionHookProto(manager, Currency.wrap(address(usdc)), PredictionHookProto.Mode.OnDemand);
        vm.etch(where, address(tmp).code);
        hook = PredictionHookProto(where);
        mId = hook.createMarket(true, 0.40e18, 0.01e18);
        (yes, no,,,,,,,,,) = hook.markets(mId);
        kYes = _k(true);
        kNo = _k(false);
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
        _swap(true, true, true, 1000 * E6); // concrete pre-state: some outstanding YES, trader holds YES
    }
    function _S() internal view returns (bool) {
        (,, uint256 bucket, uint256 invY, uint256 invN, uint256 outY, uint256 outN,,,,) = hook.markets(mId);
        bool s3 = bucket >= (outY > outN ? outY : outN);
        bool s4 = hook.totalBuckets() == bucket && bucket == manager.balanceOf(address(hook), uint160(address(usdc)));
        bool s2 = invY == manager.balanceOf(address(hook), uint160(address(yes))) && invN == manager.balanceOf(address(hook), uint160(address(no)));
        bool s1 = outY == yes.totalSupply() - invY && outN == no.totalSupply() - invN;
        return s1 && s2 && s3 && s4;
    }
    function check_e2e_oneSwap(bool isYes, bool buying, bool exactIn, uint64 amt, uint64 mid, uint64 hs) public {
        vm.assume(mid > 0 && mid < 1e18 && hs < mid && mid + hs < 1e18);
        hook.setPrice(mId, mid, hs);
        try this.doSwap(isYes, buying, exactIn, amt) {} catch {}
        assert(_S());
    }
    function doSwap(bool isYes, bool buying, bool exactIn, uint256 amt) external { _swap(isYes, buying, exactIn, amt); }
}
