# 01: Uniswap v4 core mechanics for a custom-pricing (NoOp / custom-accounting) hook, plus tooling

Status: FACT-CHECKED research note (2026-09-25). This note feeds the "prove it works" plan for a Uniswap v4 hook that prices YES/NO outcome tokens with a Black–Scholes digital model. An adversarial fact-check re-verified every load-bearing claim against source, live chain state and independent Python re-computation. Corrections are marked **[CORRECTED]** inline and additions **[ADDED]**. The full evidence is in the **Verification log** at the end.

> **Fact-check summary.** The core mechanics in this note are correct: the full-NoOp delta algebra, the sign conventions, the settlement pattern, the flags, the quoter and router behaviour, the addresses, the pool ids and the fee switch. Errors fixed:
> 1. §1.3: the allowed range of `deltaSpecified` has **only one bound**. Core rejects only overshoot. For exact-in, a *negative* `deltaSpecified` is accepted and **enlarges** the CL swap.
> 2. §7.2: UR `main` pins v4-periphery **`a7af5b3` (2026-09-16)**, not `9dafaae`.
> 3. §2.3 and §9: v4-template's pinned `uniswap-hooks@e59fe72` pins v4-core **`a7cf038`** and v4-periphery **`eeb3eff`**. `d153b04` and `7ebd04b` are the pins of OZ `master`.
> 4. Minor: a line number (`Pool.sol:453`), and two remapping aliases that were missing.
>
> Additions: the v3 oracle window bound (§5.4), fee-switch scope details and `IFeeClassifiedHook` (§6), V4Router over-delivery and hook-funded-input behaviour (§7.2), and the `afterSwap` resolution nuance (TL;DR 2).

All file:line citations point to shallow clones in `scratchpad/repos/` at these commits:

| Repo | Commit (date) | Version / latest tag | License |
|---|---|---|---|
| `Uniswap/v4-core` | `46c6834` (2026-04-02) | package `1.0.2`; only tag `v4.0.0` = `e50237c` (2025-01-21) | `PoolManager`/`Pool`/etc. BUSL-1.1 (change date: 2027-06-15 or earlier, then MIT); libraries/types (`Hooks`, `BalanceDelta`, `StateLibrary`, ...) MIT |
| `Uniswap/v4-periphery` | `9969eec` (2026-09-19) | package `1.0.4`; no git tags | MIT |
| `OpenZeppelin/uniswap-hooks` | `80bd724` (2026-09-24) | package `1.2.2`; latest tag `v1.2.1` = `acbd604` (2025-11-27) | MIT |
| `uniswapfoundation/v4-template` | `1fbf955` (2025-10-28) | — | MIT |
| `Uniswap/universal-router` | `a9c574f` (2026-09-22) | package `2.1.0` | GPL-3.0-or-later |
| `Uniswap/v4-hooks-public` (cloned for this note) | `e4eabe5` (2026-09-10) | — | MIT (`aggregator-hooks/ProtocolFees.sol` is AGPL-3.0) |
| `akshatmittal/hookmate` (cloned for this note) | `ef3e984` (2026-06-15) | npm `hookmate` | MIT |

Important version fact: on v4-core, the only `src/` change since the deployed `v4.0.0` tag is commit `a7cf038` (2025-04-28). It moved `SwapParams` and `ModifyLiquidityParams` out of `IPoolManager` into `src/types/PoolOperation.sol`. The struct layouts are identical, so the ABI and behaviour are the same. Only the import paths changed: `IPoolManager.SwapParams` became `SwapParams`. So the deployed `PoolManager` behaves exactly like the code cited below.

Verification artifacts I produced (in `scratchpad/`):
- `v4sim.py` is an exact re-implementation of the NoOp swap arithmetic and flash accounting. It produces the numbers in §1.8.
- `poolid.py` and `probe.py` compute and live-query the ETH/USDC v4 pool IDs and state (§5.4).
- `v3probe.py` reads the v3 oracle and the PoolManager's USDC balance.

---

## TL;DR

1. **A full NoOp is fully supported by core and is cheap.** In `beforeSwap`, the hook returns `BeforeSwapDelta(specified = -amountSpecified, unspecified = ±computedAmount)`. That makes `amountToSwap = 0`. `Pool.swap` then returns `ZERO_DELTA` at `Pool.sol:320`, before any price-limit check or liquidity use, and without writing state. The pool must be **initialized** (`PoolManager.sol:196`). It does **not** need any liquidity. `sqrtPriceLimitX96` is **not validated at all** on a full NoOp.
2. **What the caller owes equals the negative of the hook's delta.** In a full NoOp, `callerDelta = clDelta - hookDelta = -hookDelta` (`Hooks.sol:305-313`). The hook's delta is booked to `address(key.hooks)` (`PoolManager.sol:224`). The hook must pre-resolve exactly the opposite delta inside its callback, because it gets no further callback before `unlock` checks `NonzeroDeltaCount` (`PoolManager.sol:112`). **[ADDED]** Precisely: with our flag set (no `AFTER_SWAP`), `beforeSwap` is the only chance. If `AFTER_SWAP` were enabled, `afterSwap` also runs *before* `hookDelta` is booked at `:224`, so resolution could happen there too. It could never happen after `PM.swap` returns, because the router owns the `unlock`.
3. **The settlement pattern for our hook.** The swapper has not paid yet when `beforeSwap` runs, and the PoolManager (PM) holds no YES tokens. So:
   - The hook takes its **input credit as ERC-6909 claims** with `poolManager.mint(hook, currency.toId(), amt)`.
   - It **delivers YES** with `sync(YES)`, then `YES.mint(address(poolManager), amt)`, then `settle()`.
   - It **pays USDC** by burning its USDC claims with `poolManager.burn(hook, usdcId, amt)`.

   This matches OZ `BaseCustomCurve` (`src/base/BaseCustomCurve.sol:112-128`) and Uniswap Labs' `SettlementLib` (`v4-hooks-public/src/alf/libraries/SettlementLib.sol:28-30, 61-82`), which states: "positive delta … the swapper has not settled yet, so mint ERC-6909 claims rather than calling `take`". Calling `take()` in `beforeSwap` works only if the PM already holds that ERC20. The official docs warn about this too.
4. **Flags for our hook.** `BEFORE_INITIALIZE | BEFORE_ADD_LIQUIDITY | BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA` gives low 14 address bits = **`0x2888`**. Adding `BEFORE_REMOVE_LIQUIDITY` gives `0x2A88`, the same set as OZ `BaseCustomCurve`. A `beforeInitialize` that always reverts makes pool creation hook-only. This works because `Hooks.noSelfCall` skips the callback when the hook itself calls `PM.initialize` (`Hooks.sol:171-182`); `v4-hooks-public` uses the same trick.
5. **Standard routers, UniversalRouter and the quoter all work unchanged.**
   - V4Router, UniversalRouter (`V4_SWAP` = `0x10` with `SWAP_EXACT_IN_SINGLE`/`SETTLE_ALL`/`TAKE_ALL`) and `V4Quoter` work with no special encoding.
   - Caveat: the quoter reverts `NotEnoughLiquidity` unless the hook fills the **exact** specified amount (`BaseV4Quoter.sol:53-57`). Never partial-fill.
   - Caveat: the `ExactInputSingleParams` struct gained a `minHopPriceX36` field in periphery `03b2d09` (2026-03). The original UR v2.0 deployment uses the old 5-field struct.
6. **No protocol fee is charged by core on NoOp volume.** `Pool.swap` returns `amountToProtocol = 0` (`Pool.sol:320`). The July-2026 v4 fee switch (Governance Proposal 100) charges "aggregator hook pools" only through **hook-side cooperation**: `v4-hooks-public/src/aggregator-hooks/ProtocolFees.sol` reads `slot0.protocolFee`, multiplies it by 25 and `take`s it to the TokenJar.
7. **OZ `uniswap-hooks` fit.** Inherit **OZ `BaseHook` only**. `BaseCustomAccounting` and `BaseCustomCurve` are single-pool (`_poolKey` is bound at the first initialize) and assume two-sided LP deposits. Our hook is multi-market, USDC-only-collateral and mints its outcome tokens. Copy their settlement pattern instead of inheriting them.
8. **The live price source.** The canonical ETH/USDC v4 pools have `hooks = 0`, so they have no oracle. `StateLibrary.getSlot0` costs one `extsload`, about 2.4k gas cold, and can be called from inside our callback. But slot0 can be manipulated within the same transaction, so pricing and settlement need a TWAP or observation buffer. Mainnet ETH/USDC 0.05% pool id is `0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27`. I verified it on-chain: price ≈ $2,688 at block 26,054,869.
9. **Tooling.**
   - Foundry, solc **0.8.26** (`PoolManager.sol` and `V4Router.sol` pin `pragma solidity 0.8.26`), `evm_version = "cancun"` (transient storage), `ffi = true` for mpmath reference tests.
   - Dependencies as git submodules via `forge install`, pinned by `foundry.lock`.
   - `HookMiner` was **removed from `v4-periphery/src/utils`** on 2026-02-06 (`5da22e6`). It now lives in `v4-hooks-public/src/utils/HookMiner.sol` and `v4-periphery/test/shared/HookMiner.sol`.
   - In tests, deploy the hook with forge-std `deployCodeTo`.

---

## 1. `PoolManager.swap` flow, line by line

### 1.1 Entry and pre-checks (`v4-core/src/PoolManager.sol:187-227`)

```solidity
function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
    external onlyWhenUnlocked noDelegateCall returns (BalanceDelta swapDelta)
{
    if (params.amountSpecified == 0) SwapAmountCannotBeZero.selector.revertWith();   // :193
    PoolId id = key.toId();
    Pool.State storage pool = _getPool(id);
    pool.checkPoolInitialized();                                                     // :196 -> Pool.sol:585-587 (sqrtPriceX96 != 0)

    BeforeSwapDelta beforeSwapDelta;
    {
        int256 amountToSwap;
        uint24 lpFeeOverride;
        (amountToSwap, beforeSwapDelta, lpFeeOverride) = key.hooks.beforeSwap(key, params, hookData);  // :202
        swapDelta = _swap(pool, id, Pool.SwapParams({
            tickSpacing: key.tickSpacing, zeroForOne: params.zeroForOne,
            amountSpecified: amountToSwap,                    // <- NOT params.amountSpecified
            sqrtPriceLimitX96: params.sqrtPriceLimitX96, lpFeeOverride: lpFeeOverride
        }), params.zeroForOne ? key.currency0 : key.currency1);                          // :206-217
    }
    BalanceDelta hookDelta;
    (swapDelta, hookDelta) = key.hooks.afterSwap(key, params, swapDelta, hookData, beforeSwapDelta); // :221
    if (hookDelta != BalanceDeltaLibrary.ZERO_DELTA) _accountPoolBalanceDelta(key, hookDelta, address(key.hooks)); // :224
    _accountPoolBalanceDelta(key, swapDelta, msg.sender);                                // :226
}
```

- `onlyWhenUnlocked` (`:96-99`): swaps are possible only inside `PM.unlock(...)` → `IUnlockCallback(msg.sender).unlockCallback(data)` (`:104-114`). At the end, `if (NonzeroDeltaCount.read() != 0) CurrencyNotSettled` (`:112`).
- `msg.sender` of `PM.swap` is the **router**, never the EOA. `Hooks.beforeSwap` forwards that `msg.sender` as the `sender` argument to the hook (`Hooks.sol:256`).

### 1.2 `amountSpecified` sign convention (`v4-core/src/types/PoolOperation.sol:19-26`)

```solidity
struct SwapParams {
    bool zeroForOne;          // Whether to swap token0 for token1 or vice versa
    int256 amountSpecified;   // The desired input amount if negative (exactIn), or the desired output amount if positive (exactOut)
    uint160 sqrtPriceLimitX96;
}
```

- `amountSpecified < 0` means exact input; `|amountSpecified|` is the input.
- `amountSpecified > 0` means exact output; `amountSpecified` is the output.
- `zeroForOne = true` means input is currency0 and output is currency1.

**Specified vs unspecified currency.** The specified currency is **currency0 iff `zeroForOne == (amountSpecified < 0)`**:

| zeroForOne | exactIn? | specified | unspecified |
|---|---|---|---|
| true | exactIn (<0) | currency0 (input) | currency1 (output) |
| true | exactOut (>0) | currency1 (output) | currency0 (input) |
| false | exactIn | currency1 (input) | currency0 (output) |
| false | exactOut | currency0 (output) | currency1 (input) |

Sources: `Hooks.sol:307`; `DeltaReturningHook._sortCurrencies` at `v4-core/src/test/DeltaReturningHook.sol:81-83`; OZ `BaseCustomCurve.sol:100-101`; `Pool.sol:453` **[CORRECTED from :452]** ("if currency1 is specified": `zeroForOne != (amountSpecified < 0)`).

### 1.3 `Hooks.beforeSwap`: how `amountToSwap` is computed (`v4-core/src/libraries/Hooks.sol:248-282`)

```solidity
amountToSwap = params.amountSpecified;
if (msg.sender == address(self)) return (amountToSwap, BeforeSwapDeltaLibrary.ZERO_DELTA, lpFeeOverride); // hook calling swap on its own pool -> hooks skipped
if (self.hasPermission(BEFORE_SWAP_FLAG)) {
    bytes memory result = callHook(self, abi.encodeCall(IHooks.beforeSwap, (msg.sender, key, params, hookData)));
    if (result.length != 96) InvalidHookResponse.selector.revertWith();            // (bytes4, int256, uint24)
    if (key.fee.isDynamicFee()) lpFeeOverride = result.parseFee();                  // only parsed for dynamic-fee pools
    if (self.hasPermission(BEFORE_SWAP_RETURNS_DELTA_FLAG)) {                        // delta ignored without this flag!
        hookReturn = BeforeSwapDelta.wrap(result.parseReturnDelta());
        int128 hookDeltaSpecified = hookReturn.getSpecifiedDelta();
        if (hookDeltaSpecified != 0) {
            bool exactInput = amountToSwap < 0;
            amountToSwap += hookDeltaSpecified;
            if (exactInput ? amountToSwap > 0 : amountToSwap < 0) HookDeltaExceedsSwapAmount.selector.revertWith();
        }
    }
}
```

