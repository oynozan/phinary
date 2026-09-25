// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Research prototype for the LP (underwriter) layer: per-(asset, expiry) series tranches,
// complete sets pre-minted as ERC-6909 claims, claims-only swap path, exact ladder cap,
// sequential pro-rata LP exit, redemption that never depends on oracle / pause.
// Pricing is a stub (a settable mid per market); the Black-Scholes module is out of scope here.

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {BaseTestHooks} from "v4-core/src/test/BaseTestHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";

contract OutcomeToken is ERC20 {
    address public immutable hook;

    constructor(string memory n, string memory s) ERC20(n, s, 6) {
        hook = msg.sender;
    }

    function mint(address to, uint256 a) external {
        require(msg.sender == hook, "only hook");
        _mint(to, a);
    }

    function burn(address from, uint256 a) external {
        require(msg.sender == hook, "only hook");
        _burn(from, a);
    }
}

contract SeriesHook is BaseTestHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;

    uint256 constant WAD = 1e18;
    uint256 public constant MAX_STRIKES = 30; // Lyra maxStrikesPerBoard = 30
    uint256 public constant GRACE = 7 days; // after expiry: INVALID (50/50) fallback becomes callable
    uint256 public constant CUTOFF = 1 hours;
    uint256 public constant HALF_SPREAD = 0.01e18;
    uint256 public constant PREMINT = 10 minutes; // subscriptions close at openTime - PREMINT; pre-minting starts then

    enum State { NONE, LIVE, SETTLED, FINALIZED } // LIVE: subscribe before openTime, trade in [openTime, expiry - CUTOFF)

    struct Series {
        State state;
        bool invalid;
        bool forceExact; // benchmark switch: skip the O(1) fast path
        uint64 openTime;
        uint64 expiry;
        uint256 settlePrice; // same S_T for every strike of the series
        uint256 D; // subscribed capital == total shares (1:1 while subscribing)
        uint256 B; // max loss budget: D - min_S W(S) <= B
        uint256 cash; // free USDC claims owned by the series LPs
        uint256 sumMinInv; // sum_m min(invY_m, invN_m), for the O(1) union bound
        uint256 remShares; // after finalize: shares not yet claimed
        uint256 remCash; // after finalize: USDC not yet claimed
        uint256[] markets; // sorted by strike ascending
    }

    struct Market {
        uint256 series;
        uint256 strike;
        OutcomeToken yes;
        OutcomeToken no;
        uint128 invY; // hook-held YES claims (vault inventory)
        uint128 invN;
        uint256 collateral; // USDC claims backing all complete sets of this market
        uint256 midWad; // pricing stub (YES mid)
    }

    IPoolManager public immutable manager;
    Currency public immutable usdc;
    address public immutable owner;
    bool public paused;

    uint256 public nextSeries = 1;
    uint256 public nextMarket = 1;
    mapping(uint256 => Series) internal _series;
    mapping(uint256 => Market) public markets;
    mapping(uint256 => mapping(address => uint256)) public sharesOf;
    mapping(PoolId => uint256) public marketOfPool;
    mapping(PoolId => bool) public poolIsYes;
    mapping(uint256 => uint256) public oraclePrice; // settlement-oracle stub per series (0 = unavailable)

    error Paused();
    error NotTrading();
    error WrongState();
    error Capacity();
    error InsufficientCash();
    error LadderCap(int256 minW, int256 floor_);
    error ZeroAmount();

    constructor(IPoolManager m, Currency u) {
        manager = m;
        usdc = u;
        owner = msg.sender;
    }

    // ------------------------------------------------------------------ admin / creation
    function setPaused(bool p) external {
        require(msg.sender == owner);
        paused = p;
    }

    function setMid(uint256 mid, uint256 w) external {
        require(msg.sender == owner);
        markets[mid].midWad = w;
    }

    function setOracle(uint256 sid, uint256 px) external {
        require(msg.sender == owner);
        oraclePrice[sid] = px;
    }

    function createSeries(uint64 openTime, uint64 expiry, uint256 B, bool forceExact) external returns (uint256 sid) {
        require(msg.sender == owner && openTime < expiry);
        sid = nextSeries++;
        Series storage s = _series[sid];
        s.state = State.LIVE;
        s.openTime = openTime;
        s.expiry = expiry;
        s.B = B;
        s.forceExact = forceExact;
    }

    function addMarket(uint256 sid, uint256 strike, uint256 midWad) external returns (uint256 mid) {
        require(msg.sender == owner);
        Series storage s = _series[sid];
        if (s.state != State.LIVE || block.timestamp >= s.openTime) revert WrongState();
        require(s.markets.length < MAX_STRIKES, "too many strikes");
        mid = nextMarket++;
        Market storage m = markets[mid];
        m.series = sid;
        m.strike = strike;
        m.midWad = midWad;
        m.yes = new OutcomeToken("YES", "YES");
        m.no = new OutcomeToken("NO", "NO");
        _initPool(mid, address(m.yes), true);
        _initPool(mid, address(m.no), false);
        // sorted insert (bounded by MAX_STRIKES)
        s.markets.push(mid);
        uint256 i = s.markets.length - 1;
        while (i > 0 && markets[s.markets[i - 1]].strike > strike) {
            s.markets[i] = s.markets[i - 1];
            i--;
        }
        require(i == 0 || markets[s.markets[i - 1]].strike != strike, "dup strike");
        s.markets[i] = mid;
    }

    function _initPool(uint256 mid, address outcome, bool isYes) internal {
        (Currency c0, Currency c1) = outcome < Currency.unwrap(usdc)
            ? (Currency.wrap(outcome), usdc)
            : (usdc, Currency.wrap(outcome));
        PoolKey memory key = PoolKey(c0, c1, 0, 60, IHooks(address(this)));
        manager.initialize(key, 79228162514264337593543950336); // noSelfCall: our beforeInitialize (revert) is skipped
        marketOfPool[key.toId()] = mid;
        poolIsYes[key.toId()] = isYes;
    }

    function poolKeyOf(uint256 mid, bool isYes) public view returns (PoolKey memory key) {
        address outcome = isYes ? address(markets[mid].yes) : address(markets[mid].no);
        (Currency c0, Currency c1) = outcome < Currency.unwrap(usdc)
            ? (Currency.wrap(outcome), usdc)
            : (usdc, Currency.wrap(outcome));
        key = PoolKey(c0, c1, 0, 60, IHooks(address(this)));
    }

    // ------------------------------------------------------------------ LP: subscribe / unsubscribe (before open only)
    function subscribe(uint256 sid, uint256 amt) external {
        Series storage s = _series[sid];
        if (paused) revert Paused();
        if (s.state != State.LIVE || block.timestamp + PREMINT >= s.openTime) revert WrongState();
        if (amt == 0) revert ZeroAmount();
        // effects: 1 share per USDC unit; NAV == cash exactly while nothing has traded
        sharesOf[sid][msg.sender] += amt;
        s.D += amt;
        s.cash += amt;
        ERC20(Currency.unwrap(usdc)).transferFrom(msg.sender, address(this), amt);
        manager.unlock(abi.encode(uint8(0), amt, uint256(0)));
    }

    function unsubscribe(uint256 sid, uint256 amt) external {
        Series storage s = _series[sid];
        if (s.state != State.LIVE || block.timestamp + PREMINT >= s.openTime) revert WrongState();
        sharesOf[sid][msg.sender] -= amt;
        s.D -= amt;
        s.cash -= amt;
        manager.transfer(msg.sender, usdc.toId(), amt); // pay as ERC-6909 claims: no unlock needed
    }

    // ------------------------------------------------------------------ value-neutral inventory maintenance
    /// @notice Convert free series cash into complete sets held as claims (permissionless, NAV- and cap-neutral).
    function topUp(uint256 mid, uint256 amt) external {
        Market storage m = markets[mid];
        Series storage s = _series[m.series];
        if (paused) revert Paused();
        if (s.state != State.LIVE || block.timestamp + PREMINT < s.openTime || block.timestamp >= s.expiry) {
            revert WrongState(); // capital is frozen before any of it is converted into sets
        }
        if (amt > s.cash) revert InsufficientCash();
        uint256 oldMin = _min(m.invY, m.invN);
        s.cash -= amt;
        m.collateral += amt;
        m.invY += amt.toUint128();
        m.invN += amt.toUint128();
        s.sumMinInv = s.sumMinInv - oldMin + _min(m.invY, m.invN);
        manager.unlock(abi.encode(uint8(1), mid, amt));
    }

    /// @notice Merge hook-held complete sets back into free cash (permissionless, NAV- and cap-neutral).
    function merge(uint256 mid, uint256 amt) external {
        Market storage m = markets[mid];
        Series storage s = _series[m.series];
        if (s.state != State.LIVE) revert WrongState();
        uint256 oldMin = _min(m.invY, m.invN);
        require(amt <= oldMin, "no sets");
        m.invY -= amt.toUint128();
        m.invN -= amt.toUint128();
        m.collateral -= amt;
        s.cash += amt;
        s.sumMinInv = s.sumMinInv - oldMin + _min(m.invY, m.invN);
        manager.unlock(abi.encode(uint8(2), mid, amt));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager));
        (uint8 op, uint256 a, uint256 b) = abi.decode(data, (uint8, uint256, uint256));
        if (op == 0) {
            // subscribe: USDC ERC20 -> PM, credit hook with claims
            manager.sync(usdc);
            ERC20(Currency.unwrap(usdc)).transfer(address(manager), a);
            manager.settle();
            manager.mint(address(this), usdc.toId(), a);
        } else if (op == 1) {
            // topUp(mid=a, amt=b): mint b YES + b NO into the PM and hold them as hook claims
            Market storage m = markets[a];
            _mintInto(address(m.yes), b);
            _mintInto(address(m.no), b);
        } else if (op == 2 || op == 3) {
            // merge (2) / finalize-burn (3): burn hook claims, take the ERC20 out, burn it
            Market storage m = markets[a];
            (uint256 y, uint256 n) = op == 2 ? (b, b) : _unpack(b);
            _burnOut(address(m.yes), y);
            _burnOut(address(m.no), n);
        } else if (op == 4) {
            // pay USDC as ERC20: burn claims, take
            manager.burn(address(this), usdc.toId(), b);
            manager.take(usdc, address(uint160(a)), b);
        }
        return "";
    }

    function _mintInto(address t, uint256 amt) internal {
        if (amt == 0) return;
        Currency c = Currency.wrap(t);
        manager.sync(c);
        OutcomeToken(t).mint(address(manager), amt);
        manager.settle();
        manager.mint(address(this), c.toId(), amt);
    }

    function _burnOut(address t, uint256 amt) internal {
        if (amt == 0) return;
        Currency c = Currency.wrap(t);
        manager.burn(address(this), c.toId(), amt);
        manager.take(c, address(this), amt);
        OutcomeToken(t).burn(address(this), amt);
    }

    function _unpack(uint256 b) internal pure returns (uint256, uint256) {
        return (b >> 128, uint128(b));
    }

    // ------------------------------------------------------------------ swap path: claims only, no sync, no ERC20 calls
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata p, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        require(msg.sender == address(manager), "not PM");
        if (paused) revert Paused();
        PoolId pid = key.toId();
        uint256 mid = marketOfPool[pid];
        require(mid != 0, "unknown pool");
        bool isYes = poolIsYes[pid];
        Market storage m = markets[mid];
        Series storage s = _series[m.series];
        if (s.state != State.LIVE || block.timestamp < s.openTime || block.timestamp + CUTOFF >= s.expiry) {
            revert NotTrading();
        }

        bool exactIn = p.amountSpecified < 0;
        (Currency input, Currency output) = p.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        bool buying = !(output == usdc);
        uint256 px = isYes ? m.midWad : WAD - m.midWad;
        px = buying ? px + HALF_SPREAD : px - HALF_SPREAD; // stub must keep px in (0, 1e18)
        uint256 amt = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);
        uint256 amtIn;
        uint256 amtOut;
        if (exactIn) {
            amtIn = amt;
            amtOut = buying ? FullMath.mulDiv(amt, WAD, px) : FullMath.mulDiv(amt, px, WAD);
        } else {
            amtOut = amt;
            amtIn = buying ? FullMath.mulDivRoundingUp(amt, px, WAD) : FullMath.mulDivRoundingUp(amt, WAD, px);
        }
        if (amtOut == 0 || amtIn == 0) revert ZeroAmount();

        // ---- effects on the series ledger
        uint256 oldMin = _min(m.invY, m.invN);
        if (buying) {
            if (isYes) {
                if (m.invY < amtOut) revert Capacity();
                m.invY -= uint128(amtOut);
            } else {
                if (m.invN < amtOut) revert Capacity();
                m.invN -= uint128(amtOut);
            }
            s.cash += amtIn;
        } else {
            if (s.cash < amtOut) revert InsufficientCash();
            s.cash -= amtOut;
            if (isYes) m.invY += amtIn.toUint128();
            else m.invN += amtIn.toUint128();
        }
        s.sumMinInv = s.sumMinInv - oldMin + _min(m.invY, m.invN);
        _checkLadder(s);

        // ---- interactions: ERC-6909 only
        manager.mint(address(this), input.toId(), amtIn);
        manager.burn(address(this), output.toId(), amtOut);
        BeforeSwapDelta d = exactIn
            ? toBeforeSwapDelta(amtIn.toInt128(), -amtOut.toInt128())
            : toBeforeSwapDelta(-amtOut.toInt128(), amtIn.toInt128());
        return (IHooks.beforeSwap.selector, d, 0);
    }

    // ------------------------------------------------------------------ exposure cap over the strike ladder
    function _checkLadder(Series storage s) internal view {
        int256 floor_ = int256(s.D) - int256(s.B);
        if (!s.forceExact && int256(s.cash + s.sumMinInv) >= floor_) return; // O(1) union bound suffices
        int256 w = ladderMin(s);
        if (w < floor_) revert LadderCap(w, floor_);
    }

    /// @notice min over settlement regions of the series' terminal wealth W(S_T) (O(#strikes)).
    function ladderMin(Series storage s) internal view returns (int256 mn) {
        uint256[] storage ids = s.markets;
        uint256 n = ids.length;
        int256 run = int256(s.cash);
        for (uint256 i; i < n; ++i) run += int256(uint256(markets[ids[i]].invN)); // region 0: S_T <= K_1, every NO wins
        mn = run;
        for (uint256 i; i < n; ++i) {
            Market storage m = markets[ids[i]];
            run += int256(uint256(m.invY)) - int256(uint256(m.invN)); // cross K_i: market i flips to YES
            if (run < mn) mn = run;
        }
    }

    function ladderMinOf(uint256 sid) external view returns (int256) {
        return ladderMin(_series[sid]);
    }

    // ------------------------------------------------------------------ settlement, finalize, redeem, claim
    function settle(uint256 sid) external {
        Series storage s = _series[sid];
        if (s.state != State.LIVE || block.timestamp < s.expiry) revert WrongState();
        uint256 px = oraclePrice[sid];
        require(px != 0, "oracle unavailable");
        s.settlePrice = px;
        s.state = State.SETTLED;
    }

    function settleInvalid(uint256 sid) external {
        Series storage s = _series[sid];
        if (s.state != State.LIVE || block.timestamp < s.expiry + GRACE) revert WrongState();
        s.invalid = true;
        s.state = State.SETTLED;
    }

    /// @notice Redeem the vault's own inventory, burn it, and open LP claims. Permissionless, O(#strikes).
    function finalize(uint256 sid) external {
        Series storage s = _series[sid];
        if (s.state != State.SETTLED) revert WrongState();
        uint256[] storage ids = s.markets;
        for (uint256 i; i < ids.length; ++i) {
            Market storage m = markets[ids[i]];
            uint256 y = m.invY;
            uint256 n = m.invN;
            uint256 value = s.invalid ? (y + n) / 2 : (s.settlePrice > m.strike ? y : n);
            m.collateral -= value;
            s.cash += value;
            m.invY = 0;
            m.invN = 0;
            if (y + n > 0) manager.unlock(abi.encode(uint8(3), ids[i], (y << 128) | n));
        }
        s.sumMinInv = 0;
        s.remShares = s.D;
        s.remCash = s.cash;
        s.cash = 0;
        s.state = State.FINALIZED;
    }

    /// @notice Trader redemption. Depends only on the series being SETTLED: no oracle read, no pause, no LP action.
    function redeem(uint256 mid, bool yesToken, uint256 amt, address to, bool asClaims) external returns (uint256 out) {
        Market storage m = markets[mid];
        Series storage s = _series[m.series];
        if (s.state != State.SETTLED && s.state != State.FINALIZED) revert WrongState();
        OutcomeToken t = yesToken ? m.yes : m.no;
        t.burn(msg.sender, amt);
        if (s.invalid) out = amt / 2;
        else out = ((s.settlePrice > m.strike) == yesToken) ? amt : 0;
        m.collateral -= out;
        _pay(to, out, asClaims);
    }

    /// @notice LP exit after finalize: sequential pro-rata, floor. The last claimer receives the exact remainder.
    function claim(uint256 sid, uint256 shares, address to, bool asClaims) external returns (uint256 out) {
        Series storage s = _series[sid];
        if (s.state != State.FINALIZED) revert WrongState();
        sharesOf[sid][msg.sender] -= shares;
        out = FullMath.mulDiv(shares, s.remCash, s.remShares);
        s.remShares -= shares;
        s.remCash -= out;
        _pay(to, out, asClaims);
    }

    function _pay(address to, uint256 amt, bool asClaims) internal {
        if (amt == 0) return;
        if (asClaims) manager.transfer(to, usdc.toId(), amt); // no unlock, no USDC transfer (blacklist/pause-proof for the hook)
        else manager.unlock(abi.encode(uint8(4), uint256(uint160(to)), amt));
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ------------------------------------------------------------------ views for invariants
    function seriesInfo(uint256 sid)
        external
        view
        returns (State state, uint256 D, uint256 B, uint256 cash, uint256 remShares, uint256 remCash, uint256 n)
    {
        Series storage s = _series[sid];
        return (s.state, s.D, s.B, s.cash, s.remShares, s.remCash, s.markets.length);
    }

    function seriesMarkets(uint256 sid) external view returns (uint256[] memory) {
        return _series[sid].markets;
    }

    /// @notice Sum of every USDC ledger bucket (must equal PM.balanceOf(hook, USDC) minus donations).
    function ledgerUSDC() external view returns (uint256 t) {
        for (uint256 sid = 1; sid < nextSeries; ++sid) t += _series[sid].cash + _series[sid].remCash;
        for (uint256 mid = 1; mid < nextMarket; ++mid) t += markets[mid].collateral;
    }
}
