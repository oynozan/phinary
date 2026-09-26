# 06: Security of custom-accounting Uniswap v4 hooks, and what it means for a Black–Scholes prediction hook

- **Status:** fact-checked final, 2026-09-25. Corrections made during verification are marked **[corrected]** inline, and additions **[added]**. Every checked claim is listed in the Verification log at the end.
- **Scope:** vulnerability classes for v4 hooks that return deltas (the "NoOp" / custom-curve pattern), mint and burn their own ERC-20 outcome tokens, and hold LP collateral. Covers audit findings, production hooks, oracle manipulation, and a threat model for **PredictionHook**, with a Foundry test for every threat.
- **Evidence standard:** Wherever possible, claims cite source code as `repo/path:line`. Repos are shallow clones in the session scratchpad, pinned in the table below. Claims taken only from secondary sources (news, blog summaries) are marked **UNVERIFIED** or "(secondary)".

| Repo | Commit | Date |
|---|---|---|
| Uniswap/v4-core | `46c6834` | 2026-04-02 |
| Uniswap/v4-periphery | `9969eec` | 2026-09-19 |
| OpenZeppelin/uniswap-hooks (package 1.2.2) | `80bd724` | 2026-09-24 |
| Uniswap/universal-router (2.1.0) | `a9c574f` | 2026-09-22 |
| euler-xyz/euler-swap | `dd936d2` | 2026-01-21 |
| SorellaLabs/angstrom | `3690f91` | 2026-08-25 |
| flayerlabs/flaunchgg-contracts | `77d7d23` | 2026-09-21 |
| whetstoneresearch/doppler | `5754c7e` | 2026-08-26 |
| Bunniapp/bunni-v2 | `2b303b8` | 2025-10-22 |
| lyra-finance/lyra-v1 (reference only) | `ea9e36a` | 2023-09-01 |

Audit PDFs were read in full. They were converted to text with `pypdf`:
- OZ uniswap-hooks v1.0.0-RC1, v1.1.0-RC1 and v1.1.0-RC2 (`oz-uniswap-hooks/audits/`)
- v4-core audits by OpenZeppelin, Trail of Bits, Spearbit, Certora and ABDK, plus `Known_Effects_of_Hook_Permissions.pdf` (`v4-core/docs/security/`)
- The six EulerSwap audits (`euler-swap/audits/`)

---

## 0. Executive summary

1. **The two largest hook incidents both came from the application's own code, not from `PoolManager`.**
   - **Cork, May 2025, about $11–12M.** `beforeSwap` had no `onlyPoolManager` check. On top of that, a rate formula blew up near expiry, and there was no pool or token allowlist.
   - **Bunni v2, Sept 2025, about $8.4M.** The rounding direction for the idle balance was wrong on withdraw. The attacker amplified it with flash-loan price pushes and 44 tiny withdrawals.

   Our design shares the *risk factors* of both. It is a singleton hook serving many expiring markets, with custom math that becomes extreme near expiry, custom accounting, and LP shares.
2. **For our design, pricing from spot is fatal, not just a risk.** v4 flash accounting makes atomic manipulation of the underlying pool almost free: the attacker pays only swap fees. Near expiry, the binary option's delta is huge.
   - To first order, an attacker profits once trade size q satisfies `q > fee_pool · V_virtual · σ√T / (2·φ(d2))`. The size of the price push cancels out of this condition (§5.2).
   - Example: a 5 bp pool, $100M of virtual in-range liquidity, σ = 60%, 1 hour to expiry, at the money: **the break-even trade is about $400 of YES notional.**
   - The price S **must** come from an observation made before the current block: a TWAP whose window ends at the last observation. We also recommend a **dual-price rule** (ask = max(P(spot), P(twap)) + h, bid = min(...) − h).
3. **Delta and sign bugs pass `PoolManager` settlement silently.** `unlock()` only checks that `NonzeroDeltaCount == 0` (`v4-core/src/PoolManager.sol:112`). A hook that overpays still settles cleanly. This leaks value but reverts nothing. Invariant tests are required: no free output, no profitable round trip, and internal accounting equal to real ERC-6909/ERC-20 balances.
4. **Use the "self-initialize, then always revert `beforeInitialize`" pattern** (Euler Swap, Flaunch, Doppler). It works because `Hooks.beforeInitialize` has `noSelfCall` (`v4-core/src/libraries/Hooks.sol:171-182`). Only pools the hook creates itself can exist, which closes the "anyone can create a pool with your hook" class.
5. **Settle swaps with ERC-6909 claims, not ERC-20 transfers, inside `beforeSwap`.** Take the input with `mint` and pay the output with `burn`, as OZ `BaseCustomCurve` and Bunni do.
   - This avoids depending on `PoolManager`'s ERC-20 balances. The swapper has not paid yet when `beforeSwap` runs.
   - It avoids `sync` interleaving, which uses a single slot in `CurrencyReserves`.
   - It removes external token calls, and with them reentrancy, from the swap path.
6. **Expiry needs four protections:**
   - A trading cutoff of at least the settlement averaging window W plus a margin. Lyra v1 enforced a `tradingCutoff`.
   - Price clamps to [p_min, 1 − p_min], so the hook never sells near-free lottery tickets.
   - Caps on liability per market and per block.
   - A settlement price that is a TWAP or median over [T − W, T], never a spot read.
7. **Our hook falls in the high tier of the Uniswap Foundation Hook Security Framework.** Our self-score is about 24 on the 0–33 scale (§8). That tier requires two audits (one by a math specialist), a mandatory bug bounty, invariant and stateful fuzzing, and monitoring.

---

## 1. The v4 mechanics that matter for security

### 1.1 Permission bits

Permissions are encoded in the low 14 bits of the hook's address (`v4-core/src/libraries/Hooks.sol:27-47`). A few rules:

- A return-delta flag without its base flag makes the address invalid (`Hooks.sol:109-120`). For example, `BEFORE_SWAP_RETURNS_DELTA_FLAG` requires `BEFORE_SWAP_FLAG`.
- `validateHookPermissions` (`Hooks.sol:83-103`) is called in `BaseHook`'s constructor (`oz-uniswap-hooks/src/base/BaseHook.sol:53-57`). It makes a wrongly mined address revert at deploy time.

Proposed flags for PredictionHook:

| Flag | Bit | Purpose |
|---|---|---|
| `BEFORE_INITIALIZE` | `1<<13` = 0x2000 | Always revert. The hook self-initializes, which skips this callback (§1.5). |
| `BEFORE_ADD_LIQUIDITY` | `1<<11` = 0x0800 | Always revert, so no CL liquidity can ever exist. |
| `BEFORE_REMOVE_LIQUIDITY` | `1<<9` = 0x0200 | Always revert (defence in depth). |
| `BEFORE_SWAP` | `1<<7` = 0x0080 | Pricing and settlement. |
| `BEFORE_DONATE` | `1<<5` = 0x0020 | Always revert. `donate` already reverts with zero liquidity (`Pool.sol:466-468`), but this is explicit. |
| `BEFORE_SWAP_RETURNS_DELTA` | `1<<3` = 0x0008 | NoOp or custom curve. |

**Mask = `0x2AA8`** (0x2000+0x0800+0x0200+0x0080+0x0020+0x0008, checked). Mine the address with `v4-periphery/test/shared/HookMiner.sol:23`:

```solidity
find(address deployer, uint160 flags, bytes creationCode, bytes constructorArgs)
```

The only permission-mismatch incident we found is Angstrom's. The hook returned an `afterSwap` delta without the `AFTER_SWAP_RETURNS_DELTA` bit, so every swap reverted (ToB blog 2026-07-30; Cyfrin deep dive; secondary). The fix is to keep `getHookPermissions()` in sync with the functions actually implemented.

### 1.2 The `beforeSwap` delta path and sign conventions

`PoolManager.swap` works as follows (`v4-core/src/PoolManager.sol:187-227`):
- It calls `key.hooks.beforeSwap` (`Hooks.sol:248-282`).
- It runs the CL `_swap` with `amountToSwap`.
- It calls `afterSwap` (`Hooks.sol:285-315`).
- It credits `hookDelta` to the hook and `swapDelta − hookDelta` to the caller (`PoolManager.sol:224-226`).

```solidity
// Hooks.sol:266-279
if (self.hasPermission(BEFORE_SWAP_RETURNS_DELTA_FLAG)) {
    hookReturn = BeforeSwapDelta.wrap(result.parseReturnDelta());
    int128 hookDeltaSpecified = hookReturn.getSpecifiedDelta();
    if (hookDeltaSpecified != 0) {
        bool exactInput = amountToSwap < 0;
        amountToSwap += hookDeltaSpecified;
        if (exactInput ? amountToSwap > 0 : amountToSwap < 0) {
            HookDeltaExceedsSwapAmount.selector.revertWith();   // only sign-flip is checked
        }
    }
}
// Hooks.sol:306-313  (afterSwap)
hookDelta = (params.amountSpecified < 0 == params.zeroForOne)
    ? toBalanceDelta(hookDeltaSpecified, hookDeltaUnspecified)
    : toBalanceDelta(hookDeltaUnspecified, hookDeltaSpecified);
swapDelta = swapDelta - hookDelta;   // "the caller has to pay for (or receive) the hook's delta"
```

Conventions:
- `amountSpecified < 0` means exact input; `> 0` means exact output.
- The "specified" currency is `currency0` iff `zeroForOne == exactInput`. OZ `BaseCustomCurve.sol:100-101` shows the same logic.
- In `BeforeSwapDelta`, a **positive** value means the hook is owed or took currency. A **negative** value means the hook owes or sent currency (`Flaunch PositionManager.sol` NatSpec; `EulerSwap UniswapHook.sol:98-107`).
- **Core checks only the sign.** `Hooks.sol:276` never checks that the hook consumed exactly `amountSpecified`, or that the unspecified delta has a sensible sign. Everything else is the hook's responsibility.

Worked example (USDC has 6 decimals; our outcome tokens also have 6, see §9). The pool is (USDC, YES) with `USDC < YES` by address, so `currency0 = USDC`. The model ask is 0.41 USDC.

| Trade | `zeroForOne` | `amountSpecified` | specified / unspecified | `BeforeSwapDelta(spec, unspec)` | Caller's final delta (c0, c1) | Hook's own ops in `beforeSwap` |
|---|---|---|---|---|---|---|
| Buy YES, exact in 100 USDC | true | −100 000 000 | USDC / YES | (+100 000 000, −243 902 439) where `floor(100e6/0.41)` = 243 902 439 | (−100e6 USDC, +243 902 439 YES) | Take 100e6 USDC by claim `mint`; pay 243 902 439 YES by claim `burn` |
| Buy YES, exact out 250 YES | true | +250 000 000 | YES / USDC | (−250 000 000, +102 500 000) where `ceil(250e6·0.41)` = 102 500 000 | (−102.5e6, +250e6) | Take 102.5e6 USDC; pay 250e6 YES |
| Sell YES, exact in | false | −y | YES / USDC | (+y, −floor(y·bid)) | (+floor(y·bid), −y) | Take y YES; pay USDC |
| Sell YES, exact out u USDC | false | +u | USDC / YES | (−u, +ceil(u/bid)) | (+u, −ceil(u/bid)) | |

If `YES < USDC`, the same trades flip `zeroForOne` and the mapping of `(spec, unspec)` to `(amount0, amount1)` (`Hooks.sol:307-309`). This is the most likely place for an ordering bug (T21).

### 1.3 Flash accounting, `sync`/`settle`, claims

- **`unlock`** (`PoolManager.sol:104-114`) reverts if already unlocked. It calls `IUnlockCallback(msg.sender).unlockCallback(data)` and at the end requires `NonzeroDeltaCount == 0`.
  - Consequence 1: only the contract that called `unlock` receives the callback, so `unlockCallback` cannot be "spoofed" as long as it is `onlyPoolManager` (T4).
  - Consequence 2: **inside an unlock anyone can swap any pool on credit and repay at the end.** Manipulating the underlying ETH/USDC v4 pool within one unlock costs only fees, not capital.
- **`sync`/`settle`** (`PoolManager.sol:279-288`, `349-365`). `sync` records a *single* currency and its reserves in transient storage. The next `settle` credits `balanceNow − reservesBefore` for that currency and resets the slot. OZ's v4-core audit C-01 (native CELO / ERC-20 CELO double-count) led to the rule that "the very next `settle` settles the previously synced currency".
  - Consequence: a hook that calls `sync` in the middle of a swap overwrites any pending `sync` of its caller. Routers that do `sync → transfer → swap → settle` would lose accounting (they revert, so nothing is stolen). V4Router does `sync+transfer+settle` atomically in `SETTLE`, so this is a composability hazard, not a theft vector.
- **`take`** (`PoolManager.sol:291-297`) transfers real ERC-20 out of `PoolManager`, so `PoolManager` must hold that balance at that moment. In `beforeSwap` the swapper has **not yet settled**: V4Router does `SWAP` and then `SETTLE_ALL`.
  - Euler Swap's hook calls `poolManager.take(input, address(this), amountIn)` (`euler-swap/src/UniswapHook.sol:111`). It works only because `PoolManager` already holds other pools' tokens.
  - For a brand-new token like YES, `PoolManager`'s balance may be too low. **In a fresh Foundry deployment `PoolManager` holds zero of everything**, so this pattern reverts.