`BeforeSwapDelta` packing (`v4-core/src/types/BeforeSwapDelta.sol:4-16, 25-37`): the upper 128 bits are `deltaSpecified` and the lower 128 bits are `deltaUnspecified`. Both are `int128`, and both are **the hook's own deltas**: positive means the hook is owed or took currency, negative means it owes or sent currency (`IHooks.sol:101`).

```solidity
function toBeforeSwapDelta(int128 deltaSpecified, int128 deltaUnspecified) pure returns (BeforeSwapDelta d) {
    assembly ("memory-safe") { d := or(shl(128, deltaSpecified), and(sub(shl(128, 1), 1), deltaUnspecified)) }
}
```

- **Allowed range of `deltaSpecified`. [CORRECTED]** Core enforces **only one bound** (`Hooks.sol:273-278`):
  - For exact-in (`amountSpecified = -A`), it reverts `HookDeltaExceedsSwapAmount` iff `deltaSpecified > A`.
  - For exact-out (`amountSpecified = +A`), it reverts iff `deltaSpecified < -A`.

  There is **no** lower bound for exact-in and **no** upper bound for exact-out. A negative `deltaSpecified` on an exact-in swap is accepted and makes `amountToSwap` *more* negative, so the hook "adds" to the CL swap. For example, `A = 100, deltaSpecified = -50` gives `amountToSwap = -150`, re-derived in `scratchpad/fc03_sim.py`. The swap type can never flip. A **full NoOp** sets `deltaSpecified = -amountSpecified`, which gives `amountToSwap = 0`. Our hook must assert this exact value itself; core will not catch a wrong-signed specified delta.
- If the hook lacks `BEFORE_SWAP_RETURNS_DELTA_FLAG`, the returned delta is **silently ignored** (`:266`). Any settle/take the hook already did would then be unbalanced, and the transaction reverts with `CurrencyNotSettled`. Getting the flags wrong is fatal.

### 1.4 `Pool.swap` with `amountToSwap == 0` (`v4-core/src/libraries/Pool.sol:279-338`)

```solidity
Slot0 slot0Start = self.slot0;
...
{   // :302-308
    uint24 lpFee = params.lpFeeOverride.isOverride()
        ? params.lpFeeOverride.removeOverrideFlagAndValidate()   // can revert LPFeeTooLarge even on a NoOp (dynamic-fee pools only)
        : slot0Start.lpFee();
    swapFee = protocolFee == 0 ? lpFee : uint16(protocolFee).calculateSwapFee(lpFee);
}
if (swapFee >= SwapMath.MAX_SWAP_FEE) { if (params.amountSpecified > 0) InvalidFeeForExactOut... }   // :311-316 (amountSpecified==0 here, so no revert)
if (params.amountSpecified == 0) return (BalanceDeltaLibrary.ZERO_DELTA, 0, swapFee, result);        // :320  <-- EARLY RETURN
if (zeroForOne) { if (params.sqrtPriceLimitX96 >= slot0Start.sqrtPriceX96()) PriceLimitAlreadyExceeded ...   // :322-338 never reached
```

- **Is the CL swap skipped?** Yes. `Pool.swap` is still called, but it returns at `:320`. It does no tick traversal, touches no liquidity, updates no fee growth, does **not write `slot0`** (writes happen only at `Pool.sol:439`), and accrues no protocol fee (`amountToProtocol = 0`).
- **Does the pool need liquidity?** No.
- **Must the pool be initialized?** Yes (`PoolManager.sol:196`). It needs a valid `sqrtPriceX96` in `[MIN_SQRT_PRICE = 4295128739, MAX_SQRT_PRICE)` (`TickMath.sol:31-33, 121-129`). That price is never used and never moves.
- **Is `sqrtPriceLimitX96` validated?** No. On a full NoOp the checks at `:322-338` are skipped, so any value, even 0, is accepted. Routers pass `MIN_SQRT_PRICE+1` or `MAX_SQRT_PRICE-1` (`V4Router.sol:215`, `BaseV4Quoter.sol:48`). Slippage protection must come from router-level `amountOutMinimum`/`amountInMaximum`, which check the returned delta, or from our own hook-level check.
- `PoolManager._swap` still **emits `Swap(id, sender, 0, 0, sqrtPriceX96(static), liquidity, tick, swapFee)`** (`PoolManager.sol:241-250`). Indexers therefore see zero amounts. That is why OZ defines a `HookSwap` event (§4.6).

### 1.5 `Hooks.afterSwap`: mapping hook deltas to currency0/1 and deriving the caller delta (`Hooks.sol:285-315`)

```solidity
if (msg.sender == address(self)) return (swapDelta, BalanceDeltaLibrary.ZERO_DELTA);
int128 hookDeltaSpecified   = beforeSwapHookReturn.getSpecifiedDelta();
int128 hookDeltaUnspecified = beforeSwapHookReturn.getUnspecifiedDelta();
if (self.hasPermission(AFTER_SWAP_FLAG)) {       // optional: afterSwap may ADD to the unspecified delta
    hookDeltaUnspecified += self.callHookWithReturnDelta(abi.encodeCall(IHooks.afterSwap, (...)),
                                                         self.hasPermission(AFTER_SWAP_RETURNS_DELTA_FLAG)).toInt128();
}
BalanceDelta hookDelta;
if (hookDeltaUnspecified != 0 || hookDeltaSpecified != 0) {
    hookDelta = (params.amountSpecified < 0 == params.zeroForOne)
        ? toBalanceDelta(hookDeltaSpecified, hookDeltaUnspecified)     // specified is currency0
        : toBalanceDelta(hookDeltaUnspecified, hookDeltaSpecified);    // specified is currency1
    swapDelta = swapDelta - hookDelta;     // "the caller has to pay for (or receive) the hook's delta"
}
return (swapDelta, hookDelta);
```

- This mapping runs **even if the hook has no `AFTER_SWAP` permission**. The flag only guards the external call.
- `BalanceDelta` subtraction uses `SafeCast.toInt128`, so it reverts on int128 overflow (`BalanceDelta.sol:34-46`).
- `PoolManager.swap` returns `swapDelta` **after** this subtraction. Routers therefore see `callerDelta = clDelta - hookDelta`, and on a full NoOp that is **`-hookDelta`**.

### 1.6 Accounting to the hook and to the caller (`PoolManager.sol:367-384`)

```solidity
function _accountDelta(Currency currency, int128 delta, address target) internal {
    if (delta == 0) return;
    (int256 previous, int256 next) = currency.applyDelta(target, delta);   // transient slot keccak(target, currency)
    if (next == 0) NonzeroDeltaCount.decrement();
    else if (previous == 0) NonzeroDeltaCount.increment();
}
function _accountPoolBalanceDelta(PoolKey memory key, BalanceDelta delta, address target) internal {
    _accountDelta(key.currency0, delta.amount0(), target);
    _accountDelta(key.currency1, delta.amount1(), target);
}
```

- The hook's delta is booked to `address(key.hooks)` **after** its callbacks have returned (`:224`).
- Anything the hook did during `beforeSwap` (mint, burn, settle, take) has already moved its delta in the **opposite** direction. The two must cancel exactly.
- The hook gets no other callback within the swapper's unlock, so it cannot "settle later".

### 1.7 Sign-convention summary for a full NoOp

Let `A = |amountSpecified|`. `out` is the hook-computed output (exact-in). `in` is the hook-computed input (exact-out).

| | exact-in (`amountSpecified = -A`) | exact-out (`amountSpecified = +A`) |
|---|---|---|
| `BeforeSwapDelta` | `(specified = +A, unspecified = -out)` | `(specified = -A, unspecified = +in)` |
| `amountToSwap` | `-A + A = 0` | `A - A = 0` |
| hook's delta on the input currency | `+A` (credited) | `+in` |
| hook's delta on the output currency | `-out` (owes) | `-A` |
| caller's delta | input `-A`, output `+out` | input `-in`, output `+A` |

Rounding rule for solvency: exact-in output rounds **down** (`FullMath.mulDiv`). Exact-out input rounds **up** (`FullMath.mulDivRoundingUp`, `FullMath.sol:14,109`).

### 1.8 Worked numeric examples: YES/USDC pool, hook prices everything

Assumptions:
- `currency0 = YES` (`address(YES) < address(USDC)`), `currency1 = USDC`. Both have 6 decimals, so 1 YES = 1e6 units and pays 1e6 USDC units at expiry.
- Model mid price 0.40 USDC/YES with a half-spread of 0.01: **ask 0.41, bid 0.39**.
- The hook holds LP collateral as USDC ERC-6909 claims.

Hook-side resolution in every case:
- input credit → `poolManager.mint(hook, input.toId(), in)`;
- YES output → `sync(YES); YES.mint(PM, out); settle()`;
- USDC output → `poolManager.burn(hook, USDC.toId(), out)`.

I verified every row with `scratchpad/v4sim.py`, which replicates `Hooks.beforeSwap/afterSwap`, the `Pool.swap` early return, `_accountDelta` and `NonzeroDeltaCount`. In every case, after the router settles its negative delta and takes its positive delta, **`NonzeroDeltaCount == 0` and the hook's net delta is (0, 0)**.

| # | Trade | `zeroForOne` | `amountSpecified` | Hook computes | `BeforeSwapDelta` (spec, unspec) → raw int256 | `hookDelta` (amount0 YES, amount1 USDC) | caller `swapDelta` returned | Hook's in-callback actions |
|---|---|---|---|---|---|---|---|---|
| A | buy YES, exact-in 100 USDC | `false` | `-100_000_000` | out = ⌊100e6 / 0.41⌋ = **243,902,439 YES** | `(+100_000_000, -243_902_439)` → `0x…05f5e100fffffffffffffffffffffffff1765819` | `(-243,902,439, +100,000,000)` | `(+243,902,439, -100,000,000)` | `mint(hook, USDC, 100e6)`; `sync(YES)`, `YES.mint(PM, 243,902,439)`, `settle()` |
| B | buy YES, exact-out 250 YES | `false` | `+250_000_000` | in = ⌈250e6 · 0.41⌉ = **102,500,000 USDC** | `(-250_000_000, +102_500_000)` → `0xfffffffffffffffffffffffff1194d80000000000000000000000000061c06a0` | `(-250,000,000, +102,500,000)` | `(+250,000,000, -102,500,000)` | `mint(hook, USDC, 102.5e6)`; `sync(YES)`, `YES.mint(PM, 250e6)`, `settle()` |
| C | sell YES, exact-in 250 YES | `true` | `-250_000_000` | out = ⌊250e6 · 0.39⌋ = **97,500,000 USDC** | `(+250_000_000, -97_500_000)` → `0x0000000000000000000000000ee6b280fffffffffffffffffffffffffa3044a0` | `(+250,000,000, -97,500,000)` | `(-250,000,000, +97,500,000)` | `mint(hook, YES, 250e6)` (YES claim); `burn(hook, USDC, 97.5e6)` |
| D | sell YES, exact-out 100 USDC | `true` | `+100_000_000` | in = ⌈100e6 / 0.39⌉ = **256,410,257 YES** | `(-100_000_000, +256_410_257)` → `0xfffffffffffffffffffffffffa0a1f000000000000000000000000000f488291` | `(+256,410,257, -100,000,000)` | `(-256,410,257, +100,000,000)` | `mint(hook, YES, 256,410,257)`; `burn(hook, USDC, 100e6)` |

The full raw values printed by the script are:
- A: `0x00000000000000000000000005f5e100fffffffffffffffffffffffff1765819`
- B: `0xfffffffffffffffffffffffff1194d80000000000000000000000000061c06a0`
- C: `0x0000000000000000000000000ee6b280fffffffffffffffffffffffffa3044a0`
- D: `0xfffffffffffffffffffffffffa0a1f000000000000000000000000000f488291`

Walking through case A in detail:
1. `PM.swap` is called with `amountSpecified = -100e6`. `zeroForOne = false`, so the specified currency is currency1 (USDC).
2. The hook runs `mint(hook, USDC, 100e6)`, which moves the hook's USDC delta to −100e6. Then `sync(YES)`, `YES.mint(PM, 243,902,439)` and `settle()` move the hook's YES delta to +243,902,439.
3. The hook returns `(+100e6, −243,902,439)`, so `amountToSwap = −100e6 + 100e6 = 0`.
4. `Pool.swap` returns `ZERO_DELTA`.
5. `afterSwap` maps the deltas. `(amountSpecified<0) == zeroForOne` is `true == false`, which is false, so the result is `toBalanceDelta(unspec, spec) = (−243,902,439, +100e6)`.
6. The hook is credited that, and its deltas become `(0, 0)`.
7. The caller's delta is `(0,0) − hookDelta = (+243,902,439 YES, −100e6 USDC)`.
8. The router settles 100e6 USDC (`sync` → `transferFrom` → `settle`) and takes 243,902,439 YES. The PM holds exactly that much YES because the hook minted it into the PM.

If instead `address(USDC) < address(YES)`, then `currency0 = USDC`. Buying YES becomes `zeroForOne = true`, and the amount0/amount1 columns swap. The `BeforeSwapDelta` (specified, unspecified) values are **unchanged**, because they are expressed relative to specified and unspecified, not token0 and token1. A CREATE2 salt can force either ordering (§11).

### 1.9 Everything that can revert on this path

