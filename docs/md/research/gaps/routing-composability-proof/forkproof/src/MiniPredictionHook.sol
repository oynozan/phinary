// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTestHooks} from "v4-core/src/test/BaseTestHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SoBOracleHook} from "./SoBOracleHook.sol";

/// @notice 6-decimal outcome token, mint/burn only by the hook, no transfer callbacks.
contract OutcomeToken is ERC20 {
    address public immutable hook;

    error OnlyHook();

    constructor(string memory n, string memory s) ERC20(n, s, 6) {
        hook = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != hook) revert OnlyHook();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != hook) revert OnlyHook();
        _burn(from, amount);
    }
}

/// @title MiniPredictionHook
/// @notice ROUTING/COMPOSABILITY prototype (not the pricing model). One market, two pools (YES/USDC, NO/USDC).
///         Price is a deterministic, monotone stand-in for the digital price, fed by the SoB spot of an
///         oracle-hooked underlying ETH/USDC pool:  pYES = S/(S+K), pNO = 1 - pYES, ask/bid = p +/- h.
///         Swaps are fully NoOp'd via beforeSwapReturnDelta; accounting follows the "virtual complete sets"
///         design of the swap-path gap report (B = USDC claims, outY/outN outstanding, B >= max(outY,outN)).
///         Halts (all revert, never partial-fill): 1 = band, 2 = cutoff, 3 = per-trade cap, 4 = collateral.
///         hookData modes (optional; empty hookData = normal pricing):
///           abi.encode(uint8(1), address recipient) on a USDC -> X exact-in swap: SPLIT at par, the other side
///             is minted as ERC20 directly to `recipient`;
///           abi.encode(uint8(2)) on an X -> USDC exact-in swap: MERGE at par, consuming the other side that was
///             transferred to the hook earlier in the same transaction (e.g. UR PERMIT2_TRANSFER_FROM).
contract MiniPredictionHook is BaseTestHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant WAD = 1e18;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint8 internal constant MODE_SPLIT = 1;
    uint8 internal constant MODE_MERGE = 2;

    IPoolManager public immutable manager;
    SoBOracleHook public immutable oracle;
    PoolId public immutable underlyingId;
    Currency public immutable usdc;
    address public immutable admin;

    OutcomeToken public yes;
    OutcomeToken public no;
    PoolKey internal _yesKey;
    PoolKey internal _noKey;
    uint256 public strikeWad; // K, USD per ETH, WAD
    uint256 public halfSpread = 0.005e18;
    uint256 public pMin = 0.02e18;
    uint256 public cutoff; // unix time after which trading halts
    uint256 public capPerTrade = type(uint256).max; // max outcome tokens out per swap

    uint256 public bucket; // B: USDC ERC-6909 claims owned by this market
    uint256 public outYes;
    uint256 public outNo;
    mapping(PoolId => uint8) public side; // 1 = YES pool, 2 = NO pool

    error NotPoolManager();
    error NotAdmin();
    error MarketHalted(uint8 code);
    error ForeignInitialize();
    error LiquidityBlocked();
    error UnknownPool();
    error ExactOutputUnsupported();
    error BadMode();
    error MergeNotFunded(uint256 have, uint256 need);

    /// @dev Same signature as Uniswap's aggregator hooks (IAggregatorHook), which the Uniswap v4-subgraph ABI knows.
    event HookSwap(PoolId indexed poolId, address indexed sender, int256 amount0, int256 amount1, uint24 swapFee);
    event Split(address indexed recipient, uint256 amount);
    event Merge(uint256 amount);

    modifier onlyPM() {
        if (msg.sender != address(manager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager _manager, SoBOracleHook _oracle, PoolId _underlyingId, Currency _usdc) {
        manager = _manager;
        oracle = _oracle;
        underlyingId = _underlyingId;
        usdc = _usdc;
        admin = msg.sender;
    }

    // ------------------------------------------------------------------ admin / setup
    function createMarket(uint256 _strikeWad, uint256 _cutoff) external returns (PoolKey memory, PoolKey memory) {
        if (msg.sender != admin) revert NotAdmin();
        strikeWad = _strikeWad;
        cutoff = _cutoff;
        yes = new OutcomeToken("YES ETH>K", "YES");
        no = new OutcomeToken("NO ETH>K", "NO");
        _yesKey = _key(address(yes));
        _noKey = _key(address(no));
        side[_yesKey.toId()] = 1;
        side[_noKey.toId()] = 2;
        manager.initialize(_yesKey, SQRT_PRICE_1_1); // self-call: beforeInitialize skipped (noSelfCall)
        manager.initialize(_noKey, SQRT_PRICE_1_1);
        return (_yesKey, _noKey);
    }

    function setParams(uint256 _pMin, uint256 _cutoff, uint256 _cap) external {
        if (msg.sender != admin) revert NotAdmin();
        pMin = _pMin;
        cutoff = _cutoff;
        capPerTrade = _cap;
    }

    function yesKey() external view returns (PoolKey memory) {
        return _yesKey;
    }

    function noKey() external view returns (PoolKey memory) {
        return _noKey;
    }

    function _key(address outcome) internal view returns (PoolKey memory k) {
        address u = Currency.unwrap(usdc);
        (address c0, address c1) = outcome < u ? (outcome, u) : (u, outcome);
        k = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 0, 1, IHooks(address(this)));
    }

    /// @notice LP collateral deposit (own unlock): USDC -> hook-owned ERC-6909 USDC claims.
    function fund(uint256 amount) external {
        manager.unlock(abi.encode(msg.sender, amount));
    }

    function unlockCallback(bytes calldata data) external onlyPM returns (bytes memory) {
        (address from, uint256 amount) = abi.decode(data, (address, uint256));
        manager.sync(usdc);
        ERC20(Currency.unwrap(usdc)).transferFrom(from, address(manager), amount);
        manager.settle();
        manager.mint(address(this), usdc.toId(), amount);
        bucket += amount;
        return "";
    }

    // ------------------------------------------------------------------ pricing
    function spotWad() public view returns (uint256) {
        uint160 sp = oracle.sobSqrtPriceX96(underlyingId);
        return FullMath.mulDiv(FullMath.mulDiv(sp, sp, 1 << 96), 1e30, 1 << 96); // ETH(18) / USDC(6)
    }

    function mid(bool isYes) public view returns (uint256) {
        uint256 s = spotWad();
        uint256 pY = FullMath.mulDiv(s, WAD, s + strikeWad);
        return isYes ? pY : WAD - pY;
    }

    function _checkLive(uint256 p) internal view {
        if (block.timestamp >= cutoff) revert MarketHalted(2);
        if (p < pMin || p > WAD - pMin) revert MarketHalted(1);
    }

    function quoteBuyExactIn(bool isYes, uint256 cash) public view returns (uint256 q) {
        uint256 p = mid(isYes);
        _checkLive(p);
        q = FullMath.mulDiv(cash, WAD, p + halfSpread); // floor output
        if (q > capPerTrade) revert MarketHalted(3);
    }

    function quoteSellExactIn(bool isYes, uint256 q) public view returns (uint256 cash) {
        uint256 p = mid(isYes);
        _checkLive(p);
        if (q > capPerTrade) revert MarketHalted(3);
        cash = FullMath.mulDiv(q, p - halfSpread, WAD); // floor output
    }

    // ------------------------------------------------------------------ hook callbacks
    function beforeInitialize(address, PoolKey calldata, uint160) external view override onlyPM returns (bytes4) {
        revert ForeignInitialize(); // only reached for third-party initialize (our own is a self-call)
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        override
        onlyPM
        returns (bytes4)
    {
        revert LiquidityBlocked();
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        override
        onlyPM
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint8 s = side[key.toId()];
        if (s == 0) revert UnknownPool();
        if (params.amountSpecified >= 0) revert ExactOutputUnsupported();
        bool isYes = s == 1;
        OutcomeToken outTok = isYes ? yes : no;
        OutcomeToken otherTok = isYes ? no : yes;
        Currency inC = params.zeroForOne ? key.currency0 : key.currency1;
        uint256 amountIn = uint256(-params.amountSpecified);
        uint8 mode = hookData.length == 0 ? 0 : abi.decode(hookData, (uint8));
        uint256 amountOut;

        if (inC == usdc) {
            // ---------------- buy X with USDC (or SPLIT)
            if (mode == MODE_SPLIT) {
                (, address recipient) = abi.decode(hookData, (uint8, address));
                if (block.timestamp >= cutoff) revert MarketHalted(2);
                amountOut = amountIn; // par
                otherTok.mint(recipient, amountIn); // the other leg leaves outside PM accounting
                outYes += amountIn;
                outNo += amountIn;
                emit Split(recipient, amountIn);
            } else if (mode == 0) {
                amountOut = quoteBuyExactIn(isYes, amountIn);
                if (isYes) outYes += amountOut;
                else outNo += amountOut;
            } else {
                revert BadMode();
            }
            bucket += amountIn;
            manager.mint(address(this), usdc.toId(), amountIn); // take the USDC as claims
            uint256 inv = manager.balanceOf(address(this), uint256(uint160(address(outTok))));
            uint256 fromInv = inv < amountOut ? inv : amountOut;
            if (fromInv > 0) manager.burn(address(this), uint256(uint160(address(outTok))), fromInv);
            uint256 minted = amountOut - fromInv;
            if (minted > 0) {
                manager.sync(Currency.wrap(address(outTok)));
                outTok.mint(address(manager), minted);
                manager.settle();
            }
        } else {
            // ---------------- sell X for USDC (or MERGE)
            if (mode == MODE_MERGE) {
                uint256 have = otherTok.balanceOf(address(this));
                if (have < amountIn) revert MergeNotFunded(have, amountIn);
                otherTok.burn(address(this), amountIn);
                amountOut = amountIn; // par
                outYes -= amountIn;
                outNo -= amountIn;
                emit Merge(amountIn);
            } else if (mode == 0) {
                amountOut = quoteSellExactIn(isYes, amountIn);
                if (isYes) outYes -= amountIn;
                else outNo -= amountIn;
            } else {
                revert BadMode();
            }
            bucket -= amountOut;
            manager.mint(address(this), uint256(uint160(address(outTok))), amountIn); // take X as claims (inventory)
            manager.burn(address(this), usdc.toId(), amountOut); // pay USDC from claims
        }
        if (bucket < (outYes > outNo ? outYes : outNo)) revert MarketHalted(4);

        int128 dIn = int128(int256(amountIn));
        int128 dOut = -int128(int256(amountOut));
        (int256 a0, int256 a1) = params.zeroForOne ? (int256(dIn), int256(dOut)) : (int256(dOut), int256(dIn));
        emit HookSwap(key.toId(), sender, a0, a1, 0);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(dIn, dOut), 0);
    }
}