- **`mint`/`burn` of ERC-6909 claims** (`PoolManager.sol:322-336`) only move deltas and internal balances. There are no ERC-20 calls, so no balance dependence and no reentrancy. OZ `BaseCustomCurve._beforeSwap` uses exactly this: `take(..., claims=true)` for input and `settle(..., burn=true)` for output (`BaseCustomCurve.sol:112-128`). Bunni does the same (`bunni-v2/src/lib/BunniHookLogic.sol:519,530`).

### 1.4 NoOp early return: price limits and events

When the hook consumes the whole specified amount, `amountToSwap == 0`, and `Pool.swap` returns **before** it validates `sqrtPriceLimitX96`:

```solidity
// v4-core/src/libraries/Pool.sol:318-320
// when the amount swapped is 0, there is no protocolFee applied and the fee amount paid to the protocol is set to 0
if (params.amountSpecified == 0) return (BalanceDeltaLibrary.ZERO_DELTA, 0, swapFee, result);
```

Consequences:
1. **`sqrtPriceLimitX96` gives the user no protection.** Slippage protection must be amount-based. V4Router exposes no price limit anyway (`v4-periphery/src/V4Router.sol:211-216`: "for protection of exactOut swaps, sqrtPriceLimit is not exposed"). It enforces:
   - `amountOutMinimum` for exact input (`V4Router.sol:93`, `132`);
   - `amountInMaximum` for exact output (`V4Router.sol:149`, `196`);
   - `V4ExactOutputUnfilled` if the realized output is short (`V4Router.sol:147`, `184`);
   - an optional per-hop `minHopPriceX36`.
2. `PoolManager` emits `Swap` with zero amounts (`PoolManager.sol:240-249`, emitted from `_swap`). Indexers therefore need a hook event; OZ uses `IHookEvents.HookSwap` (`BaseCustomCurve.sol:130-153`).
3. The protocol fee is zero for NoOp swaps (same line), so Uniswap governance cannot tax our pools. Informational.
4. **If the hook consumes only part of the amount, the remainder runs the CL loop against zero liquidity.**
   - The price moves to the limit and the user pays nothing for the remainder.
   - With `tickSpacing = 1` the loop walks about 887 272 / 256 ≈ 3.5k bitmap words, which costs a lot of gas.
   - Hence: **always return `specifiedDelta = −amountSpecified`, or revert.** Bunni's code shows how subtle partial logic gets: `max(−amountSpecified, inputAmount)` on exact input and `min(amountSpecified, outputAmount)` on exact output (`BunniHookLogic.sol:434-441`, `480-488`).

### 1.5 `noSelfCall` and skipped callbacks

`Hooks.sol:171-175` defines `modifier noSelfCall(IHooks self) { if (msg.sender != address(self)) { _; } }`. It applies to `beforeInitialize`, `afterInitialize`, `before/afterModifyLiquidity` and donate. `beforeSwap` and `afterSwap` return early when `msg.sender == hook` (`Hooks.sol:253`, `293`).

- **Good use:** the hook calls `poolManager.initialize(key, …)` itself, so its own `beforeInitialize` is skipped. Any third-party `initialize` with our hook runs `beforeInitialize`, which always reverts. This is how Euler Swap (`UniswapHook.sol:36-54`, `125-157`), Flaunch (`PositionManager.sol:342-348`, `revert CannotBeInitializedDirectly()`) and Doppler (`DopplerHookInitializer.sol:496-499`) do it.
  - Cantina's EulerSwap review (3.3.5, in `report-cantinacode-euler-0901`; its context cites `Hooks.sol#L170-L175`) points out that the override is "never reached during normal initialization". It still acts as a guard against *foreign* initializations.
- **Bad use:** if the hook itself swaps on its own pools, its pricing callback is skipped. The OZ v1.0 audit's integration guide ("Skipped Callbacks") and OZ `BaseOracleHook.sol:107-109` both note that "a hook that swaps on its own skips this callback". **PredictionHook must never call `swap` on its own pools.**

### 1.6 Router layer: `sender`, `hookData`, quoting

- The `sender` argument of `beforeSwap` is `msg.sender` of `PoolManager.swap`, meaning **the router, not the user**. The only trustworthy way to learn the user is `IMsgSender(sender).msgSender()` from an **allowlisted** router (`v4-periphery/src/interfaces/IMsgSender.sol`; Universal Router `Dispatcher.sol:47` returns the locker).
  - Universal Router 2.1.0 also exposes `signedRouteContext()` (`UniversalRouter.sol:91`), an EIP-712-signed route intent. We have not analysed its semantics for hooks (**UNVERIFIED**).
  - Do not use `tx.origin`. EIP-7702 EOAs can carry code.
- **`hookData` is attacker-controlled.** Cork's `beforeSwap` interpreted crafted `hookData` (secondary: Dedaub, BlockSec).
- **Quoting.** V4Quoter simulates swaps via revert. 0x's September 2026 analysis of 84,163 hooks classified 54.2% as malicious and 26.4% as likely malicious, for "quote one price, settle another" behaviour (secondary: CryptoSlate, KuCoin, 0x blog). Aggregators will be suspicious of any hook whose settlement differs from its quote. Our price legitimately depends on time and oracle state, so it **must be deterministic given (block.timestamp, oracle state)**, expose a `quote()` view, and never branch on `tx.origin`, gas left or `hookData`.
  - Uniswap's hook registry says listing "DOES NOT automatically cause your hook to be allowlisted for routing"; routing needs a separate application (github.com/Uniswap/hooklist).

---

## 2. Vulnerability classes (catalogue)

