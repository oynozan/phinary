// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IUnderlyingOracle} from "../../src/interfaces/IUnderlyingOracle.sol";
import {DemoToken} from "../../src/demo/DemoToken.sol";
import {PriceSteerer} from "../../src/demo/PriceSteerer.sol";
import {MockSobHook} from "./mocks/MockSobHook.sol";

/// @notice Steers the demo WETH/USDC pool when it carries the oracle's hook flags (AFTER_INITIALIZE | BEFORE_SWAP),
///         in both token orderings, with the oracle track's pool parameters (fee 500, tick spacing 10).
abstract contract HookedSteerBase is Test, Deployers {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
    uint24 internal constant FEE = 500;
    int24 internal constant SPACING = 10;
    uint128 internal constant LIQ = 1e18;
    uint32 internal constant T0 = 1_790_000_017;

    DemoToken internal weth;
    DemoToken internal usdc;
    PriceSteerer internal steerer;
    address internal hook;
    PoolKey internal poolKey;
    PoolId internal poolId;
    bool internal wethIs0;

    function _deployHook(address at, address usdc_, address weth_) internal virtual;

    /// @dev Asserts the hook's start-of-block sqrtPrice for the current block.
    function _assertSob(uint160 expected, string memory what) internal view virtual;

    function setUp() public virtual {
        vm.warp(T0);
        deployFreshManagerAndRouters();
        steerer = new PriceSteerer(manager, address(this));
    }

    function _pool(bool wethFirst, uint256 cents) internal {
        address lo = address(uint160(0x1000000000000000000000000000000000000000));
        address hi = address(uint160(0xE000000000000000000000000000000000000000));
        (address wethAt, address usdcAt) = wethFirst ? (lo, hi) : (hi, lo);
        deployCodeTo(
            "DemoToken.sol:DemoToken", abi.encode("Demo WETH", "dWETH", uint8(18), 0, 0, address(this)), wethAt
        );
        deployCodeTo("DemoToken.sol:DemoToken", abi.encode("Demo USDC", "dUSDC", uint8(6), 0, 0, address(this)), usdcAt);
        weth = DemoToken(wethAt);
        usdc = DemoToken(usdcAt);
        weth.setMinter(address(steerer), true);
        usdc.setMinter(address(steerer), true);
        wethIs0 = wethFirst;
        hook = address(FLAGS | (uint160(0x4444) << 144));
        _deployHook(hook, usdcAt, wethAt);
        poolKey = PoolKey(Currency.wrap(lo), Currency.wrap(hi), FEE, SPACING, IHooks(hook));
        poolId = poolKey.toId();
        manager.initialize(poolKey, _sqrtPriceForCents(cents));
        steerer.addLiquidityFullRange(poolKey, LIQ);
    }

    function _sqrtPriceForCents(uint256 cents) internal view returns (uint160) {
        uint256 ratioX192 = wethIs0
            ? FullMath.mulDiv(cents * 1e6, 1 << 192, 100 * 1e18)
            : FullMath.mulDiv(100 * 1e18, 1 << 192, cents * 1e6);
        return uint160(FixedPointMathLib.sqrt(ratioX192));
    }

    function _slot0() internal view returns (uint160 sp) {
        (sp,,,) = manager.getSlot0(poolId);
    }

    function _nextBlock(uint256 dt) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    function _steer(uint256 cents) internal returns (uint160 target) {
        target = _sqrtPriceForCents(cents);
        steerer.steer(poolKey, target);
        assertEq(_slot0(), target, "pool lands on target");
    }

    /// @dev Two steers in one block keep the start-of-block price; the next block starts at the last target.
    function _steerAcrossBlocks(bool wethFirst) internal {
        _pool(wethFirst, 2000_00);
        _nextBlock(2);
        uint160 start = _slot0();
        _steer(2701_35);
        _assertSob(start, "same block: pre-steer price");
        uint160 last = _steer(2650_07);
        _assertSob(start, "same block after a second steer");
        _nextBlock(1);
        _assertSob(last, "next block: last target");
        _nextBlock(3600);
        uint160 back = _steer(1999_99);
        _assertSob(last, "after a gap, same block");
        _nextBlock(1);
        _assertSob(back, "after a gap, next block");
    }

    function test_steerHooked_wethCurrency0() public {
        _steerAcrossBlocks(true);
    }

    function test_steerHooked_wethCurrency1() public {
        _steerAcrossBlocks(false);
    }
}

