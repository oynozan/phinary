// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IHookEvents} from "@openzeppelin/uniswap-hooks/interfaces/IHookEvents.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IPredictionHook} from "./interfaces/IPredictionHook.sol";
import {IUnderlyingOracle} from "./interfaces/IUnderlyingOracle.sol";
import {OutcomeToken} from "./OutcomeToken.sol";
import {BinaryPricer} from "./math/BinaryPricer.sol";
import {QuoteMath} from "./math/QuoteMath.sol";
import {StrikeMath} from "./hook/StrikeMath.sol";

/// @title PredictionHook
/// @notice Singleton v4 hook that prices binary YES/NO outcome tokens against USDC with the settlement-matched
///         Black-Scholes (discrete geometric-Asian) binary, and underwrites them from an internal LP vault.
/// @dev Normative spec: docs/md/SPEC.md §3. Every swap on a market pool is a full NoOp (specified = -amountSpecified):
///      inputs are taken as hook ERC-6909 claims, outputs are paid from inventory claims first and any outcome-token
///      shortfall is minted on demand (sync, mint, settle). Per market the ledger keeps a USDC bucket and the
///      outstanding YES/NO, and every mutation ends with bucket >= max(outYes, outNo) (or the settled requirement).
///      Market ids are 1..marketCount. hookData is ignored and the swap sender is never asked for msgSender().
contract PredictionHook is BaseHook, IPredictionHook, IHookEvents, IUnlockCallback {
    using SafeCast for uint256;

    struct Market {
        address yes;
        uint64 openTime;
        uint32 window;
        address no;
        uint64 expiry;
        uint32 cutoffBuffer;
        address oracle;
        uint32 nSamples;
        uint8 sigmaMode;
        Status status;
        bool yesWon;
        uint64 h0Wad;
        uint64 gammaSWad;
        uint64 pMinWad;
        uint128 lambdaWad;
        uint128 qEpochMax;
        uint64 epochTs;
        int192 epochFlow;
        int256 lnStrikeWad;
        int256 settleThreshold;
        uint256 fixedVarE36;
        uint256 budget;
        uint256 bucket;
        uint256 outYes;
        uint256 outNo;
        uint256 invYes;
        uint256 invNo;
    }

    struct PoolRef {
        uint128 marketId;
        bool isYes;
    }

    error Unauthorized();
    error InvalidParams();
    error UnsupportedKernel();
    error UnknownMarket();
    error UnknownPool();
    error NotTradable();
    error MarketClosed();
    error NotSettled();
    error TooEarly();
    error OracleAvailable();
    error OutOfBand();
    error EpochCapExceeded();
    error Insolvent();
    error ZeroAmount();
    error InsufficientIdle();
    error InsufficientShares();
    error ForeignInitialize();
    error LiquidityDisabled();
    error DonateDisabled();

    uint256 internal constant WAD = 1e18;
    uint256 internal constant SHARE_OFFSET = 1e6;
    uint160 internal constant SQRT_PRICE_1_1 = 1 << 96;
    int24 internal constant TICK_SPACING = 60;
    /// @notice Delay after expiry before an unanswerable market can be settled INVALID (50/50)
    uint256 public constant GRACE = 1 hours;

    address public immutable usdc;
    address public immutable owner;
    address public keeper;

    uint256 public marketCount;
    uint256 public vaultIdle;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    /// @dev Sum over markets of (bucket - min(outYes,outNo)) while trading, (bucket - required) once resolved
    uint256 internal _sumPlus;
    /// @dev Sum over markets of (bucket - max(outYes,outNo)) while trading, (bucket - required) once resolved
    uint256 internal _sumMinus;

    mapping(uint256 => Market) internal _markets;
    mapping(bytes32 => PoolRef) internal _pools;

    constructor(IPoolManager poolManager_, address usdc_, address owner_) BaseHook(poolManager_) {
        usdc = usdc_;
        owner = owner_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeRemoveLiquidity = true;
        p.beforeSwap = true;
        p.beforeSwapReturnDelta = true;
        p.beforeDonate = true;
    }

    /* Admin */

    function setKeeper(address keeper_) external {
        if (msg.sender != owner) revert Unauthorized();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// @inheritdoc IPredictionHook
    function createMarket(MarketParams calldata p) external returns (uint256 id) {
        if (msg.sender != owner && msg.sender != keeper) revert Unauthorized();
        if (p.kernel != 0) revert UnsupportedKernel();
        if (
            p.oracle == address(0) || p.window == 0 || p.expiry > type(uint32).max || p.sigmaMode > 1
                || (p.sigmaMode == 1 && p.fixedVarE36 == 0) || p.quote.qEpochMax == 0 || p.quote.pMinWad == 0
                || p.quote.pMinWad >= WAD / 2
                || uint256(p.openTime > block.timestamp ? p.openTime : block.timestamp) + p.window + p.cutoffBuffer
                    >= p.expiry
        ) revert InvalidParams();
        if (p.budget > vaultIdle) revert InsufficientIdle();

        id = ++marketCount;
        Market storage m = _markets[id];
        address yes = address(new OutcomeToken{salt: keccak256(abi.encode(id, true))}(p.yesName, p.yesSymbol, id, true));
        address no = address(new OutcomeToken{salt: keccak256(abi.encode(id, false))}(p.noName, p.noSymbol, id, false));
        m.yes = yes;
        m.no = no;
        m.oracle = p.oracle;
        m.openTime = p.openTime;
        m.expiry = p.expiry;
        m.window = p.window;
        m.cutoffBuffer = p.cutoffBuffer;
        m.nSamples = p.nSamples;
        m.sigmaMode = p.sigmaMode;
        m.fixedVarE36 = p.fixedVarE36;
        m.h0Wad = p.quote.h0Wad;
        m.gammaSWad = p.quote.gammaSWad;
        m.lambdaWad = p.quote.lambdaWad;
        m.qEpochMax = p.quote.qEpochMax;
        m.pMinWad = p.quote.pMinWad;
        m.lnStrikeWad = p.lnStrikeWad;
        m.settleThreshold = StrikeMath.threshold(p.lnStrikeWad, IUnderlyingOracle(p.oracle).decimalsShift(), p.window);
        m.status = Status.Trading;
        m.budget = p.budget;
        m.bucket = p.budget;
        vaultIdle -= p.budget;
        _sumPlus += p.budget;
        _sumMinus += p.budget;

        PoolKey memory yesKey = _key(yes);
        PoolKey memory noKey = _key(no);
        bytes32 yesId = PoolId.unwrap(yesKey.toId());
        bytes32 noId = PoolId.unwrap(noKey.toId());
        _pools[yesId] = PoolRef(uint128(id), true);
        _pools[noId] = PoolRef(uint128(id), false);
        poolManager.initialize(yesKey, SQRT_PRICE_1_1);
        poolManager.initialize(noKey, SQRT_PRICE_1_1);
        emit MarketCreated(id, yes, no, yesId, noId, p.lnStrikeWad, p.expiry);
    }

    /* Hook callbacks */

    function _beforeInitialize(address, PoolKey calldata, uint160) internal pure override returns (bytes4) {
        revert ForeignInitialize();
    }

    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert LiquidityDisabled();
    }

    function _beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert LiquidityDisabled();
    }

    function _beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert DonateDisabled();
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        bytes32 poolId = PoolId.unwrap(key.toId());
        PoolRef memory ref = _pools[poolId];
        if (ref.marketId == 0) revert UnknownPool();
        Market storage m = _markets[ref.marketId];

        bool exactIn = params.amountSpecified < 0;
        uint256 amt = exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        bool isBuy = Currency.unwrap(params.zeroForOne ? key.currency0 : key.currency1) == usdc;

        (uint256 q, uint256 cash) = _fill(m, ref.isYes, isBuy, exactIn, amt);
        _book(m, ref.isYes, isBuy, q, cash);

        (uint256 amtIn, uint256 amtOut) = isBuy ? (cash, q) : (q, cash);
        BeforeSwapDelta delta = exactIn
            ? toBeforeSwapDelta(amtIn.toInt128(), -amtOut.toInt128())
            : toBeforeSwapDelta(-amtOut.toInt128(), amtIn.toInt128());
        (int128 a0, int128 a1) =
            params.zeroForOne ? (amtIn.toInt128(), -amtOut.toInt128()) : (-amtOut.toInt128(), amtIn.toInt128());
        emit HookSwap(poolId, sender, a0, a1, 0, 0);
        emit Trade(ref.marketId, sender, ref.isYes, isBuy, q, cash, cash * WAD / q);
        return (IHooks.beforeSwap.selector, delta, 0);
    }

    /// @dev Token and USDC amounts of a swap, the input equals `amt` for exact-in and the output does for exact-out
    function _fill(Market storage m, bool isYes, bool isBuy, bool exactIn, uint256 amt)
        internal
        returns (uint256 q, uint256 cash)
    {
        Status st = m.status;
        if (st == Status.Trading) return _fillTrading(m, isYes, isBuy, exactIn, amt);
        if (isBuy || (st == Status.Settled && isYes != m.yesWon)) revert MarketClosed();
        if (st == Status.Settled) return (amt, amt);
        (q, cash) = exactIn ? (amt, amt / 2) : (amt * 2, amt);
        if (cash == 0) revert ZeroAmount();
    }

    function _fillTrading(Market storage m, bool isYes, bool isBuy, bool exactIn, uint256 amt)
        internal
        returns (uint256 q, uint256 cash)
    {
        (uint256 ask, uint256 bid) = _askBid(m);
        int256 flow = m.epochTs == block.timestamp ? int256(m.epochFlow) : int256(0);
        uint256 price;
        if (isYes) {
            price = isBuy ? ask : bid;
        } else if (isBuy) {
            price = WAD - bid;
        } else {
            if (ask >= WAD) revert OutOfBand();
            price = WAD - ask;
        }
        int256 i0 = isYes ? flow : -flow;
        uint256 lam = m.lambdaWad;
        uint256 pMin = m.pMinWad;
        _checkBand(pMin, price, lam, i0);
        if (isBuy) {
            (q, cash) = exactIn
                ? (QuoteMath.buyExactIn(price, lam, i0, amt), amt)
                : (amt, QuoteMath.buyExactOut(price, lam, i0, amt));
        } else {
            (q, cash) = exactIn
                ? (amt, QuoteMath.sellExactIn(price, lam, i0, amt))
                : (QuoteMath.sellExactOut(price, lam, i0, amt), amt);
        }
        if (q == 0 || cash == 0) revert ZeroAmount();

        int256 dq = SafeCast.toInt256(q);
        int256 f = isYes == isBuy ? flow + dq : flow - dq;
        if ((f < 0 ? uint256(-f) : uint256(f)) > m.qEpochMax) revert EpochCapExceeded();
        _checkBand(pMin, price, lam, isYes ? f : -f);
        m.epochTs = uint64(block.timestamp);
        m.epochFlow = int192(f);
    }

    /// @dev The marginal price at mirrored flow x, price + lam * x / 1e6, must lie in [pMin, 1 - pMin]
    function _checkBand(uint256 pMin, uint256 price, uint256 lam, int256 x) internal pure {
        int256 p = int256(price * QuoteMath.UNIT) + int256(lam) * x;
        if (p < int256(pMin * QuoteMath.UNIT) || p > int256((WAD - pMin) * QuoteMath.UNIT)) revert OutOfBand();
    }

    /// @dev Ledger effects, solvency post-check and NAV aggregates, then the PoolManager settlement of the hook's side
    function _book(Market storage m, bool isYes, bool isBuy, uint256 q, uint256 cash) internal {
        (uint256 p0, uint256 n0) = _contrib(m);
        address tok = isYes ? m.yes : m.no;
        uint256 fromInv;
        if (isBuy) {
            m.bucket += cash;
            uint256 inv = isYes ? m.invYes : m.invNo;
            fromInv = q < inv ? q : inv;
            if (isYes) {
                m.outYes += q;
                m.invYes = inv - fromInv;
            } else {
                m.outNo += q;
                m.invNo = inv - fromInv;
            }
        } else {
            if (cash > m.bucket) revert Insolvent();
            m.bucket -= cash;
            if (isYes) {
                m.outYes -= q;
                m.invYes += q;
            } else {
                m.outNo -= q;
                m.invNo += q;
            }
        }
        _updateNav(m, p0, n0);

        uint256 usdcId = uint160(usdc);
        if (isBuy) {
            poolManager.mint(address(this), usdcId, cash);
            if (fromInv != 0) poolManager.burn(address(this), uint160(tok), fromInv);
            uint256 shortfall = q - fromInv;
            if (shortfall != 0) {
                poolManager.sync(Currency.wrap(tok));
                OutcomeToken(tok).mint(address(poolManager), shortfall);
                poolManager.settle();
            }
        } else {
            poolManager.mint(address(this), uint160(tok), q);
            poolManager.burn(address(this), usdcId, cash);
        }
    }

    /* Quote */

    function _askBid(Market storage m) internal view returns (uint256 ask, uint256 bid) {
        if (!_inTradingWindow(m)) revert NotTradable();
        (BinaryPricer.Result memory r,,) = _price(m, m.expiry - block.timestamp);
        (ask, bid) = BinaryPricer.askBid(r, m.gammaSWad, m.h0Wad);
    }

    function _price(Market storage m, uint256 tau)
        internal
        view
        returns (BinaryPricer.Result memory r, int256 x, uint256 varE36)
    {
        IUnderlyingOracle o = IUnderlyingOracle(m.oracle);
        x = o.lnSpotSoBWad() - m.lnStrikeWad;
        if (m.sigmaMode == 0) (varE36,) = o.varianceE36();
        else varE36 = m.fixedVarE36;
        r = BinaryPricer.price(x, varE36, tau, m.window, m.nSamples);
    }

    function _inTradingWindow(Market storage m) internal view returns (bool) {
        return m.status == Status.Trading && block.timestamp >= m.openTime
            && block.timestamp + m.window + m.cutoffBuffer < m.expiry;
    }

    /* Settlement and redemption */

    /// @inheritdoc IPredictionHook
    function settle(uint256 marketId) external {
        Market storage m = _market(marketId);
        if (m.status != Status.Trading) revert MarketClosed();
        if (block.timestamp < m.expiry) revert TooEarly();
        IUnderlyingOracle o = IUnderlyingOracle(m.oracle);
        uint32 t = uint32(m.expiry);
        int256 d = int256(o.cumulativeAt(t)) - int256(o.cumulativeAt(t - m.window));
        bool yesWon = d * 1e18 > m.settleThreshold;
        (uint256 p0, uint256 n0) = _contrib(m);
        m.status = Status.Settled;
        m.yesWon = yesWon;
        _updateNav(m, p0, n0);
        emit MarketSettled(marketId, yesWon, d, false);
    }

    /// @inheritdoc IPredictionHook
    function settleInvalid(uint256 marketId) external {
        Market storage m = _market(marketId);
        if (m.status != Status.Trading) revert MarketClosed();
        if (block.timestamp <= m.expiry + GRACE) revert TooEarly();
        if (_oracleAnswers(m)) revert OracleAvailable();
        (uint256 p0, uint256 n0) = _contrib(m);
        m.status = Status.Invalid;
        _updateNav(m, p0, n0);
        emit MarketSettled(marketId, false, 0, true);
    }

    function _oracleAnswers(Market storage m) internal view returns (bool) {
        IUnderlyingOracle o = IUnderlyingOracle(m.oracle);
        uint32 t = uint32(m.expiry);
        try o.cumulativeAt(t - m.window) returns (int56) {}
        catch {
            return false;
        }
        try o.cumulativeAt(t) returns (int56) {}
        catch {
            return false;
        }
        return true;
    }

    /// @inheritdoc IPredictionHook
    /// @dev Settled pays 1 USDC per winning token, Invalid pays floor(amount / 2) for tokens burned YES first then NO
    function redeem(uint256 marketId, uint256 amount) external returns (uint256 payout) {
        Market storage m = _market(marketId);
        if (amount == 0) revert ZeroAmount();
        (uint256 p0, uint256 n0) = _contrib(m);
        Status st = m.status;
        if (st == Status.Settled) {
            payout = amount;
            if (m.yesWon) {
                OutcomeToken(m.yes).burn(msg.sender, amount);
                m.outYes -= amount;
            } else {
                OutcomeToken(m.no).burn(msg.sender, amount);
                m.outNo -= amount;
            }
        } else if (st == Status.Invalid) {
            payout = amount / 2;
            if (payout == 0) revert ZeroAmount();
            uint256 bal = OutcomeToken(m.yes).balanceOf(msg.sender);
            uint256 fromYes = amount < bal ? amount : bal;
            if (fromYes != 0) OutcomeToken(m.yes).burn(msg.sender, fromYes);
            if (amount != fromYes) OutcomeToken(m.no).burn(msg.sender, amount - fromYes);
            m.outYes -= fromYes;
            m.outNo -= amount - fromYes;
        } else {
            revert NotSettled();
        }
        m.bucket -= payout;
        _updateNav(m, p0, n0);
        poolManager.unlock(abi.encode(msg.sender, payout, false));
        emit Redeemed(marketId, msg.sender, amount, payout);
    }

    /// @inheritdoc IPredictionHook
    function sweep(uint256 marketId) external returns (uint256 amount) {
        Market storage m = _market(marketId);
        Status st = m.status;
        if (st != Status.Settled && st != Status.Invalid) revert NotSettled();
        (uint256 p0, uint256 n0) = _contrib(m);
        amount = p0;
        m.bucket -= amount;
        vaultIdle += amount;
        _updateNav(m, p0, n0);
        emit Swept(marketId, amount);
    }

    /* LP vault */

    /// @inheritdoc IPredictionHook
    function deposit(uint256 assets) external returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        shares = assets * (totalShares + SHARE_OFFSET) / (navPlus() + 1);
        if (shares == 0) revert ZeroAmount();
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        vaultIdle += assets;
        SafeTransferLib.safeTransferFrom(usdc, msg.sender, address(this), assets);
        poolManager.unlock(abi.encode(msg.sender, assets, true));
        emit Deposit(msg.sender, assets, shares);
    }

    /// @inheritdoc IPredictionHook
    function withdraw(uint256 shares) external returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (shares > sharesOf[msg.sender]) revert InsufficientShares();
        assets = shares * (navMinus() + 1) / (totalShares + SHARE_OFFSET);
        if (assets == 0) revert ZeroAmount();
        if (assets > vaultIdle) revert InsufficientIdle();
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        vaultIdle -= assets;
        poolManager.unlock(abi.encode(msg.sender, assets, false));
        emit Withdraw(msg.sender, assets, shares);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (address to, uint256 amount, bool isDeposit) = abi.decode(data, (address, uint256, bool));
        Currency c = Currency.wrap(usdc);
        if (isDeposit) {
            poolManager.sync(c);
            SafeTransferLib.safeTransfer(usdc, address(poolManager), amount);
            poolManager.settle();
            poolManager.mint(address(this), uint160(usdc), amount);
        } else {
            poolManager.burn(address(this), uint160(usdc), amount);
            poolManager.take(c, to, amount);
        }
        return "";
    }

    /// @inheritdoc IPredictionHook
    function navPlus() public view returns (uint256) {
        return vaultIdle + _sumPlus;
    }

    /// @inheritdoc IPredictionHook
    function navMinus() public view returns (uint256) {
        return vaultIdle + _sumMinus;
    }

    /// @dev A market's (NAV+, NAV-) contribution, reverting Insolvent when the bucket is below the requirement
    function _contrib(Market storage m) internal view returns (uint256 plus, uint256 minus) {
        uint256 b = m.bucket;
        uint256 y = m.outYes;
        uint256 n = m.outNo;
        Status st = m.status;
        uint256 hi;
        uint256 lo;
        if (st == Status.Trading) {
            (hi, lo) = y > n ? (y, n) : (n, y);
        } else {
            hi = st == Status.Settled ? (m.yesWon ? y : n) : (y + n + 1) / 2;
            lo = hi;
        }
        if (b < hi) revert Insolvent();
        return (b - lo, b - hi);
    }

    function _updateNav(Market storage m, uint256 p0, uint256 n0) internal {
        (uint256 p1, uint256 n1) = _contrib(m);
        _sumPlus = _sumPlus - p0 + p1;
        _sumMinus = _sumMinus - n0 + n1;
    }

    /* Views */

    /// @inheritdoc IPredictionHook
    /// @dev Never reverts for a known market: when pricing fails (oracle revert, zero variance) all fields but tau are 0
    function quote(uint256 marketId) external view returns (Quote memory qt) {
        Market storage m = _market(marketId);
        try this.quoteStrict(marketId) returns (Quote memory r) {
            return r;
        } catch {
            if (block.timestamp < m.expiry) qt.tau = m.expiry - block.timestamp;
        }
    }

    /// @notice quote() that reverts when pricing fails
    /// @dev Prices exclude the current epoch's impact and are zero once tau <= window
    function quoteStrict(uint256 marketId) external view returns (Quote memory qt) {
        Market storage m = _market(marketId);
        qt.tradable = _inTradingWindow(m);
        if (block.timestamp >= m.expiry) return qt;
        qt.tau = m.expiry - block.timestamp;
        if (qt.tau <= m.window) return qt;
        BinaryPricer.Result memory r;
        (r, qt.xWad, qt.varE36) = _price(m, qt.tau);
        qt.midYes = r.mid;
        (qt.askYes, qt.bidYes) = BinaryPricer.askBid(r, m.gammaSWad, m.h0Wad);
        qt.askNo = WAD - qt.bidYes;
        qt.bidNo = qt.askYes >= WAD ? 0 : WAD - qt.askYes;
    }

    /// @notice Current epoch (block.timestamp of the last trade) and its signed YES-equivalent flow
    function epochOf(uint256 marketId) external view returns (uint64 ts, int256 flow) {
        Market storage m = _market(marketId);
        return (m.epochTs, m.epochFlow);
    }

    /// @notice The settlement threshold, YES iff (cum(T) - cum(T - window)) * 1e18 > threshold
    function settleThresholdOf(uint256 marketId) external view returns (int256) {
        return _market(marketId).settleThreshold;
    }

    /// @inheritdoc IPredictionHook
    function marketInfo(uint256 marketId) external view returns (MarketInfo memory i) {
        Market storage m = _market(marketId);
        i.yes = m.yes;
        i.no = m.no;
        i.oracle = m.oracle;
        i.lnStrikeWad = m.lnStrikeWad;
        i.openTime = m.openTime;
        i.expiry = m.expiry;
        i.window = m.window;
        i.cutoffBuffer = m.cutoffBuffer;
        i.status = m.status;
        i.yesWon = m.yesWon;
        i.bucket = m.bucket;
        i.outYes = m.outYes;
        i.outNo = m.outNo;
        i.invYes = m.invYes;
        i.invNo = m.invNo;
    }

    /// @inheritdoc IPredictionHook
    function marketParams(uint256 marketId) external view returns (MarketParams memory p) {
        Market storage m = _market(marketId);
        p.oracle = m.oracle;
        p.lnStrikeWad = m.lnStrikeWad;
        p.openTime = m.openTime;
        p.expiry = m.expiry;
        p.window = m.window;
        p.cutoffBuffer = m.cutoffBuffer;
        p.nSamples = m.nSamples;
        p.budget = m.budget;
        p.quote = QuoteParams(m.h0Wad, m.gammaSWad, m.lambdaWad, m.qEpochMax, m.pMinWad);
        p.sigmaMode = m.sigmaMode;
        p.fixedVarE36 = m.fixedVarE36;
        p.yesName = OutcomeToken(m.yes).name();
        p.yesSymbol = OutcomeToken(m.yes).symbol();
        p.noName = OutcomeToken(m.no).name();
        p.noSymbol = OutcomeToken(m.no).symbol();
    }

    /// @inheritdoc IPredictionHook
    function poolKeys(uint256 marketId) external view returns (PoolKey memory yesKey, PoolKey memory noKey) {
        Market storage m = _market(marketId);
        return (_key(m.yes), _key(m.no));
    }

    /// @inheritdoc IPredictionHook
    function marketOfPool(bytes32 poolId) external view returns (uint256 marketId, bool isYes) {
        PoolRef memory ref = _pools[poolId];
        return (ref.marketId, ref.isYes);
    }

    function _market(uint256 marketId) internal view returns (Market storage m) {
        if (marketId == 0 || marketId > marketCount) revert UnknownMarket();
        return _markets[marketId];
    }

    function _key(address outcome) internal view returns (PoolKey memory) {
        (address c0, address c1) = outcome < usdc ? (outcome, usdc) : (usdc, outcome);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), 0, TICK_SPACING, IHooks(address(this)));
    }
}