Each class gives the mechanism, evidence, mitigation, and how to test it in Foundry. The threat IDs (T#) refer to §6.

### 2.1 Unprotected hook callbacks (T1)
- **Mechanism.** External hook functions are ordinary public functions. Nothing in the EVM restricts them to `PoolManager`.
- **Evidence.**
  - **Cork (2025-05-28).** "their CorkHook contract inherited from BaseHook … but they only applied it to `unlockCallback`, not to `beforeSwap`". The attacker called `beforeSwap` directly with crafted `hookData` and was credited about 3,761 weETH-DS that were never deposited (Dedaub, BlockSec, CertiK; secondary).
  - Guardian's audit of Gamma UniV4 Limit Orders, C-06: "any address [could] call beforeSwap() and afterSwap()" (Cyfrin deep dive; secondary).
- **Mitigation.** Inherit OZ `BaseHook`: every `IHooks` entrypoint there is `onlyPoolManager` (`BaseHook.sol:62-65`, `97-99` and so on), and only the internal `_beforeSwap` and friends are overridden. Put OZ `BaseHook`'s own `onlyPoolManager` modifier on `unlockCallback`.
  - **[corrected]** Do *not* also inherit v4-periphery `SafeCallback`. OZ `BaseHook` declares its own `IPoolManager public immutable poolManager` and `onlyPoolManager` (`oz-uniswap-hooks/src/base/BaseHook.sol:30-34`, `62-65`) and does not inherit periphery `ImmutableState`. `SafeCallback` inherits `ImmutableState`, which declares the same two identifiers (`v4-periphery/src/base/ImmutableState.sol:17`, `SafeCallback.sol:15`), so combining them does not compile.
- **Test.** For every selector in `IHooks` plus `unlockCallback`, `vm.prank(attacker)` and expect a revert with `NotPoolManager`. Pair it with a meta-test that the list of external functions matches an allowlist, which catches future additions.

### 2.2 Permissionless pool initialization and untrusted `PoolKey` (T2, T3)
- **Mechanism.** Anyone can call `PoolManager.initialize` with *our* hook address and arbitrary currencies, fee and tickSpacing (`PoolManager.sol:117-142`). User-facing hook functions that accept a `PoolKey` can be pointed at attacker pools.
- **Evidence.**
  - **OZ uniswap-hooks v1.0-RC1 C-01, "Non-Explicit Multiple-Pool Support Allows Overwriting Hook State".** A second `initialize` overwrote `poolKey` and locked all LP funds. The fix: `AlreadyInitialized` (`BaseCustomAccounting.sol:337-345`).
  - **2026 OZ audit, M-09** (report not found publicly, **UNVERIFIED** which engagement). The first initializer "permanently binds the hook to the first key it sees, so a third party can front-run it". The fix was a documentation warning (`BaseCustomAccounting.sol:333-335`, PR #170, merged 2026-09-24).
  - **Cork.** "There was no validation on the pool id nor the hook contract address". A DS token from one market was accepted as the redemption asset of another (Dedaub; secondary).
  - **Semantic Layer SVFHook.** `addLiquidity` took a caller-supplied `PoolKey`, so deposits could be routed "through a custom WETH/SVF pool with a malicious hook" (ToB blog; secondary).
  - **Doppler, Certora C-01:** "drained by specification of a malicious pool key" (Cyfrin summary; secondary, **UNVERIFIED** primary report).
- **Mitigation.**
  - Self-initialize and revert `beforeInitialize` (§1.5).
  - Public functions take a `marketId` and read the `PoolKey` from storage.
  - `_beforeSwap` asserts `markets[key.toId()].exists` as defence in depth.
  - Whitelist collateral (USDC) and underlying oracle pools. Outcome tokens are never accepted as collateral anywhere.
- **Test.**
  - Fuzz `PoolKey{c0,c1,fee,tickSpacing}` with our hook address and expect `initialize` to revert.
  - **[corrected]** The revert data is **not** a bare `HookCallFailed()`. `Hooks.callHook` calls `CustomRevert.bubbleUpAndRevertWith(hook, IHooks.beforeInitialize.selector, HookCallFailed.selector)` (`Hooks.sol:137`). That reverts with `CustomRevert.WrappedError(address target, bytes4 selector, bytes reason, bytes details)` (`v4-core/src/libraries/CustomRevert.sol:11`, `83-88`). The test must expect `abi.encodeWithSelector(CustomRevert.WrappedError.selector, address(hook), IHooks.beforeInitialize.selector, <inner revert>, abi.encodeWithSelector(Hooks.HookCallFailed.selector))`.
  - Grep and assert that no external function has a `PoolKey` parameter.

### 2.3 `unlockCallback` spoofing and crafted unlock data (T4)
- **Mechanism.**
  - A hook exposes `unlockCallback(bytes)` to run its own `PoolManager` operations. The OZ v1.0 audit guide ("Crafting unlock Calldata") warns that user-influenced unlock data "could be used to call any function on the hook".
  - OZ L-04 removed the default `unlockCallback` from `BaseHook` because it opened "a way to re-enter the hook".
  - A transient-storage version of the same bug is the SIR.trading exploit (§2.14).
- **Mitigation.**
  - `onlyPoolManager`.
  - Internally encoded, enum-tagged callback data. Never forward user bytes into `unlock`.
  - Derive every address and amount inside the callback from hook state or from values the hook itself encoded.
- **Test.** Call `unlockCallback` directly and expect a revert. A malicious contract that calls `PoolManager.unlock` must never reach our callback, because `PoolManager` calls back `msg.sender`.

### 2.4 Delta accounting and sign errors (T5)
- **Mechanism.** `PoolManager` only checks that the whole session nets to zero. If the hook pays out too much, it simply ends up with fewer claims.
  - **[corrected, now verbatim]** ToB pattern 3, "Custom accounting leaks value" (2026-07-30): "settlement only checks that the session's currency deltas resolve; it does not validate the hook's internal accounting. A hook's accounting can still be wrong even when settlement succeeds."
  - The Uniswap Foundation framework, verbatim: "Returning a `BeforeSwapDelta` that fully consumes the user's input (or fully satisfies exact-output) means the PoolManager sees zero remaining amount, causing the Uniswap CL math to be skipped."
- **Evidence.**
  - TOB-BUNNI-15/16/17/18: "free swaps, providing zero input tokens but receive a non-zero amount of output tokens", and "net positive amount of tokens from round trip swaps" (Cyfrin summary; secondary).
  - OZ v1.0 M-06 "Unintuitive Return Delta": the callback returned negative amounts for both add and remove.
  - OZ v1.1-RC1 H-07: `uint256(uint128(target))` on a negative `int128` produced about 2^128 (unsafe cast).
  - OZ v1.0 M-03 and H-02: `modifyLiquidity`'s `callerDelta` includes accrued fees, so the sign can flip.
- **Mitigation.**
  - One canonical helper maps `(yesIsCurrency0, zeroForOne, exactIn)` to `(inputCurrency, outputCurrency, specifiedIsOutcome)`.
  - Use `SafeCast` everywhere.
  - Assert the post-conditions (a sketch of these checks follows the list):
    - `specifiedDelta == −amountSpecified`;
    - the hook's claim deltas are exactly `+input` and `−output`;
    - `input > 0` and `output > 0`.
- **Test.** Fuzz all 8 combinations: 2 orderings × 2 directions × exact in or out. Compare user balance changes against an independent Solidity/Python reference model. Also check `PoolManager` `slot0` is unchanged and the `Swap` event deltas are zero.

A minimal sketch of those post-conditions. The error names are placeholders; the exact-output form of the specified check follows from the conventions in §1.2:

```solidity
function _assertSwapPostConditions(
    SwapParams calldata params,
    BeforeSwapDelta delta,
    uint256 amountIn,
    uint256 amountOut
) internal pure {
    int128 spec = delta.getSpecifiedDelta();
    int128 unspec = delta.getUnspecifiedDelta();
    // Full consumption: amountToSwap must end up exactly 0 (see §1.4)
    if (int256(spec) != -params.amountSpecified) revert NotFullyConsumed();
    if (amountIn == 0 || amountOut == 0) revert ZeroAmount();
    if (params.amountSpecified < 0) {
        // exact input: hook took `amountIn` (specified, +), paid `amountOut` (unspecified, -)
        if (spec <= 0 || unspec != -amountOut.toInt128()) revert BadDelta();
    } else {
        // exact output: hook paid `amountOut` (specified, -), took `amountIn` (unspecified, +)
        if (spec >= 0 || unspec != amountIn.toInt128()) revert BadDelta();
    }
}
```

### 2.5 Rounding direction (T6)
- **Evidence.**
  - **Bunni exploit, 2025-09-02.** The vulnerable line is `uint256 newBalance = balance - balance.mulDiv(shares, currentTotalSupply);` (`bunni-v2/src/lib/BunniHubLogic.sol:478` at `2b303b8`; the post-mortem's fix is `mulDivUp`).
    - "A rounding direction that's safe in the context of a single operation may not be safe in the context of multiple operations."
    - Attack sequence: flash-borrow 3M USDT, push the tick to 5000 so the USDC active balance falls to 28 wei, then make 44 tiny withdrawals that took it from 28 wei to 4 wei (−85.7%) and cut liquidity by 84.4%. A final swap sandwich followed (blog.bunni.xyz post-mortem).
  - ChainSecurity's EulerSwap audit, 6.2 "Bad Rounding Direction" and 6.5 "Rounding Error Gets Amplified" (`euler-swap/audits/ChainSecurity_EulerSwap_audit.pdf`).
  - Euler's quote code inflates the input on exact output (`QuoteLib.sol:100-103`) and deducts the fee on exact input (`QuoteLib.sol:89-90`).
- **Our advantage.** Price is **stateless**: it is not derived from reserves, so a rounding error does not feed back into the next price. That removes Bunni's amplification loop. **But** rounding still feeds into inventory, collateral buckets and LP NAV, so it can compound there.
- **Rules for PredictionHook.** Amounts are in integer units of 6-decimal tokens; ask ≥ mid ≥ bid, all in 1e18 fixed point.

| Swap | Computed amount | Rounding | Revert if |
|---|---|---|---|
| Buy outcome, exact in (USDC `u` in) | outcome out = `u·1e18 / ask` | **floor** | out == 0 |
| Buy outcome, exact out (`y` out) | USDC in = `y·ask / 1e18` | **ceil** | — |
| Sell outcome, exact in (`y` in) | USDC out = `y·bid / 1e18` | **floor** | out == 0 |
| Sell outcome, exact out (`u` out) | outcome in = `u·1e18 / bid` | **ceil** | bid == 0 |
| LP deposit | shares = `assets·(S+v)/(A+1)` | **floor** | shares == 0 |
| LP withdraw (shares) | assets out | **floor** | — |
| Settlement payout | `winning·1` | exact (1:1 units) | — |

- **Test.**
  - Fuzz tiny amounts (1..1e6 units) and extreme prices.
  - Invariant: a same-block round trip (buy then sell, both exact in, both exact out, and mixed) never returns more than it put in.
  - `exactOut ⇒ amountIn ≥ 1`.
  - Also replay the Bunni pattern: n tiny LP withdrawals must not reduce per-share value for the others.

### 2.6 Exact-in versus exact-out asymmetry (T5, T6)
- **Evidence.**
  - OZ v1.0 **M-02**: the after-swap fee could be bypassed with exact output.
  - OZ v1.0 **M-05**: BaseAsyncSwap only handled exact input, so exact-output swaps fell through to the CL curve.
  - OZ v1.1-RC1 **H-04 / H-06**: code treated `unspecifiedAmount` as always the output, which broke anti-sandwich logic and overcharged users.
  - OZ v1.1-RC2 **M-01**: the same issue in `BaseDynamicAfterFee`, fixed by renaming to `_getTargetUnspecified`.
- **Mitigation.** Implement both paths explicitly, or revert on exact output. Never let a path fall through to the CL curve.
- **Test.** For each price state, check that exact-in(u) → y and exact-out(y) → u' satisfy `u' ≥ u − 1` (the same rate up to rounding) and `u' ≤ u + 1`.

### 2.7 Reentrancy and checks-effects-interactions (T24)
- **Evidence.**
  - OZ PR #166 (merged 2026-09-24). The old code "settled and paid out one currency before it touched the other", so pricing read "the hook's ERC-6909 claim balances … against one post-withdrawal reserve and one pre-withdrawal reserve, which is not a state the pool has been in" (**[corrected]** quote re-taken from the PR page). The fix settles both sides before any payout (`BaseCustomCurve.sol:204`, `BaseCustomAccounting.sol:270`).
  - OZ `CurrencySettler.sol:21-25`: moving an underlying token "hands execution to code the hook does not control … The `PoolManager` is unlocked there".
  - Cantina's EulerSwap review 3.2.1 (Low; in the `report-cantinacode-uniswap-euler-0422` extraction, a different report from the one with 3.3.5): reentrancy via the `uniswapV2Call` hook in `_beforeSwap`. The fix was `nonReentrant` (`UniswapHook.sol:69`).
  - Bunni: a malicious hook deployed via `deployBunniToken()` could "unlock the global reentrancy guard" (Cyfrin summary; secondary).
  - OZ `BaseCustomCurve.sol:34-36`: "share supply is stale for the length of a liquidity modification".
- **Mitigation.**
  - No calls to untrusted code inside `beforeSwap`: claims only, and our own outcome tokens without transfer hooks.
  - `nonReentrant` on all state-changing external entrypoints (LP, settle, redeem, create).
  - Checks-effects-interactions.
  - Any function that calls `poolManager.unlock` automatically cannot run *inside* another unlock (`AlreadyUnlocked`, `PoolManager.sol:105`), which is a useful natural barrier.
- **Test.** Use a malicious ERC-20 mock (with callbacks) as collateral, which must be rejected by the whitelist. Try calling LP functions from inside an `unlockCallback` and expect `AlreadyUnlocked`. Run read-only reentrancy checks on view functions used by integrators.

### 2.8 Native ETH (T27)
- **Evidence.**
  - OZ v1.0 **H-01** "Hooks Do Not Support Native Tokens": the hook had no `receive`, so native settles were impossible.
  - OZ v4-core **C-01**: native and ERC-20 representations of CELO were double-counted to drain native pools. Fixed by the `sync`/`settle` pairing.
  - `CurrencySettler.sol:53-57` reverts native settles whose payer is not the hook (`InvalidNativePayer`).
- **For us.** Collateral is USDC only. Native ETH appears only as `currency0` of the *underlying* pool, which we read and never transfer. The hook should not be payable.

### 2.9 Non-standard tokens
- The Uniswap Foundation framework's category 12 lists fee-on-transfer, rebasing, ERC-777 and pausable tokens.
- USDC specifics:
  - It is upgradeable, pausable and has a blacklist. A blacklist on `PoolManager` or on the hook blocks ERC-20 `take`. A pause freezes all settlement.
  - Mitigation: keep collateral as ERC-6909 claims inside `PoolManager` wherever possible, and document the dependency.
- **Outcome tokens:** plain ERC-20, `decimals()` = 6 to match USDC, mint and burn only by the hook, no permit/hooks/pause.

### 2.10 Donations and raw-balance reliance (T26)
- **Evidence.**
  - Cantina's EulerSwap review 3.2.2 "Unrestricted Donations": the fix was `beforeDonate` returning a revert. It is the `beforeDonate: true` entry in `UniswapHook.sol:134-150`.
  - Paladin Valkyrie: "Donations can be made directly to the Uniswap v4 pool due to missing overrides" (Cyfrin summary; secondary).
  - ERC-4626 inflation attacks rely on `balanceOf` (§6, T15).
- **Mitigation.**
  - Internal accounting only. Never price or compute NAV from `balanceOf` or ERC-6909 `balanceOf(hook, id)`.
  - Revert in `beforeDonate`.
  - An owner `sweep` for surplus above the internal total, kept below the internal total.

### 2.11 Permission-bit mismatch (T29)
Covered in §1.1. Also note that Euler overrides `validateHookAddress` for proxies and validates in `activateHook` instead (`UniswapHook.sol:39`, `61-64`).

### 2.12 DoS: hooks that revert, and blocked exits (T27)
- **Evidence.**
  - ToB pattern 6, "Hook failures can block pool actions" **[corrected title]**: "keep non-essential code out of the main user flow. Wrap optional external calls in `try`/`catch`, or move optional logic to a separate function users can call after exiting."
  - Guardian's Gamma **H-01**: "dust balances that prevent account deltas from being fully settled" (secondary).
  - OZ v1.1-RC2 **H-01**: an infinite tick loop in AntiSandwichHook (`tick != currentTick` never true for a misaligned tick) made every swap a DoS.
  - v4-core's `Known_Effects_of_Hook_Permissions.pdf`: remove-liquidity hooks that revert mean "user funds could be permanently locked".
- **Mitigation.**
  - Redemption and LP exit must **not** depend on the swap path, on oracle freshness, or on any admin action.
  - Pauses may block *new risk* (buys and sells) but never redemptions.
  - No unbounded loops over markets.

### 2.13 Upgradeability and admin (T28)
- The Uniswap Foundation framework gives upgradeability 0–3 points. Upgradeable hooks need a "storage collision review", a "documentation of upgrade policy", and a "time-lock or multisig".
- ToB audit question 5 asks whether "permission bits, functions, return values, and upgrade paths align".
- Recommendation:
  - An immutable hook with **market parameters fixed at creation** (K, T, W, cutoff, σ bounds, caps). This matches the product spec's "fixed parameters".
  - Global parameters behind a timelock, applying only to new markets.
  - No admin override of settlement, except a bounded fallback path (T14).

### 2.14 Transient storage (T25)
- **Evidence.**
  - **SIR.trading (2025-03-30, $355k).** A transient slot `0x1` held the authorized Uniswap v3 pool address for `uniswapV3SwapCallback` but was later overwritten with an *amount*. The attacker brute-forced a vanity contract address equal to that amount and passed the callback check (Verichains, Blockscope, SIR docs; secondary). Transient values live for the whole transaction and must be cleared after use.
  - ToB pattern 7, "State can change during a callback sequence" **[corrected title]**: "avoid shared scratch state. If data must cross callbacks, key it by `PoolId` and caller, reject overlapping operations while that state is live, and clear it after use."
  - Angstrom keeps `tint256 currentTickBeforeSwap` between `beforeSwap` and `afterSwap` (`angstrom/contracts/src/modules/UnlockHook.sol:36`, `65`). Keying by pool is not needed there because it does not re-enter.
- **Mitigation.** PredictionHook does not need `afterSwap`, so it should use no transient state across callbacks. If it does, key by `PoolId`, clear it, and test multi-hop routes (YES→USDC→NO in one V4Router call) and repeated swaps in one transaction.

### 2.15 Hooks priced off an oracle or pool state (T8–T11)
- **Evidence.**
  - **Flaunch security finding "H-4".** The internal fill was priced at live spot. It was fixed with a 10-minute TWAP and a "no-fill if the oracle is unseeded" rule (`flaunchgg-contracts/src/contracts/hooks/InternalSwapPool.sol:151-164`; `src/contracts/Oracle.sol:20-22` for the quote, `:29` `TWAP_WINDOW = 600`, `:33` `MAX_OBSERVATION_CARDINALITY = 300`; pre-swap tick recorded at `PositionManager.sol:410-412`):
    > "Observations are written at most once per block. Because the buffer is populated from the tick recorded at the start of a block, an attacker cannot influence the historical reference within their own transaction, which is what defeats atomic spot-price manipulation."
  - **SpiralHookV2 (2026-09-14, 10.7 ETH).** Collateral was valued at "the pool's live spot price … Without any price limits" and exploited within a single block (Cryptonomist; secondary, **UNVERIFIED** details).
  - OZ v1.0 **M-04**: `poke` lets anyone reset the dynamic fee from manipulable external state within one transaction.
  - OZ v1.1-RC1 **M-03**: anti-sandwich anchoring removes the arbitrage incentive, so the start-of-block price itself can become stale or manipulated.
  - Classic non-v4 cases:
    - Mango Markets (Oct 2022, about $114M): a thin-market perp mark was manipulated.
    - Inverse Finance (Apr 2022, about $15.6M): a thin SushiSwap TWAP was manipulated over a few blocks.
    - KiloEx (Apr 2025, about $7.5M): price-feed access control was bypassed through `MinimalForwarder`, letting the attacker set prices (Halborn, CoinDesk; secondary).

  Full analysis is in §5.

### 2.16 The malicious-hook ecosystem, and trust in our hook (T30)
- ToB's v4-core review TOB-UNI4-6 notes that v4 makes it "much easier … for malicious actors to trick users into using malicious pools".
- 0x (September 2026): 84,163 hooks analysed, 19.4% safe, 54.2% malicious, 26.4% likely malicious. The worst fills were "as much as 50% less at execution than the amount quoted" (secondary).
- **For us:** a legitimate custom-curve hook has to *earn* routing. It needs deterministic quotes, a `quote()` view, public audits, a hooklist entry plus a routing allowlist application, no `hookData` requirement, and events.

### 2.17 Hook-adjacent integrations
- rsETH, 2026-09-15, $7.73M (secondary, **UNVERIFIED**). A public "Keeper Multicall" was used "to redirect the Safe's custom Uniswap V4 LP module to a Hook Pool created by the attacker".
- Lesson: every module that accepts a `PoolKey` or hook address is an attack surface. The same lesson as §2.2.

---

## 3. Audit findings on reference code

### 3.1 OpenZeppelin uniswap-hooks

| Audit (dates) | ID | Title | Relevance to PredictionHook |
|---|---|---|---|
| v1.0.0-RC1 (Jan 7–17 2025, commit 1db9646) | **C-01** | Non-explicit multiple-pool support allows overwriting hook state | Our hook is multi-market: **all state keyed by PoolId**, and initialization only by the hook itself. |
| | H-01 | Hooks do not support native tokens | We avoid native collateral. |
| | H-02 | Insufficient slippage check (fees flip the sign; no check on remove) | LP functions need `minShares`/`minAssets` and a deadline. |
| | M-02 | Dynamic after-swap fees skippable via exact output | Handle exact output explicitly. |
| | M-03 | Unsafe casting due to accrued fees | Use SafeCast; sign-check before negating. |
| | M-04 | `BaseDynamicFee` can be poked arbitrarily | No permissionless parameter refresh from manipulable state. |
| | M-05 | BaseAsyncSwap only handles exact input | Same. |
| | M-06 | Unintuitive return delta | Sign conventions (§1.2). |
| | L-02 | "Insufficient Documentation" **[corrected title]**. One bullet says a per-LP salt is needed, or anyone can remove others' liquidity. | We use no CL positions, but the same idea applies to per-user vault accounting. |
| | L-04 | `BaseHook.unlockCallback` not needed; opens reentry | T4. |
| v1.1.0-RC1 (Apr 25–May 12 2025) | C-01 | JIT penalty bypass via `increaseLiquidity` collecting fees | Callback-timing class (ToB 4). |
| | C-02 | Asymmetric first-in-block snapshot leads to stale state | Oracle snapshot must be complete and taken at the start of the block. |
| | H-04 / H-06 / H-07 | `unspecifiedAmount` treated as output; unsafe `int128→uint128` | T5, T6. |
| | H-05 | Sandwich via JIT against the anti-sandwich donation | Donations and JIT around fee redistribution. |
| | M-01 | `block.number` on Arbitrum returns the L1 block | Same-block logic on L2s (T31). |
| | M-03 | Anti-sandwich breaks start-of-block price reliability | Oracle design. |
| v1.1.0-RC2 (Jun 16–26 2025, fixes at 67ddcdf) | H-01 | Infinite loop in tick iteration (misaligned tick) causes swap DoS | Loops over ticks or observations must be bounded. |
| | M-01 | Fee applied to input when unspecified is input | T5. |
| | L-02 | Penalty redirected with a secondary account | Multi-account coordination. |
| 2026 engagement (**UNVERIFIED** which report; the PR title cites M-09) | M-09 (PR #170, merged 2026-09-24, "BaseCustomAccounting: M-09 document permissionless pool initialization") | Permissionless first initialization binds the hook. The PR says the same finding was closed earlier for ReHypothecationHook. | T2. |
| Not tied to an audit ID **[corrected]** | PR #166 (merged 2026-09-24, "BaseCustomCurve and BaseCustomAccounting CEI enforcement") | CEI: settle both currencies before paying either | T24. |

**Important structural fact.** `BaseCustomAccounting` and `BaseCustomCurve` are **single-pool** by design: "This base hook is designed to work with a single pool key" (`BaseCustomAccounting.sol:31-33`), with a `PoolKey private _poolKey` (`:109`). A multi-market PredictionHook therefore cannot inherit them as they are. Reuse their `_beforeSwap` claim-settlement pattern (`BaseCustomCurve.sol:90-156`) inside a multi-market design based on `BaseHook`.

Also note `BaseCustomCurve.sol:262-268`: `_getSwapFeeAmount` "is only reported in the `HookSwap` event and is not applied … The amount returned by {_getUnspecifiedAmount} must therefore already account for the fee". This is a footgun.

### 3.2 v4-core audits (hook-relevant items)
- **OpenZeppelin core C-01.** Double-counting native and ERC-20 CELO drained native pools. Fix: pair each `sync` with the next `settle` (§1.3).
- **OpenZeppelin core M-03**, "Front-Running Pool's Initialization or Initial Deposit". With zero liquidity, a swap can move `sqrtPriceX96` anywhere for free. Acknowledged: "prevented by peripheral contracts adding slippage protection".
  - Relevance: never read S from a pool that can be empty or thin.
- **Certora I-01** "Flash accounting cannot be used for actions that require untrusted calls": an untrusted contract can leave a nonzero delta and revert the whole `unlock`.
  - Relevance: never call untrusted code inside the hook's unlock.
- **Spearbit M** "Donations can be stolen by providing just-in-time liquidity". Also 5.4.15 "Pools with maximum lpFee do not support exact output swaps".
- **Trail of Bits:** 1 low and 5 informational findings, plus 100 invariants (8 proved with Halmos, 88 with Medusa/Echidna). Its fuzzing harness design (Appendix D, "Actions Harness") is a template for our invariant tests.
- **`Known_Effects_of_Hook_Permissions.pdf`** has two warnings about `beforeSwapReturnDelta` hooks that apply to us:
  - On exact input, a hook "can 'take' all specified token without crediting the user with anything — should be checked in a router".
  - A badly written hook that "blindly credits without checking liquidity status" lets users drain the hook: "A user can always take the full creditable amount from the hook".

  For PredictionHook this means checking capacity against per-market collateral before crediting.

---

## 4. Production custom-curve and custom-accounting hooks

| Hook | Input leg in `beforeSwap` | Output leg | Exact output | Initialization guard | Donate guard | Reentrancy | Price source |
|---|---|---|---|---|---|---|---|
| **OZ BaseCustomCurve** (reference) | `take(claims=true)`, i.e. ERC-6909 `mint` (`BaseCustomCurve.sol:115`, `123`) | `settle(burn=true)`, i.e. ERC-6909 `burn` (`:117`, `125`) | Yes (`:120-128`) | `AlreadyInitialized`, first key wins (`BaseCustomAccounting.sol:337-345`) | — | CEI (PR #166) | Virtual `_getUnspecifiedAmount` |
| **Euler Swap** | ERC-20 `poolManager.take` into the Euler vault (`UniswapHook.sol:109-112`) | `sync` → vault withdraw to `PoolManager` → `settle` (`:114-118`) | Yes (`:79-86`, `105-107`) | Self-`initialize` in `activateHook` (`:36-54`) plus the `BaseHook` revert | `beforeDonate` reverts (`:134-136`) | `nonReentrant` (`:69`) | Custom curve on reserves; `QuoteLib` caps `amount ≤ uint112.max` (`QuoteLib.sol:79`), checks `expiration` (`:82`), **[corrected]** the curve itself rounds in the pool's favour (`CurveLib.sol:66`, `72`, `146-148` use `DivUp`/`sqrtUp`), **but** the fee arithmetic in `QuoteLib.sol:90` (`amount - amount*fee/1e18`) and `:102` (`quote*1e18/(1e18-fee)`) floors, which favours the trader by up to 1 wei. This is a real-world example that the rounding direction must be checked on *every* step. |
| **Bunni v2** | `poolManager.mint(this, input)` (`BunniHookLogic.sol:519`) | `poolManager.burn(this, output)` (`:530`) | Yes, with max/min clamps (`:434-441`, `480-488`) | — | — | Global guard; the bypass via a malicious hook was a finding | LDF on reserves. **Exploited through rounding (§2.5)** |
| **Flaunch** | Internal swap pool (ISP): `take` native plus `settle` memecoin (`PositionManager.sol` `_processInternalSwap`) | Same | Yes | `revert CannotBeInitializedDirectly()` (`:342-348`) | — | — | ISP fills priced at a **10-minute TWAP**; the oracle records the pre-swap tick at most once per block (`:412`); H-4 fix |
| **Angstrom** | No custom curve. `beforeSwap` requires a block "unlocked" by a node's signed attestation (`UnlockHook.sol:38-65`, `TopLevelAuth.sol:193-214`) | Protocol fee via `afterSwap` return delta, minted as claims to the fee collector | — | — | — | — | Top-of-block auction; "OnlyOncePerBlock" (`TopLevelAuth.sol:193-195`, `222-226`) |
| **Doppler** | Bonding-curve launch | — | — | `require(sender == address(this), OnlyInitializer())` (`DopplerHookInitializer.sol:496-499`) | — | — | Dutch auction on ticks; Certora C-01 malicious `PoolKey` (secondary) |
| **Arrakis Pro Private Hook** | CL. `beforeAddLiquidity` allows only the Arrakis module; `beforeSwap` overrides the dynamic fee per direction using CEX-aware executors (Arrakis docs; secondary, code not reviewed, **UNVERIFIED**) | — | — | — | — | — | Off-chain informed fees against LVR |

Takeaways:
1. The **claims-based NoOp** used by OZ and Bunni is the cleanest pattern for a hook that holds its own inventory inside `PoolManager`. It does not need `PoolManager`'s ERC-20 balances and makes no external calls in the swap path.
2. **Self-initialize and revert** is the norm in production.
3. **Oracle-priced fills use TWAPs of previous blocks**, as Flaunch does after its H-4 finding.
4. Every production system that combines **expiring instruments** and **AMM pricing** had near-expiry problems: Cork's HIYA exponent, and Lyra's `tradingCutoff`, `minDelta` and circuit breakers (§5.4).

---

## 5. Oracle manipulation of hooks that price off pool state

### 5.1 Where S (and σ) can come from

v4 pools have **no built-in oracle**. The main options:

| Source | Atomic (same-transaction) manipulable? | Multi-block manipulable? | Notes |
|---|---|---|---|
| `getSlot0` of the ETH/USDC v4 pool, read via `StateLibrary`/`extsload` | **Yes, capital-free inside one unlock** | Yes | Never use it alone for pricing or settlement. |
| TWAP from a v3-style oracle on a pool whose *every swap* is observed: the v3 ETH/USDC 5 bp pool, or a v4 ETH/USDC pool carrying an oracle hook such as OZ `BaseOracleHook`/Panoptic truncated oracle (`oz-uniswap-hooks/src/oracles/panoptic/BaseOracleHook.sol:114-137`, `Oracle.sol:38-56`) | **No**, if the window ends at the last observation. The first swap of a block writes the *pre-swap* tick. | Costly, but cheaper under PoS/L2 (§5.5) | The truncated oracle caps the per-block tick delta at `MAX_ABS_TICK_DELTA` (`BaseOracleHook.sol:47`). The deepest v4 ETH/USDC pools appear to be hookless (**UNVERIFIED**); a new oracle-hook pool may be thin. |
| Our own sampler: the hook or a keeper reads `slot0` of the hookless v4 pool at most once per block | The sample can be manipulated by whoever triggers it in that block | Medium | Needs truncation plus a median. Weaker than a pool-attached oracle. |
| External signed prices (Chainlink Data Streams, Pyth, RedStone) passed in `hookData` | Not by pool swaps; must verify signature, feed id and timestamp | — | Not "Uniswap-native". The user can **choose** which valid report to submit within the staleness window, so use a short window and a worst-case rule. |

### 5.2 Economics of atomic manipulation with flash accounting

Model the underlying pool locally as a constant-product pool with virtual value `V` in range. Moving the price by a relative δ needs a notional of about `V·δ/4`. An in-transaction round trip costs about `2·fee·V·δ/4 = fee·V·δ/2`. The constant-product curve is path-independent, so the return leg recovers the principal minus fees.

A binary YES contract moves by `ΔP ≈ φ(d2)·δ/(σ√T)` per unit of log-spot move. An attacker who buys q contracts at the manipulated price and sells them at the restored price, paying the hook's half-spread h on each leg, earns:

```
profit(q, δ) ≈ q·( φ(d2)·δ/(σ√T) − 2h ) − fee·V·δ/2
```

- To first order this is linear in δ. With h = 0 the break-even is `q* = fee·V·σ√T / (2φ(d2))`, **independent of δ**.
- **[corrected]** The draft said the attacker then "pushes as far as the price clamps allow". That only holds to first order. The exact gain `q·(P(S) − P(S(1−δ)))` is bounded and concave in δ, while the CPMM cost is convex in δ. So the break-even `q*` is the δ→0 infimum, and the profit-maximising δ is finite. We re-checked this with exact CPMM and BS math (`scratchpad/verify06/check.py`; 1 h, $100M, 5 bp):
  - q = 300: no δ is profitable.
  - q = 402: break-even.
  - q = 1,000: the best profit is about $189, at δ ≈ 1%.
  - q = 10,000: the best profit is about $4.2k, at δ ≈ 3%.
- The conclusion does not change: every q above q* is profitable.
- q is counted in contracts, each paying $1. The premium spent is about q·P, roughly q/2 at the money.

Computed with mpmath (`scratchpad/sec/sens.py`), ATM, σ = 60%:

| Pool fee | V (virtual, in range) | T = 7d | T = 1d | T = 1h | T = 5m |
|---|---|---|---|---|---|
| 5 bp | $10M | $521 | $197 | $40 | $12 |
| 5 bp | $100M | $5,211 | $1,968 | **$402** | $116 |
| 30 bp | $100M | $31,269 | $11,810 | $2,410 | $696 |

**[corrected]** The 7d column changed by about 0.1%. The draft used φ(0) instead of φ(d2) with d2 = −σ√T/2. The other cells were reproduced independently. The year is taken as 365 days.

These are break-even YES notionals. With a half-spread h, the spot move needed is only `δ_min = 2h·σ√T/φ`. For h = 0.5c that is 7.9 bp at 1 day, 1.6 bp at 1 hour and 0.46 bp at 5 minutes. For h = 2c it is 31, 6.4 and 1.9 bp.

**Conclusion: current-block spot pricing is unsafe at any realistic size.** The multi-hop "ETH→USDC (underlying pool) → YES" route shows that even honest users push S against themselves inside one route.

### 5.3 Binary-option amplification near expiry

ATM sensitivity (σ = 60%, S = K = 5000; `sens.py`, `lat.py`):

| T to expiry | σ√T | Spot move that shifts YES by 1c | YES change for one 1σ block (12s L1 / 2s / 1s) | Error from rounding S to 1 tick (1 bp) |
|---|---|---|---|---|
| 30d | 0.172 | 43 bp | — | — |
| 1d | 0.0314 | 7.9 bp | 0.47c / 0.19c / 0.14c | 0.13c |
| 4h | 0.0128 | 3.2 bp | 1.15c / 0.47c / 0.33c | 0.31c |
| 1h | 0.0064 | 1.6 bp | **2.30c** / 0.94c / 0.66c | 0.62c |
| 15m | 0.0032 | 0.80 bp | 4.61c / 1.88c / 1.33c | 1.24c |
| 5m | 0.0019 | 0.46 bp | 7.98c / 3.26c / 2.30c | 2.16c |
| 1m | 0.0008 | 0.21 bp | 17.8c / 7.3c / 5.2c | 4.8c |

The one-block 1σ move for ETH at 60% vol is 3.7 bp on 12 s blocks, 1.5 bp on 2 s blocks and 1.07 bp on 1 s blocks.

Two conclusions:
- **ATM trading inside about 15–60 minutes of expiry cannot be market-made** without a spread larger than several cents. This is the quantitative basis for the cutoff.
- A TWAP read as an *integer* mean tick adds up to 1 bp of error, which is material near expiry. Compute the mean log-price in fixed point, `ΔtickCumulative·ln(1.0001)/Δt` in 1e18 precision, rather than using `int24` floor division.

Cork's HIYA shows the same failure shape. With `rT = (F/pT)^(1/T) − 1`, "the same 5% CT discount generates a risk premium ~1,500x larger near expiration" (BlockSec; secondary).

### 5.4 Defences, from strongest to weakest, and combined

1. **An oracle window ending before the current block.** Use observations written with the pre-swap tick at most once per block. This is v3 semantics, OZ `BaseOracleHook`, and the Flaunch `Oracle`.
   - **[corrected]** For an oracle that observes *every* tick-changing action with the pre-action tick, `observe([W, 0])` is already atomic-safe. Examples are v3 `Oracle` and OZ `BaseOracleHook` writing in `beforeSwap` at most once per block (`panoptic/libraries/Oracle.sol:108`).
     - If an observation exists at `block.timestamp`, it is returned as stored.
     - If none exists, no swap has happened in this block, so the current tick is still the previous block's closing tick. Extrapolating with it (`Oracle.sol:38-58`, `BaseOracleHook.observe`) is correct.
   - The "`secondsAgo = 0` uses the current, manipulable tick" hazard applies only where the tick can move without an observation being written first. That covers our own sampler over a hookless pool, a hook that writes in `afterSwap` (the post-swap tick), or a pool whose hook itself swaps (skipped callback). In those cases, cut the window off at the last observation strictly before this block.
2. **Dual-price quoting.** `ask = max(P(S_spot), P(S_twap)) + h`, `bid = min(P(S_spot), P(S_twap)) − h`.
   - Pushing spot down cannot lower the ask below P(twap), and pushing spot up cannot raise the bid above it, so atomic round trips lose at least 2h.
   - If the market *really* moved (spot fresh, TWAP stale), arbitrageurs cannot trade the stale side either.
   - The spread widens automatically by |P(spot) − P(twap)| in volatile periods.
   - Cross-outcome consistency is preserved: `askY + askN = 1 + |ΔP| + 2h ≥ 1`.
   - The same principle as lending's "min for collateral, max for debt". We have not found it documented in production hooks in exactly this form, so it is **our proposal**.
3. **A spread scaled to gamma and delta.** `h ≥ c·|∂P/∂lnS|·σ_block`, with `∂P/∂lnS = φ(d2)/(σ√T)`, charged per contract (§5.3).
4. **Caps.** Limit per-transaction and per-block net delta, and cap liability per market (max(YES_out, NO_out) exposure versus collateral). Euler caps amounts at `uint112`; Lyra v1 blocks trades whose `|delta|` is out of range (`OptionMarketPricer.sol:340-347`) and clamps skew into `[absMinSkew, absMaxSkew]` (`:261`, `311`).
5. **Trading cutoff** `T − cutoff`, with `cutoff ≥ W + margin`. Lyra v1 `isPostCutoff = block.timestamp + tradingCutoff > boardExpiry` (`OptionMarketPricer.sol:252`, `273`).
6. **Circuit breakers** on the deviation between spot and TWAP, and on σ jumps. Lyra v1 `CircuitBreakerParameters` (`LiquidityPool.sol:104-121`: `ivVarianceCBThreshold`, `liquidityCBThreshold`, timeouts) block LP deposits and withdrawals while greeks are unreliable.
7. **Price clamps.** Clamp to `[p_min, 1 − p_min]`, and halt, rather than quote, outside them. Model tails ignore jump risk.
8. **Defence-in-depth idea (not seen in production; weak, [corrected]).** In `beforeSwap`, before the hook's own `mint`/`burn`, require `TransientStateLibrary.getNonzeroDeltaCount(poolManager) == 0` (`v4-core/src/libraries/TransientStateLibrary.sol:28`).
   - This only forces the manipulation leg to be settled with real tokens before our swap. That is **not** a real barrier:
     - Zero-fee flash loans (Balancer, Morpho) supply the capital.
     - A single transaction may make several *sequential* `unlock` calls: manipulate and settle in unlock #1, trade YES in unlock #2, restore in unlock #3. `AlreadyUnlocked` blocks only nested unlocks (`PoolManager.sol:105`).
   - It also rejects legitimate multi-hop routes. Do not rely on it. The real defences are #1 and #2.

### 5.5 Multi-block manipulation (PoS and L2)
- Uniswap Labs, "Uniswap v3 TWAP Oracles in Proof of Stake" (blog.uniswap.org/uniswap-v3-oracles):
  - A proposer who controls consecutive blocks avoids the arbitrage between them, which makes multi-block TWAP manipulation much cheaper. (The draft's verbatim quote "almost entirely from losses to arbitrageurs" could not be re-confirmed: **UNVERIFIED wording**.)
  - Wide-range liquidity is the best mitigation: "adding a single $1m wide-range mint on USDC/WETH 5 bps makes a two-block oracle attack cost around $360b more".
  - Time-weighted *median* (TWMP) or winsorized oracles require manipulating more than half the blocks.
- ChainSecurity, "Why is Oracle Manipulation after the Merge so cheap? Multi-Block MEV" (secondary).
- Müller, Moumeni, Messaoudi, "Cost of Manipulation in AMM-Based Oracles" (arXiv 2606.03548, FC'26 DeFi workshop): in a frictionless CPMM model with cross-pool arbitrage, the manipulation cost "depends only on the total quote depth and coincides across symmetric aggregators". They also solve the attacker–designer game for weighted means and medians. **[corrected]** The draft's "liquidity-weighted medians are optimal" was not confirmed from the abstract (**UNVERIFIED**).
- **L2s** (Base, Arbitrum, Unichain): a single sequencer orders every block, and blocks are 1–2 s, so the sequencer is a trusted party for oracle integrity.
  - On Arbitrum, `block.number` is the L1 block (OZ v1.1-RC1 M-01).
  - Sequencers have some freedom over timestamps (bounds **UNVERIFIED**). Add margins around cutoff and expiry.

---

## 6. Threat model for PredictionHook

Impact: **C** critical (LP or collateral loss), **H** high, **M** medium, **L** low.

| ID | Threat | Impact | Mitigation | How to test in Foundry |
|---|---|---|---|---|
| T1 | Direct call of `beforeSwap` or other callbacks (Cork) | C | `BaseHook` `onlyPoolManager` on all `IHooks` entrypoints; internal `_beforeSwap` | For each `IHooks` selector: `vm.prank(attacker)` and `expectRevert(NotPoolManager)`. A selector-list meta-test. |
| T2 | Foreign pool initialized with our hook (arbitrary currencies, fee, tickSpacing, dynamic-fee flag) | H | Hook self-initializes; `_beforeInitialize` always reverts; `_beforeSwap` requires a registered market | Fuzz `PoolKey` and `sqrtPrice`; `PoolManager.initialize` must revert (`CustomRevert.WrappedError` wrapping `HookCallFailed`, see §2.2). Assert `beforeSwap` on an unregistered id reverts (via a harness that bypasses init). |
| T3 | Untrusted `PoolKey` or `hookData` reaching logic (Cork, SVFHook, Doppler) | C | Public API takes `marketId`; key comes from storage; `hookData` ignored, or only emitted | Fuzz `hookData` (0–1 kB random): outputs are identical. Static test that no external function takes `PoolKey`. |
| T4 | `unlockCallback` spoofing or crafted unlock data | H | `onlyPoolManager`; enum-tagged internal payloads; no user bytes forwarded | Direct call reverts. An attacker contract calling `PoolManager.unlock` cannot reach our callback. Fuzz the payload decoder. |
| T5 | Wrong delta sign, currency or scale; partial consumption | C | Canonical orientation helper; `specifiedDelta == −amountSpecified` asserted; SafeCast | Fuzz 2 orderings × 2 directions × exact in/out through the **real V4Router**. Assert user/hook balance changes equal a reference model. Assert `slot0` unchanged and `Swap` event amounts zero. |
| T6 | Rounding favours the trader: free output, free input, round-trip profit (TOB-BUNNI-15..18) | H | Floor outputs, ceil inputs; revert on zero; bid ≤ mid ≤ ask | Fuzz tiny and huge amounts. Invariant `roundTripProfit ≤ 0` for every combination. `exactOut ⇒ amountIn ≥ 1`. Bunni-style repeated micro-operations. |
| T7 | Cross-outcome arbitrage: `askY + askN < 1` or `bidY + bidN > 1`, including rounding | H | Both sides derived from one mid and one clamp; dual-price keeps the sums ≥1 and ≤1 | Fuzz state: buy y YES + y NO (exact out) and merge, which must cost ≥ y; split and sell, which must return ≤ y. Multi-hop YES→USDC→NO in one V4Router call is not profitable. |
| T8 | Atomic spot manipulation of the underlying (flash accounting, zero capital) | C | Oracle window ends at the last observation before the current block; dual-price; caps | `Attacker is IUnlockCallback`: swap the ETH/USDC pool → buy YES → swap back → sell YES, all in one unlock. Fuzz δ and q. Assert attacker PnL ≤ 0. Repeat on a mainnet fork with real liquidity. |
| T9 | Multi-block TWAP manipulation (proposer or sequencer) | H | Longer W; median or truncated oracle; minimum-depth requirement for the oracle pool; deviation circuit breaker | Simulate k manipulated blocks with `vm.roll`/`vm.warp`; compute cost (arbitrage loss) versus profit. Assert the breaker trips when |spot − TWAP| > threshold. |
| T10 | Stale-price or latency arbitrage (LVR) against LPs | M (economic) | Dual-price; gamma-scaled h; cutoff; per-block flow caps | Agent-based simulation: GBM path plus an arbitrageur with a one-block look-ahead. LP PnL distribution versus h, cutoff and W (Foundry or Python). |
| T11 | Manipulated or degenerate σ estimator (oscillation inflates it, gaps bias it, truncation biases it low) | M | `σ ∈ [σ_min, σ_max]`; bounded change per update; option to fix σ per market; estimator from observations before the current block only | Oscillation attack harness: σ change ≤ bound; cost ≥ gain. Fuzz observation gaps. Compare against an mpmath estimator. |
| T12 | Settlement manipulation at T (single-block push across K) | C | `S_T` = TWAP or median over [T − W, T]; compare in log-price fixed point; `S_T == K ⇒ NO`; permissionless `settle` after T | Manipulate in the blocks around T; the outcome must not change. Boundary tests at `S_T` = K ± 1 unit. |
| T13 | Trading with a known or partly known outcome (after cutoff, inside the averaging window, after expiry, before settlement) | H | `beforeSwap` reverts when `block.timestamp ≥ T − cutoff`, with `cutoff ≥ W + margin`; after settlement, only redemption | `vm.warp` to T − cutoff ± 1 s, T ± 1 s, and settlement ± 1 s. Each path reverts or succeeds as specified. |
| T14 | Settlement griefing or oracle unavailability: no observations, ring buffer overwritten, oracle pool dead | H | v3-style extrapolation (`observe` uses the current tick when there has been no swap since); keeper checkpoints of cumulatives at T − W and T; after a grace period, a fallback (external oracle or last mark); **redemptions never locked** | No swaps near T; settlement delayed past the buffer; oracle pool drained. Settlement still resolves via the defined fallback, and redemptions work. |
| T15 | LP vault inflation or first-depositor attack | H | Internal-accounting NAV (not `balanceOf`); virtual shares (OZ ERC-4626 `_decimalsOffset`, `ERC4626.sol:226`, `233`) or dead shares; minimum first deposit | Classic PoC: 1-wei deposit, then donations (ERC-20 to the hook and ERC-6909 to the hook), then a victim deposit. Victim loss < ε. |
| T16 | LP NAV manipulation: deposit or withdraw at a manipulated mark, or JIT LP around a big trade | H | NAV from TWAP; deposit at max(NAV), withdraw at min(NAV); queued deposits and withdrawals with a delay (Lyra v1 `depositDelay`/`withdrawalDelay`/`withdrawalFee`, `LiquidityPool.sol:87-91`, `262-420`), or per-market LP locked until settlement | Flash-loaned capital manipulates S across separate unlocks around deposit and withdraw: no profit. JIT deposit, big trade, withdraw: the JIT LP earns ≤ its time-weighted share. |
| T17 | Collateral insolvency; outcome supply invariant broken | C | Complete sets: `setsMinted_m == YES_m.totalSupply == NO_m.totalSupply` (this includes the hook's own inventory held as claims inside `PoolManager`, see §9.4a). Solvency: `usdcClaims_m ≥ max(YES_m.totalSupply − hookYES_m, NO_m.totalSupply − hookNO_m)`. After settlement: `usdcClaims_m ≥ outstandingWinning_m`. Exposure caps. | Stateful invariant fuzzing with a handler over every action (§7). |
| T18 | Cross-market contamination in a singleton (Cork) | H | Per-market buckets; Σ buckets ≤ claims balance; outcome tokens never accepted as collateral or underlying | Invariant `Σ_m bucket_m ≤ PoolManager.balanceOf(hook, USDC.id)`. Markets with adversarial parameters cannot touch other markets' buckets. |
| T19 | Market-creation spam or malicious parameters (tiny T, strike far away, zero σ) | M | Creation permissioned or bonded; bounds on T, K (relative to TWAP), W and cutoff; LP opt-in; no loops over markets | Create N = 1..500 markets: swap gas is independent of N. Fuzz invalid parameters: all revert. |
| T20 | Math domain, precision and overflow (T→0, σ→0, |d2|→∞, ln domain, 1e18↔1e6 conversion, `int128` casts) | H | Clamp d2 to ±8..10; saturating CDF; price clamp; cutoff before T; `FullMath.mulDiv`; SafeCast | Differential fuzzing against mpmath via FFI (the template has `ffi = true`). Boundary fuzz: no revert inside the allowed domain, revert outside it. |
| T21 | Token-ordering and orientation bugs: YES versus USDC, and the underlying ETH/USDC orientation. On mainnet USDC (`0xA0b8…`) < WETH (`0xC02a…`); on Base (`0x4200…06` WETH < `0x8335…` USDC) and Arbitrum (`0x82aF…` WETH < `0xaf88…` USDC) it is the reverse; native ETH is always `currency0` | H | Store `yesIsCurrency0`, `underlyingBaseIs0` and decimals at creation; derive the price in the log-tick domain with an explicit sign | Deploy YES at addresses both below and above USDC (CREATE2 salt search or `vm.etch`). Underlying pools in both orientations. The same economic results must follow. |
| T22 | Partial fill or fall-through to the CL curve (gas bomb, `slot0` moves) | M | Always consume fully or revert; `beforeAddLiquidity` reverts (no CL liquidity) | Assert `slot0` unchanged after every swap. Gas snapshot. Capacity-exceeded swaps revert. |
| T23 | `sync` interleaving and dependence on `PoolManager`'s ERC-20 balances (§1.3) | M | ERC-6909 `mint`/`burn` in `beforeSwap`; any `sync` is atomic (`sync → transfer → settle`) | **Fresh `PoolManager` with zero balances**, swaps via V4Router, and a custom router that does `sync` before `swap`. |
| T24 | Reentrancy or mid-state reads (token callbacks, nested unlock, read-only reentrancy) | M | No untrusted calls in the swap path; `nonReentrant`; CEI; natural `AlreadyUnlocked` barrier | Reentrancy attempts from mock tokens and from an `unlockCallback`. View functions are consistent during callbacks. |
| T25 | Transient-storage misuse (SIR.trading) | M | Avoid; if used, key by PoolId and clear | Multi-hop and repeated swaps in one transaction; the second swap sees no stale transient values. |
| T26 | Donations or direct transfers skewing accounting | L/M | Internal accounting; `beforeDonate` reverts; owner sweep of surplus only | Donate ERC-20 and ERC-6909 to the hook: prices and NAV unchanged; sweep ≤ surplus. |
| T27 | DoS or blocked exits (stale oracle, pause, USDC blacklist or pause) | M | Redemption independent of the swap path and oracle; pauses block only new risk | Simulate oracle failure and pause: redeem and LP exit after settlement still work. |
| T28 | Admin, upgrade or parameter abuse | H (trust) | Immutable hook; per-market parameters immutable; timelock for global parameters; no settlement override | Access-control tests; attempts to change a live market's parameters revert. |
| T29 | Permission-bit mismatch | M | `BaseHook` validation; mask 0x2AA8 | Deploying at a wrong address reverts. `getHookPermissions` matches the implemented overrides. |
| T30 | Quote and execution mismatch, aggregator distrust, user slippage | M | Deterministic pricing given (timestamp, oracle); `quote()` view; `HookSwap` events; no `hookData` requirement; front-ends set `amountOutMinimum` | `V4Quoter` quote equals execution in the same block. Across blocks, the difference is explained only by time and oracle. |
| T31 | L2 timestamp and block-number quirks | M | Margins on cutoff and expiry; avoid `block.number` semantics on Arbitrum | Fork tests per target chain. |
| T32 | Identity assumptions (sender is the router; `tx.origin`; EIP-7702) | L/M | No authorization from `sender` or `tx.origin`; if user identity is ever needed, `IMsgSender` on allowlisted routers | Swaps via V4Router, Universal Router, a custom contract and 7702-style code: identical economics. |

### 6.1 Notes on the design-specific threats

- **Settlement window and payoff mismatch (T12/T13).**
  - If settlement uses a TWAP over [T − W, T], the payoff is an *Asian* digital. Inside the window, part of the average is already realized, so the European Black–Scholes price is wrong in a direction an informed trader can exploit.
  - The simplest fix is `cutoff ≥ W`: trading stops before the window opens.
  - Keep the rule for the boundary explicit: `S_T > K ⇒ YES` and `S_T ≤ K ⇒ NO`. Define K in the same fixed-point log domain as the TWAP. A tick boundary is simplest.
- **Complete sets (T17).**
  - With 6-decimal outcome tokens, splitting and merging are exact (1 USDC unit ↔ 1 YES unit + 1 NO unit).
  - The hook's inventory (YES/NO/USDC as ERC-6909 claims) is the LP book. Liability is bounded by construction: the winner's supply equals the collateral. Solvency then reduces to an accounting invariant instead of a model assumption.
- **LP NAV (T15/T16).**
  - Inventory is marked to model, so NAV is exposed to oracle manipulation exactly as prices are. A deposit priced at a manipulated-low NAV followed by a withdrawal at the true NAV takes value from other LPs.
  - With flash-loaned capital this works *across* unlocks, even though LP functions cannot run inside an unlock (`AlreadyUnlocked`).
  - Lyra v1's answer was queued deposits and withdrawals, a withdrawal fee, GWAV-based NAV (`OptionGreekCache.sol:53-56`), and circuit breakers that block the queue.
- **Clamps (T20).** Without a floor p_min, a model price of 1e-9 lets 1 USDC buy 1e9 YES. A jump then makes the LP owe 1e9. Halt trading outside `[p_min, 1 − p_min]` (for example 1%–99%), and cap liability per market.

---

## 7. Security-focused Foundry test plan (sketch)

**Harness.**
- Deploy `PoolManager`, V4Router or Universal Router, Permit2 and V4Quoter as in the v4-template `Deployers` and `BaseTest`.
- Deploy the hook with `HookMiner` (mask `0x2AA8`).
  - **[added]** Watch the import path. v4-template `1fbf955` imports `@uniswap/v4-periphery/src/utils/HookMiner.sol` (`script/00_DeployHook.s.sol:5`) and resolves periphery through `lib/uniswap-hooks/lib/v4-periphery` (`remappings.txt`). Periphery `9969eec` has **no** `src/utils/`; `HookMiner` is at `test/shared/HookMiner.sol`. Pin the submodules, or vendor `HookMiner` into our repo.
- Foundry `ffi = true` is already set in the template (`v4-template/foundry.toml:4`), so `vm.ffi` differential tests work out of the box.
- Deploy USDC as a 6-decimal mock (plus a mainnet-fork variant).
- Deploy the underlying ETH/USDC pool, with an oracle hook in the local variant and the real pool in the fork variant.
- Use `PoolManager` from a **fresh deployment** (zero balances) to catch T23.

**Stateful invariant suite** (`forge test --match-contract Invariants`). The handler has these actions:
- `buy`/`sell` (YES or NO, exact in or out) via V4Router;
- `split`/`merge`;
- `lpDeposit`/`lpWithdraw` (and queue processing);
- `warp(dt)`, `roll(n)`;
- `moveUnderlying(δ)` (swap the underlying pool);
- `settle`, `redeem`;
- `donateERC20`, `donate6909`;
- `attackerAtomicManipulation(δ, q)`.

Invariants (`invariant_*`):
1. `setsMinted[m] == YES[m].totalSupply() == NO[m].totalSupply()` before settlement. **[corrected]** Premiums make the USDC balance larger than the set count, and hook inventory counts toward `totalSupply`. Solvency is therefore `usdcBucket[m] ≥ max(YES[m].totalSupply() − hookYES[m], NO[m].totalSupply() − hookNO[m])`. After settlement, `usdcBucket[m] ≥ outstandingWinning[m]`.
2. `Σ_m bucket[m].usdc ≤ poolManager.balanceOf(hook, USDC.toId())`, and the same per outcome token.
3. `ghost_attackerPnL ≤ 0` for the atomic manipulator; `ghost_roundTripPnL ≤ 0`.
4. `askY + askN ≥ 1e18` and `bidY + bidN ≤ 1e18` (1e18 fixed point) at every observed state.
5. The prices of every registered pool satisfy `p_min ≤ bid ≤ ask ≤ 1 − p_min`, or trading is halted.
6. `poolManager.getSlot0(predictionPool).sqrtPriceX96` never changes (no CL fall-through).
7. After every handler call, `TransientStateLibrary.getNonzeroDeltaCount(poolManager) == 0`, and the hook holds no currency outside {USDC, YES_m, NO_m}.
8. LP share price is non-decreasing across pure deposit/withdraw sequences with no trades or time (anti-Bunni); only rounding dust is allowed.

**Attack PoCs** (unit tests expected to fail against a naive implementation and pass against the hardened one): T1, T2, T8, T12, T15 and T16, each as a standalone attacker contract.

A sketch for T8:

```solidity
contract AtomicManip is IUnlockCallback {
    function unlockCallback(bytes calldata) external returns (bytes memory) {
        pm.swap(ethUsdc, SwapParams(true, -int256(ethIn), TickMath.MIN_SQRT_PRICE + 1), "");   // push S down
        pm.swap(yesUsdc, SwapParams(usdcIs0, -int256(usdcIn), usdcIs0 ? MIN+1 : MAX-1), "");   // buy YES "cheap"
        pm.swap(ethUsdc, SwapParams(false, int256(ethIn), TickMath.MAX_SQRT_PRICE - 1), "");  // restore (exact out)
        pm.swap(yesUsdc, SwapParams(!usdcIs0, -int256(yesBought), ...), "");                   // sell YES
        _settleAll(); // pay/take all open deltas from test balances
        return "";
    }
}
// assertLe(usdc.balanceOf(attacker) + ethValue, startValue);  // fuzz ethIn, usdcIn
```

**Differential math.** Use `vm.ffi(["python3","ref.py", …])` with mpmath for `N(d2)`, `ln`, `exp` and the whole price path, including rounding. Fuzz across the domain.

**Longer campaigns.** Medusa or Echidna, following ToB's recommendation and its v4-core invariant harness. Optionally Halmos for the pure rounding helpers (the property: "floor/ceil helpers never favour the trader").

**Gas.** `forge snapshot` on `beforeSwap`, so that caps and loops stay bounded.

---

## 8. Self-score on the Uniswap Foundation Hook Security Framework

Source: developers.uniswap.org/docs/protocols/v4/security, fetched through the `llms.mdx` redirect.

| Dimension (range) | Score | Reason |
|---|---|---|
| Complexity (0–5) | 4 | Multi-market, custom accounting, settlement, LP vault |
| Custom math (0–5) | 5 | Black–Scholes digital, ln/exp/CDF, σ estimator |
| External dependencies (0–3) | 2 | Oracle pool (or v3 pool), USDC |
| External liquidity exposure (0–3) | 2 | Hook holds collateral as claims or in a vault |
| TVL potential (0–5) | 2–3 | Estimate |
| Team maturity (0–3) | 3 | New team |
| Upgradeability (0–3) | 0 | Immutable (recommended) |
| Autonomous parameter updates (0–3) | 2 | σ estimator |
| Price-impacting behaviour (0–3) | 3 | NoOp pricing |
| **Total** | **≈23–24** | **High (18–33)**: two audits, one by a math specialist; mandatory bug bounty; invariant and stateful fuzzing; mandatory monitoring with anomaly detection; formal verification optional. The "Custom curve" feature requirement: "At least one audit should include a math and invariants specialist". |

---

## 9. Implications for our design

1. **Base contract.** Use OZ `BaseHook` (v1.2.x) for `onlyPoolManager` on every callback. **Do not inherit** `BaseCustomAccounting` or `BaseCustomCurve`, which are single-pool. Port their claims-based `_beforeSwap` settlement (`BaseCustomCurve.sol:112-128`) into a multi-market contract whose state is keyed by `PoolId`.
2. **Permissions.** Use mask `0x2AA8`: `beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity` and `beforeDonate` all revert; `beforeSwap` and `beforeSwapReturnDelta` are live. There is no `afterSwap` and no transient state across callbacks.
3. **Market creation.**
   - `createMarket(params)` is permissioned or bonded. It deploys YES and NO (6 decimals, hook-only mint), then calls `poolManager.initialize` itself (skipping its own `beforeInitialize`) for the YES/USDC and NO/USDC pools with fee 0 and a large `tickSpacing`.
   - It records orientation flags. All risk parameters are immutable per market: K, T, W, cutoff, σ bounds or fixed σ, p_min, caps, fee or spread.
4. **Collateral model.** Complete sets: 1 USDC ↔ 1 YES + 1 NO. Hook inventory is held as ERC-6909 claims. Solvency is a checked invariant, not a model assumption.

   4a. **[added] How the inventory claims come into existence.** `beforeSwap` can pay YES only by `burn`ing YES claims it already holds (`PoolManager.sol:332-336`). A claim can be minted only against a positive delta (`:322-329`).
   - So YES/NO inventory must be created *outside* the swap path, inside the hook's own `unlock`, when LP collateral arrives:
     1. `sync(YES)`;
     2. `YES.mint(address(poolManager), c)`;
     3. `settle()`;
     4. `poolManager.mint(hook, YES.id, c)`;
     5. the same for NO;
     6. USDC is settled and minted as claims too.
   - This `sync` is fine there because it is atomic inside our own unlock (T23).
   - The alternative is to mint fresh YES straight to `PoolManager` inside `beforeSwap` (`sync`/`mint`/`settle`). That brings back the `sync` interleaving hazard of §1.3, so avoid it.
   - Consequence for invariants: `YES.totalSupply()` includes the hook's inventory. Solvency must be stated on *outstanding* supply, `totalSupply − hook claims` (see T17 and §7 #1).
   - A buy of y YES at price p burns y YES claims and mints y·p USDC claims to the hook.
   - A sell of y YES does the reverse. The hook needs `usdcClaims ≥ y·bid`, or the swap must revert (capacity check, `Known_Effects…` "blindly credits").
5. **Swap path.**
   - Exact input and exact output are both supported, always fully consumed (`specifiedDelta = −amountSpecified`), or the swap reverts.
   - Use the §2.5 rounding table.
   - Revert on zero amounts, on capacity exceeded, and outside [T0, T − cutoff) or outside price clamps.
   - Make no external calls apart from `PoolManager` claim `mint`/`burn` and reading oracle state.
6. **Price inputs.**
   - **Never use current-block spot alone.** Take S from a TWAP whose window ends at the last observation before the current block. Compute the mean log-price in 1e18 fixed point from `tickCumulative`.
   - Quote with the dual-price rule and a gamma-scaled half-spread.
   - Cap per-block net delta and per-market liability.
   - σ comes from bounded, smoothed estimates of past observations. For the proof of concept, consider **σ fixed per market at creation**, with the estimator as a separate, tested module.
7. **Oracle source.**
   - To prove the concept, run two paths behind one interface:
     - (a) a v4 ETH/USDC pool with an oracle hook (OZ `BaseOracleHook`/truncated oracle), which is "Uniswap-native" and covers every swap;
     - (b) a mainnet-fork adapter over the v3 ETH/USDC 5 bp oracle for realistic depth.
   - A hookless v4 pool can only be sampled, and is weaker.
8. **Settlement.**
   - `S_T` is the TWAP over [T − W, T], compared with K in the log domain.
   - `settle()` is permissionless after T + ε. There are keeper checkpoints and a documented fallback after a grace period.
   - `redeem()` is independent of swaps and pauses.
   - Choose `cutoff ≥ W + margin`. From §5.3 a good starting point is cutoff ≈ 30–60 minutes for ATM safety on L1; shorter on 1–2 s chains, subject to simulation.
9. **LP vault.**
   - Internal accounting; virtual or dead shares.
   - Deposits and withdrawals via a queue with a delay, or per-market LP locked from creation to settlement.
   - NAV from TWAP with a conservative side (deposit at max NAV, withdraw at min NAV). Lyra-style circuit breakers.
   - Never read `balanceOf` for NAV.
10. **Composability.**
    - Deterministic `quote(marketId, side, exactIn, amount)` view that matches `beforeSwap` bit for bit.
    - `HookSwap` events (OZ `IHookEvents`); no `hookData` requirement.
    - Document that users must set `amountOutMinimum`/`amountInMaximum` (price limits are ignored, §1.4).
    - Submit to hooklist and apply for routing.
11. **Governance.** Immutable hook. A global-parameter timelock applying only to new markets. A pause that blocks only new trades, never redemptions.
12. **Process.** Budget for a high-tier security process (§8). The invariant suite in §7 is the "proof" deliverable for security, alongside the math and economics proofs from the other research tracks.

---

## 10. Open questions

1. **Oracle source for S.** Which ETH/USDC v4 pools carry most liquidity today, and are they hookless (**UNVERIFIED**)? If they are, is "Uniswap-native" satisfied by (a) our own oracle-hook ETH/USDC pool, which may be thin and cheaply manipulable across blocks, (b) the v3 ETH/USDC TWAP, or (c) a hybrid with a circuit breaker against an external reference?
2. **σ estimation.** How to estimate realized variance from TWAP-averaged ticks without bias? Differences of interval means scale variance by about 2/3 for Brownian motion. How to handle truncated observations, and sparse observations on quiet pools? Should σ be fixed per market for version 1?
3. **Settlement definition.** What window W, TWAP versus median, and how to handle tick quantization at `S_T ≈ K`? Should near-expiry pricing model the Asian payoff instead of relying on a cutoff?
4. **Cutoff and fees.** How long should the cutoff be, and how should spread scale with |∂P/∂lnS|? These need the latency and LVR simulation (T10) on the target chain's block time (12 s L1, 2 s Base, 1 s Unichain).
5. **Dual-price rule.** How much honest volume does it cost during fast markets, and does it interact badly with the no-arbitrage sums once clamps bind?
6. **LP structure.** Per-market LP tranches locked to expiry (simple, safe) or a shared vault with a queue (capital-efficient, NAV risk)? This drives T15 and T16.
7. **Partial fills.** Should the hook partially fill when capacity is short, which is more composable but raises T22, or revert?
8. **`NonzeroDeltaCount == 0` heuristic (§5.4 #8).** Is breaking multi-hop routes acceptable in exchange for denying capital-free manipulation? Is it effective against attackers who pre-settle with flash-loaned capital? Probably only partly (**UNVERIFIED**).
9. **Chain choice.** What is the sequencer trust model and timestamp freedom on Base, Arbitrum and Unichain (bounds **UNVERIFIED**)? How do they affect cutoff and TWAP guarantees?
10. **Market creation.** Permissioned, or bonded and permissionless? What bounds on K relative to S, and on T?
11. **Aggregator acceptance.** What are the concrete criteria for Uniswap routing allowlisting of custom-accounting hooks, given 0x's "quote vs settle" heuristics (**UNVERIFIED**)?
12. **USDC dependency.** Blacklist or pause risk for `PoolManager` or the hook; is it acceptable to hold collateral as ERC-6909 claims?
13. **Unverified incident details.** SpiralHookV2 (2026-09-14) and the rsETH keeper-multicall incident (2026-09-15) rest on news sources. The primary post-mortems should be read before we cite them externally. The 2026 OZ audit that produced M-09 and PR #166 also needs locating.

---

## Sources

**Primary code and audits (local, pinned commits above)**
- `v4-core/src/PoolManager.sol`, `src/libraries/Hooks.sol`, `src/libraries/Pool.sol`, `src/types/BeforeSwapDelta.sol`, `src/libraries/TransientStateLibrary.sol`, `src/test/CustomCurveHook.sol`
- `v4-core/docs/security/Known_Effects_of_Hook_Permissions.pdf`; `docs/security/audits/{OpenZeppelin,TrailOfBits,DRAFT_Spearbit,DRAFT_Certora,DRAFT_ABDK}_audit_core.pdf`
- `v4-periphery/src/V4Router.sol`, `src/interfaces/IMsgSender.sol`, `test/shared/HookMiner.sol`
- `oz-uniswap-hooks/src/base/{BaseHook,BaseCustomAccounting,BaseCustomCurve}.sol`, `src/utils/CurrencySettler.sol`, `src/oracles/panoptic/{BaseOracleHook.sol,libraries/Oracle.sol}`; `audits/OpenZeppelin Uniswap Hooks v1.0.0 RC 1 / v1.1.0 RC 1 / v1.1.0 RC 2 Audit.pdf`
- `euler-swap/src/UniswapHook.sol`, `src/libraries/QuoteLib.sol`, `audits/*.pdf`
- `bunni-v2/src/lib/{BunniHubLogic,BunniHookLogic}.sol`
- `flaunchgg-contracts/src/contracts/{PositionManager.sol,Oracle.sol,hooks/InternalSwapPool.sol}`
- `angstrom/contracts/src/modules/{UnlockHook,TopLevelAuth}.sol`
- `doppler/src/initializers/DopplerHookInitializer.sol`
- `universal-router/contracts/{UniversalRouter.sol,base/Dispatcher.sol,base/RouteSigner.sol}`
- `lyra-v1/contracts/{OptionMarketPricer,LiquidityPool,OptionGreekCache}.sol`
- OZ ERC4626 (`flaunchgg-contracts/lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol:20-37,226,233`)
- Numerics: `scratchpad/sec/sens.py`, `scratchpad/sec/lat.py` (mpmath)

**Web**
- [Trail of Bits: Building secure Uniswap v4 hooks (2026-07-30)](https://blog.trailofbits.com/2026/07/30/building-secure-uniswap-v4-hooks/)
- [Uniswap Developers: v4 Security Framework](https://developers.uniswap.org/docs/protocols/v4/security)
- [Cyfrin: Uniswap v4 Hooks Security Deep Dive](https://www.cyfrin.io/blog/uniswap-v4-hooks-security-deep-dive)
- [Dedaub: The $11M Cork Protocol Hack](https://dedaub.com/blog/the-11m-cork-protocol-hack-a-critical-lesson-in-uniswap-v4-hook-security/)
- [BlockSec: Cork Protocol Incident, two independent flaws](https://blocksec.com/blog/cork-protocol-incident-two-independent-flaws-combine-into-one-devastating-exploit-chain)
- [CertiK: Cork Protocol Incident Analysis](https://www.certik.com/blog/cork-protocol-incident-analysis)
- [Cork: May 28 2025 Exploit Post-Mortem](https://www.cork.tech/blog/post-mortem) (HTTP 403 when fetched; content via the secondary sources above)
- [Bunni: Exploit Post Mortem](http://blog.bunni.xyz/posts/exploit-post-mortem/)
- [Halborn: Explained, the Bunni Hack](https://www.halborn.com/blog/post/explained-the-bunni-hack-september-2025)
- [The Block: Bunni cites rounding error](https://www.theblock.co/post/369564/bunni-smart-contract-rounding-error)
- [OpenZeppelin uniswap-hooks PR #166 (CEI)](https://github.com/OpenZeppelin/uniswap-hooks/pull/166)
- [OpenZeppelin uniswap-hooks PR #170 (M-09)](https://github.com/OpenZeppelin/uniswap-hooks/pull/170)
- [OZ Uniswap Hooks v1.1.0 RC2 Audit](https://www.openzeppelin.com/news/openzeppelin-uniswap-hooks-v1.1.0-rc-2-audit)
- [Verichains: EIP-1153 Transient Storage, SIR.trading](https://blog.verichains.io/p/eip-1153-transient-storage-save-gas)
- [SIR: Exploit & Relaunch](https://docs.sir.trading/protocol-overview/exploit-and-relaunch)
- [Uniswap Labs: Uniswap v3 TWAP Oracles in Proof of Stake](https://blog.uniswap.org/uniswap-v3-oracles)
- [ChainSecurity: Oracle manipulation after the Merge](https://www.chainsecurity.com/blog/oracle-manipulation-after-merge)
- [arXiv 2606.03548: Cost of Manipulation in AMM-Based Oracles](https://arxiv.org/abs/2606.03548)
- [CryptoSlate: Malicious Uniswap v4 hooks baiting traders (0x analysis)](https://cryptoslate.com/malicious-uniswap-v4-hooks-are-baiting-defi-traders-with-fake-swap-quotes/)
- [0x: Uniswap v4 hooks were a mistake](https://webflow.internal.0x.org/post/uniswap-v4-hooks-were-a-mistake)
- [Cryptonomist: Uniswap V4 exploit, SpiralCom](https://en.cryptonomist.ch/2026/09/14/uniswap-v4-exploit-spiralcom/)
- [KuCoin: Uniswap V4 Hook exploited, $7.73M rsETH](https://www.kucoin.com/news/flash/uniswap-v4-hook-exploited-in-attack-user-loses-7-73m-in-rseth)
- [Halborn: Explained, the KiloEx Hack](https://www.halborn.com/blog/post/explained-the-kiloex-hack-april-2025)
- [CoinDesk: KiloEx loses $7M](https://www.coindesk.com/markets/2025/04/15/dex-kiloex-loses-usd7m-in-apparent-oracle-manipulation-attack)
- [Uniswap/hooklist](https://github.com/Uniswap/hooklist)
- [Arrakis Pro Hook](https://arrakis.finance/blog/the-arrakis-pro-hook-dynamic-fees-for-token-issuers-on-uniswap-v4)
- [ChainSecurity: Arrakis Uniswap V4 Module audit](https://www.chainsecurity.com/security-audit/arrakis-uniswap-v4-module)

---

## Verification log (adversarial fact-check, 2026-09-25)

Method:
- Every code claim was re-read at the pinned commits listed in the header table. The commits were re-checked with `git log -1` and all match.
- Audit claims were re-read in the `pypdf` text extractions (`scratchpad/audits_txt/`).
- Web claims were re-fetched.
- The numerics were recomputed independently with mpmath (`scratchpad/verify06/check.py`).

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Permission bits; mask 0x2AA8; a return-delta flag needs its base flag; validation happens in the `BaseHook` constructor | Confirmed | `v4-core/src/libraries/Hooks.sol:27-47`, `83-103`, `109-120`; OZ `BaseHook.sol:54-57`. The arithmetic 0x2000+0x800+0x200+0x80+0x20+0x8 = 0x2AA8. |
| 2 | `unlock` checks only `NonzeroDeltaCount == 0`, calls back `msg.sender`, and reverts `AlreadyUnlocked` when nested | Confirmed | `PoolManager.sol:104-114` (105, 110, 112) |
| 3 | `beforeSwap` delta: core checks only for a sign flip of `amountToSwap`; `afterSwap` maps (spec, unspec) to (amount0, amount1) by `amountSpecified<0 == zeroForOne`; caller gets `swapDelta − hookDelta` | Confirmed | `Hooks.sol:266-279` (the check is at 276-277), `306-310`; `PoolManager.sol:224-226` |
| 4 | Worked sign table in §1.2 (all four rows, `USDC = currency0`) | Confirmed | Re-derived by hand from items 3 and 5. floor(100e6/0.41) = 243,902,439 and ceil(250e6·0.41) = 102,500,000. |
| 5 | OZ `BaseCustomCurve` takes input with `take(claims=true)` (ERC-6909 `mint`) and pays output with `settle(burn=true)` (`burn`); the specified currency is `currency0` iff `zeroForOne == exactInput` | Confirmed | `BaseCustomCurve.sol:100-101`, `112-128`; `CurrencySettler.sol:51-52`, `85` |
| 6 | The NoOp early return skips `sqrtPriceLimit` validation and protocol fee; the `Swap` event is emitted with zero amounts | Confirmed | `Pool.sol:320` comes before the limit checks at `323-336`. `PoolManager.sol:241` emits in `_swap`. The fee-100% exact-out check (`Pool.sol:~310-315`) uses the post-hook amount (0), so it does not fire. |
| 7 | V4Router has no price limit and enforces `amountOutMinimum`/`amountInMaximum`/`V4ExactOutputUnfilled`/`minHopPriceX36` | Confirmed | `V4Router.sol:93-97`, `132`, `147-153`, `184`, `196`, `211-216` (it passes `MIN_SQRT_PRICE+1`/`MAX_SQRT_PRICE−1`). `_validatePoolKey` is a no-op in V4Router (`:203`) and only enforced in `PermissionedV4Router`. |
| 8 | `noSelfCall` skips `beforeInitialize` when the hook itself initializes; `beforeSwap`/`afterSwap` return early for self-calls | Confirmed | `Hooks.sol:171-178`, `253`, `293`. Euler `UniswapHook.sol:36-54`; Flaunch `PositionManager.sol:342-347`; Doppler `DopplerHookInitializer.sol:496-499` |
| 9 | A foreign `initialize` reverts "as `HookCallFailed`" | **Corrected** | It reverts as `CustomRevert.WrappedError(hook, beforeInitialize.selector, reason, HookCallFailed.selector)` (`Hooks.sol:137`, `CustomRevert.sol:11`, `83-88`). Tests must expect `WrappedError`. |
| 10 | "Add `SafeCallback` or `onlyPoolManager` to `unlockCallback`" | **Corrected** | OZ `BaseHook` defines its own `poolManager` and `onlyPoolManager` and does not inherit `ImmutableState` (`BaseHook.sol:30-34`, `62-65`). Periphery `SafeCallback` inherits `ImmutableState` (`ImmutableState.sol:17`), so the identifiers collide. Use OZ `onlyPoolManager`. |
| 11 | `sync`/`settle` use a single transient slot; `take` needs a real ERC-20 balance; V4Router settles atomically | Confirmed | `PoolManager.sol:279-297`, `349-365`; `DeltaResolver.sol:38-48`. Euler `take` in `beforeSwap` is at `UniswapHook.sol:111`. |
| 12 | OZ `BaseCustomAccounting` is single-pool, first key wins, and has the M-09 warning; PR #166 is CEI | Confirmed, with a correction | `BaseCustomAccounting.sol:31-33`, `109`, `270`, `333-345`. The PR #170 title contains "M-09". **Corrected:** PR #166 cites no audit ID. Its quote was re-taken. Both PRs were merged on 2026-09-24. |
| 13 | Titles and dates of the OZ uniswap-hooks audit findings | Confirmed, with 1 correction | v1.0 RC1 ran 2025-01-07..17 at commit `1db9646`. v1.1 RC1 ran 2025-04-25..05-12. RC2 ran 2025-06-16..26 at `3e9fa22`, with fixes merged at `67ddcdf`. **Corrected:** v1.0 L-02 is titled "Insufficient Documentation", and the salt issue is one bullet inside it. H-07 is the `uint256(uint128(target))` underflow, as the draft said. |
| 14 | v4-core audits: OZ C-01 (native CELO) and M-03 (front-running init, "prevented by peripheral contracts"); Certora I-01; Spearbit 5.1.1 JIT donation (Medium) and 5.4.15; ToB 1 Low + 5 Info with 100 invariants (8 Halmos, 88 Medusa/Echidna, 4 Slither); TOB-UNI4-6 | Confirmed | `audits_txt/OpenZeppelin_audit_core.txt:16`, `20`, `383`; the Certora, Spearbit and ToB texts (regex matches). The Spearbit JIT item is numbered 5.1.1. |
| 15 | `Known_Effects_of_Hook_Permissions`: "can 'take' all specified token without crediting…", "blindly credits…", "user funds could be permanently locked" | Confirmed | `audits_txt/Known_Effects_of_Hook_Permissions.txt` pages 2-3 |
| 16 | Bunni: the vulnerable line, the `mulDivUp` fix, $8.4M, 3M USDT flash loan, tick 5000, 28→4 wei, 44 withdrawals, −85.7% / −84.4% | Confirmed | `bunni-v2/src/lib/BunniHubLogic.sol:478`; Bunni post-mortem (re-fetched). `BunniHookLogic.sol:436-441`, `483-488`, `519`, `530` |
| 17 | Cork: no `onlyPoolManager` on `beforeSwap`, ~3,761 weETH-DS credited via crafted `hookData`, no pool-id or hook validation, 2025-05-28, about $11M | Confirmed (secondary) | Dedaub blog (re-fetched). The Cork post-mortem itself was not fetched. |
| 18 | Euler `QuoteLib` "rounds in the pool's favour (`:89-103`)" | **Corrected** | The curve rounds up (`CurveLib.sol:66`, `72`, `146-148`). The fee lines floor and favour the trader by ≤1 wei (`QuoteLib.sol:90`, `102`). The cap is at `:79` and expiration at `:82`, as the draft said. |
| 19 | §5.2 break-even `q* = fee·V·σ√T/(2φ(d2))` and its table; δ_min values | Confirmed, with a correction | Recomputed. The 7d/30bp cells were off by about 0.1% because the draft used φ(0); fixed. δ_min: 7.87/1.61/0.46 bp (h = 0.5c) and 31.5/6.43/1.86 bp (h = 2c). |
| 20 | "Attacker pushes as far as the clamps allow" (profit linear in δ) | **Corrected** | Only first-order. The exact gain is bounded and concave and the CPMM cost convex, so the optimal δ is finite (exact check: q = 1,000 is optimal at about 1%). The break-even is the δ→0 infimum. |
| 21 | §5.3 sensitivity table and 1σ block moves (3.70 / 1.51 / 1.07 bp) | Confirmed | `verify06/check.py`. Every cell matches to the stated precision. |
| 22 | "`observe` at `secondsAgo = 0` uses the current, manipulable tick" | **Corrected** | Not true for oracles that write the pre-swap tick on every swap (`panoptic/libraries/Oracle.sol:38-58`, `108`; `BaseOracleHook.sol:114-137`, `152-168`). It is true only for samplers or `afterSwap` writers. |
| 23 | Requiring `NonzeroDeltaCount == 0` forces real capital | **Corrected** | It is bypassed by zero-fee flash loans and by several sequential `unlock`s in one transaction (`PoolManager.sol:105` blocks only nesting). Downgraded to "do not rely on it". |
| 24 | Dual-price sums: `askY+askN = 1+|ΔP|+2h` and `bidY+bidN = 1−|ΔP|−2h` | Confirmed | Algebra: max(a,b) − min(a,b) = |a−b|. |
| 25 | Uniswap Foundation framework dimensions (max total 33), tiers (Low 0-6, Medium 7-17, High 18-33), high-tier requirements, custom-curve requirement; self-score 23–24 | Confirmed | developers.uniswap.org `llms.mdx` (re-fetched). The quote in §2.4 was replaced with the verbatim text. |
| 26 | ToB 2026-07-30 blog: Angstrom `afterSwapReturnDelta` mismatch, SVFHook, class quotes | Confirmed, with a correction | Blog re-fetched. **Corrected:** pattern 6 and 7 titles and the "value leaks" quote (now verbatim). |
| 27 | Lyra v1 `tradingCutoff`, `minDelta`, circuit breakers, delays, GWAV NAV | Confirmed | `OptionMarketPricer.sol:252`, `340-347`; `LiquidityPool.sol:85-91`, `104-121`; `OptionGreekCache.sol:50-57` |
| 28 | Token ordering: mainnet USDC `0xA0b8…` < WETH `0xC02a…`; Base WETH `0x4200…06` < USDC `0x8335…`; Arbitrum WETH `0x82aF…` < USDC `0xaf88…`; native ETH is always `currency0` | Confirmed | Hex comparison of the canonical addresses. `address(0)` is the minimum. |
| 29 | 0x hooks study: 84,163 hooks, 54.2% malicious, 26.4% suspected, 19.4% safe | Confirmed (secondary) | KuCoin/CryptoSlate/CryptoBriefing coverage: six chains, as of Sept 11. The 0x post itself was not fetched. |
| 30 | arXiv 2606.03548 "liquidity-weighted medians are optimal" | **Corrected / UNVERIFIED** | The abstract says cost "depends only on total quote depth and coincides across symmetric aggregators". |
| 31 | Uniswap PoS-oracle blog: "$360b more" for a $1m wide-range mint | Confirmed | Re-fetched. The "almost entirely from losses to arbitrageurs" wording could not be re-confirmed (UNVERIFIED). |
| 32 | `HookMiner.find(address,uint160,bytes,bytes)` at `v4-periphery/test/shared/HookMiner.sol:23` | Confirmed, plus an omission | Periphery `9969eec` has no `src/utils/HookMiner.sol`, but v4-template imports that path (see §7). |
| 33 | SpiralHookV2 (2026-09-14), rsETH keeper multicall (2026-09-15), Guardian Gamma C-06/H-01, TOB-BUNNI-15..18, Doppler Certora C-01, SIR.trading, KiloEx | Unverifiable here (secondary) | Left marked as secondary or UNVERIFIED. No primary post-mortems were read. |

**Omissions filled:**
- `SafeCallback` incompatibility (item 10).
- The `WrappedError` revert shape (item 9).
- How outcome-token claim inventory is created, and the corrected supply and solvency invariants (§9.4a, T17, §7 #1).
- The v4-template `HookMiner` path drift (§7).
- Oracle-observation semantics that make `observe([W,0])` safe for every-swap oracles (item 22).
- The sequential-unlock bypass (item 23).
- `_validatePoolKey` being a no-op in the plain V4Router (item 7).
