// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseTestHooks} from "v4-core/src/test/BaseTestHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

/// @title PredictionHookProto
/// @notice ACCOUNTING prototype only. Price is a fixed per-market mid P (stand-in for the Black-Scholes digital).
///         State machine = "virtual complete sets":
///           - per-market USDC bucket B_m held as hook-owned ERC-6909 USDC claims in the PoolManager;
///           - outcome tokens exist only when outstanding (held outside the hook) or as hook inventory
///             (hook-owned ERC-6909 claims on the outcome token id, created by sells or by restock());
///           - solvency: B_m >= max(outYES_m, outNO_m) before resolution, B_m >= out_winning after.
///         Buy: pay from inventory claims (PM.burn) first; shortfall minted on demand (sync -> mint(PM) -> settle)
///         unless mode == InventoryOnly (then revert = hard capacity limit, 06 §9.4a design).
contract PredictionHookProto is BaseTestHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using SafeCast for uint256;

    uint256 internal constant WAD = 1e18;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    enum Mode {
        OnDemand,
        InventoryOnly
    }

    enum Status {
        None,
        Trading,
        Resolved
    }

    enum Op {
        Fund,
        Pay,
        Restock,
        Sweep
    }

    struct Market {
        OutcomeToken yes;
        OutcomeToken no;
        uint256 bucket; // USDC ERC-6909 claims attributable to this market (collateral C + free cash U)
        uint256 invYes; // hook-owned YES claims (ERC-6909 id = uint160(YES))
        uint256 invNo;
        uint256 outYes; // outstanding YES = YES.totalSupply() - invYes (tracked independently, cross-checked in tests)
        uint256 outNo;
        uint256 mid; // YES mid in WAD (stand-in for e^{-rT} N(d2))
        uint256 halfSpread; // WAD
        Status status;
        bool yesWon;
    }

    struct PoolInfo {
        uint256 marketId; // 0 = not ours
        bool isYes;
    }

    event Trade(
        uint256 indexed marketId,
        bool isYes,
        bool buying,
        bool exactIn,
        uint256 outcomeAmt,
        uint256 usdcAmt,
        uint256 fromInventory,
        uint256 mintedOnDemand,
        BeforeSwapDelta delta
    );

    error NotPoolManager();
    error UnknownPool();
    error NotTrading();
    error ZeroAmount();
    error Insolvent(uint256 bucket, uint256 required);
    error InsufficientInventory(uint256 have, uint256 need);
    error NotResolved();
    error OnlyOwner();
    error BadPrice();
    error SettleMismatch();

    IPoolManager public immutable pm;
    Currency public immutable usdc;
    Mode public immutable mode;
    address public immutable owner;

    uint256 public marketCount;
    uint256 public totalBuckets; // == sum_m bucket_m (invariant: == pm.balanceOf(this, usdc.toId()) absent donations)
    mapping(uint256 => Market) public markets;
    mapping(PoolId => PoolInfo) public poolInfo;
    mapping(uint256 => PoolKey) public yesKey;
    mapping(uint256 => PoolKey) public noKey;

    modifier onlyPM() {
        if (msg.sender != address(pm)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager _pm, Currency _usdc, Mode _mode) {
        pm = _pm;
        usdc = _usdc;
        mode = _mode;
        owner = msg.sender;
    }

    // --------------------------------------------------------------------------------------------
    // Market creation
    // --------------------------------------------------------------------------------------------

    function createMarket(bool outcomeIsCurrency0, uint256 mid, uint256 halfSpread) external returns (uint256 id) {
        if (msg.sender != owner) revert OnlyOwner();
        id = ++marketCount;
        Market storage m = markets[id];
        m.yes = _deployOrdered("YES", outcomeIsCurrency0, id, 0);
        m.no = _deployOrdered("NO", outcomeIsCurrency0, id, 1);
        m.status = Status.Trading;
        _setPrice(m, mid, halfSpread);
        PoolKey memory ky = _key(Currency.wrap(address(m.yes)));
        PoolKey memory kn = _key(Currency.wrap(address(m.no)));
        yesKey[id] = ky;
        noKey[id] = kn;
        poolInfo[ky.toId()] = PoolInfo(id, true);
        poolInfo[kn.toId()] = PoolInfo(id, false);
        // Hooks.noSelfCall: our own initialize skips beforeInitialize, which reverts for everyone else.
        pm.initialize(ky, SQRT_PRICE_1_1);
        pm.initialize(kn, SQRT_PRICE_1_1);
    }

    function _key(Currency outc) internal view returns (PoolKey memory k) {
        (Currency c0, Currency c1) = outc < usdc ? (outc, usdc) : (usdc, outc);
        k = PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: IHooks(address(this))});
    }

    /// @dev CREATE2 with a salt search so the outcome token sorts on the requested side of USDC.
    function _deployOrdered(string memory sym, bool below, uint256 id, uint256 side) internal returns (OutcomeToken t) {
        bytes32 initHash = keccak256(abi.encodePacked(type(OutcomeToken).creationCode, abi.encode(sym, sym)));
        for (uint256 i;; ++i) {
            bytes32 salt = keccak256(abi.encode(id, side, i));
            address a = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash))))
            );
            if ((a < Currency.unwrap(usdc)) == below) {
                t = new OutcomeToken{salt: salt}(sym, sym);
                return t;
            }
        }
    }

    function setPrice(uint256 id, uint256 mid, uint256 halfSpread) external {
        if (msg.sender != owner) revert OnlyOwner();
        _setPrice(markets[id], mid, halfSpread);
    }

    function _setPrice(Market storage m, uint256 mid, uint256 hs) internal {
        // need 0 < bid, ask <= 1 on both sides
        if (mid <= hs || mid + hs >= WAD || hs == 0) revert BadPrice();
        m.mid = mid;
        m.halfSpread = hs;
    }

    function quotes(uint256 id, bool isYes) public view returns (uint256 ask, uint256 bid) {
        Market storage m = markets[id];
        uint256 p = isYes ? m.mid : WAD - m.mid; // NO := 1 - YES in integers (05 §3.4)
        ask = p + m.halfSpread;
        bid = p - m.halfSpread;
    }

    // --------------------------------------------------------------------------------------------
    // Swap path
    // --------------------------------------------------------------------------------------------

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        revert NotPoolManager(); // only reachable for third-party initializers
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotTrading();
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata p, bytes calldata)
        external
        override
        onlyPM
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolInfo memory info = poolInfo[key.toId()];
        if (info.marketId == 0) revert UnknownPool();
        Market storage m = markets[info.marketId];
        if (m.status != Status.Trading) revert NotTrading();

        OutcomeToken tok = info.isYes ? m.yes : m.no;
        Currency outc = Currency.wrap(address(tok));
        bool buying = (p.zeroForOne ? key.currency0 : key.currency1) == usdc; // input currency is USDC
        bool exactIn = p.amountSpecified < 0;
        uint256 a = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);

        (uint256 ask, uint256 bid) = quotes(info.marketId, info.isYes);
        uint256 q; // outcome tokens
        uint256 cash; // USDC
        if (buying) {
            if (exactIn) (cash, q) = (a, FullMath.mulDiv(a, WAD, ask)); // out rounds down
            else (q, cash) = (a, FullMath.mulDivRoundingUp(a, ask, WAD)); // in rounds up
        } else {
            if (exactIn) (q, cash) = (a, FullMath.mulDiv(a, bid, WAD));
            else (cash, q) = (a, FullMath.mulDivRoundingUp(a, WAD, bid));
        }
        if (q == 0 || cash == 0) revert ZeroAmount();

        uint256 fromInv;
        uint256 minted;
        // ---- effects (all ledger updates before any PM call) ----
        if (buying) {
            m.bucket += cash;
            totalBuckets += cash;
            uint256 inv = info.isYes ? m.invYes : m.invNo;
            fromInv = q < inv ? q : inv;
            minted = q - fromInv;
            if (minted > 0 && mode == Mode.InventoryOnly) revert InsufficientInventory(inv, q);
            if (info.isYes) (m.invYes, m.outYes) = (inv - fromInv, m.outYes + q);
            else (m.invNo, m.outNo) = (inv - fromInv, m.outNo + q);
        } else {
            uint256 b = m.bucket;
            if (cash > b) revert Insolvent(b, cash);
            m.bucket = b - cash;
            totalBuckets -= cash;
            if (info.isYes) (m.invYes, m.outYes) = (m.invYes + q, m.outYes - q);
            else (m.invNo, m.outNo) = (m.invNo + q, m.outNo - q);
        }
        _checkSolvent(m);

        // ---- interactions with the PoolManager only ----
        if (buying) {
            pm.mint(address(this), usdc.toId(), cash); // input credit -> USDC claims (swapper pays after swap returns)
            if (fromInv > 0) pm.burn(address(this), outc.toId(), fromInv); // deliver from inventory claims (no sync)
            if (minted > 0) {
                // on-demand mint of the shortfall straight into the PM. sync..settle is atomic: no external call
                // other than our own callback-free token between them, so `paid == minted` exactly.
                pm.sync(outc);
                tok.mint(address(pm), minted);
                if (pm.settle() != minted) revert SettleMismatch(); // defence in depth; cannot trigger (see report §7)
            }
        } else {
            pm.mint(address(this), outc.toId(), q); // outcome input -> inventory claims
            pm.burn(address(this), usdc.toId(), cash); // pay USDC from the bucket's claims
        }

        uint256 unspec = buying ? (exactIn ? q : cash) : (exactIn ? cash : q);
        BeforeSwapDelta d = exactIn
            ? toBeforeSwapDelta(a.toInt128(), -(unspec.toInt128()))
            : toBeforeSwapDelta(-(a.toInt128()), unspec.toInt128());
        emit Trade(info.marketId, info.isYes, buying, exactIn, q, cash, fromInv, minted, d);
        return (IHooks.beforeSwap.selector, d, 0);
    }

    function requiredCollateral(uint256 id) public view returns (uint256) {
        Market storage m = markets[id];
        if (m.status == Status.Resolved) return m.yesWon ? m.outYes : m.outNo;
        return m.outYes > m.outNo ? m.outYes : m.outNo;
    }

    function _checkSolvent(Market storage m) internal view {
        uint256 req = m.status == Status.Resolved ? (m.yesWon ? m.outYes : m.outNo) : (m.outYes > m.outNo ? m.outYes : m.outNo);
        if (m.bucket < req) revert Insolvent(m.bucket, req);
    }

    // --------------------------------------------------------------------------------------------
    // Non-swap entry points (each opens its own unlock; sync is atomic inside it)
    // --------------------------------------------------------------------------------------------

    /// @notice LP underwriting deposit into market `id`.
    function fund(uint256 id, uint256 amount) external {
        Market storage m = markets[id];
        if (m.status != Status.Trading) revert NotTrading();
        m.bucket += amount;
        totalBuckets += amount;
        pm.unlock(abi.encode(Op.Fund, abi.encode(msg.sender, amount)));
    }

    /// @notice LP withdrawal of free cash U = bucket - required collateral (owner = the single LP in this proto).
    function defund(uint256 id, uint256 amount, address to) external {
        if (msg.sender != owner) revert OnlyOwner();
        Market storage m = markets[id];
        m.bucket -= amount;
        totalBuckets -= amount;
        _checkSolvent(m);
        pm.unlock(abi.encode(Op.Pay, abi.encode(to, amount)));
    }

    /// @notice User split: 1 USDC -> 1 YES + 1 NO (ERC20 minted straight to the user; no PM involvement for tokens).
    function split(uint256 id, uint256 amount) external {
        Market storage m = markets[id];
        if (m.status != Status.Trading) revert NotTrading();
        m.bucket += amount;
        totalBuckets += amount;
        m.outYes += amount;
        m.outNo += amount;
        pm.unlock(abi.encode(Op.Fund, abi.encode(msg.sender, amount)));
        m.yes.mint(msg.sender, amount);
        m.no.mint(msg.sender, amount);
    }

    /// @notice User merge: 1 YES + 1 NO -> 1 USDC.
    function merge(uint256 id, uint256 amount) external {
        Market storage m = markets[id];
        if (m.status != Status.Trading) revert NotTrading();
        m.yes.burn(msg.sender, amount);
        m.no.burn(msg.sender, amount);
        m.outYes -= amount;
        m.outNo -= amount;
        m.bucket -= amount;
        totalBuckets -= amount;
        _checkSolvent(m);
        pm.unlock(abi.encode(Op.Pay, abi.encode(msg.sender, amount)));
    }

    /// @notice Pre-mint outcome inventory as hook-owned ERC-6909 claims (06 §9.4a). Changes no economic quantity.
    function restock(uint256 id, bool isYes, uint256 amount) external {
        if (msg.sender != owner) revert OnlyOwner();
        Market storage m = markets[id];
        if (isYes) m.invYes += amount;
        else m.invNo += amount;
        pm.unlock(abi.encode(Op.Restock, abi.encode(address(isYes ? m.yes : m.no), amount)));
    }

    /// @notice Physically destroy hook inventory: claims burn -> take ERC20 -> ERC20 burn. Changes no economic quantity.
    function sweep(uint256 id, bool isYes) external {
        Market storage m = markets[id];
        uint256 amount = isYes ? m.invYes : m.invNo;
        if (amount == 0) return;
        if (isYes) m.invYes = 0;
        else m.invNo = 0;
        pm.unlock(abi.encode(Op.Sweep, abi.encode(address(isYes ? m.yes : m.no), amount)));
    }

    /// @notice Stand-in for TWAP settlement.
    function resolve(uint256 id, bool yesWon) external {
        if (msg.sender != owner) revert OnlyOwner();
        Market storage m = markets[id];
        if (m.status != Status.Trading) revert NotTrading();
        m.status = Status.Resolved;
        m.yesWon = yesWon;
        _checkSolvent(m);
    }

    function redeem(uint256 id, bool isYes, uint256 amount) external returns (uint256 payout) {
        Market storage m = markets[id];
        if (m.status != Status.Resolved) revert NotResolved();
        (isYes ? m.yes : m.no).burn(msg.sender, amount);
        if (isYes) m.outYes -= amount;
        else m.outNo -= amount;
        if (isYes == m.yesWon) {
            payout = amount;
            m.bucket -= amount;
            totalBuckets -= amount;
            pm.unlock(abi.encode(Op.Pay, abi.encode(msg.sender, amount)));
        }
        _checkSolvent(m);
    }

    function unlockCallback(bytes calldata raw) external onlyPM returns (bytes memory) {
        (Op op, bytes memory data) = abi.decode(raw, (Op, bytes));
        if (op == Op.Fund) {
            (address payer, uint256 amount) = abi.decode(data, (address, uint256));
            pm.sync(usdc);
            MockTransferFrom(Currency.unwrap(usdc)).transferFrom(payer, address(pm), amount);
            pm.settle();
            pm.mint(address(this), usdc.toId(), amount);
        } else if (op == Op.Pay) {
            (address to, uint256 amount) = abi.decode(data, (address, uint256));
            pm.burn(address(this), usdc.toId(), amount);
            pm.take(usdc, to, amount);
        } else if (op == Op.Restock) {
            (address tok, uint256 amount) = abi.decode(data, (address, uint256));
            Currency c = Currency.wrap(tok);
            pm.sync(c);
            OutcomeToken(tok).mint(address(pm), amount);
            pm.settle();
            pm.mint(address(this), c.toId(), amount);
        } else {
            (address tok, uint256 amount) = abi.decode(data, (address, uint256));
            Currency c = Currency.wrap(tok);
            pm.burn(address(this), c.toId(), amount);
            pm.take(c, address(this), amount);
            OutcomeToken(tok).burn(address(this), amount);
        }
        return "";
    }
}

interface MockTransferFrom {
    function transferFrom(address, address, uint256) external returns (bool);
}