| Where | Condition |
|---|---|
| `PoolManager.sol:97` | `ManagerLocked`: `swap` called outside `unlock` |
| `PoolManager.sol:193` | `SwapAmountCannotBeZero` (checked on the **user's** `amountSpecified`, before the hook runs) |
| `PoolManager.sol:196` / `Pool.sol:586` | `PoolNotInitialized` |
| `Hooks.sol:137` | a hook revert is bubbled as ERC-7751 `WrappedError(address target, bytes4 selector, bytes reason, bytes details)` with `details = HookCallFailed` (`CustomRevert.sol:11, 83`). `vm.expectRevert` must match this wrapper. |
| `Hooks.sol:152-153, 259` | `InvalidHookResponse`: wrong selector, or return data length ≠ 96 |
| `Hooks.sol:276-278` | `HookDeltaExceedsSwapAmount` |
| `Pool.sol:303-305` | `LPFeeTooLarge`: dynamic-fee pool returning the override flag with fee > 1e6. This still applies on a NoOp. |
| `BalanceDelta.sol:31,45` / `SafeCast` | int128 overflow in delta add or sub |
| `PoolManager.sol:112` | `CurrencyNotSettled` at the end of `unlock` |
| **Not** checked on a full NoOp | `PriceLimitAlreadyExceeded` and `PriceLimitOutOfBounds` (`Pool.sol:322-338`); `InvalidFeeForExactOut` (`:311-316`, because the effective amount is 0) |

**Warning about partial fills.** Suppose the hook returns `|deltaSpecified| < |amountSpecified|`. The remainder then goes through the CL loop on a zero-liquidity pool. `computeSwapStep` yields 0 amounts, so the loop walks tick words until it reaches the router's `MIN/MAX_SQRT_PRICE±1` limit. That can take thousands of iterations with `tickSpacing = 1` (≈887,272 ticks / 256 per word) and permanently moves the cosmetic `slot0` price. The quoter would also revert (§7.3). **Always fill fully or revert.** Defensively, a larger `tickSpacing` bounds that walk.

---

## 2. Hook permission flags and address bits

### 2.1 Flags (`v4-core/src/libraries/Hooks.sol:27-47`)

| Flag | Bit | Hex |
|---|---|---|
| `BEFORE_INITIALIZE_FLAG` | 1<<13 | `0x2000` |
| `AFTER_INITIALIZE_FLAG` | 1<<12 | `0x1000` |
| `BEFORE_ADD_LIQUIDITY_FLAG` | 1<<11 | `0x0800` |
| `AFTER_ADD_LIQUIDITY_FLAG` | 1<<10 | `0x0400` |
| `BEFORE_REMOVE_LIQUIDITY_FLAG` | 1<<9 | `0x0200` |
| `AFTER_REMOVE_LIQUIDITY_FLAG` | 1<<8 | `0x0100` |
| `BEFORE_SWAP_FLAG` | 1<<7 | `0x0080` |
| `AFTER_SWAP_FLAG` | 1<<6 | `0x0040` |
| `BEFORE_DONATE_FLAG` | 1<<5 | `0x0020` |
| `AFTER_DONATE_FLAG` | 1<<4 | `0x0010` |
| `BEFORE_SWAP_RETURNS_DELTA_FLAG` | 1<<3 | `0x0008` |
| `AFTER_SWAP_RETURNS_DELTA_FLAG` | 1<<2 | `0x0004` |
| `AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG` | 1<<1 | `0x0002` |
| `AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG` | 1<<0 | `0x0001` |

`ALL_HOOK_MASK = (1<<14) - 1`. The check is `hasPermission(self, flag) = uint160(address(self)) & flag != 0` (`:337-339`).

### 2.2 Validation rules

- **Called by `PM.initialize` (`PoolManager.sol:126`): `isValidHookAddress(IHooks self, uint24 fee)`** (`Hooks.sol:109-127`):
  - Each `*_RETURNS_DELTA` flag requires its base flag. `BEFORE_SWAP_RETURNS_DELTA` requires `BEFORE_SWAP`, and similarly for afterSwap, afterAddLiquidity and afterRemoveLiquidity.
  - `hooks == address(0)` means the fee must not be dynamic.
  - Otherwise the address must have at least one flag bit set **or** the fee must be dynamic.
- **`validateHookPermissions(IHooks, Permissions)`** (`:83-103`) is meant for the hook's own constructor. Every one of the 14 booleans must **equal** the corresponding address bit. Extra bits are therefore also fatal. OZ `BaseHook` calls it in its constructor (`oz-uniswap-hooks/src/base/BaseHook.sol:54-57, 90-92`), so `new Hook(...)` at an unmined address reverts `HookAddressNotValid`.
- **Initialize-time checks in `PoolManager.initialize` (`:117-142`):**
  - `TickSpacingTooLarge` if `> 32767` (`type(int16).max`);
  - `TickSpacingTooSmall` if `< 1`;
  - `CurrenciesOutOfOrderOrEqual` unless `currency0 < currency1`;
  - `HookAddressNotValid`;
  - `LPFeeTooLarge` if a static fee is `> 1_000_000` (`LPFeeLibrary.sol:51-56`).
  - For dynamic-fee pools, `key.fee == 0x800000` exactly, and the initial LP fee is 0.

**Our flag set:**
- `BEFORE_INITIALIZE | BEFORE_ADD_LIQUIDITY | BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA` = `0x2000|0x0800|0x0080|0x0008` = **`0x2888`**.
- With `BEFORE_REMOVE_LIQUIDITY` added it is `0x2A88`, identical to OZ `BaseCustomCurve.getHookPermissions` (`BaseCustomCurve.sol:307-324`).
- 14 bits must match, so mining takes about 2^14 = 16,384 CREATE2 tries on average.

### 2.3 Deploying hooks at flagged addresses (tests and scripts)

1. **`vm.etch` (v4-core tests).**
   ```solidity
   address hookAddr = address(uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG));
   address impl = address(new CustomCurveHook(manager));
   vm.etch(hookAddr, impl.code);
   ```
   Source: `v4-core/test/CustomAccounting.t.sol:35-39, 62-66`. Caveats: constructor **storage is not copied** (immutables are, since they live in the runtime code), and the implementation must be deployable at a non-flag address. That fails for OZ `BaseHook`, whose constructor validates the address.
2. **`deployCodeTo` (forge-std `StdCheats`), which the v4-template uses.**
   ```solidity
   address flags = address(uint160(Hooks.BEFORE_SWAP_FLAG | ... ) ^ (0x4444 << 144)); // namespace to avoid collisions
   deployCodeTo("Counter.sol:Counter", abi.encode(poolManager), flags);
   ```
   Source: `v4-template/test/Counter.t.sol:48-57`. This runs the real constructor at the target address. **Recommended for our tests.**
3. **`HookMiner` with CREATE2** (scripts and real deployments):
   ```solidity
   library HookMiner {
       uint160 constant FLAG_MASK = Hooks.ALL_HOOK_MASK; uint256 constant MAX_LOOP = 160_444;
       function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
           internal view returns (address, bytes32);           // loops salt, checks addr & FLAG_MASK == flags && addr.code.length == 0
       function computeAddress(address deployer, uint256 salt, bytes memory creationCodeWithArgs)
           internal pure returns (address);
   }
   // usage: (address a, bytes32 salt) = HookMiner.find(CREATE2_FACTORY, flags, type(H).creationCode, abi.encode(pm));
   //        H h = new H{salt: salt}(pm); require(address(h) == a);
   ```
   - In `forge script`, the deployer is the CREATE2 proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C`. In `forge test`, it is `address(this)` or the pranked address (`v4-template/README.md`, "Hook deployment failures").
   - **Path change.** `v4-periphery/src/utils/HookMiner.sol` and `src/utils/BaseHook.sol` were **deleted** on 2026-02-06 in commit `5da22e6` ("remove hooks and move to hook repo (#510)"). Current copies are:
     - `v4-hooks-public/src/utils/HookMiner.sol` (plus `HookMinerCreate3.sol` and `PrefacedHookMiner.sol`);
     - `v4-periphery/test/shared/HookMiner.sol:1-57` (MIT, `^0.8.21`).
   - The v4-template still imports `@uniswap/v4-periphery/src/utils/HookMiner.sol` (`script/00_DeployHook.s.sol:5`). That works only because its remapping points at an older periphery commit inside OZ `uniswap-hooks`' submodule. **[CORRECTED]** The template's `foundry.lock` pins `uniswap-hooks@e59fe72` (2025-07-10), whose `lib/v4-periphery` is **`eeb3eff`** (2025-05-02), not `7ebd04b`. `7ebd04b` (2025-10-23) is what OZ `master` pins. Both still contain `src/utils/HookMiner.sol`.
   - For our repo, vendor `HookMiner.sol` (≈50 lines, MIT) or depend on `v4-hooks-public`.

---

## 3. Settlement mechanics inside the swap

### 3.1 Primitives and their delta effect on `msg.sender` (`PoolManager.sol:279-365`)

| Call | Effect on caller's delta | Token movement | Notes |
|---|---|---|---|
| `sync(Currency c)` | none | none | Stores `c` and `balanceOf(PM)` in transient `CURRENCY_SLOT`/`RESERVES_OF_SLOT` (`CurrencyReserves.sol:27-32`). Must precede an ERC20 transfer-in. No lock required. |
| `settle()` payable | `+paid` in the synced currency | none (measures the balance diff) | `paid = balanceOf(PM) - syncedReserves`, then `resetCurrency()` (`:349-365`). With no synced currency it expects native and `paid = msg.value`. |
| `settleFor(recipient)` | `+paid` credited to `recipient` | — | |
| `take(c, to, amt)` | `-amt` | **ERC20/native transfer out now** | Needs the PM to physically hold `amt` of `c` (`:291-297`) |
| `mint(to, id, amt)` | `-amt` | none; ERC-6909 `balanceOf[to][id] += amt` | `id = uint160(currency)` (`Currency.sol:110-118`) |
| `burn(from, id, amt)` | `+amt` | none; burns ERC-6909 (needs operator or allowance if `from != msg.sender`) | `ERC6909Claims._burnFrom` (`ERC6909Claims.sol:13-22`) |
| `clear(c, amt)` | `-amt` | none | Forfeits a **positive** delta; `amt` must equal it exactly (`MustClearExactPositiveDelta`, `:310-319`) |

- Deltas live in transient storage: `slot = keccak256(target, currency)` (`CurrencyDelta.sol:10-41`).
- `NonzeroDeltaCount` counts non-zero (target, currency) pairs (`NonzeroDeltaCount.sol:9-34`, `PoolManager.sol:368-378`).
- `unlock` reverts `CurrencyNotSettled` unless the count is 0 (`:112`).
- Intermediate non-zero deltas are fine, which is why the hook can `mint` or `settle` before its `hookDelta` is booked.
- Readers: `TransientStateLibrary.currencyDelta(manager, target, currency)` (`TransientStateLibrary.sol:35-43`), `getNonzeroDeltaCount`, `getSyncedCurrency`, `isUnlocked`.

### 3.2 Canonical patterns in the code base

**(a) v4-core `CustomCurveHook` (1:1 line), ERC20 take/settle** (`v4-core/src/test/CustomCurveHook.sol:33-49`):
```solidity
manager.take(inputCurrency, address(this), amount);                 // ERC20 OUT of the PM, before the swapper paid!
outputCurrency.settle(manager, address(this), amount, false);        // sync + transfer + settle
BeforeSwapDelta hookDelta = toBeforeSwapDelta(int128(-params.amountSpecified), int128(params.amountSpecified));
```
- This works in the v4-core test only because `initializeManagerRoutersAndPoolsWithLiq` seeds the PM with those tokens.
- The official docs say: "Using `poolManager.take()` requires an ERC20 balance on the PoolManager … If the `.take()` amount exceeds the ERC20 balance, the code will revert. As a workaround, use … `poolManager.mint()` to obtain ERC6909" (developers.uniswap.org, *Custom Accounting*, step 2.2 note).
- For our **YES input** (a sell), the PM usually holds **zero** YES, so `take(YES)` would revert. **Do not use `take` for inputs.**

**(b) v4-core `DeltaReturningHook`** (`src/test/DeltaReturningHook.sol:47-99`). This is a generic "settle or take according to the sign" helper for arbitrary specified and unspecified deltas. Rule: a positive delta means the hook takes, a negative delta means it settles.

**(c) OZ `BaseCustomCurve._beforeSwap`, using ERC-6909 claims** (`oz-uniswap-hooks/src/base/BaseCustomCurve.sol:90-156`):
```solidity
if (exactInput) {
    specified.take(poolManager, address(this), specifiedAmount, true);      // claims=true -> PM.mint(hook, id, amt)
    unspecified.settle(poolManager, address(this), unspecifiedAmount, true); // burn=true  -> PM.burn(hook, id, amt)
    returnDelta = toBeforeSwapDelta(specifiedAmount.toInt128(), -unspecifiedAmount.toInt128());
} else {
    unspecified.take(poolManager, address(this), unspecifiedAmount, true);
    specified.settle(poolManager, address(this), specifiedAmount, true);
    returnDelta = toBeforeSwapDelta(-specifiedAmount.toInt128(), unspecifiedAmount.toInt128());
}
```
LP funds are converted into hook-owned ERC-6909 claims at deposit time (`unlockCallback`, `:186-249`: user ERC20 → `settle`, then `take(..., claims=true)`).

**(d) OZ `BaseAsyncSwap`** (`src/base/BaseAsyncSwap.sol:58-94`). Exact-in only. It mints claims for the full input and returns `toBeforeSwapDelta(specifiedAmount, 0)`, so the swapper receives nothing now. Its warning at `:36-39` also applies to us: "claim tokens … are keyed by currency with no pool component, so a hook serving multiple pools must key its own accounting by `PoolId`".

**(e) Uniswap Labs `SettlementLib`** (`v4-hooks-public/src/alf/libraries/SettlementLib.sol:55-83`) resolves by net delta:
```solidity
int256 delta = poolManager.currencyDelta(address(this), currency);
if (delta < 0) { poolManager.sync(currency); currency.transfer(address(poolManager), owed); poolManager.settle(); }
else if (delta > 0) { poolManager.mint(address(this), currency.toId(), uint256(delta)); } // "swapper has not settled yet, so mint ERC-6909 claims rather than calling take"
```

**(f) Uniswap aggregator hooks** (`v4-hooks-public/src/aggregator-hooks/BaseAggregatorHook.sol:137-220`). They obtain the output externally, settle it into the PM (sync/send/settle), return `toBeforeSwapDelta(-amountSpecified, ±unspecified)`, and emit `HookSwap`. For exact-out they set `specified = -amountOut` from what was actually obtained.

### 3.3 Recommended pattern for our hook

- **(a) Receive USDC from the swapper** (a buy). In `beforeSwap`, call `poolManager.mint(address(this), USDC.toId(), amountIn)`. The hook's USDC delta goes to −in, then `hookDelta` adds +in, giving 0. The swapper's router later settles its −in by transferring USDC. Net result: the PM holds `amountIn` more USDC and the hook holds `amountIn` more USDC claims. That is the premium, credited to the LP vault ledger.
- **(b) Deliver a YES that the hook mints.**
  - **Preferred:** `poolManager.sync(YES); YES.mint(address(poolManager), amountOut); poolManager.settle();`. The hook's YES delta goes to +out, then `hookDelta` adds −out, giving 0. The router then `take`s `amountOut` YES, which the PM physically holds. This is one ERC20 mint straight into the PM; no hook-held ERC20 hop is needed.
  - Alternative (c): mint to the hook, then `transfer` to the PM. Same result, with an extra SSTORE pair and more gas.
  - Alternative (d): keep YES **inventory as ERC-6909 claims** (for example the claims received from sells in case C/D). Then call `poolManager.burn(hook, YES.toId(), amountOut)`, which needs no `sync` and no ERC20 call. This nets inventory, so outstanding YES liability = `YES.totalSupply() − hookYesClaims`.
- **(e) Pay USDC out** (a sell): `poolManager.burn(address(this), USDC.toId(), amountOut)` from the collateral claims.
- **(f) Receive YES** (a sell): `poolManager.mint(address(this), YES.toId(), amountIn)`. The hook now owns YES claims. They can be reused as inventory, or redeemed in a later hook-initiated unlock (`burn` claims → `take` YES → `YES.burn`).

Sketch (illustrative, not compiled):

```solidity
function _beforeSwap(address, PoolKey calldata key, SwapParams calldata p, bytes calldata)
    internal override returns (bytes4, BeforeSwapDelta, uint24)
{
    Market storage m = _marketOf(key.toId());             // revert UnknownPool / MarketClosed
    bool exactIn = p.amountSpecified < 0;
    (Currency input, Currency output) = p.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
    uint256 amt = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);
    bool buying = Currency.unwrap(output) == m.outcomeToken;
    uint256 px = buying ? _askWad(m) : _bidWad(m);         // USDC per outcome token, 1e18 fixed point
    uint256 amtIn; uint256 amtOut;
    if (exactIn) { amtIn = amt;  amtOut = buying ? FullMath.mulDiv(amt, 1e18, px) : FullMath.mulDiv(amt, px, 1e18); }
    else         { amtOut = amt; amtIn  = buying ? FullMath.mulDivRoundingUp(amt, px, 1e18) : FullMath.mulDivRoundingUp(amt, 1e18, px); }
    // effects (internal ledgers: collateral, liabilities) BEFORE interactions
    poolManager.mint(address(this), input.toId(), amtIn);                 // credit on input -> ERC-6909
    if (buying) { poolManager.sync(output); IOutcome(Currency.unwrap(output)).mint(address(poolManager), amtOut); poolManager.settle(); }
    else        { poolManager.burn(address(this), output.toId(), amtOut); } // pay USDC from collateral claims
    BeforeSwapDelta d = exactIn ? toBeforeSwapDelta(amtIn.toInt128(), -amtOut.toInt128())
                                : toBeforeSwapDelta(-amtOut.toInt128(), amtIn.toInt128());
    emit HookSwap(...);
    return (IHooks.beforeSwap.selector, d, 0);
}
```

### 3.4 `sync` caveats

- `sync` overwrites the single transient "synced currency" slot. A `settle()` from anyone resets it (`PoolManager.sol:361`).
- Standard routers do `sync → transfer → settle` atomically **after** `swap`. That includes V4Router `DeltaResolver._settle` (`v4-periphery/src/base/DeltaResolver.sol:38-48`), `PoolSwapTest` and v4-core `CurrencySettler`. So the hook's own `sync/settle` inside `beforeSwap` cannot interfere with them.
- A contrived caller that did `sync(USDC)` **before** `swap` and then transferred and settled afterwards would have its `settle` misattributed. It would fail closed with `CurrencyNotSettled`.
- Using the claims-inventory path (3.3d) avoids `sync` entirely.

---

## 4. OpenZeppelin `uniswap-hooks`

- **Package and tags.** Package `@openzeppelin/uniswap-hooks` `1.2.2` on `master` (`80bd724`, 2026-09-24). The latest **tag** is `v1.2.1` (`acbd604`, 2025-11-27).
- **master vs v1.2.1.** master has audit-remediation changes in `src/base` (labels such as `N-05`, `M-15` and `L-05` in commit messages, 2026-09-24):
  - `BaseHook.onlyValidPools` added;
  - `BaseCustomCurve.unlockCallback` reordered to "settle both currencies before taking either";
  - the `HookSwap` fee reported in the unspecified currency.
- **Other facts.** License MIT (`LICENSE`). `pragma solidity ^0.8.26`. `foundry.toml`: `solc = "0.8.26"`, `evm_version = "cancun"`, `ffi = true`, optimizer 200 runs. Audits in `audits/`: v1.0.0 RC1, v1.1.0 RC1 and RC2. Install with `forge install OpenZeppelin/uniswap-hooks` and remap `@openzeppelin/uniswap-hooks/=lib/uniswap-hooks/src/`. The README also warns "Hardhat not supported".

### 4.1 `BaseHook` (`src/base/BaseHook.sol`)

- `IPoolManager public immutable poolManager`.
- Errors: `HookNotImplemented()`, `NotPoolManager()`, `InvalidPool()`.
- Constructor: `constructor(IPoolManager)` calls `_validateHookAddress(this)` → `Hooks.validateHookPermissions` (`:54-57, 90-92`).
- `modifier onlyPoolManager` (`:62-65`), `modifier onlyValidPools(IHooks hooks)` (`:73-76`).
- `function getHookPermissions() public pure virtual returns (Hooks.Permissions memory)`.
- All 10 external IHooks entry points are `onlyPoolManager`. Each forwards to an `internal virtual _xxx` that reverts `HookNotImplemented` by default. Overridable internals:
  - `_beforeInitialize(address,PoolKey,uint160) → bytes4`
  - `_afterInitialize(address,PoolKey,uint160,int24) → bytes4`
  - `_beforeAddLiquidity` / `_beforeRemoveLiquidity(address,PoolKey,ModifyLiquidityParams,bytes) → bytes4`
  - `_afterAddLiquidity` / `_afterRemoveLiquidity(... ,BalanceDelta,BalanceDelta,bytes) → (bytes4, BalanceDelta)`
  - `_beforeSwap(address,PoolKey,SwapParams,bytes) → (bytes4, BeforeSwapDelta, uint24)`
  - `_afterSwap(address,PoolKey,SwapParams,BalanceDelta,bytes) → (bytes4, int128)`
  - `_beforeDonate` / `_afterDonate(address,PoolKey,uint256,uint256,bytes) → bytes4`

### 4.2 `BaseCustomAccounting` (`src/base/BaseCustomAccounting.sol`)

- Declaration: `abstract contract BaseCustomAccounting is BaseHook, IHookEvents, IUnlockCallback`.
- Errors: `ExpiredPastDeadline`, `PoolNotInitialized`, `TooMuchSlippage`, `LiquidityOnlyViaHook`, `InvalidNativeValue`, `AlreadyInitialized`.
- Structs:
  - `AddLiquidityParams{amount0Desired, amount1Desired, amount0Min, amount1Min, deadline, tickLower, tickUpper, userInputSalt}`
  - `RemoveLiquidityParams{liquidity, amount0Min, amount1Min, deadline, tickLower, tickUpper, userInputSalt}`
  - `CallbackData{sender, ModifyLiquidityParams params}`
- **Single pool.** `PoolKey private _poolKey`. `_beforeInitialize` stores it and reverts `AlreadyInitialized` on a second pool (`:337-345`). Its warning says initialization is permissionless and can be front-run.
- Public functions:
  - `addLiquidity(AddLiquidityParams) payable → BalanceDelta` (`:141-185`)
  - `removeLiquidity(RemoveLiquidityParams) → BalanceDelta` (`:196-222`)
  - `poolKey() view`
  - `unlockCallback(bytes)` (`:249-307`): it runs `PM.modifyLiquidity` on a real CL position whose salt is `keccak(sender, salt)`, then settles and takes.
- `_beforeAddLiquidity` and `_beforeRemoveLiquidity` revert `LiquidityOnlyViaHook` (`:350-369`), which blocks direct PM liquidity.
- Abstract functions:
  - `_getAddLiquidity(uint160 sqrtPriceX96, AddLiquidityParams) → (bytes modify, uint256 shares)`
  - `_getRemoveLiquidity(RemoveLiquidityParams) → (bytes, uint256 shares)`
  - `_mint(AddLiquidityParams, BalanceDelta callerDelta, BalanceDelta feesAccrued, uint256 shares)`
  - `_burn(RemoveLiquidityParams, BalanceDelta, BalanceDelta, uint256 shares)`
  - `_handleAccruedFees` (virtual)
- Permissions: beforeInitialize, beforeAddLiquidity, beforeRemoveLiquidity (`:444-461`).
- Its own warning: the share supply is stale during a modification, because `_mint`/`_burn` run after `unlockCallback`.

### 4.3 `BaseCustomCurve is BaseCustomAccounting` (`src/base/BaseCustomCurve.sol`)

- It overrides `_getAddLiquidity`/`_getRemoveLiquidity` to encode `(int128 amount0, int128 amount1)` and `_modifyLiquidity` to `unlock` with `CallbackDataCustom{sender, amount0, amount1}`.
- Its `unlockCallback` (`:186-249`) moves user ERC20 into the PM and mints **ERC-6909 claims to the hook** (deposit), or burns claims and `take`s to the user (withdraw). It returns `(toBalanceDelta(-a0, -a1), ZERO)`.
- `_beforeSwap` is shown in §3.2(c). It **emits `HookSwap`** (`:133-153`).
- Abstract functions:
  - `_getUnspecifiedAmount(SwapParams calldata) internal virtual returns (uint256 unspecifiedAmount)`: the output for exact-in or the input for exact-out, **including** any fee (`:258`).
  - `_getSwapFeeAmount(SwapParams calldata, uint256 unspecifiedAmount) → uint256`: **only reported in the event, not applied** (`:274-277`).
  - `_getAmountOut(RemoveLiquidityParams) → (amount0, amount1, shares)` (`:285-288`).
  - `_getAmountIn(AddLiquidityParams) → (amount0, amount1, shares)` (`:296-299`).
- The share accounting is the implementer's choice. The mock pro-rates against claim reserves: `_reserve(c) = poolManager.balanceOf(address(this), c.toId())` (`src/mocks/base/BaseCustomCurveMock.sol:70-115`).
- Permissions = `0x2A88` (`:307-324`).

### 4.4 Other bases

- `BaseAsyncSwap` (§3.2d).
- `fee/`:
  - `BaseDynamicFee` sets the fee via `poolManager.updateDynamicLPFee`;
  - `BaseOverrideFee` returns the override fee from `beforeSwap`;
  - `BaseDynamicAfterFee` and `BaseHookFee` take hook fees through return deltas.
- `general/`: `AntiSandwichHook`, `LimitOrderHook`, `LiquidityPenaltyHook`, `ReHypothecationHook`.
- `utils/CurrencySettler` (§3.1 semantics). Note the early `return` when `amount == 0`, and the `InvalidNativePayer` guard.
- `interfaces/IHookEvents`:
  ```solidity
  event HookSwap(bytes32 indexed poolId, address indexed sender, int128 amount0, int128 amount1, uint128 hookLPfeeAmount0, uint128 hookLPfeeAmount1);
  event HookFee(bytes32 indexed poolId, address indexed sender, uint128 feeAmount0, uint128 feeAmount1);
  event HookModifyLiquidity(bytes32 indexed poolId, address indexed sender, int128 amount0, int128 amount1);
  event HookBonus(bytes32 indexed poolId, uint128 amount0, uint128 amount1);
  ```
  For `HookSwap`, amounts are positive for input and negative for output. Uniswap's aggregator hooks use a **different** signature: `HookSwap(PoolId indexed, address indexed, int256 amount0, int256 amount1, uint24 swapFee)` (`v4-hooks-public/src/aggregator-hooks/interfaces/IAggregatorHook.sol:15`). UNVERIFIED which one Uniswap's indexers consume.

### 4.5 `oracles/`

- `oracles/panoptic/BaseOracleHook.sol` (190 lines).
  - Permissions: afterInitialize and beforeSwap.
  - It keeps `Oracle.Observation[65535]` per `PoolId`. `_beforeSwap` writes the **pre-swap** tick (`:114-137`).
  - `observe(uint32[] secondsAgos, PoolId)` returns `(tickCumulatives, truncatedTickCumulatives)`. The truncated version uses `MAX_ABS_TICK_DELTA`.
  - `increaseObservationCardinalityNext`.
- `OracleHookWithV3Adapters.sol`, plus `adapters/V3OracleAdapter.sol` and `V3TruncatedOracleAdapter.sol` (v3-style `observe` for legacy consumers).
- `libraries/Oracle.sol` (340 lines).
- **Limitation for us:** it records only the pool **the hook is attached to**. It cannot observe the existing canonical ETH/USDC pools, which have `hooks = 0`.

### 4.6 Verdict

- **Inherit `BaseHook`**, or the MIT `v4-hooks-public/src/base/BaseHook.sol`.
- **Do not inherit `BaseCustomAccounting`/`BaseCustomCurve`**, because:
  - they bind to one PoolKey, and we need one shared hook for many markets and pools;
  - their LP model deposits both pool currencies, while ours is USDC-only collateral;
  - their swap path assumes the hook already holds claims of the output currency, whereas we mint the outcome token.
- **Reuse** their `_beforeSwap` delta and claims structure, the `HookSwap` event, the `LiquidityOnlyViaHook` guard, and the "effects before interactions" advice from `CurrencySettler`.

---

## 5. Reading another pool's state from inside the hook

### 5.1 `StateLibrary` (`v4-core/src/libraries/StateLibrary.sol`)

```solidity
bytes32 public constant POOLS_SLOT = bytes32(uint256(6));   // mapping(PoolId => Pool.State) _pools
uint256 public constant LIQUIDITY_OFFSET = 3;               // Pool.State: slot0, feeGrowthGlobal0X128, feeGrowthGlobal1X128, liquidity, ticks, tickBitmap, positions
function getSlot0(IPoolManager manager, PoolId poolId) internal view
    returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) {
    bytes32 data = manager.extsload(keccak256(abi.encodePacked(PoolId.unwrap(poolId), POOLS_SLOT)));
    // | 24 bits lpFee | 24 bits protocolFee | 24 bits tick | 160 bits sqrtPriceX96 |
    assembly { sqrtPriceX96 := and(data, 0xFFFF...FF /*160*/) tick := signextend(2, shr(160, data))
               protocolFee := and(shr(184, data), 0xFFFFFF) lpFee := and(shr(208, data), 0xFFFFFF) }
}
function getLiquidity(IPoolManager manager, PoolId poolId) internal view returns (uint128); // stateSlot + 3
```

Sources: `:10-28, 40-63, 183-191, 324-326`. `PoolId = keccak256(abi.encode(PoolKey))`, a 0xa0-byte struct (`PoolId.sol:11-15`).

### 5.2 `extsload` and `exttload`

- `Extsload` (`v4-core/src/Extsload.sol:10-63`) is a plain `view` function with **no lock check**. You can call it at any time, including from inside our `beforeSwap` while the PM is unlocked.
- It returns the **current** in-transaction state. Any earlier swap in the same transaction or the same `unlock` is already reflected, so it can be manipulated.
- `Exttload` does the same for transient slots.
- Gas, from the v4-core snapshot `snapshots/StateLibraryTest.json`:
  - `extsload getSlot0` = **2,375**
  - `getLiquidity` = 2,375
  - `getTickInfo` = 6,949
- That is about one cold SLOAD (2,100) plus a warm CALL. From a hook the PM is already warm, so expect about 2.4k gas per cold slot.
- `StateView` (periphery lens, `v4-periphery/src/lens/StateView.sol:19-110`) wraps the same reads for **off-chain** use (`getSlot0(PoolId)`, `getLiquidity(PoolId)`, …). On-chain, use `StateLibrary` directly; it saves a call.

### 5.3 From `sqrtPriceX96` to a USDC-per-ETH price

For the canonical pool `(currency0 = native ETH address(0), currency1 = USDC)`:

`S = (sqrtPriceX96 / 2^96)^2 · 10^(18−6)` USDC per ETH.

On-chain, use `FullMath.mulDiv(FullMath.mulDiv(sqrtP, sqrtP, 2^96), 10^12 · 10^18, 2^96)` for a WAD result. The log-return between two observations is exactly `(tick₂ − tick₁)·ln(1.0001)`, with ≤1 tick quantization. That is useful for a Uniswap-native realized-volatility estimate built from ticks.

### 5.4 Live ETH/USDC v4 pools (queried 2026-09-25 via each chain's StateView)

All pools use `hooks = address(0)`. Pool ids were computed with `keccak256(abi.encode(0x0, USDC, fee, tickSpacing, 0x0))`.

| Chain (block) | fee / tickSpacing | PoolId | sqrtPriceX96 | tick | L | protocolFee raw (0→1 / 1→0 pips) | ETH ≈ |
|---|---|---|---|---|---|---|---|
| Ethereum (26,054,869) | 100 / 1 | `0x00b9edc1583bf6ef09ff3a09f6c23ecb57fd7d0bb75625717ec81eed181e22d7` | 4109885895008202758516487 | −197344 | 2.06e16 | 102425 (25/25) | $2,690.9 |
| Ethereum | **500 / 10** | **`0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27`** | 4108033932007197530849134 | −197353 | 1.71e17 | 512125 (125/125) | $2,688.5 |
| Ethereum | 3000 / 60 | `0xdce6394339af00981949f5f3baf27e3610c76326a700af57e4b3e3ae4977f78d` | 4108859557830086018266729 | −197349 | 3.05e18 | 2048500 (500/500) | $2,689.6 |
| Ethereum | 10000 / 200 | `0xd934712639fede326a3ff8d2a9c2f73749bac510c23fb33443cea7f3c9aca6f3` | 4130729916199723849437627 | −197243 | 1.6e13 | 4097000 (1000/1000) | $2,718 (stale) |
| Base (51,777,394) | 100 / 1 | `0xe87077fd043c1a6afa5256104acb1d1eb5ca5bc031ee57f9d96c8172ead4bef8` | … | −197355 | 5.8e13 | 102425 | $2,688.1 |
| Base | 500 / 10 | `0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a` | … | −197357 | 4.77e16 | 512125 | $2,687.5 |
| Base | 3000/60, 10000/200 | `0xe070797535b13431808f8fc81fdbe7b41362960ed0b55bc2b6117c49c51b7eb9`, `0xa7d23af8df40bfaa36d3635aa84475d53f635b1fdf42a99d3cd40bad59190100` | not queried (RPC rate-limited) | | | | |
| Arbitrum (508,781,029) | 500 / 10 | `0x864abca0a6202dba5b8868772308da953ff125b0f95015adbf89aaf579e903a8` | … | −197357 | 6.57e17 | 512125 | $2,687.5 |
| Arbitrum | 3000 / 60 | `0x03df2300e83353309c1069ae3ea89c31b361a009f9c36a1de5c8f0afcc45bde8` | … | −197351 | 2.33e17 | 2048500 | $2,689.0 |
| Arbitrum | 100/1, 10000/200 | `0x19235486bda85a935bed1024abfc40ed02cd3fb14b43ced1f644b74c9398451a`, `0xec71296a7e90eab1c659c93b5ed332747396f7d73ac5fec8c5559755ebdc63d4` | … | | 1.07e13 / 3.4e14 | | |
| Unichain (59,595,778) | 500 / 10 | `0x3258f413c7a88cda2fa8709a589d221a80f6574f63df5a5b6774485d8acc39d9` | … | −197358 | 1.43e17 | 0 | $2,687.2 |
| Unichain | 3000 / 60 | `0x25939956ef14a098d95051d86c75890cfd623a9eeba055e46d8dd9135980b37c` | … | −197352 | 8.68e16 | 0 | $2,688.7 |
| Unichain | 100/1, 10000/200 | `0x9bdd72519ad7e2b5f0d5441d7af389771cc04a8406cd577fac0c68a8b6b396bd`, `0x20947aa58635c1073943adb739ee56de8bc68376791dc3a2ca7e9ff2a75d90a0` | … | | 1.1e13 / 1.3e12 | 0 | |

Other on-chain facts:
- Uniswap v3 USDC/WETH 0.05% (`0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640`) has `observationCardinality = 723` (tick 197312 at draft time; re-checked 197349 with cardinality 723). That is an alternative TWAP source with `observe()`. **[ADDED]** At most one observation is written per block, and only in blocks that contain a swap. 723 slots therefore cover **at most ~723 blocks ≈ 2.4 h** on mainnet, which bounds the longest available TWAP window unless someone pays to `increaseObservationCardinalityNext`.
- The mainnet PoolManager holds **≈73.3M USDC**, so a `take(USDC)` in `beforeSwap` would not revert on mainnet. It would revert on a fresh local PoolManager.

---

## 6. Dynamic fees and protocol fees

- **`LPFeeLibrary`** (`v4-core/src/libraries/LPFeeLibrary.sol`):
  - `DYNAMIC_FEE_FLAG = 0x800000` (key.fee must equal it exactly);
  - `OVERRIDE_FEE_FLAG = 0x400000`;
  - `REMOVE_OVERRIDE_MASK = 0xBFFFFF`;
  - `MAX_LP_FEE = 1_000_000` (100%, in pips);
  - dynamic pools start at LP fee 0 (`:51-56`);
  - `PM.updateDynamicLPFee(key, fee)` may be called only by the hook, on dynamic pools (`PoolManager.sol:339-346`).
- **Relevance when fully NoOp'd.** None for pricing, because the LP fee applies only inside `Pool.swap` steps. Two side effects remain:
  - if `key.fee` is dynamic and the hook returns an override with an invalid fee, the swap reverts even on a NoOp (`Pool.sol:303-305`);
  - the `Swap` event's `fee` field shows the stored or override fee.
- **Recommendation.** Use a static `key.fee = 0` (valid). Put all economics (spread, fees) into the hook's price. Report them in `HookSwap`/`HookFee`.
- **Protocol fees.** Core charges them only on the CL-swapped amount (`Pool.sol:385-398`). On a full NoOp, `amountToProtocol = 0` (`:320`). So PM-level protocol fees never touch hook-priced volume. The controller *can* still set `slot0.protocolFee` for our pool (`ProtocolFees.sol:35-42`), but it would have no effect.
- **UNIfication and the v4 fee switch.**
  - Governance Proposal 100 activated v4 protocol fees on 2026-07-27. Scope: "static fee pools without hooks, continuous clearing auction pools, and aggregator hook pools" (press coverage, e.g. cryptobriefing.com).
  - Observed on-chain for ETH/USDC: 25 pips on the 1 bp tier, 125 on 5 bp, 500 on 30 bp, and 1000 on 100 bp. Unichain is 0. Decoding: `raw & 0xFFF` = zeroForOne and `raw >> 12` = oneForZero, e.g. `512125 = 125 + 125·4096`.
  - **[ADDED]** Per press coverage, the fee is **additive** for traders; core computes `swapFee = protocolFee + lpFee·(1 − protocolFee/1e6)`. It is live on Ethereum, Arbitrum, Base, BNB Chain, Polygon, OP Mainnet and Robinhood Chain. **Unichain is not in the list**, which matches the 0 observed there. For our S oracle this only changes the arbitrage band around the underlying pool slightly.
  - **[ADDED]** Aggregator hooks also implement `IFeeClassifiedHook.protocolFeeFlags()` (returns `1 << 11`; `BaseAggregatorHook.sol:91-94`, interface from the `protocol-fees` repo). That is how the fee system classifies a hook pool. UNVERIFIED whether classification is ever required of third-party hooks.
  - For **aggregator hooks** the fee is collected **by the hook itself**. `v4-hooks-public/src/aggregator-hooks/ProtocolFees.sol:45-100` reads `slot0.protocolFee`, multiplies it by `protocolFeeMultiplier = 25` (`BaseAggregatorHook.sol:37`), and `poolManager.take(unspecifiedCurrency, tokenJar, fee)`. The TokenJar comes from `IV4FeeAdapter(protocolFeeController).TOKEN_JAR()`.
  - The mainnet `protocolFeeController` is `0x89a5d5bf00a27d55c02951e49078a5c5771051db`.
  - Our hook is not obliged to do this. UNVERIFIED whether hook allowlisting (routing) will require it.

---

## 7. v4-periphery, Universal Router and test routers

### 7.1 `Actions` (`v4-periphery/src/libraries/Actions.sol:7-63`) and constants

| Action | Code | Action | Code |
|---|---|---|---|
| INCREASE_LIQUIDITY | 0x00 | SETTLE | 0x0b |
| DECREASE_LIQUIDITY | 0x01 | SETTLE_ALL | 0x0c |
| MINT_POSITION | 0x02 | SETTLE_PAIR | 0x0d |
| BURN_POSITION | 0x03 | TAKE | 0x0e |
| INCREASE_LIQUIDITY_FROM_DELTAS | 0x04 (deprecated) | TAKE_ALL | 0x0f |
| MINT_POSITION_FROM_DELTAS | 0x05 (deprecated) | TAKE_PORTION | 0x10 |
| SWAP_EXACT_IN_SINGLE | 0x06 | TAKE_PAIR | 0x11 |
| SWAP_EXACT_IN | 0x07 | CLOSE_CURRENCY 0x12, CLEAR_OR_TAKE 0x13, SWEEP 0x14 | |
| SWAP_EXACT_OUT_SINGLE | 0x08 | WRAP 0x15, UNWRAP 0x16, MINT_6909 0x17, BURN_6909 0x18 | |
| SWAP_EXACT_OUT | 0x09 | UNWIND_WITH_FALLBACK 0x19 (permissioned pools) | |
| DONATE | 0x0a | | |

`ActionConstants`: `OPEN_DELTA = 0`, `CONTRACT_BALANCE = 1<<255`, `MSG_SENDER = address(1)`, `ADDRESS_THIS = address(2)`.

### 7.2 `V4Router` (`v4-periphery/src/V4Router.sol`)

- `_swapExactInputSingle` (`:84-100`) calls `_swap(key, zeroForOne, -amountIn, hookData)`. It reads `amountOut` from the returned delta and checks `amountOutMinimum` and the optional `minHopPriceX36`.
- `_swapExactOutputSingle` (`:136-156`) reverts `V4ExactOutputUnfilled` if the delivered amount is below `amountOut`. This was added in `545a5d2` (2026-08-03). It then checks `amountInMaximum`.
- `_swap` (`:205-219`) calls `poolManager.swap(poolKey, SwapParams(zeroForOne, amountSpecified, zeroForOne ? MIN_SQRT_PRICE+1 : MAX_SQRT_PRICE-1), hookData)`.
- `SETTLE_ALL(currency, maxAmount)` → `_getFullDebt` → `_settle(currency, msgSender(), amount)`. `TAKE_ALL(currency, minAmount)` → `_getFullCredit` → `_take(currency, msgSender(), amount)` (`:55-66`). Both read the **router's** PM delta, which already includes our hook's delta.
- **Struct versions:**
  - Current: `ExactInputSingleParams { PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; uint256 minHopPriceX36; bytes hookData; }` (`IV4Router.sol:31-38`). `minHopPriceX36` was added to singles in `03b2d09` (2026-03-17); multi-hop got it in `3779387` (2025-11-05).
  - The docs example and the original 2025 deployments (UR "v2.0", e.g. mainnet `0x66a9…`) use the 5-field struct **without** `minHopPriceX36`.
  - **[CORRECTED]** UR `main` (`a9c574f`) pins periphery **`a7af5b3` (2026-09-16)**, not `9dafaae`. That commit contains the 6-field struct (`03b2d09`) and the exact-out partial-fill revert (`545a5d2`). UNVERIFIED exactly which deployed UR version (2.1.1 vs 2.1.2) first uses the 6-field struct. **Encoding must match the router you target.**
  - **[ADDED]** Exact-out semantics in current V4Router (`:136-156`):
    - under-delivery reverts `V4ExactOutputUnfilled`;
    - **over-delivery is allowed** ("possible only via hook pools");
    - the input is read by `_swapInput`, which negates the caller's input delta and `toUint128`s it. A hook-*funded* input (positive caller delta on the input side) therefore reverts. Commit `bbd4346` briefly tolerated this and was reverted by `a7af5b3` (#601).

    Our hook always charges a positive input and delivers exactly the requested output, so none of this bites.

### 7.3 `V4Quoter` (`v4-periphery/src/lens/V4Quoter.sol`, `src/base/BaseV4Quoter.sol`)

- It simulates by `unlock` → `swap` → revert with the amount (`QuoterRevert`).
- API: `quoteExactInputSingle(QuoteExactSingleParams{poolKey, zeroForOne, exactAmount, hookData}) → (amountOut, gasEstimate)`, and likewise for exact-out and multi-hop.
- **It works for custom-accounting hooks**, because the whole hook path executes and then rolls back. That includes `mint`, `sync/settle` and the YES mint.
- Hard requirement (`BaseV4Quoter.sol:53-57`):
  ```solidity
  int128 amountSpecifiedActual = (zeroForOne == (amountSpecified < 0)) ? swapDelta.amount0() : swapDelta.amount1();
  if (amountSpecifiedActual != amountSpecified) revert NotEnoughLiquidity(poolKey.toId());
  ```
  So the hook must fill the specified side exactly.
- `sender` seen by the hook is the quoter. `V4Quoter.msgSender()` returns the original caller (`:154-157`).
- Quotes can differ from execution. `T` shrinks with `block.timestamp`, and S and σ move, so always set slippage limits.

### 7.4 Universal Router (`universal-router/contracts/…`)

- `Commands.V4_SWAP = 0x10`, `V4_INITIALIZE_POOL = 0x13`, `V4_POSITION_MANAGER_CALL = 0x14` (`libraries/Commands.sol:35-39`).
- `Dispatcher` (`:282-284`): `if (command == Commands.V4_SWAP) _executeActions(inputs);` → `BaseActionsRouter` → `PM.unlock`.
- `V4SwapRouter is PermissionedV4Router, Permit2Payments` (`modules/uniswap/v4/V4SwapRouter.sol:17-35`). It pays via Permit2 (`payOrPermit2Transfer`).
- `PermissionedV4Router._validatePoolKey` rejects only pools whose currency is a *verified permissions adapter* (`v4-periphery/src/hooks/permissionedPools/PermissionedV4Router.sol:32-42`). **Ordinary hook pools pass.**
- `Dispatcher.msgSender()` returns the locker, i.e. the EOA (`:47-49`).

**Buying YES with standard encoding.** This is the same as the docs' `swapExactInputSingle` example, pointed at our PoolKey:

```solidity
bytes memory commands = abi.encodePacked(uint8(Commands.V4_SWAP));                         // 0x10
bytes memory actions  = abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL)); // 06 0c 0f
bytes[] memory params = new bytes[](3);
params[0] = abi.encode(IV4Router.ExactInputSingleParams({
    poolKey: yesUsdcKey /* {YES, USDC, fee:0, tickSpacing, hooks: PredictionHook} */,
    zeroForOne: false /* USDC(currency1) -> YES(currency0) */, amountIn: 100e6, amountOutMinimum: minYes,
    minHopPriceX36: 0 /* omit for UR v2.0 */, hookData: "" }));
