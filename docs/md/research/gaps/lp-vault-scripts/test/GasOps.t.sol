// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import "./Series.t.sol";

contract GasOpsTest is SeriesTest {
    function _cool(uint256[3] memory m) internal {
        vm.cool(address(hook)); vm.cool(address(manager)); vm.cool(address(usdcT));
        for (uint256 i; i < 3; ++i) { vm.cool(Currency.unwrap(_yes(m[i]))); vm.cool(Currency.unwrap(_no(m[i]))); }
    }
    function test_gas_lpOps() public {
        (uint256 sid, uint256[3] memory m) = _series3(1_000_000 * U, false);
        for (uint256 i; i < 3; ++i) _approveOutcomes(m[i]);
        uint256 g;
        _cool(m); g = gasleft(); vm.prank(lp1); hook.subscribe(sid, 600_000 * U); emit log_named_uint("subscribe (first)", g - gasleft());
        _cool(m); g = gasleft(); vm.prank(lp2); hook.subscribe(sid, 400_000 * U); emit log_named_uint("subscribe (second LP)", g - gasleft());
        vm.warp(T0 + 50 minutes);
        _cool(m); g = gasleft(); hook.topUp(m[0], 300_000 * U); emit log_named_uint("topUp (first, per market)", g - gasleft());
        hook.topUp(m[1], 300_000 * U); hook.topUp(m[2], 300_000 * U);
        _cool(m); g = gasleft(); hook.topUp(m[0], 1_000 * U); emit log_named_uint("topUp (repeat)", g - gasleft());
        _cool(m); g = gasleft(); hook.merge(m[0], 1_000 * U); emit log_named_uint("merge", g - gasleft());
        vm.warp(T0 + 1 hours);
        _swap(alice, m[1], true, true, true, 10_000 * U);
        _swap(bob, m[0], false, true, true, 10_000 * U);
        vm.warp(T0 + 7 days);
        hook.setOracle(sid, 5200);
        _cool(m); g = gasleft(); hook.settle(sid); emit log_named_uint("settle (series, oracle stub)", g - gasleft());
        _cool(m); g = gasleft(); hook.finalize(sid); emit log_named_uint("finalize (3 markets)", g - gasleft());
        (,, OutcomeToken y1,,,,,) = hook.markets(m[1]);
        uint256 aY = y1.balanceOf(alice);
        _cool(m); g = gasleft(); vm.prank(alice); hook.redeem(m[1], true, aY / 2, alice, true); emit log_named_uint("redeem -> 6909 claims", g - gasleft());
        _cool(m); g = gasleft(); vm.prank(alice); hook.redeem(m[1], true, aY - aY / 2, alice, false); emit log_named_uint("redeem -> ERC20 (unlock+take)", g - gasleft());
        _cool(m); g = gasleft(); vm.prank(lp1); hook.claim(sid, 600_000 * U, lp1, true); emit log_named_uint("LP claim -> 6909 claims", g - gasleft());
        _cool(m); g = gasleft(); vm.prank(lp2); hook.claim(sid, 400_000 * U, lp2, false); emit log_named_uint("LP claim -> ERC20", g - gasleft());
    }
}
