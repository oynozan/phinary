// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {DemoToken} from "../../src/demo/DemoToken.sol";
import {PriceSteerer} from "../../src/demo/PriceSteerer.sol";

contract PriceSteererTest is Test, Deployers {
    using StateLibrary for IPoolManager;

    uint128 constant LIQ = 1e15;

    DemoToken weth;
    DemoToken usdc;
    PriceSteerer steerer;
    PoolKey poolKey;
    PoolId poolId;
    bool wethIs0;

    function setUp() public {
        deployFreshManagerAndRouters();
        steerer = new PriceSteerer(manager, address(this));
    }

    /// @dev Deploys demo WETH/USDC so that WETH sorts as currency0 iff `wethFirst`, then inits the pool at `cents`.
    function _pool(bool wethFirst, uint256 cents, bool steererMints) internal {
        address lo = address(uint160(0x1000000000000000000000000000000000000000));
        address hi = address(uint160(0xE000000000000000000000000000000000000000));
        (address wethAt, address usdcAt) = wethFirst ? (lo, hi) : (hi, lo);
        deployCodeTo(
            "DemoToken.sol:DemoToken", abi.encode("Demo WETH", "dWETH", uint8(18), 0, 0, address(this)), wethAt
        );
        deployCodeTo("DemoToken.sol:DemoToken", abi.encode("Demo USDC", "dUSDC", uint8(6), 0, 0, address(this)), usdcAt);
        weth = DemoToken(wethAt);
        usdc = DemoToken(usdcAt);
        if (steererMints) {
            weth.setMinter(address(steerer), true);
            usdc.setMinter(address(steerer), true);
        }
        wethIs0 = wethFirst;
        poolKey = PoolKey({
            currency0: Currency.wrap(lo),
            currency1: Currency.wrap(hi),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        poolId = poolKey.toId();
        manager.initialize(poolKey, _sqrtPriceForCents(cents));
    }

    /// @dev USD per ETH given in cents -> sqrtPriceX96 of the pool (raw token1 per raw token0), floored.
    function _sqrtPriceForCents(uint256 cents) internal view returns (uint160) {
        uint256 ratioX192 = wethIs0
            ? FullMath.mulDiv(cents * 1e6, 1 << 192, 100 * 1e18)
            : FullMath.mulDiv(100 * 1e18, 1 << 192, cents * 1e6);
        return uint160(FixedPointMathLib.sqrt(ratioX192));
    }

    function _usdCentsAt(uint160 sqrtPriceX96) internal view returns (uint256) {
        uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
        return wethIs0
            ? FullMath.mulDiv(ratioX192, 100 * 1e18, 1e6 << 192)
            : FullMath.mulDiv(100 * 1e18, 1 << 192, ratioX192 * 1e6);
    }

    function _slot0() internal view returns (uint160 sqrtPriceX96, int24 tick) {
        (sqrtPriceX96, tick,,) = manager.getSlot0(poolId);
    }

    function _assertAt(uint160 target) internal view {
        (uint160 sqrtPriceX96, int24 tick) = _slot0();
        assertEq(sqrtPriceX96, target, "sqrtPrice != target");
        int24 expected = TickMath.getTickAtSqrtPrice(target);
        assertTrue(tick == expected || tick == expected - 1, "tick inconsistent with price");
    }

    function _steerAndCheck(uint256 cents) internal returns (BalanceDelta delta) {
        uint160 target = _sqrtPriceForCents(cents);
        delta = steerer.steer(poolKey, target);
        _assertAt(target);
        assertApproxEqAbs(_usdCentsAt(target), cents, 1);
    }

    function _steerUpDown(bool wethFirst) internal {
        _pool(wethFirst, 2000_00, true);
        steerer.addLiquidityFullRange(poolKey, LIQ);

        uint256 wethBefore = weth.balanceOf(address(steerer));
        _steerAndCheck(2101_37);
        assertEq(weth.balanceOf(address(steerer)) - wethBefore > 0, true, "ETH up: steerer buys WETH");

        uint256 usdcBefore = usdc.balanceOf(address(steerer));
        _steerAndCheck(1899_99);
        assertGt(usdc.balanceOf(address(steerer)), usdcBefore, "ETH down: steerer buys USDC");

        _steerAndCheck(2000_00);
        _steerAndCheck(2000_01);
        _steerAndCheck(1999_99);
        _steerAndCheck(4000_00);
        _steerAndCheck(500_00);
    }

    function test_steerUpDown_wethCurrency0() public {
        _steerUpDown(true);
        assertTrue(wethIs0);
    }

    function test_steerUpDown_wethCurrency1() public {
        _steerUpDown(false);
        assertFalse(wethIs0);
    }

    function test_orientationWethCurrency0() public {
        _pool(true, 2000_00, true);
        (uint160 before,) = _slot0();
        assertGt(_sqrtPriceForCents(2100_00), before, "ETH up is sqrtPrice up");
    }

    function test_orientationWethCurrency1() public {
        _pool(false, 2000_00, true);
        (uint160 before,) = _slot0();
        assertLt(_sqrtPriceForCents(2100_00), before, "ETH up is sqrtPrice down");
    }

    function test_steerNoopAtTarget() public {
        _pool(true, 2000_00, true);
        steerer.addLiquidityFullRange(poolKey, LIQ);
        (uint160 current,) = _slot0();
        uint256 w = weth.balanceOf(address(steerer));
        uint256 u = usdc.balanceOf(address(steerer));
        BalanceDelta delta = steerer.steer(poolKey, current);
        assertEq(BalanceDelta.unwrap(delta), 0);
        _assertAt(current);
        assertEq(weth.balanceOf(address(steerer)), w);
        assertEq(usdc.balanceOf(address(steerer)), u);
    }

    function test_steerWithoutLiquidityMovesPriceForFree() public {
        _pool(false, 2000_00, true);
        uint160 target = _sqrtPriceForCents(3333_33);
        BalanceDelta delta = steerer.steer(poolKey, target);
        assertEq(BalanceDelta.unwrap(delta), 0);
        _assertAt(target);
    }

    function test_steerAcrossNarrowRangeAndBeyond() public {
        _pool(true, 2000_00, true);
        (, int24 tick) = _slot0();
        int24 lower = (tick / 60 - 10) * 60;
        int24 upper = (tick / 60 + 10) * 60;
        steerer.addLiquidity(poolKey, lower, upper, LIQ);
        _steerAndCheck(2500_00);
        _steerAndCheck(1500_00);
        _steerAndCheck(2000_00);
        (, tick) = _slot0();
        assertTrue(tick >= lower && tick < upper);
    }

    function test_steerSignsAndSettlement() public {
        _pool(true, 2000_00, true);
        steerer.addLiquidityFullRange(poolKey, LIQ);
        uint256 w = weth.balanceOf(address(steerer));
        uint256 u = usdc.balanceOf(address(steerer));
        uint256 wethSupply = weth.totalSupply();

        BalanceDelta up = steerer.steer(poolKey, _sqrtPriceForCents(2200_00));
        assertLt(up.amount1(), 0, "pays USDC (currency1)");
        assertGt(up.amount0(), 0, "receives WETH (currency0)");
        assertEq(weth.balanceOf(address(steerer)), w + uint128(up.amount0()));
        assertEq(usdc.balanceOf(address(steerer)), u, "USDC shortfall minted straight to the PoolManager");
        assertEq(weth.totalSupply(), wethSupply);

        weth.mint(address(steerer), 1e18);
        wethSupply = weth.totalSupply();
        w = weth.balanceOf(address(steerer));
        u = usdc.balanceOf(address(steerer));
        BalanceDelta down = steerer.steer(poolKey, _sqrtPriceForCents(2000_00));
        assertLt(down.amount0(), 0, "pays WETH (currency0)");
        assertGt(down.amount1(), 0, "receives USDC (currency1)");
        assertEq(weth.balanceOf(address(steerer)), w - uint128(-down.amount0()), "WETH debt paid from balance");
        assertEq(weth.totalSupply(), wethSupply, "nothing minted when the balance covers the debt");
        assertEq(usdc.balanceOf(address(steerer)), u + uint128(down.amount1()));
    }

    function test_prefundedNonMinter() public {
        _pool(false, 2000_00, false);
        weth.mint(address(steerer), 1_000e18);
        usdc.mint(address(steerer), 2_000_000e6);
        steerer.addLiquidityFullRange(poolKey, LIQ);
        uint256 wethSupply = weth.totalSupply();
        uint256 usdcSupply = usdc.totalSupply();
        _steerAndCheck(2050_00);
        _steerAndCheck(1950_00);
        assertEq(weth.totalSupply(), wethSupply);
        assertEq(usdc.totalSupply(), usdcSupply);
    }

    function test_unfundedNonMinterReverts() public {
        _pool(true, 2000_00, false);
        vm.expectRevert();
        steerer.addLiquidityFullRange(poolKey, LIQ);
    }

    function test_addAndRemoveLiquidity() public {
        _pool(true, 2000_00, true);
        (int24 lower, int24 upper) = steerer.fullRange(60);
        assertEq(lower, TickMath.minUsableTick(60));
        assertEq(upper, TickMath.maxUsableTick(60));

        BalanceDelta added = steerer.addLiquidityFullRange(poolKey, LIQ);
        assertLt(added.amount0(), 0);
        assertLt(added.amount1(), 0);
        assertEq(manager.getLiquidity(poolId), LIQ);
        assertEq(weth.balanceOf(address(manager)), uint128(-added.amount0()));
        assertEq(usdc.balanceOf(address(manager)), uint128(-added.amount1()));

        BalanceDelta removed = steerer.removeLiquidity(poolKey, lower, upper, LIQ);
        assertEq(manager.getLiquidity(poolId), 0);
        assertApproxEqAbs(uint128(removed.amount0()), uint128(-added.amount0()), 1);
        assertApproxEqAbs(uint128(removed.amount1()), uint128(-added.amount1()), 1);
        assertEq(weth.balanceOf(address(steerer)), uint128(removed.amount0()));
        assertEq(usdc.balanceOf(address(steerer)), uint128(removed.amount1()));
    }

    function test_withdraw() public {
        _pool(true, 2000_00, true);
        weth.mint(address(steerer), 5e18);
        steerer.withdraw(address(weth), address(0xBEEF), 2e18);
        assertEq(weth.balanceOf(address(0xBEEF)), 2e18);
        assertEq(weth.balanceOf(address(steerer)), 3e18);
    }

    function test_onlyOwner() public {
        _pool(true, 2000_00, true);
        address mallory = makeAddr("mallory");
        vm.startPrank(mallory);
        vm.expectRevert(Ownable.Unauthorized.selector);
        steerer.steer(poolKey, _sqrtPriceForCents(2100_00));
        vm.expectRevert(Ownable.Unauthorized.selector);
        steerer.addLiquidityFullRange(poolKey, LIQ);
        vm.expectRevert(Ownable.Unauthorized.selector);
        steerer.addLiquidity(poolKey, -600, 600, LIQ);
        vm.expectRevert(Ownable.Unauthorized.selector);
        steerer.removeLiquidity(poolKey, -600, 600, LIQ);
        vm.expectRevert(Ownable.Unauthorized.selector);
        steerer.withdraw(address(weth), mallory, 1);
        vm.stopPrank();
    }

    function test_unlockCallbackOnlyPoolManager() public {
        vm.expectRevert(PriceSteerer.OnlyPoolManager.selector);
        steerer.unlockCallback("");
    }

    function test_targetOutOfRange() public {
        _pool(true, 2000_00, true);
        vm.expectRevert(abi.encodeWithSelector(PriceSteerer.TargetOutOfRange.selector, TickMath.MIN_SQRT_PRICE));
        steerer.steer(poolKey, TickMath.MIN_SQRT_PRICE);
        vm.expectRevert(abi.encodeWithSelector(PriceSteerer.TargetOutOfRange.selector, TickMath.MAX_SQRT_PRICE));
        steerer.steer(poolKey, TickMath.MAX_SQRT_PRICE);
    }

    function test_nativeCurrencyUnsupported() public {
        PoolKey memory nk = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(0xE000000000000000000000000000000000000000)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        vm.expectRevert(PriceSteerer.NativeCurrencyUnsupported.selector);
        steerer.steer(nk, SQRT_PRICE_1_1);
    }

    function testFuzz_steerExact(bool wethFirst, uint256 centsA, uint256 centsB) public {
        _pool(wethFirst, 2000_00, true);
        steerer.addLiquidityFullRange(poolKey, LIQ);
        centsA = bound(centsA, 1_00, 1_000_000_00);
        centsB = bound(centsB, 1_00, 1_000_000_00);
        _steerAndCheck(centsA);
        _steerAndCheck(centsB);
    }

    function testFuzz_steerRawTargets(bool wethFirst, uint160 a, uint160 b) public {
        _pool(wethFirst, 2000_00, true);
        steerer.addLiquidityFullRange(poolKey, LIQ);
        a = uint160(bound(a, TickMath.MIN_SQRT_PRICE + 1, TickMath.MAX_SQRT_PRICE - 1));
        b = uint160(bound(b, TickMath.MIN_SQRT_PRICE + 1, TickMath.MAX_SQRT_PRICE - 1));
        steerer.steer(poolKey, a);
        _assertAt(a);
        steerer.steer(poolKey, b);
        _assertAt(b);
    }
}
