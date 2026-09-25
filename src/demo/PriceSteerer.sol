// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "solady/auth/Ownable.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
}

/// @title PriceSteerer
/// @notice Owner-only helper that moves a demo v4 pool to a target price and seeds its liquidity.
/// @dev Debts are paid from this contract's token balance first; any shortfall is minted straight into the
///      PoolManager, so the steerer must either be pre-funded or be a minter of the pool's demo tokens.
contract PriceSteerer is IUnlockCallback, Ownable {
    using StateLibrary for IPoolManager;
    using SafeTransferLib for address;

    error OnlyPoolManager();
    error NativeCurrencyUnsupported();
    error TargetOutOfRange(uint160 targetSqrtPriceX96);

    event Steered(PoolId indexed id, uint160 fromSqrtPriceX96, uint160 toSqrtPriceX96, int128 amount0, int128 amount1);
    event LiquidityModified(
        PoolId indexed id, int24 tickLower, int24 tickUpper, int256 liquidityDelta, int128 amount0, int128 amount1
    );

    enum Action {
        Swap,
        ModifyLiquidity
    }

    /// @dev Exact-in magnitude large enough that every steer stops at the price limit, small enough for int128.
    int256 internal constant STEER_AMOUNT = -int256(uint256(uint128(type(int128).max)));

    IPoolManager public immutable poolManager;

    constructor(IPoolManager poolManager_, address owner_) {
        poolManager = poolManager_;
        _initializeOwner(owner_);
    }

    /// @notice Swap the pool to exactly `targetSqrtPriceX96`. No-op when already there.
    function steer(PoolKey calldata key, uint160 targetSqrtPriceX96) external onlyOwner returns (BalanceDelta delta) {
        if (targetSqrtPriceX96 <= TickMath.MIN_SQRT_PRICE || targetSqrtPriceX96 >= TickMath.MAX_SQRT_PRICE) {
            revert TargetOutOfRange(targetSqrtPriceX96);
        }
        _requireErc20(key);
        PoolId id = key.toId();
        (uint160 current,,,) = poolManager.getSlot0(id);
        if (current == targetSqrtPriceX96) return delta;
        SwapParams memory params = SwapParams({
            zeroForOne: targetSqrtPriceX96 < current,
            amountSpecified: STEER_AMOUNT,
            sqrtPriceLimitX96: targetSqrtPriceX96
        });
        delta = abi.decode(poolManager.unlock(abi.encode(Action.Swap, key, abi.encode(params))), (BalanceDelta));
        emit Steered(id, current, targetSqrtPriceX96, delta.amount0(), delta.amount1());
    }

    /// @notice Add `liquidity` to the position [tickLower, tickUpper) owned by this contract (salt 0).
    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
        onlyOwner
        returns (BalanceDelta)
    {
        return _modifyLiquidity(key, tickLower, tickUpper, int256(uint256(liquidity)));
    }

    /// @notice Add `liquidity` over the widest range allowed by the pool's tick spacing.
    function addLiquidityFullRange(PoolKey calldata key, uint128 liquidity) external onlyOwner returns (BalanceDelta) {
        (int24 lower, int24 upper) = fullRange(key.tickSpacing);
        return _modifyLiquidity(key, lower, upper, int256(uint256(liquidity)));
    }

    /// @notice Remove `liquidity` from the position [tickLower, tickUpper) and keep the proceeds here.
    function removeLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
        onlyOwner
        returns (BalanceDelta)
    {
        return _modifyLiquidity(key, tickLower, tickUpper, -int256(uint256(liquidity)));
    }

    /// @notice Recover tokens held by this contract.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }

    /// @notice Usable [lower, upper] ticks for a full-range position at `tickSpacing`.
    function fullRange(int24 tickSpacing) public pure returns (int24 lower, int24 upper) {
        lower = TickMath.minUsableTick(tickSpacing);
        upper = TickMath.maxUsableTick(tickSpacing);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (Action action, PoolKey memory key, bytes memory inner) = abi.decode(data, (Action, PoolKey, bytes));
        BalanceDelta delta;
        if (action == Action.Swap) {
            delta = poolManager.swap(key, abi.decode(inner, (SwapParams)), "");
        } else {
            (delta,) = poolManager.modifyLiquidity(key, abi.decode(inner, (ModifyLiquidityParams)), "");
        }
        _resolve(key.currency0, delta.amount0());
        _resolve(key.currency1, delta.amount1());
        return abi.encode(delta);
    }

    function _modifyLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidityDelta)
        internal
        returns (BalanceDelta delta)
    {
        _requireErc20(key);
        ModifyLiquidityParams memory params = ModifyLiquidityParams({
            tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: bytes32(0)
        });
        delta =
            abi.decode(poolManager.unlock(abi.encode(Action.ModifyLiquidity, key, abi.encode(params))), (BalanceDelta));
        emit LiquidityModified(key.toId(), tickLower, tickUpper, liquidityDelta, delta.amount0(), delta.amount1());
    }

    function _resolve(Currency currency, int128 amount) internal {
        if (amount < 0) _pay(currency, uint256(uint128(-amount)));
        else if (amount > 0) poolManager.take(currency, address(this), uint256(uint128(amount)));
    }

    function _pay(Currency currency, uint256 amount) internal {
        address token = Currency.unwrap(currency);
        poolManager.sync(currency);
        uint256 balance = token.balanceOf(address(this));
        if (balance >= amount) {
            token.safeTransfer(address(poolManager), amount);
        } else {
            if (balance > 0) token.safeTransfer(address(poolManager), balance);
            IMintableERC20(token).mint(address(poolManager), amount - balance);
        }
        poolManager.settle();
    }

    function _requireErc20(PoolKey calldata key) internal pure {
        if (key.currency0.isAddressZero()) revert NativeCurrencyUnsupported();
    }
}