params[1] = abi.encode(USDC, uint256(100e6));   // SETTLE_ALL(currency, maxAmount)
params[2] = abi.encode(YES,  uint256(minYes));  // TAKE_ALL(currency, minAmount)
bytes[] memory inputs = new bytes[](1); inputs[0] = abi.encode(actions, params);
// once: USDC.approve(PERMIT2, max); IPermit2(PERMIT2).approve(USDC, UR, amount, expiration);
IUniversalRouter(UR).execute(commands, inputs, block.timestamp + 60);
```

So **yes**, any user or integrator who knows the PoolKey can buy YES through UR with no custom code.

The Uniswap **interface and routing API** will not discover the pool automatically:
- hooked pools need allowlisting through Uniswap's hook allowlisting form (*Integrated Routing with UniswapX*);
- the alternative is running a UniswapX filler.

### 7.5 `PositionManager`

`v4-periphery/src/PositionManager.sol`:
- `modifyLiquidities(bytes unlockData, uint256 deadline)` (`:172`);
- `modifyLiquiditiesWithoutUnlock` (`:182`);
- `msgSender()` (`:191`);
- action handler `:195-287`.

It is irrelevant for our hook-priced pools, where liquidity is blocked. It is useful in tests to seed a mock ETH/USDC underlying pool. v4-template's `EasyPosm` gives `mint/increaseLiquidity/decreaseLiquidity/collect/burn` helpers (`test/utils/libraries/EasyPosm.sol:31-195`).

### 7.6 v4-core test routers (`v4-core/src/test/`)

- **`PoolSwapTest.swap(key, params, TestSettings{takeClaims, settleUsingBurn}, hookData)`** (`PoolSwapTest.sol:35-116`):
  - It asserts that the router's pre-deltas are 0 and that the post-deltas are consistent with direction and type. For exact-in, `delta.amount_in == deltaAfter_in`; for exact-out, `delta.amount_out == deltaAfter_out`, among others.
  - It then settles negatives (`sync` + `transferFrom` + `settle`, or `burn`) and takes positives (`take` or `mint`).
  - Our hook's deltas satisfy these checks, as the CustomCurve tests show.
- `PoolModifyLiquidityTest`, `SwapRouterNoChecks`, `PoolDonateTest`, `PoolTakeTest`, `PoolClaimsTest`, `PoolNestedActionsTest`, `ActionsRouter`.
- `Deployers` (`test/utils/Deployers.sol`):
  - `deployFreshManagerAndRouters()` (`:91-105`), `deployMintAndApprove2Currencies()` (`:109-116`), `initPool`, `initPoolAndAddLiquidity`, `swap(key, zeroForOne, amountSpecified, hookData)` (`:214-234`);
  - constants `MIN_PRICE_LIMIT = MIN_SQRT_PRICE+1`, `MAX_PRICE_LIMIT = MAX_SQRT_PRICE−1`, `SQRT_PRICE_1_1 = 2^96 = 79228162514264337593543950336` (`Constants.sol:7`).
- Periphery test helpers:
  - `test/mocks/MockV4Router.sol` is a concrete `V4Router` with `executeActions(bytes)` and `msgSender()`. **Copy it to exercise real V4Router encoding locally.**
  - `test/shared/Planner.sol` builds action plans.
  - `test/shared/Deploy.sol` has deploy helpers for `v4Quoter`, `stateView` and others.
- Gas references from v4-core snapshots:
  - `"swap CA custom curve + swap noop": 124402`;
  - `"simple swap": 123144`;
  - `"swap with hooks": 132165`.

  Each includes the router and ERC20 transfers (`snapshots/CustomAccountingTest.json`, `PoolManagerTest.json`).

---

## 8. Pitfalls checklist

1. **Initialization.**
   - A pool must be initialized with a valid `sqrtPriceX96`, even though it is unused.
   - `tickSpacing` must be in `[1, 32767]`, `currency0 < currency1`, and the fee ≤ 1e6 or exactly `0x800000`.
   - Initialization is **permissionless**; anyone can `initialize` a pool with our hook address and arbitrary currencies. **Mitigation:** `_beforeInitialize` always reverts, and the hook's own `createMarket()` calls `poolManager.initialize(...)`. Because of `noSelfCall` (`Hooks.sol:171-182`), the hook's callback is skipped for self-initiated calls. `v4-hooks-public/src/alf/base/SpreadQuoterBase.sol:105-122` does exactly this: "routes through `poolManager.initialize` so v4's `Hooks.noSelfCall` exempts the call from `_beforeInitialize`'s revert".
   - Also resolve `PoolId → Market` in `beforeSwap` and revert for unknown pools (defense in depth).
2. **Blocking CL liquidity.** Revert in `_beforeAddLiquidity`, as in `BaseCustomAccounting.sol:350-357` and `BaseAggregatorHook.sol:128-135`.
   - Any CL liquidity is never used by NoOp swaps. It could only confuse integrators, or be traded against on a partial fill.
   - `donate` already reverts with 0 liquidity (`NoLiquidityToReceiveFees`, `Pool.sol:466-468`).
   - `modifyLiquidity` with delta 0 (a "poke") goes through the *remove* path (`Hooks.sol:203`).
3. **Hook flags.** A missing `BEFORE_SWAP_RETURNS_DELTA` means the delta is silently ignored and the transaction reverts `CurrencyNotSettled`. Extra bits mean `HookAddressNotValid`. Verify the mined address in deployment scripts.
4. **Reentrancy and what the hook may call during a callback.** The PM is unlocked, so the hook may call `swap` and `modifyLiquidity` on **other** pools (for example, delta-hedging on ETH/USDC), plus `donate`, `take`, `settle`, `settleFor`, `mint`, `burn`, `clear`, `sync`, `initialize`, ERC-6909 transfers and `extsload`/`exttload`.
   - It may **not** call `unlock` (`AlreadyUnlocked`, `PoolManager.sol:105`).
   - Calls by the hook into its **own** pools skip its callbacks (`Hooks.sol:217, 253, 293`). A self-swap on our pool would run a raw CL swap on an empty pool, so avoid it.
   - External token calls (USDC transfer, our YES mint) run while the PM is unlocked. Follow checks-effects-interactions: update the market and vault ledgers **before** `mint`/`settle` (OZ `CurrencySettler` warning, `src/utils/CurrencySettler.sol:21-25`).
   - The hook's external callbacks must be `onlyPoolManager`; a Trail of Bits 2026 post stresses that callbacks are otherwise directly callable.
5. **`sender` semantics.**
   - `sender` is the router (UR, V4Router, PoolSwapTest, Quoter), not the trader.
   - To identify the trader, check `sender` against an allowlist and then call `IMsgSender(sender).msgSender()` (`v4-periphery/src/interfaces/IMsgSender.sol`; implemented by UR `Dispatcher.sol:47`, `PositionManager.sol:191`, `V4Quoter.sol:155`, `MockV4Router`). Alternatively, use `hookData`.
   - Never use `tx.origin`.
   - Pricing does not need the trader's identity. Only per-user caps or KYC would.
6. **Rounding.**
   - Exact-in output rounds down; exact-out input rounds up.
   - Price and amount conversions should use `FullMath.mulDiv`/`mulDivRoundingUp`.
   - Cast with `SafeCast.toInt128(uint256)` (`SafeCast.sol:56`). A plain `int128(x)` truncates silently in explicit conversions.
   - `-params.amountSpecified` must not be `type(int256).min`; checked arithmetic reverts.
7. **Full fill or revert.** Partial fills break the quoter, can walk the empty CL pool (§1.9) and trip V4Router exact-out checks. Enforce max size and exposure by **reverting**.
8. **Multi-pool claims fungibility.** ERC-6909 claim ids are per currency, not per pool. All markets' USDC collateral is one `balanceOf[hook][USDC]`, so the hook must keep per-market and per-vault ledgers (OZ `BaseAsyncSwap` warning, `:36-39`). Invariant: Σ ledgers == `poolManager.balanceOf(hook, USDC.toId())`.
9. **Oracle manipulation.** `getSlot0` of ETH/USDC reads in-transaction state. An attacker can move ETH/USDC within the same transaction or unlock (even in the same `unlock`, via multi-hop), buy mispriced YES, and swap back, paying only the pool fees. Use a TWAP or observation buffer and/or deviation bounds, both for trading and **especially for expiry settlement**.
10. **Time.** `T = expiry − block.timestamp`. As T → 0, σ√T → 0 and d2 → ±∞. Halt trading at `expiry − buffer`, and handle `T ≤ 0` explicitly.
11. **Indexing and UX.** The PM `Swap` event shows 0/0 and a frozen `sqrtPriceX96`. UIs reading `slot0` will show a meaningless price. Emit `HookSwap` and expose a `quote()`/`price()` view (compare `IALFHook.getIndicativeQuote`).
12. **Token behaviour.** YES and NO must be plain ERC20s with no transfer hooks. USDC is an upgradeable, blacklistable proxy; a blacklisted router or PM would DoS. The generic hook-security checklist (Uniswap *Security Framework*) lists fee-on-transfer, rebasing and ERC-777 tokens as hazards.
13. **Errors are wrapped.** Hook reverts surface as `WrappedError(hook, IHooks.beforeSwap.selector, reason, HookCallFailed)`. Test assertions must encode that wrapper.

---

## 9. Tooling

- **v4-template layout** (`uniswapfoundation/v4-template@1fbf955`):
  - `src/Counter.sol` (inherits OZ `BaseHook`);
  - `test/Counter.t.sol`;
  - `test/utils/{BaseTest.sol, Deployers.sol, libraries/EasyPosm.sol}`;
  - `script/{00_DeployHook, 01_CreatePoolAndAddLiquidity, 02_AddLiquidity, 03_Swap}.s.sol`, `script/base/{BaseScript, LiquidityHelpers}.sol`, `script/testing/00_DeployV4.s.sol`.
  - Its `Deployers` does **not compile** PoolManager. It deploys **precompiled bytecode** from `hookmate/artifacts` (`V4PoolManagerDeployer`, `V4PositionManagerDeployer`, `V4RouterDeployer` for hookmate's `IUniswapV4Router04`, `Permit2Deployer`) on chain 31337. On other chains it uses canonical addresses from `hookmate/constants/AddressConstants.sol` (`test/utils/Deployers.sol:60-110`). That is why its `solc_version = "0.8.30"` works despite `PoolManager.sol` pinning 0.8.26.
- **v4-template `foundry.toml`:** `bytecode_hash="none"`, `evm_version="cancun"`, `ffi=true`, `fs_permissions=[.forge-snapshots rw]`, `solc_version="0.8.30"`, `via_ir=false`.
- **v4-template remappings:**
  ```
  forge-std/=lib/forge-std/src/
  @uniswap/v4-core/=lib/uniswap-hooks/lib/v4-core/
  @uniswap/v4-periphery/=lib/uniswap-hooks/lib/v4-periphery/
  @openzeppelin/uniswap-hooks/=lib/uniswap-hooks/
  @openzeppelin/contracts/=lib/uniswap-hooks/lib/v4-core/lib/openzeppelin-contracts/contracts/
  hookmate/=lib/hookmate/src/
  permit2/=lib/uniswap-hooks/lib/v4-periphery/lib/permit2/
  solmate/=lib/uniswap-hooks/lib/v4-core/lib/solmate/
  v4-core/=lib/uniswap-hooks/lib/v4-core/            # [ADDED] also present in remappings.txt
  v4-periphery/=lib/uniswap-hooks/lib/v4-periphery/  # [ADDED]
  ```
- **v4-template dependencies:** git submodules pinned in `foundry.lock`: `forge-std 8bbcf6e`, `hookmate 33408fb`, `uniswap-hooks e59fe72`. **[CORRECTED]** That `uniswap-hooks` commit (`e59fe72`, 2025-07-10) pins `v4-core a7cf038` and `v4-periphery eeb3eff`, per `git ls-tree e59fe72 lib/`. OZ `master` (`80bd724`) pins `v4-core d153b04` and `v4-periphery 7ebd04b`.
- **Other repos' configs:**
  - v4-core: `solc 0.8.26`, `via_ir = true`, `optimizer_runs = 44444444`, `evm_version = cancun`, `ffi = true`, fuzz runs 1000, profile `debug` with `via_ir=false`.
  - v4-periphery: the same, plus `compilation_restrictions` (tests `via_ir=false`).
  - OZ hooks: `solc 0.8.26`, `cancun`, `ffi = true`, optimizer 200.
- **Recommended for our project (to confirm in the plan):**
  - `solc = "0.8.26"`, so we can compile `PoolManager`, `V4Router`, `PositionManager` and `V4Quoter` from source;
  - `evm_version = "cancun"`;
  - `via_ir = false` for tests, with an optional `via_ir` gas profile;
  - `ffi = true` for differential tests against an mpmath/scipy reference via `uv run`;
  - `fs_permissions` for fixtures;
  - fuzz and invariant sections.
- **Install:**
  ```
  forge init prediction-hook && cd prediction-hook   # or: forge init --template uniswapfoundation/v4-template
  forge install foundry-rs/forge-std Uniswap/v4-core Uniswap/v4-periphery OpenZeppelin/uniswap-hooks@v1.2.1 OpenZeppelin/openzeppelin-contracts
  ```
  - Pin exact commits; they are recorded in `foundry.lock`.
  - Suggested pins: v4-core `46c6834` or `v4.0.0` (the latter implies the old `IPoolManager.SwapParams` import path); v4-periphery `9969eec` or an older commit if `src/utils/HookMiner.sol` is wanted.
  - UNVERIFIED: exact `forge install` flag behaviour in the current stable Foundry (`--no-commit` semantics changed across versions). Foundry is **not installed** on this machine (`forge`/`cast`/`anvil` not on PATH), so install it with `foundryup`.
  - **Soldeer:** the registry has `uniswap-v4-core` version `4` (uploaded 2025-02-28) and `uniswap-v4-periphery` by commit (latest `9969eec…`, uploaded 2026-09-22, community uploads). Submodules remain the ecosystem norm (template, OZ, periphery, UR all use them).
- **Test utilities to reuse:**
  - v4-core `Deployers` (needs `solmate` MockERC20 and `forge-std`), `PoolSwapTest`, `CurrencySettler`, `Constants`, `SortTokens`, `LiquidityAmounts`;
  - periphery `MockV4Router`, `Planner`, `V4Quoter` (`new V4Quoter(manager)`);
  - template `EasyPosm`;
  - `hookmate` artifacts for bytecode-deployed canonical contracts.
- **Fork tests (optional):** `vm.createSelectFork(rpc)`, then `deployCodeTo` our hook onto the fork, create a market, and buy through the **deployed** UR 2.1.2. This is the strongest "a standard route works" evidence.

---

## 10. Deployed addresses (official: developers.uniswap.org/docs/protocols/v4/deployments, fetched 2026-09-25)

| Contract | Ethereum (1) | Unichain (130) | Base (8453) | Arbitrum One (42161) |
|---|---|---|---|---|
| PoolManager | `0x000000000004444c5dc75cB358380D2e3dE08A90` | `0x1f98400000000000000000000000000000000004` | `0x498581ff718922c3f8e6a244956af099b2652b2b` | `0x360e68faccca8ca495c1b759fd9eee466db9fb32` |
| PositionManager | `0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e` | `0x4529a01c7a0410167c5740c487a8de60232617bf` | `0x7c5f5a4bbd8fd63184577525326123b519429bdc` | `0xd88f38f930b7952f2db2432cb002e7abbf3dd869` |
| PositionDescriptor | `0xd1428ba554f4c8450b763a0b2040a4935c63f06c` | `0x9fb28449a191cd8c03a1b7abfb0f5996ecf7f722` | `0x25d093633990dc94bedeed76c8f3cdaa75f3e7d5` | `0xe2023f3fa515cf070e07fd9d51c1d236e07843f4` |
| V4Quoter | `0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203` | `0x333e3c607b141b18ff6de9f258db6e77fe7491e0` | `0x0d5e0f971ed27fbff6c2837bf31316121532048d` | `0x3972c00f7ed4885e145823eb7c655375d275a1c5` |
| StateView | `0x7ffe42c4a5deea5b0fec41c94c136cf115597227` | `0x86e8631a016f9068c3f085faf484ee3f5fdee8f2` | `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71` | `0x76fd297e2d437cd7f76d50f01afe6160f86e9990` |
| ReservesLens | `0x0000001b173C3bbF3984D417d8614E3eed34865B` | same | same | same |
| UniversalRouter (v2.0) | `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` | `0xef740bf23acae26f6492b10de645d6b98dc8eaf3` | `0x6ff5693b99212da76ad316178a184ab56d299b43` | `0xa51afafe0263b40edaef0df8781ea9aa03e381a3` |
| UniversalRouter 2.1.1 | `0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca` | `0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7` | `0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7` | `0x8b844f885672f333bc0042cb669255f93a4c1e6b` |
| UniversalRouter 2.1.2 | `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85` | `0xD1b797D92d87B688193A2B976eFc8D577D204343` | `0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40` | `0x2d01411773c8C24805306E89A41F7855C3c4Fe65` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same | same | same |

These match `universal-router/deploy-addresses/{mainnet,unichain,base,arbitrum}.json`.

Testnets (useful for a live demo):
- **Sepolia:** PoolManager `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`, PositionManager `0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4`, Quoter `0x61b3f2011a92d183c7dbadbda940a7555ccf9227`, StateView `0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c`, UR 2.1.2 `0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3`, PoolSwapTest `0x9b6b46e2c869aa39918db7f52f5557fe577b6eee`.
- **Unichain Sepolia:** PoolManager `0x00b036b58a818b1bc34d502d3fe730db729e62ac`, UR 2.1.2 `0xDf38F24fE153761634Be942F9d859f3DBA857E95`, Quoter `0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472`, StateView `0xc199f1072a74d4e905aba1a84d9a45e2546b6222`, PoolSwapTest `0x9140a78c1a137c7ff1c151ec8231272af78a99a4`.
- **Base Sepolia:** PoolManager `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408`, UR 2.1.2 `0x8702463e73f74d0b6765aBceb314Ef07aCb92650`, StateView `0x571291b572ed32ce6751a2cb2486ebee8defb9b4`.

The docs say: "Integrators should **no longer assume that they are deployed to the same addresses across chains**".

ETH/USDC v4 pool ids and state are in §5.4. The major ones all use `hooks = 0` with fee tiers 100, 500, 3000 and 10000. The deepest mainnet v4 pool by in-range `L` is the 0.30% tier; the most-used is UNVERIFIED (no volume data queried). USDC addresses used: mainnet `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Arbitrum `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, Unichain `0x078D782b760474a361dDA0AF3839290b0EF57AD6`.

---

## 11. Implications for our design

1. **Topology.**
   - One `PredictionHook` (singleton). Each market has one YES ERC20 and one NO ERC20, both with 6 decimals, mint and burn restricted to the hook, deployed via CREATE2 or clones.
   - There are two pools per market: `{YES, USDC}` and `{NO, USDC}`, each with `fee = 0` (static), a fixed `tickSpacing`, and `hooks = PredictionHook`.
   - The pools are created only by `hook.createMarket()`, which calls `poolManager.initialize(key, cosmeticSqrtPrice)`; any other initializer is rejected by `beforeInitialize`.
   - Optionally choose the CREATE2 salt so the outcome token sorts below or above USDC consistently. This keeps `zeroForOne` semantics uniform: with outcome = currency0, the pool's "price" is USDC per outcome.
2. **Permissions:** `0x2888` (or `0x2A88`), and no afterSwap. All pricing happens in `beforeSwap`, with the full-NoOp delta per §1.7. Always fill fully or revert.
3. **Settlement:** §3.3. Inputs become 6909 claims. Outputs are YES/NO minted into the PM with sync/settle, or netted from claim inventory, and USDC is paid by burning collateral claims. Collateral lives as hook-owned USDC ERC-6909 claims in the PM, with per-market and per-vault ledgers and an invariant test against `poolManager.balanceOf(hook, USDC.toId())`.
4. **LP (underwriter) vault:** hook functions `deposit`/`withdraw` open their own `unlock`, following `BaseCustomCurve.unlockCallback`: settle USDC in and `mint` claims; or `burn` claims and `take` out. The key solvency invariant to prove is **claims ≥ worst-case payout of outstanding YES and NO** for each market (or pooled).
5. **Price inputs:**
   - `S`: `StateLibrary.getSlot0(PM, ethUsdcPoolId)`, about 2.4k gas and callable inside the callback. It must not be the sole input to pricing or settlement, because of in-transaction manipulation.
   - Options for manipulation resistance:
     - an in-hook observation ring buffer of `(timestamp, tick)` fed by every market trade plus a permissionless `poke()`. This gives a TWAP and a realized-variance σ from Δtick·ln(1.0001), fully Uniswap-native;
     - v3 `observe()` (0.05% pool, cardinality 723);
     - our own ETH/USDC pool with OZ `BaseOracleHook`.
   - Settlement at expiry must use the TWAP window, not spot.
6. **Composability claims we can prove in tests:**
   - PoolSwapTest (all 4 swap types);
   - local `MockV4Router` with standard Actions;
   - local `V4Quoter` (exact-in and exact-out quotes equal execution in the same block);
   - a fork test through the **deployed** UniversalRouter 2.1.2 (`V4_SWAP`).
   
   Mention the need for allowlisting if Uniswap's own frontend routing is desired.
7. **Fees and economics:** LP compensation equals the hook spread, since there is no LP fee and no PM protocol fee on NoOp volume. Report it via `HookSwap`/`HookFee`. Optionally add aggregator-style protocol-fee cooperation later.
8. **Test catalogue implied by this research:**
   - (a) delta-table unit tests for the 4 swap types × YES/NO × both token orderings;
   - (b) revert tests: third-party initialize, add liquidity, unknown pool, expired or halted market, partial-fill attempts, flag mismatch;
   - (c) invariants: Σ deltas zero, claims == ledgers, no round-trip profit in the same block (spread ≥ 0), outcome-token supply == liabilities;
   - (d) differential fuzz of the in-hook price against an mpmath reference via `ffi`;
   - (e) gas snapshots.
9. **Gas budget:** baseline v4 NoOp swap through PoolSwapTest is 124,402 gas (snapshot). Our additions are estimates, UNVERIFIED until measured:
   - slot0 extsload about 2.4k;
   - market SLOADs about 4–9k;
   - Black–Scholes math about 10–40k, depending on the library;
   - 6909 `mint` about 3–25k (cold versus zero-to-nonzero);
   - YES ERC20 mint into the PM about 5–45k.

   Expect roughly **160–250k gas per trade**.

---

## 12. Open questions

1. **Oracle design.** Should S come from an in-hook tick buffer, v3 `observe`, a dedicated oracle-hook pool, or a hybrid with deviation checks? Which exact window should settlement use, and who pokes it (keepers vs trades)? How much manipulation cost do we require relative to market open interest?
2. **σ estimation.** What window and sampling, and how do we bound σ (floor/cap) so d2 stays numerically safe? This belongs to the math-research topic, but it constrains on-chain storage (buffer size) and gas.
3. **Vault structure.** Should there be one pooled USDC vault across markets, or one per market? How are shares priced mid-life, given mark-to-model liabilities? That needs a view of Σ outstanding × current price.
4. **Size-dependent pricing.** Should the spread widen with size or with inventory imbalance to limit adverse selection? Should markets have per-market exposure caps (revert on breach)?
5. **Outcome-token mechanics.**
   - Mint on demand versus ERC-6909 inventory netting.
   - Whether to add split/merge of complete sets (1 USDC ↔ 1 YES + 1 NO) so that YES_ask + NO_ask ≥ 1 is enforced by arbitrage.
   - Redemption after expiry through the same swap path (the hook prices YES at 1 or 0) versus a dedicated `redeem()`.
6. **Discounting.** With `r ≠ 0`, `YES + NO = e^{−rT} ≠ 1`, but the payout is 1 USDC. Decide whether to use `r = 0` and state it as a modelling assumption.
7. **Router struct version.** Should we support both `ExactInputSingleParams` layouts in scripts and the frontend, and which UR version is primary? That depends on which UR 2.1.x includes `minHopPriceX36`, which is UNVERIFIED. It can be resolved in a fork test by calling the deployed UR with both encodings.
8. **Event standard for indexers.** OZ `IHookEvents.HookSwap` versus Uniswap aggregator `HookSwap(PoolId,address,int256,int256,uint24)`. UNVERIFIED which one Uniswap tooling indexes.
9. **Chain choice for a demo.** Unichain has 0 protocol fee on ETH/USDC and cheap gas, while mainnet has the deepest ETH/USDC. Which chain should the fork tests and a testnet deployment target?
10. **Hedging.** Should the hook (or the vault) delta-hedge on ETH/USDC in the same callback? It is technically allowed (the PM is unlocked), but it adds gas, adds manipulation surface, and makes the "LP = underwriter" story more complex.
11. **Pinning and licensing.** Pin v4-core `v4.0.0` (identical bytecode behaviour to the deployment, old import paths) or `main` (new `PoolOperation.sol` paths)? BUSL-1.1 on `PoolManager` is fine for non-production testing. Our own hook imports only MIT libraries.

---

### Sources

- Local source code at the commits listed at the top (all file:line references).
- Uniswap docs: [v4 Deployments](https://developers.uniswap.org/docs/protocols/v4/deployments), [Custom Accounting](https://developers.uniswap.org/docs/protocols/v4/guides/custom-accounting), [Access msg.sender Inside a Hook](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/accessing-msg.sender), [Swap (Universal Router)](https://developers.uniswap.org/docs/protocols/v4/guides/swapping/swapping), [Integrated Routing with UniswapX](https://developers.uniswap.org/docs/protocols/v4/concepts/hook-routing), [Security Framework](https://developers.uniswap.org/docs/protocols/v4/security).
- [Uniswap/v4-hooks-public](https://github.com/Uniswap/v4-hooks-public), [akshatmittal/hookmate](https://github.com/akshatmittal/hookmate).
- v4 fee switch: [UNIfication](https://blog.uniswap.org/unification), [Uniswap governance votes on activating protocol fees for v4 pools (cryptobriefing)](https://cryptobriefing.com/uniswap-governance-v4-protocol-fees/), [Uniswap activates fee switch on v4 pools (cryptobriefing)](https://cryptobriefing.com/uniswap-fee-switch-v4-pools-325k-revenue/).
- [Trail of Bits, "Building secure Uniswap v4 hooks" (2026-07-30)](https://blog.trailofbits.com/2026/07/30/building-secure-uniswap-v4-hooks/).
- On-chain reads through public RPCs (publicnode, mainnet.base.org, arb1.arbitrum.io, mainnet.unichain.org) at the block numbers given in §5.4.
- Soldeer registry API (`api.soldeer.xyz`) for package availability.

---

## Verification log (adversarial fact-check, 2026-09-25)

Method:
- Re-read every cited line in the local clones at the listed commits. The clones' histories go back far enough to resolve all cited commit hashes.
- Recomputed all numbers in independent Python:
  - `scratchpad/fc01.py`: `BeforeSwapDelta` hex, pool ids, prices, protocol-fee decode;
  - `scratchpad/fc03_sim.py`: an independent flash-accounting simulator.
- Re-queried mainnet live via publicnode (`scratchpad/fc02.py`, block ≈ 26,054,983).
- Fetched the Trail of Bits post and fee-switch press coverage.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | The only `src/` change in v4-core since tag `v4.0.0` is `a7cf038` (struct move, no behaviour change) | Confirmed (source). That the deployed bytecode matches the tag is UNVERIFIED | `git log v4.0.0..HEAD -- src` → only `a7cf038`; `git diff` shows only import/struct relocation |
| 2 | `PoolManager.swap` flow and line numbers (193, 196, 202, 206-217, 221, 224, 226); `unlock` checks `NonzeroDeltaCount` at :112 | Confirmed | `PoolManager.sol:103-114, 187-227` |
| 3 | Full NoOp: `Pool.swap` returns `ZERO_DELTA` at `:320` before price-limit checks and with no state write; `amountToProtocol = 0` | Confirmed | `Pool.sol:279-338` (only write is `:439`); `PoolManager._swap` emits `Swap` with 0/0 at `:241-250` |
| 4 | `sqrtPriceLimitX96` is not validated on a full NoOp | Confirmed | Checks at `Pool.sol:322-338` sit after the `:320` return |
| 5 | Allowed range of `deltaSpecified` is `[0, A]` (exact-in) / `[-A, 0]` (exact-out) | **Corrected** | `Hooks.sol:273-278` checks only overshoot. Sim: exact-in `A=100, hds=-50` → `amountToSwap=-150` (accepted) |
| 6 | Mapping hook deltas to currency0/1 (`(amountSpecified<0)==zeroForOne` → specified is currency0); caller = cl − hook; mapping runs without the AFTER_SWAP flag | Confirmed | `Hooks.sol:285-315` |
| 7 | `BeforeSwapDelta` packing (upper 128 = specified), and the sign meaning (positive = hook owed/took) | Confirmed | `BeforeSwapDelta.sol:4-37`; `IHooks.sol:101` |
| 8 | §1.8 worked cases A–D: amounts 243,902,439 / 102,500,000 / 97,500,000 / 256,410,257, the raw int256 hex, hookDelta, caller delta, and NonzeroDeltaCount = 0 after router settlement | Confirmed | `fc01.py` reproduces all four hex words byte-for-byte; `fc03_sim.py` reproduces hookDelta/caller deltas and `nz == 0` |
| 9 | Flag bits; `0x2888` for our set; `0x2A88` = OZ `BaseCustomCurve`; ≈16,384 expected CREATE2 tries | Confirmed | `Hooks.sol:27-47`; `BaseCustomCurve.sol:307-324`. HookMiner `MAX_LOOP = 160_444` gives a failure probability of (1−2⁻¹⁴)^160444 ≈ 5.6e-5 |
| 10 | `isValidHookAddress` / `validateHookPermissions` semantics; initialize checks (tick spacing 1..32767, ordering, `LPFeeTooLarge`, dynamic fee == `0x800000` exactly with initial fee 0) | Confirmed | `Hooks.sol:83-127`; `PoolManager.sol:117-128`; `LPFeeLibrary.sol:15-56`; `TickMath.sol:26-33` |
| 11 | `noSelfCall` lets the hook itself initialize while `beforeInitialize` reverts for others; used by `SpreadQuoterBase` | Confirmed | `Hooks.sol:171-182`; `v4-hooks-public/src/alf/base/SpreadQuoterBase.sol:106-120` |
| 12 | Settlement primitives: `mint` = −delta, no token movement; `burn` = +delta; `take` needs a physical balance; `settle` measures the balance diff since `sync`, then resets; `clear` needs an exact positive amount | Confirmed | `PoolManager.sol:279-365`; `ERC6909Claims.sol:13-22`; `Currency.sol:110-118` |
| 13 | Settlement pattern: input → `PM.mint` claims; YES output → `sync`/`YES.mint(PM)`/`settle`; USDC output → `PM.burn` claims. Matches OZ `BaseCustomCurve` and `SettlementLib` ("mint ERC-6909 claims rather than calling `take`") | Confirmed | `BaseCustomCurve.sol:90-156`; `SettlementLib.sol:26-29, 58-82`; docs custom-accounting note (saved at `scratchpad/docs_guides_custom-accounting.md:166-168`) |
| 14 | v4-core `CustomCurveHook` uses `take` of ERC20 before the swapper pays; the test works because the pool holds liquidity | Confirmed | `CustomCurveHook.sol:33-49`; `CustomAccounting.t.sol:35-39` uses `initPoolAndAddLiquidity` |
| 15 | Quoter requires an exact fill (`NotEnoughLiquidity`) | Confirmed | `BaseV4Quoter.sol:52-57` |
| 16 | V4Router single-swap semantics; `minHopPriceX36` added in `03b2d09` (2026-03-17); `V4ExactOutputUnfilled` added in `545a5d2` (2026-08-03) | Confirmed | `V4Router.sol:84-156, 205-219`; `IV4Router.sol:31-38`; `git log` |
| 17 | UR `main` pins periphery `9dafaae` | **Corrected** → `a7af5b3` (2026-09-16) | `git ls-tree HEAD lib/` in universal-router |
| 18 | `PermissionedV4Router` rejects only verified permissions-adapter currencies; ordinary hook pools pass | Confirmed | `PermissionedV4Router.sol:32-43` |
| 19 | UR `V4_SWAP = 0x10`; Actions codes; `ActionConstants` | Confirmed | `Commands.sol:35-39`; `Actions.sol:10-62`; `ActionConstants.sol:10-19` |
| 20 | `StateLibrary.getSlot0` layout, `POOLS_SLOT = 6`, `extsload getSlot0` snapshot 2,375 gas | Confirmed | `StateLibrary.sol:11-63`; `snapshots/StateLibraryTest.json` |
| 21 | Gas snapshots 124,402 / 123,144 / 132,165 | Confirmed; caveat: the 124,402 test uses ERC20 `take`/`settle` and a pool with liquidity, so it is not our claims-based path | `snapshots/CustomAccountingTest.json:4`; `PoolManagerTest.json:16,24`; `CustomAccounting.t.sol:111-127` |
| 22 | ETH/USDC v4 pool ids on all four chains; mainnet 0.05% id `0x21c67e…ca27`; prices ≈ $2,688–2,691 | Confirmed | `fc01.py` recomputed all 16 ids; live `StateView.getSlot0` → sqrtP 4107905792714108248784896, tick −197354, protocolFee 512125 (≈ $2,688.3) |
| 23 | Mainnet `protocolFeeController = 0x89a5…51db`; PM holds ≈ 73.3M USDC; v3 0.05% pool cardinality 723 | Confirmed | Live `eth_call`s (`fc02.py`, curl `slot0()` on the v3 pool) |
| 24 | Governance Proposal 100 executed 2026-07-27; scope of static-no-hook, CCA and aggregator-hook pools; aggregator hooks self-collect `slot0.protocolFee × 25` via `take` to the TokenJar | Confirmed | cryptobriefing coverage; `BaseAggregatorHook.sol:36` (`ProtocolFees(25)`); `ProtocolFees.sol:44-100` |
| 25 | Deployed addresses (PM, PositionManager, Quoter, StateView, UR v2/2.1.1/2.1.2, Permit2) for 1/130/8453/42161 | Confirmed | `scratchpad/v4deployments.md:16-81`; `universal-router/deploy-addresses/*.json` |
| 26 | `HookMiner` removed from periphery `src/utils` in `5da22e6` (2026-02-06); copies in `v4-hooks-public/src/utils` and `v4-periphery/test/shared` | Confirmed | `git log -1 5da22e6`; files present, `MAX_LOOP = 160_444` |
| 27 | v4-template: `deployCodeTo` with the `0x4444 << 144` namespace; `foundry.toml`; `foundry.lock` pins | Confirmed | `Counter.t.sol:48-55`; `foundry.toml`; `foundry.lock` |
| 28 | `uniswap-hooks e59fe72` pins v4-core `d153b04` and v4-periphery `7ebd04b` | **Corrected** → `a7cf038` / `eeb3eff` (the draft's values are OZ `master`'s pins) | `git ls-tree e59fe72 lib/` in oz-uniswap-hooks |
| 29 | OZ package 1.2.2, tag `v1.2.1`; master carries audit remediations (N-05, M-09, M-12, M-15, L-05, CEI enforcement) | Confirmed | `package.json:3`; `git log v1.2.1..HEAD` |
| 30 | Hook reverts are wrapped as ERC-7751 `WrappedError(target, selector, reason, HookCallFailed)` | Confirmed | `Hooks.sol:137`; `CustomRevert.sol:11, 83-110` |
| 31 | Trail of Bits post (2026-07-30) stresses `onlyPoolManager` because callbacks are otherwise directly callable | Confirmed | WebFetch of the post, Section 1 "Anyone can call your hook" |
| 32 | Partial fill walks an empty CL pool to the price limit | Plausible (reasoned from `SwapMath` with L = 0; not executed) | `Pool.sol:341+`; test to be written in the plan |
| 33 | Estimate of 160–250k gas per trade | UNVERIFIED (estimate) | To be measured with `forge snapshot` |
| 34 | Which deployed UR (2.1.1 / 2.1.2) uses the 6-field `ExactInputSingleParams`; which `HookSwap` event Uniswap indexers consume | UNVERIFIED | No primary source found; resolve by fork test / Uniswap confirmation |