contract PriceSteererMockHookTest is HookedSteerBase {
    function _deployHook(address at, address, address) internal override {
        deployCodeTo("MockSobHook.sol:MockSobHook", abi.encode(manager), at);
    }

    function _assertSob(uint160 expected, string memory what) internal view override {
        assertEq(MockSobHook(hook).sobSqrtPrice(), expected, what);
    }

    function test_oneWritePerBlock() public {
        _pool(true, 2000_00);
        _nextBlock(2);
        _steer(2100_00);
        _steer(2200_00);
        assertEq(MockSobHook(hook).writes(), 1);
        _nextBlock(1);
        _steer(2300_00);
        assertEq(MockSobHook(hook).writes(), 2);
    }
}

/// @notice Runs against src/oracle/UnderlyingOracleHook.sol when that contract is part of the build; skipped otherwise.
contract PriceSteererOracleHookTest is HookedSteerBase {
    string internal constant ORACLE = "UnderlyingOracleHook.sol:UnderlyingOracleHook";
    uint256 internal constant YEAR = 31_557_600;

    function setUp() public override {
        try vm.getCode(ORACLE) returns (bytes memory) {}
        catch {
            vm.skip(true);
        }
        super.setUp();
    }

    /// @dev The oracle track's constructor gained an `underlying` currency after the first draft; both shapes are tried.
    function _deployHook(address at, address usdc_, address weth_) internal override {
        bytes memory tail = abi.encode(
            uint32(60),
            uint16(60),
            uint16(3),
            uint32(400),
            uint256(0.2e18) * 0.2e18 / YEAR,
            uint256(2.5e18) * 2.5e18 / YEAR,
            uint256(0.6e18) * 0.6e18 / YEAR,
            uint16(4096),
            address(this)
        );
        bytes memory code = vm.getCode(ORACLE);
        if (_create(at, code, abi.encodePacked(abi.encode(manager, usdc_, weth_), tail))) return;
        assertTrue(
            _create(at, code, abi.encodePacked(abi.encode(manager, usdc_), tail)), "UnderlyingOracleHook constructor"
        );
    }

    function _create(address at, bytes memory code, bytes memory args) internal returns (bool ok) {
        vm.etch(at, abi.encodePacked(code, args));
        bytes memory runtime;
        (ok, runtime) = at.call("");
        vm.etch(at, ok ? runtime : bytes(""));
    }

    /// @dev Inverts lnSpotSoBWad = ln(USD per ETH) through the pool's raw orientation; exp loses the last digits.
    function _assertSob(uint160 expected, string memory what) internal view override {
        uint160 sob = _sqrtPriceForLnUsd(IUnderlyingOracle(hook).lnSpotSoBWad());
        uint256 diff = sob > expected ? sob - expected : expected - sob;
        assertLe(diff * 1e12, uint256(expected), what);
    }

    function _sqrtPriceForLnUsd(int256 lnUsd) internal view returns (uint160) {
        uint256 usdE18 = uint256(FixedPointMathLib.expWad(lnUsd));
        uint256 ratioX192 = wethIs0 ? FullMath.mulDiv(usdE18, 1 << 192, 1e30) : FullMath.mulDiv(1e30, 1 << 192, usdE18);
        return uint160(FixedPointMathLib.sqrt(ratioX192));
    }

    function _lnUsdCents(uint256 cents) internal pure returns (int256) {
        return FixedPointMathLib.lnWad(int256(cents * 1e16));
    }

    function _steerAndReadLn(bool wethFirst) internal {
        _pool(wethFirst, 2000_00);
        assertEq(abi.encode(_poolKeyOf()), abi.encode(poolKey), "oracle binds the steered pool");
        assertEq(IUnderlyingOracle(hook).decimalsShift(), 12);
        _nextBlock(2);
        assertApproxEqAbs(IUnderlyingOracle(hook).lnSpotSoBWad(), _lnUsdCents(2000_00), 1e4);
        uint160 a = _steer(2701_35);
        assertApproxEqAbs(IUnderlyingOracle(hook).lnSpotSoBWad(), _lnUsdCents(2000_00), 1e4, "same block");
        _nextBlock(1);
        assertApproxEqAbs(IUnderlyingOracle(hook).lnSpotSoBWad(), _lnUsdCents(2701_35), 1e4, "next block");
        _assertSob(a, "next block, via sqrtPrice");
        _steer(2650_07);
        _steer(2655_55);
        _nextBlock(1);
        assertApproxEqAbs(IUnderlyingOracle(hook).lnSpotSoBWad(), _lnUsdCents(2655_55), 1e4);
        _nextBlock(7200);
        _steer(1500_00);
        _nextBlock(1);
        assertApproxEqAbs(IUnderlyingOracle(hook).lnSpotSoBWad(), _lnUsdCents(1500_00), 1e4);
    }

    function test_oracleTracksSteer_wethCurrency0() public {
        _steerAndReadLn(true);
    }

    function test_oracleTracksSteer_wethCurrency1() public {
        _steerAndReadLn(false);
    }

    function _poolKeyOf() internal view returns (PoolKey memory k) {
        (bool ok, bytes memory ret) = hook.staticcall(abi.encodeWithSignature("poolKey()"));
        assertTrue(ok, "poolKey()");
        k = abi.decode(ret, (PoolKey));
    }

    function _cool() internal {
        vm.cool(address(manager));
        vm.cool(hook);
        vm.cool(address(steerer));
        vm.cool(address(weth));
        vm.cool(address(usdc));
    }

    function _steerGas(uint256 cents) internal returns (uint256 used) {
        uint160 target = _sqrtPriceForCents(cents);
        _cool();
        uint256 g = gasleft();
        steerer.steer(poolKey, target);
        used = g - gasleft();
    }

    /// @dev The mirror sends steers with gas = estimate * 1.3 + 100k (bot/src/mirror.ts steerGasLimit). An RPC that
    ///      estimates in a block where the oracle already wrote misses the write; the padding must cover it.
    function _assertPadCovers(uint256 first, uint256 later) internal pure {
        assertLe(first, later * 13 / 10 + 100_000, "gas padding covers the oracle write");
    }

    function test_steerGasPaddingCoversOracleWrite() public {
        _pool(true, 2000_00);
        _nextBlock(2);
        uint256 first = _steerGas(2701_35);
        uint256 later = _steerGas(2702_35);
        emit log_named_uint("fresh ring: first steer in block", first);
        emit log_named_uint("fresh ring: later steer in block", later);
        assertGt(first, later);
        _assertPadCovers(first, later);

        for (uint256 i; i < 150; i++) {
            _nextBlock(12);
            _steer(i % 2 == 0 ? 2710_00 : 2690_00);
        }
        _nextBlock(12);
        first = _steerGas(2700_00);
        later = _steerGas(2701_00);
        emit log_named_uint("steady state: first steer in block", first);
        emit log_named_uint("steady state: later steer in block", later);
        _assertPadCovers(first, later);

        _nextBlock(1 days);
        first = _steerGas(2600_00);
        later = _steerGas(2601_00);
        emit log_named_uint("after a 1-day gap: first steer in block", first);
        _assertPadCovers(first, later);
    }
}
