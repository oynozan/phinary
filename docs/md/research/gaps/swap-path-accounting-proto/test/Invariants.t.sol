// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./Base.t.sol";
import {PreSyncRouter} from "./Accounting.t.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";

contract Handler is Test {
    PredictionHookProto hook;
    IPoolManager manager;
    PoolSwapTest router;
    MockUSDC usdc;
    OutcomeToken yes;
    OutcomeToken no;
    PoolKey kYes;
    PoolKey kNo;
    uint256 mId;
    address owner;
    address[] public actors;
    PreSyncRouter pre;

    mapping(bytes32 => uint256) public ok;
    mapping(bytes32 => uint256) public ko;
    bytes public lastErr;

    constructor(
        PredictionHookProto _hook,
        IPoolManager _m,
        PoolSwapTest _r,
        MockUSDC _u,
        PoolKey memory _ky,
        PoolKey memory _kn,
        uint256 _id,
        address _owner
    ) {
        hook = _hook;
        manager = _m;
        router = _r;
        usdc = _u;
        kYes = _ky;
        kNo = _kn;
        mId = _id;
        owner = _owner;
        (yes, no,,,,,,,,,) = hook.markets(mId);
        for (uint256 i; i < 3; ++i) {
            address a = address(uint160(0xA11CE + i));
            actors.push(a);
            vm.startPrank(a);
            usdc.approve(address(router), type(uint256).max);
            yes.approve(address(router), type(uint256).max);
            no.approve(address(router), type(uint256).max);
            usdc.approve(address(hook), type(uint256).max);
            manager.setOperator(address(router), true);
            vm.stopPrank();
        }
        pre = new PreSyncRouter(manager);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _swap(address a, bool isYes, bool buying, bool exactIn, uint256 amt, bool claims) internal {
        PoolKey memory k = isYes ? kYes : kNo;
        bool usdcIs0 = Currency.unwrap(k.currency0) == address(usdc);
        bool zf1 = buying ? usdcIs0 : !usdcIs0;
        SwapParams memory p = SwapParams({
            zeroForOne: zf1,
            amountSpecified: exactIn ? -int256(amt) : int256(amt),
            sqrtPriceLimitX96: zf1 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        bytes32 tag = keccak256(abi.encode(isYes, buying, exactIn));
        vm.prank(a);
        try router.swap(k, p, PoolSwapTest.TestSettings({takeClaims: claims && buying, settleUsingBurn: claims && !buying}), "") {
            ok[tag]++;
            ok[buying ? bytes32("buyOk") : bytes32("sellOk")]++;
        } catch (bytes memory e) {
            ko[tag]++;
            ko[buying ? bytes32("buyKo") : bytes32("sellKo")]++;
            if (e.length >= 4 + 32 * 4) lastErr = e;
        }
    }

    function buy(uint256 who, bool isYes, bool exactIn, uint256 amt, bool claims) external {
        address a = actors[who % actors.length];
        amt = bound(amt, 1, 20_000e6);
        _swap(a, isYes, true, exactIn, amt, claims);
    }

    function sell(uint256 who, bool isYes, bool exactIn, uint256 amt, bool claims) external {
        address a = actors[who % actors.length];
        OutcomeToken t = isYes ? yes : no;
        uint256 bal = claims ? manager.balanceOf(a, uint160(address(t))) : t.balanceOf(a);
        if (bal == 0) return;
        if (exactIn) {
            amt = bound(amt, 1, bal);
        } else {
            (, uint256 bid) = hook.quotes(mId, isYes);
            uint256 maxOut = bal * bid / 1e18;
            if (maxOut == 0) return;
            amt = bound(amt, 1, maxOut);
        }
        _swap(a, isYes, false, exactIn, amt, claims);
    }

    function split(uint256 who, uint256 amt) external {
        address a = actors[who % actors.length];
        amt = bound(amt, 1, 5_000e6);
        vm.prank(a);
        try hook.split(mId, amt) {
            ok["split"]++;
        } catch {
            ko["split"]++;
        }
    }

    function merge(uint256 who, uint256 amt) external {
        address a = actors[who % actors.length];
        uint256 m = yes.balanceOf(a) < no.balanceOf(a) ? yes.balanceOf(a) : no.balanceOf(a);
        if (m == 0) return;
        amt = bound(amt, 1, m);
        vm.prank(a);
        try hook.merge(mId, amt) {
            ok["merge"]++;
        } catch {
            ko["merge"]++;
        }
    }

    /// Arbitrary (deliberately model-inconsistent) repricing: solvency must not depend on prices (05 I7).
    function setPrice(uint256 mid, uint256 hs) external {
        hs = bound(hs, 1e15, 3e16);
        mid = bound(mid, hs + 1, 1e18 - hs - 1);
        vm.prank(owner);
        hook.setPrice(mId, mid, hs);
    }

    function restock(bool isYes, uint256 amt) external {
        amt = bound(amt, 1, 10_000e6);
        vm.prank(owner);
        hook.restock(mId, isYes, amt);
        ok["restock"]++;
    }

    function sweep(bool isYes) external {
        hook.sweep(mId, isYes);
        ok["sweep"]++;
    }

    function defund(uint256 amt) external {
        (,, uint256 bucket,,,,,,,,) = hook.markets(mId);
        uint256 req = hook.requiredCollateral(mId);
        if (bucket <= req) return;
        amt = bound(amt, 1, (bucket - req) / 4 + 1);
        vm.prank(owner);
        hook.defund(mId, amt, owner);
        ok["defund"]++;
    }

    function preSyncBuy(uint256 amt) external {
        amt = bound(amt, 1e6, 1_000e6);
        if (usdc.balanceOf(address(pre)) < amt) return;
        bool usdcIs0 = Currency.unwrap(kYes.currency0) == address(usdc);
        PreSyncRouter.Data memory d = PreSyncRouter.Data({
            key: kYes,
            p: SwapParams({
                zeroForOne: usdcIs0,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: usdcIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            payC: Currency.wrap(address(usdc)),
            outC: Currency.wrap(address(yes)),
            pay: amt,
            repayIfUnsettled: false
        });
        try pre.run(d) {
            ok["presync"]++;
        } catch {
            ko["presync"]++;
        }
    }

    function preSyncRouter() external view returns (address) {
        return address(pre);
    }
}

abstract contract InvariantBase is ProtoBase {
    Handler h;
    uint256 totalUsdc;

    function _mode() internal pure virtual returns (PredictionHookProto.Mode);
    function _outcome0() internal pure virtual returns (bool);

    function setUp() public {
        _deploy(_mode(), _outcome0());
        h = new Handler(hook, manager, swapRouter, usdc, kYes, kNo, mId, address(this));
        for (uint256 i; i < 3; ++i) usdc.mint(h.actors(i), 100_000e6);
        usdc.mint(h.preSyncRouter(), 20_000e6);
        if (_mode() == PredictionHookProto.Mode.InventoryOnly) {
            hook.restock(mId, true, 200_000e6);
            hook.restock(mId, false, 200_000e6);
        }
        totalUsdc = usdc.totalSupply();
        targetContract(address(h));
    }

    function _lpCash() internal view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function invariant_accounting() public view {
        _checkInvariants();
        // S5 tight: no orphans can be created by the handler, so PM USDC == hook claims exactly
        assertEq(usdc.balanceOf(address(manager)), hook.totalBuckets(), "PM usdc == claims");
        // S5 tight for outcome tokens: PM ERC20 balance == all claims (hook + users)
        uint256 userYesClaims;
        uint256 userNoClaims;
        for (uint256 i; i < 3; ++i) {
            userYesClaims += manager.balanceOf(h.actors(i), uint160(address(yes)));
            userNoClaims += manager.balanceOf(h.actors(i), uint160(address(no)));
        }
        (,,, uint256 invY, uint256 invN, uint256 outY, uint256 outN, uint256 mid,,,) = hook.markets(mId);
        assertEq(yes.balanceOf(address(manager)), invY + userYesClaims, "PM YES == claims");
        assertEq(no.balanceOf(address(manager)), invN + userNoClaims, "PM NO == claims");
        // I3 conservation + I6 mark-to-market zero-sum at the current mid (exact, 1e18-scaled integers)
        uint256 cash = _lpCash() + usdc.balanceOf(h.preSyncRouter()) + usdc.balanceOf(trader);
        uint256 tY;
        uint256 tN;
        for (uint256 i; i < 3; ++i) {
            address a = h.actors(i);
            cash += usdc.balanceOf(a);
            tY += yes.balanceOf(a) + manager.balanceOf(a, uint160(address(yes)));
            tN += no.balanceOf(a) + manager.balanceOf(a, uint160(address(no)));
        }
        tY += yes.balanceOf(h.preSyncRouter());
        assertEq(tY, outY, "all outstanding YES is held by known agents");
        assertEq(tN, outN, "all outstanding NO is held by known agents");
        (,, uint256 bucket,,,,,,,,) = hook.markets(mId);
        assertEq(cash + bucket, totalUsdc, "I3 conservation");
        // traders' MTM + LP MTM == Tot (scaled by 1e18)
        uint256 traders = cash * 1e18 + mid * tY + (1e18 - mid) * tN;
        int256 lp = int256(bucket * 1e18) - int256(mid * outY) - int256((1e18 - mid) * outN);
        assertEq(int256(traders) + lp, int256(totalUsdc * 1e18), "I6 zero-sum");
    }

    /// Terminal check: resolve, redeem everything, LP withdraws, no USDC stuck, conservation exact.
    function afterInvariant() public {
        bool yesWon = uint256(keccak256(abi.encode(block.timestamp, hook.totalBuckets()))) % 2 == 0;
        hook.resolve(mId, yesWon);
        _checkInvariants();
        address[4] memory holders = [h.actors(0), h.actors(1), h.actors(2), h.preSyncRouter()];
        for (uint256 i; i < 4; ++i) {
            address a = holders[i];
            uint256 cy = manager.balanceOf(a, uint160(address(yes)));
            uint256 cn = manager.balanceOf(a, uint160(address(no)));
            if (cy > 0 || cn > 0) _unwrapClaims(a, cy, cn);
            uint256 y = yes.balanceOf(a);
            uint256 n = no.balanceOf(a);
            vm.startPrank(a);
            if (y > 0) hook.redeem(mId, true, y);
            if (n > 0) hook.redeem(mId, false, n);
            vm.stopPrank();
            _checkInvariants();
        }
        (,, uint256 bucket,,, uint256 outY, uint256 outN,,,,) = hook.markets(mId);
        assertEq(outY, 0);
        assertEq(outN, 0);
        if (bucket > 0) hook.defund(mId, bucket, address(this));
        hook.sweep(mId, true);
        hook.sweep(mId, false);
        _checkInvariants();
        assertEq(usdc.balanceOf(address(manager)), 0, "no USDC stuck");
        assertEq(yes.totalSupply(), 0);
        assertEq(no.totalSupply(), 0);
        uint256 cash = _lpCash() + usdc.balanceOf(h.preSyncRouter()) + usdc.balanceOf(trader);
        for (uint256 i; i < 3; ++i) cash += usdc.balanceOf(h.actors(i));
        assertEq(cash, totalUsdc, "terminal conservation");
        console.log("presync ok/ko", h.ok("presync"), h.ko("presync"));
        console.log("split ok/ko", h.ok("split"), h.ko("split"));
        console.log("buy ok/ko", h.ok("buyOk"), h.ko("buyKo"));
        console.log("sell ok/ko", h.ok("sellOk"), h.ko("sellKo"));
        console.logBytes(h.lastErr());
    }

    // user converts outcome claims to ERC20 through a tiny unlock (claims burn -> take)
    function _unwrapClaims(address a, uint256 cy, uint256 cn) internal {
        ClaimUnwrapper u = new ClaimUnwrapper(manager);
        vm.startPrank(a);
        manager.setOperator(address(u), true);
        u.run(a, Currency.wrap(address(yes)), cy, Currency.wrap(address(no)), cn);
        vm.stopPrank();
    }
}

contract ClaimUnwrapper is IUnlockCallback {
    IPoolManager immutable pm;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    function run(address a, Currency y, uint256 cy, Currency n, uint256 cn) external {
        pm.unlock(abi.encode(a, y, cy, n, cn));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        (address a, Currency y, uint256 cy, Currency n, uint256 cn) =
            abi.decode(raw, (address, Currency, uint256, Currency, uint256));
        if (cy > 0) {
            pm.burn(a, y.toId(), cy);
            pm.take(y, a, cy);
        }
        if (cn > 0) {
            pm.burn(a, n.toId(), cn);
            pm.take(n, a, cn);
        }
        return "";
    }
}

contract Invariant_OnDemand_Outcome0 is InvariantBase {
    function _mode() internal pure override returns (PredictionHookProto.Mode) {
        return PredictionHookProto.Mode.OnDemand;
    }

    function _outcome0() internal pure override returns (bool) {
        return true;
    }
}

contract Invariant_OnDemand_Outcome1 is InvariantBase {
    function _mode() internal pure override returns (PredictionHookProto.Mode) {
        return PredictionHookProto.Mode.OnDemand;
    }

    function _outcome0() internal pure override returns (bool) {
        return false;
    }
}

contract Invariant_InventoryOnly_Outcome1 is InvariantBase {
    function _mode() internal pure override returns (PredictionHookProto.Mode) {
        return PredictionHookProto.Mode.InventoryOnly;
    }

    function _outcome0() internal pure override returns (bool) {
        return false;
    }
}

