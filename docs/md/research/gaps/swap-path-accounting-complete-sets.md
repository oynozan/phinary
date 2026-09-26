# Gap: one accounting design for the swap path (complete sets, ERC-6909 inventory, on-demand mint)

Status: design fixed and checked with a Foundry prototype against a **fresh** `PoolManager`. 16/16 tests pass, including 3 stateful invariant campaigns of 256 runs × 100 calls each, with 500 × 100 also run once.
Date: 2026-09-25. Prototype: `docs/md/research/gaps/swap-path-accounting-proto/` (the working copy with library symlinks is in `scratchpad/accproto/`).

---

## TL;DR

1. **The design: "virtual complete sets" (VCS).** The economic state of market *m* has three numbers:
   - `B_m`: the USDC bucket, held as hook-owned ERC-6909 USDC claims;
   - `outY_m`: outstanding YES, i.e. YES held by anyone except the hook;
   - `outN_m`: outstanding NO.

   Everything else is derived:
   - locked collateral `C = max(outY, outN)`;
   - free cash `U = B − C`;
   - vault inventory `Yv = C − outY` and `Nv = C − outN`.

   This is a bijection onto the 05 §3.1 complete-set state after netting. So **05's I1–I7 hold verbatim on the derived variables**, and netting (`min(Yv,Nv) = 0`) holds by construction with nothing to burn. On chain, the single solvency check is `B_m ≥ max(outY_m, outN_m)`.
2. **Report 01's design (mint YES only) is correct but was missing a ledger.** It needs a per-market `B_m`, outstanding counters for YES *and* NO, and the post-trade check. With those it is exactly VCS. Only the *physical* identity `YES.totalSupply == NO.totalSupply == C` fails under it. That identity is not needed for solvency, so 05's I1 must be restated as the virtual identity (§6).
3. **The buy path uses inventory first and mints any shortfall on demand.** In `beforeSwap`:
   - `PM.burn(hook, OUT.id, fromInv)` from ERC-6909 inventory. This needs no sync.
   - Any shortfall is delivered with `PM.sync(OUT); OUT.mint(PM, short); PM.settle()`.
   - No NO leg is ever materialised.
   - The pre-minted inventory of report 06 §9.4a (`restock`) is an **optional** optimisation inside the same state machine, not a correctness requirement.
   - An `InventoryOnly` mode (06's design) is available as an immutable flag. It turns inventory into a hard capacity limit.
4. **Where inventory lives.** Hook inventory only ever exists as **ERC-6909 claims on the outcome token id**. It is created by sells (`PM.mint(hook, OUT.id, q)`) or by `restock`. Hook-held ERC20 outcome tokens are never used.
   - Outcome claim ids are per-market automatically (one ERC20 per outcome per market).
   - USDC claims are shared across markets, so they need the `B_m` ledger plus `Σ B_m (+ idle) == PM.balanceOf(hook, USDC.id)`.
5. **The sync-interleaving hazard (06 §1.3 / T23) only affects liveness, and only for the caller's own transaction. It cannot mis-credit value.** The prototype shows this:
   - A router that does `sync(USDC)` + transfer before `swap` and `settle` after it reverts with `CurrencyNotSettled` on the mint path. It succeeds on the inventory path and in `InventoryOnly` mode.
   - A router that "defensively" pays again loses its own first transfer as an orphan in the PM. The hook is credited **exactly** the trade cash, and nobody can claim the orphan.
   - An attacker who donates YES under their own `sync(YES)` before a mint-path buy gets `settle() == 0`, and the hook is credited exactly `minted`.
   - Uniswap Labs' audited `WETHHook` and the aggregator hooks use the same in-`beforeSwap` `sync → send → settle` pattern.
6. **Outcome tokens are plain ERC20 with 6 decimals, mint/burn restricted to the hook, and no transfer callbacks.** A v4 `PoolKey` currency must be an ERC20 address. Users can still hold outcome tokens as PM ERC-6909 claims (`takeClaims`/`settleUsingBurn`), which is tested.
7. **The prototype matches the maths bit for bit.**
   - All 8 swap cases work through PoolSwapTest and through periphery `V4Router` (`SWAP_EXACT_IN/OUT_SINGLE` + `SETTLE_ALL`/`TAKE_ALL`), in **both token orderings**.
   - The `BeforeSwapDelta` words for cases B/C/D equal 01 §1.8 byte for byte.
   - An independent Python recomputation reproduces every row and the end state.
8. **The invariant suite catches real bugs.** Removing the solvency check (M1) or double-spending inventory (M3) is caught within 100 runs.
   - A trader-favourable rounding mutant (M2) is **not** caught, and correctly so: solvency does not depend on prices (05 I7).
   - Rounding therefore needs the separate round-trip property of 05 §3.6.

---

## 0. The three conflicting recommendations, and how they reconcile

| Source | Claim | Problem as written | Resolution in VCS |
|---|---|---|---|
| 01 §3.3 / §11.3 | Buy = `sync(YES) → YES.mint(PM) → settle`; sell = `PM.mint(hook, YES.id)`; pay USDC by burning claims; no NO counterpart | No per-market ledger or solvency condition is given. `Ys ≠ Ns`, so 05's physical I1 fails | Kept as the **shortfall path**. Add `B_m`, `outY`, `outN` and the post-check `B_m ≥ max(outY,outN)`. §3.3(d) (burning inventory claims) becomes the **first** path, not an alternative |
| 06 §9.4a | Avoid `sync` in `beforeSwap`; pre-mint YES+NO complete sets as claims in the hook's own unlock | Capacity is a hard limit set by pre-minted inventory, even with ample free cash. The stated reason (sync hazard) is liveness-only (§7) | Kept as `restock()` (optional) and as the `InventoryOnly` immutable mode. Its invariant `usdcBucket ≥ max(YES.supply − hookYES, NO.supply − hookNO)` (06 §7 #1) **is** the VCS invariant S3 |
| 05 §3.1–3.2 | Vault mints complete sets on demand from U, then `net()`; I1 `C = Ys = Ns`, I4 `min(Yv,Nv)=0`, I5 `U ≥ 0`, budget `B_m` | Physically minting and burning both legs on every trade is wasted gas, and `net()` inside `beforeSwap` would need a physical merge | The same state space, reparametrised (§5). I1/I4 become identities on derived variables. I5 ⇔ S3 |

---

## 1. Final state variables (answer to (a))

Per market `m` (prototype `src/PredictionHookProto.sol:52-64`):

```solidity
struct Market {
    OutcomeToken yes;        // ERC20, 6 decimals, mint/burn onlyHook, no callbacks
    OutcomeToken no;
    uint256 bucket;          // B_m: USDC ERC-6909 claims (id = uint160(USDC)) attributable to m. B = C + U
    uint256 invYes;          // hook-owned YES claims (id = uint160(YES_m)); created by sells/restock
    uint256 invNo;
    uint256 outYes;          // outstanding YES = YES.totalSupply() - invYes   (tracked, cross-checked)
    uint256 outNo;
    /* pricing params (mid, spread, K, T, sigma...), status, yesWon */
}
uint256 totalBuckets;        // Σ_m bucket_m  (+ vault idle cash in production)
```

- **Derived, never stored:**
  - `C_m = max(outYes, outNo)` is the collateral locked by (virtual) complete sets;
  - `U_m = bucket − C_m` is free cash;
  - `Yv = C − outYes` and `Nv = C − outNo` are the virtual inventory.
- **Physical inventory `invYes`/`invNo`** is a *representation* detail. It is ERC20 held by the PM that backs the hook's ERC-6909 claims. It does not enter any economic quantity, only `totalSupply`.
- **Why store `out*` instead of reading `totalSupply − inv`?** Anyone can `PM.transfer` 6909 outcome claims to the hook (`ERC6909.sol:25`), or send ERC20 into the PM. Stored counters make those donations harmless. Tests assert `out == totalSupply − inv` exactly (S1). In production, state it with `≤`/`≥` wherever donations can intrude (§6).
- **Per-market USDC buckets are required.** USDC claims are one id shared by every market and by the vault (OZ `BaseAsyncSwap.sol:36-39` gives the same warning). Outcome claims are market-specific for free, because every market has its own ERC20 addresses.

---

## 2. The swap path: the 8 cases (answer to (a), continued)

Notation:
- `A = |amountSpecified|`.
- `OUT` is the outcome token of the pool (YES_m or NO_m).
- `ask/bid` are the quotes in WAD: YES uses `P ± s`, NO uses `(1−P) ± s`, with `NO := 1 − YES` computed in integers (05 §3.4).
- `buying ⇔ inputCurrency == USDC`, where `inputCurrency = zeroForOne ? currency0 : currency1`.
- `exactIn ⇔ amountSpecified < 0`.
- Rounding always favours the hook (01 §1.7; 05 §3.5): outputs use `mulDiv` (down), inputs use `mulDivRoundingUp` (up).

| # | Case | q (outcome) / cash (USDC) | State change (effects, before any PM call) | PM calls inside `beforeSwap` | `BeforeSwapDelta` (specified, unspecified) |
|---|---|---|---|---|---|
| 1 | buy YES, exact-in | `cash = A`, `q = ⌊A·1e18/ask⌋` | `B += cash; outY += q; f = min(invY,q); invY −= f` | `mint(hook, USDC.id, cash)`; if `f>0`: `burn(hook, YES.id, f)`; if `q−f>0`: `sync(YES); YES.mint(PM, q−f); settle()` | `(+A, −q)` |
| 2 | buy YES, exact-out | `q = A`, `cash = ⌈A·ask/1e18⌉` | same as 1 | same as 1 | `(−A, +cash)` |
| 3 | sell YES, exact-in | `q = A`, `cash = ⌊A·bid/1e18⌋` | require `cash ≤ B`; `B −= cash; outY −= q; invY += q` | `mint(hook, YES.id, q)`; `burn(hook, USDC.id, cash)` | `(+A, −cash)` |
| 4 | sell YES, exact-out | `cash = A`, `q = ⌈A·1e18/bid⌉` | same as 3 | same as 3 | `(−A, +q)` |
| 5–8 | the same for NO | with `ask_N = 1−P+s`, `bid_N = 1−P−s` | `outN`, `invN` | `NO.id`, `NO.mint` | same |

Common to every case:
- **Pre-checks:** the pool is registered; the market is `Trading`; `q > 0 && cash > 0` (otherwise `ZeroAmount`; 1 unit sold at 0.39 floors to 0, prototype row 12).
- **Post-check:** `B ≥ max(outY, outN)`, otherwise `Insolvent`.
- **Always a full fill:** `|specified| == A`, so `amountToSwap = 0` (`Hooks.sol:270-276`) and `Pool.swap` returns `ZERO_DELTA` (01 §1.4).
- **Hook delta nets to zero.** The in-callback PM calls move the hook's own delta by exactly `+input` and `−output`. The booked `hookDelta` (`PoolManager.sol:224`) cancels them, and the caller gets `−hookDelta` (`Hooks.sol:307-312`).
- **Ordering never changes the `BeforeSwapDelta`.** It is expressed as specified/unspecified. Ordering changes only `zeroForOne` and the currency0/1 mapping of `hookDelta`: specified is currency0 iff `(amountSpecified<0) == zeroForOne`, `Hooks.sol:307`.
- **Sell capacity follows from the post-check.** A sell of YES can revert with `Insolvent` when NO is the binding side (`outN == B`). That is exactly 05's precondition `U + k ≥ proceeds`, with the netting release `k` included automatically. With VCS it is the single inequality `B − cash ≥ max(outY − q, outN)`.

Prototype: `src/PredictionHookProto.sol:197-270` (the callback), `:228-246` (effects), `:248-262` (interactions).

---

## 3. Delivering YES when inventory is short (answer to (b))

**Option 1, mint on demand in `beforeSwap`:** `PM.sync(OUT); OUT.mint(address(PM), short); PM.settle()`.

**Is `sync` needed?** Yes. There is no other way to create a positive delta for an ERC20 that the PM does not yet hold:
- `PM.mint` creates claims only against a *negative* delta (`PoolManager.sol:322-329`).
- `burn` requires existing claims (`:332-336`).
- `settle()` without a synced ERC20 takes the native path and credits `msg.value` (`:349-356`).

So an ERC20 transfer-in measured by `sync`/`settle` is the only source. The docs say the same: `IPoolManager.sol:167-170`, "This MUST be called before any ERC20 tokens are sent into the contract".

**Is it safe under the single `CurrencyReserves` slot** (`CurrencyReserves.sol:11-14`: one `CURRENCY_SLOT` and one `RESERVES_OF_SLOT`)?
- For the **hook**, yes, exactly. Between the hook's `sync` and `settle`, the only balance change is `OUT.mint(PM, short)`, on our own token, which has no hooks. So `paid = balanceNow − reservesBefore = short` (`PoolManager.sol:358-361`). The prototype even asserts `pm.settle() == minted` (`:257`); it never fires across 25,600+ fuzzed calls per campaign.
- For the **caller**, it overwrites and then resets (`:361`) any sync the caller left pending. That is a liveness effect on the caller's own transaction (§7).

**Precedent.** Uniswap Labs' `WETHHook._deposit` runs inside `beforeSwap` via `BaseTokenWrapperHook._beforeSwap` (`v4-hooks-public/src/base/BaseTokenWrapperHook.sol:123-152`). It does `poolManager.sync(wrapperCurrency)`, then `_take(ETH → WETH contract)`, which mints WETH to the PM, then `poolManager.settle()` (`src/WETHHook.sol:31-39`). The README lists it as audited by OpenZeppelin (2025-04-24). The aggregator hooks mandate "sync, send, settle" inside the swap (`BaseAggregatorHook.sol:104-105`). `UniswapV2Aggregator` even makes an external call to a pair between them (`UniswapV2Aggregator.sol:151-153`).

**Option 2, hard capacity from pre-minted inventory (06 §9.4a)** is implemented as `restock()`, and as `Mode.InventoryOnly`, which reverts `InsufficientInventory` on any shortfall.
- **Pros:** there is no `sync` in the swap. Physical I1 holds exactly (`supply(YES) == supply(NO) == sets minted`; `test_inventoryOnly_capacityLimit`). Each buy is about 18k gas cheaper.
- **Cons:** capacity is bounded by an operational pre-mint rather than by collateral. Buys revert while `U` would still cover them; in the test, 1 unit over the inventory reverts with 1M USDC free. It also needs a keeper or LP flow to top up.

**Recommendation.** Use `OnDemand` with inventory first:
- Capacity equals collateral.
- Correctness does not depend on keepers.
- The only cost is the liveness caveat for non-standard pre-sync routers, which standard routers never trigger (§7).

Keep `restock()` as a permissionless-safe gas optimisation. It changes no economic variable, so it can even be permissionless. Offer `InventoryOnly` only if a specific integrator needs pre-sync compatibility.

---

## 4. The NO leg, netting and merges (answer to (c))

- **The NO leg of an on-demand "set" is virtual.** It lives only as `Nv = C − outN`, derived from the counters. Materialising it would add one ERC20 mint (and a second `sync` if it had to become claims) and a second form of inventory, with **no** change to any solvency quantity. The state bijection in §5 shows that the physical and virtual versions carry identical information.
- **Netting is automatic.** 05's `net()` burns `k = min(Yv,Nv)` sets and moves `k` from C to U. In VCS, `C := max(outY,outN)` is recomputed implicitly on every trade, so `min(Yv,Nv) = 0` always holds and freed cash appears in `U = B − C` immediately. There is nothing to burn, and no hook-initiated unlock is needed.
- **Physical merge or sweep is optional housekeeping.** `sweep(m, side)` (`:343-351`, callback `:398-404`) runs `PM.burn(hook, OUT.id, inv)`, then `PM.take(OUT, hook, inv)`, then `OUT.burn(hook, inv)` inside the hook's own `unlock`.
  - It changes no economic variable. It only shrinks `totalSupply` toward `out`, which is useful for indexers and UIs that read supply as open interest.
  - It cannot run *inside* another user's swap as a separate unlock, because `unlock` reverts `AlreadyUnlocked` (`PoolManager.sol:105`). The burn+take pair could run inline in `beforeSwap` (the PM is unlocked and holds the backing ERC20), but that would be pointless gas.
- **User split and merge** (`split`/`merge`, `:307-331`) exist for the 05 §3.4 no-arbitrage bound. In VCS they are `B ±= a; outY ±= a; outN ±= a`, which preserves S3.
  - Limitation: they open their own `unlock`, so they cannot be batched inside a Universal Router `V4_SWAP`.
  - An in-unlock variant (settle USDC with `settleFor`, then mint) is future work.

---

## 5. Equivalence with 05's complete-set model (why 05's proofs transfer)

- Let 05's post-netting state be `(U, C, Ys, Ns, Yv, Nv)` with `C = Ys = Ns` (I1) and `min(Yv,Nv) = 0` (I4).
- Define `outY = Ys − Yv` and `outN = Ns − Nv`.
  - If `Yv = 0`, then `C = Ys = outY ≥ outN`.
  - If `Nv = 0`, then `C = outN ≥ outY`.
  - So **`C = max(outY, outN)`** and `B := U + C`.
- Conversely, given `(B, outY, outN)` with `B ≥ max(outY,outN)`, set `C = max(outY,outN)`, `U = B − C`, `Yv = C − outY`, `Nv = C − outN`. This recovers the unique I1/I4 state.

Each 05 operation maps onto a VCS transition as follows. Here `q` is the trade size, `c` its USDC amount (cost or proceeds), and `a` the split/merge or redeemed amount.

| 05 op | VCS transition |
|---|---|
| buy (from inventory or with a short mint, then net) | `B += c; out_side += q` |
| sell (then net) | `B −= c; out_side −= q` |
| mint / merge | `B ±= a; outY ±= a; outN ±= a` |
| redeem | `B −= a; out_win −= a` |

So:
- **I3 (conservation)** and **I6 (mark-to-market zero-sum)** hold, and the invariant campaign asserts I6 exactly in 1e18-scaled integers (`Invariants.t.sol:invariant_accounting`).
- **I5 (`U ≥ 0`) ⇔ `B ≥ max(outY,outN)`.** This is the only check the contract needs.
- **I7 (solvency is price-independent)** holds because prices enter only the sizes of `c`. The fuzzer re-prices arbitrarily (`setPrice`, mid ∈ (0,1)) and S3 never breaks.
- **The per-market LP loss bound (05 §3.3)** follows: terminal LP wealth is `B_T − out_win ≥ 0`, so the loss is at most the allocation to `B_m`.

---

## 6. Solvency invariants in Solidity terms (answer to (d))

The prototype asserts these after **every** step: `test/Base.t.sol:_checkInvariants`, plus `invariant_accounting` and `afterInvariant` in `test/Invariants.t.sol`.

| Id | Solidity | Form in tests / in production |
|---|---|---|
| S1 | `m.outYes == YES.totalSupply() - m.invYes` (and NO) | `==` / `≤` in production if ERC20 donations to the hook are possible (tighter: count only what the hook ledgers) |
| S2 | `m.invYes == PM.balanceOf(hook, uint160(YES))` (and NO) | `==` / `≤` (6909 donations via `PM.transfer`) |
| S3 | Trading: `m.bucket >= max(m.outYes, m.outNo)`; Resolved: `m.bucket >= (yesWon ? outYes : outNo)` | enforced in-contract as a post-condition of every mutating path (`_checkSolvent`, `:278-282`) |
| S4 | `Σ_m bucket_m (+ vaultIdle) == PM.balanceOf(hook, uint160(USDC))` | `==` / `≤` (USDC-claim donations) |
| S5 | `USDC.balanceOf(PM) >= Σ all USDC claims`; `YES.balanceOf(PM) == invYes + Σ user YES claims` | the campaign asserts the equalities (no orphans can arise from the handler) |
| S6 | derived: `min(C−outY, C−outN) == 0`, `bucket − C ≥ 0` | identities; 05 I4/I5 |
| S7 | `getSlot0(pool).sqrtPriceX96 == initial` for every market pool | no CL fall-through (06 §7 #6) |
| S8 | `TransientStateLibrary.getNonzeroDeltaCount(PM) == 0` after every router call | trivially true outside `unlock`; asserted in the delta-table tests |
| T | after resolve, redeem-all, LP `defund`, `sweep`: `USDC.balanceOf(PM) == 0`, `YES.totalSupply() == NO.totalSupply() == 0`, `Σ agent cash == initial` | `afterInvariant`, every run |

What changes in the existing specs:
- **05 §3.7:** replace "I1 `C = Ys = Ns`" with S1 + S6. Replace I2 `USDC.balanceOf(vault)` with S4 (claims, not `balanceOf`).
- **06 §7:**
  - #1 is already S3.
  - #2 should say `== Σ buckets + idle` in the harness (no donations) and `≤` against donations.
  - "Hook holds no currency outside {USDC, YES_m, NO_m}" stays.
  - `setsMinted[m] == YES.totalSupply() == NO.totalSupply()` holds **only** in `InventoryOnly` mode.

---

## 7. The sync-interleaving hazard (answer to (e))

**Mechanics** (`PoolManager.sol:279-288, 349-365`):
- `sync(c)` stores `(c, balanceOf(PM))` in the single transient slot pair.
- `settle()` credits `balanceNow − stored` for the stored currency, then resets the slot to 0. With slot 0, it credits `msg.value` in native currency.

**Every interleaving, checked:**

| Scenario | What happens | Value mis-credited? | Test |
|---|---|---|---|
| Router: `sync(USDC)`, `transfer`, `swap` (mint path), `settle` | The hook's `sync(YES)…settle()` overwrites and then resets the slot. The router's `settle()` goes native and pays 0, so its −cash USDC delta stays and the unlock reverts `CurrencyNotSettled` | No, the transaction reverts | `test_T23_preSync_onDemandMint_failsClosed` |
| Same router, but the hook fills from inventory | No `sync` in the hook, so the router's pending sync survives | n/a, it succeeds | `test_T23_preSync_inventoryPath_works`, `…inventoryOnlyMode_works` |
| Same router, but it re-pays when unsettled | Succeeds. The router pays 2×; the first transfer is an orphan in the PM owned by no claim | The **hook is credited exactly `cash`** (`totalBuckets` += 100e6). The router harms only itself | `test_T23_preSync_repayingRouter_selfHarmOnly` |
| Anyone tries to claim the orphan | `sync` snapshots it, so `settle` pays 0 and `take` leaves a debt → `CurrencyNotSettled` | No | same test (`OrphanClaimer`) |
| Attacker: `sync(YES)`, donate 50 YES, then buy YES (mint path), then `settle()` | The hook's `sync(YES)` re-snapshots after the donation. The hook is credited exactly `minted`, and the attacker's `settle()` returns 0 (asserted) | No: the donation is orphaned, and S1 still holds (the orphan is counted as outstanding, which is conservative) | `test_T23_donateSameCurrency_hookNotMisCredited` |

**Why mis-crediting is impossible in general.**
- The hook's `settle` credits only the balance change since the hook's *own* `sync`, and the only thing between them is its own callback-free mint. So the hook can never receive a caller's tokens.
- A caller's `settle` after the hook's reset can only credit native `msg.value`. So a caller can never receive the hook's mint.
- The only effect of the interleaving is a residual caller debt, which fails closed by `NonzeroDeltaCount != 0` (`PoolManager.sol:112`), or self-inflicted double payment.
- The one condition is that nothing untrusted runs between the hook's `sync` and `settle`. The outcome token must never have transfer hooks (ERC777-style) or be upgradeable.

**Which routers are affected?** None of the standard ones:
- periphery `DeltaResolver._settle` does `sync → pay → settle` atomically (`v4-periphery/src/base/DeltaResolver.sol:38-48`), so V4Router and UR are safe;
- v4-core `CurrencySettler.settle` is atomic too (`test/utils/CurrencySettler.sol:20-35`);
- PoolSwapTest uses CurrencySettler.

Third-party aggregators were not audited here (**UNVERIFIED**). A pre-sync router can still trade via the inventory path, or by settling before the swap.

---

## 8. ERC20 vs ERC-6909 outcome tokens, and decimals (answer to (f))

- **The pool currency must be an ERC20 address.** `Currency` is `address` (`Currency.sol:7`). The PM calls `balanceOf`/`transfer` on it (`Currency.sol:40-104`), and `PoolKey` holds two `Currency` values.
  - An ERC-6909 id cannot be a pool currency unless it has an ERC20 facade, which would be one address per id anyway.
  - UR and V4Router pay inputs with `transferFrom` (`MockV4Router._pay`) or Permit2, both ERC20.
  - So outcome tokens must be **ERC20**.
- **Users get ERC-6909 for free.** Any holder can keep outcome tokens as PM claims (`takeClaims=true`) and sell them with `settleUsingBurn`. Those claims count as outstanding and are backed by ERC20 in the PM (`test_userClaims_roundTrip`; the campaign mixes in claim-mode trades).
- **Token requirements:**
  - 6 decimals, equal to USDC's base unit, so sets are exact 1:1 integers (05 §3.5). The terminal test ends with **exactly 0** USDC in the PM and 0 supply;
  - `mint`/`burn` restricted to the hook, which burns from holders without allowance (for redeem/merge);
  - no hooks or callbacks, not upgradeable (§7 condition);
  - deployed by the hook with CREATE2 salt selection for the desired ordering (prototype `_deployOrdered`, `:147-160`).

  In production, use `LibClone` clones with an initializer to cut deployment gas. That is not measured here.
- **Amount range.** Amounts pass `SafeCast.toInt128`. Per-trade amounts are therefore < 2^127 units, far above any realistic USDC size.

---

## 9. Worked delta table for the final design (both orderings)

Setup:
- P = 0.40 and s = 0.01, so YES ask/bid = 0.41/0.39 and NO ask/bid = 0.61/0.59.
- `B` starts at 1,000,000 USDC.
- Inventories start at 0.
- One trader executes the rows in order through PoolSwapTest on a fresh PM.

The Foundry log (`test_deltaTable_*`) and `delta_table_check.py` agree on every field.

**Hook actions per row** (the same in both orderings):
- Buys: `mint(hook,USDC,cash)`, then `burn(hook,OUT,fromInv)` if `fromInv>0`, then `sync(OUT); OUT.mint(PM,minted); settle()` if `minted>0`.
- Sells: `mint(hook,OUT,q)`, then `burn(hook,USDC,cash)`.

| # | Trade | q | cash | fromInv | minted | `BeforeSwapDelta` raw int256 |
|---|---|---|---|---|---|---|
| 1 | buy YES exact-in 200 USDC | 487,804,878 | 200,000,000 | 0 | 487,804,878 | `0x…0bebc200ffffffffffffffffffffffffe2ecb032` |
| 2 | buy YES exact-out 250 YES | 250,000,000 | 102,500,000 | 0 | 250,000,000 | `0xfffffffffffffffffffffffff1194d80000000000000000000000000061c06a0` (= 01 §1.8 B) |
| 3 | sell YES exact-in 250 YES | 250,000,000 | 97,500,000 | – | – | `0x0000000000000000000000000ee6b280fffffffffffffffffffffffffa3044a0` (= 01 C) |
| 4 | sell YES exact-out 100 USDC | 256,410,257 | 100,000,000 | – | – | `0xfffffffffffffffffffffffffa0a1f000000000000000000000000000f488291` (= 01 D) |
| 5 | buy YES exact-out 250 YES | 250,000,000 | 102,500,000 | **250,000,000** | 0 | same word as row 2 (**no sync**) |
| 6 | buy YES exact-in 300 USDC | 731,707,317 | 300,000,000 | 256,410,257 | 475,297,060 | `0x…11e1a300ffffffffffffffffffffffffd463084b` |
| 7 | buy NO exact-in 200 USDC | 327,868,852 | 200,000,000 | 0 | 327,868,852 | `0x…0bebc200ffffffffffffffffffffffffec751e4c` |
| 8 | buy NO exact-out 250 NO | 250,000,000 | 152,500,000 | 0 | 250,000,000 | `0xfffffffffffffffffffffffff1194d800000000000000000000000000916f720` |
| 9 | sell NO exact-in 250 NO | 250,000,000 | 147,500,000 | – | – | `0x0000000000000000000000000ee6b280fffffffffffffffffffffffff7355420` |
| 10 | sell NO exact-out 100 USDC | 169,491,526 | 100,000,000 | – | – | `0xfffffffffffffffffffffffffa0a1f000000000000000000000000000a1a3c46` |
| 11 | buy NO exact-in 100 USDC | 163,934,426 | 100,000,000 | **163,934,426** | 0 | `0x…05f5e100fffffffffffffffffffffffff63a8f26` |
| 12 | sell YES exact-in 1 unit | 1 | ⌊0.39⌋ = 0 | – | – | reverts `ZeroAmount` |

(`0x…` = 24 leading zero hex digits.)

**Ordering-dependent columns** (`hookDelta`/caller delta as `(amount0, amount1)`):

| # | outcome = currency0 (`address(OUT) < USDC`) | | outcome = currency1 | |
|---|---|---|---|---|
| | `zeroForOne` | caller delta | `zeroForOne` | caller delta |
| 1 | F | (+487,804,878, −200,000,000) | T | (−200,000,000, +487,804,878) |
| 2 | F | (+250,000,000, −102,500,000) | T | (−102,500,000, +250,000,000) |
| 3 | T | (−250,000,000, +97,500,000) | F | (+97,500,000, −250,000,000) |
| 4 | T | (−256,410,257, +100,000,000) | F | (+100,000,000, −256,410,257) |
| 5 | F | (+250,000,000, −102,500,000) | T | (−102,500,000, +250,000,000) |
| 6 | F | (+731,707,317, −300,000,000) | T | (−300,000,000, +731,707,317) |
| 7 | F | (+327,868,852, −200,000,000) | T | (−200,000,000, +327,868,852) |
| 8 | F | (+250,000,000, −152,500,000) | T | (−152,500,000, +250,000,000) |
| 9 | T | (−250,000,000, +147,500,000) | F | (+147,500,000, −250,000,000) |
| 10 | T | (−169,491,526, +100,000,000) | F | (+100,000,000, −169,491,526) |
| 11 | F | (+163,934,426, −100,000,000) | T | (−100,000,000, +163,934,426) |

`hookDelta = −callerDelta`. For example, row 1 with outcome = currency0 has hookDelta (−487,804,878 YES, +200,000,000 USDC). The trader's ERC20 balances moved by exactly the caller delta in every row (asserted).

**End state (both orderings):**
- `B` = 1,000,712,500,000;
- `invY` = 0 and `invN` = 255,557,100;
- `outY` = 1,213,101,938 and `outN` = 322,311,752;
- `YES.supply` = 1,213,101,938 (= outY + invY) and `NO.supply` = 577,868,852 (= outN + invN);
- derived `C` = 1,213,101,938 and `U` = 999,499,398,062, with `Yv` = 0 and `Nv` = 890,790,186.

---

## 10. Prototype and results

Files (copied to `docs/md/research/gaps/swap-path-accounting-proto/`):
- `src/OutcomeToken.sol`: 6-decimal hook-only ERC20, plus a 6-decimal mock USDC.
- `src/PredictionHookProto.sol`: the hook.
  - Flags `0x2888`: beforeInitialize (reverts; the hook's own initialize skips it via `noSelfCall`), beforeAddLiquidity (reverts), beforeSwap, beforeSwapReturnsDelta.
  - Multi-market, fixed-mid pricing (a stand-in for the Black–Scholes digital, because this gap is about accounting).
  - `fund`, `defund`, `split`, `merge`, `restock`, `sweep`, `resolve`, `redeem`, each through its own `unlock`.
- `test/Base.t.sol`: fresh PM (`Deployers.deployFreshManagerAndRouters`), hook placed with `deployCodeTo` at a flagged address, invariants S1–S7.
- `test/Accounting.t.sol`: the delta table in both orderings, V4Router for all 8 cases in both orderings, InventoryOnly capacity, 5 T23 tests, user-claims round trip, full lifecycle to zero, gas.
- `test/Invariants.t.sol`: handler (buy/sell × YES/NO × exact-in/out × ERC20 or claims, split, merge, arbitrary re-pricing, restock, sweep, defund, pre-sync router), 3 configurations, `afterInvariant` terminal settlement.
- `delta_table_check.py`: independent recomputation. `forge_test_output.txt`: the last run.

Toolchain: forge 1.8.3 (`cae51ad`), solc 0.8.26, `via_ir`, 44,444,444 optimizer runs (the v4-core settings), cancun. Sources:
- v4-core `46c6834` (2026-04-02), the same `src/` as the scratchpad clone;
- v4-periphery `9969eec` (2026-09-19): `V4Router` with the 6-field `ExactInputSingleParams` including `minHopPriceX36`.

To reproduce, symlink `lib/{forge-std,solmate,v4-core,v4-periphery}`, then run `forge test`.

Results:
- **16/16 pass.**
- **Invariant campaigns:** `Invariant_OnDemand_Outcome0`, `Invariant_OnDemand_Outcome1` and `Invariant_InventoryOnly_Outcome1` each ran 256 runs × 100 calls (25,600 calls), and once 500 × 100 (50,000 calls). There were 0 violations, and each run ended with the full terminal settlement check.
- **Mutation checks** (100 runs each):
  - M1, remove `_checkSolvent` in `beforeSwap`: **caught** (`S3 solvency: 740289213495 < 1573069821953`);
  - M3, forget to decrement inventory on buy: **caught** (`S1 outYes`);
  - M2, exact-in sell output rounds up +1: **not caught**, which is the expected consequence of I7. Rounding direction must be tested with 05 §3.6 round-trip and split properties, not with solvency invariants.
- **Gas** (PoolSwapTest.swap total, including router settle/take, the `Trade` event and fixed-price quoting, **without** Black–Scholes maths):

  | Path | Gas |
  |---|---|
  | buy with on-demand mint (warm) | 184,550 – 184,802 |
  | buy fully from inventory | 166,779 – 167,331 |
  | mixed buy (inventory + mint) | 180,052 – 180,307 |
  | sell (inventory slot already non-zero) | 166,614 – 166,902 |
  | first buy (cold supply and balances) | ≈236k |
  | first sell (zero → non-zero claim slot) | ≈218k |

  The inventory path saves ≈17.6k gas per buy, which is the sync + ERC20 mint + settle.

---

## 11. Remaining open points

1. **LP vault layer.** Add `vaultIdle` and allocation to `B_m`, and extend S4 to `Σ B_m + idle == claims`. Shares and NAV are not modelled here; see 06 §9.9.
2. **Risk caps.** Per-market caps on `max(outY,outN)` and per-block impact (05 §3.6) are orthogonal additions to the S3 post-check.
3. **In-unlock split/merge** for Universal Router batching. Not designed yet.
4. **Donation-robust production invariants.** They must be stated with `≤`/`≥` (§6). Consider a `skim`-style admin path for 6909 donations.
5. **Third-party aggregators that pre-sync.** UNVERIFIED (§7). A fork test against specific aggregators would settle it.

---

## Verification

Verified, by me, in this session:
- **v4-core primitives** at `46c6834`, by reading the source:
  - `sync`/`take`/`settle`/`clear`/`mint`/`burn`/`_settle`/`_accountDelta` (`PoolManager.sol:279-384`);
  - `unlock` and the `CurrencyNotSettled` check (`:104-113`);
  - swap booking order (`:202, 224, 226`);
  - `Hooks.beforeSwap` (`:248-282`) and the `afterSwap` mapping (`:285-315`, specifically `:307, 312`);
  - `CurrencyReserves` single slot pair (`:11-35`);
  - the `IPoolManager.sync` natspec (`:165-171`);
  - `ERC6909Claims._burnFrom` (`:13-22`);
  - `toBeforeSwapDelta` packing (`BeforeSwapDelta.sol:9-15`).
- **Router settle patterns:** periphery `DeltaResolver._settle` (`:38-48`), v4-core `CurrencySettler.settle` (`:20-35`), `PoolSwapTest.unlockCallback` (checks + settle/take).
- **Precedent** in `v4-hooks-public` `e4eabe5`: `WETHHook._deposit` (`:31-39`), `BaseTokenWrapperHook._beforeSwap` (`:123-152`), `BaseAggregatorHook` (`:104-105`), `UniswapV2Aggregator._conductSwap` (`:151-153`). The OZ audit of WETHHook (2025-04-24) is taken from the README table; I did not read the PDF.
- **Every numeric claim in §9 and §10** comes from actual `forge test` runs (the output is saved). The §9 table was independently recomputed in Python, including the `BeforeSwapDelta` hex and the `hookDelta` currency mapping.
- **Rows 2–4 reproduce 01 §1.8 B/C/D byte for byte.**
- **The state bijection in §5** is proved above and checked numerically by the I6 and S6 assertions in every invariant call.

Not verified / caveats:
- **Pre-sync behaviour of third-party aggregators:** UNVERIFIED.
- **Whether `WETHHook` is deployed on mainnet** was not checked, and is not needed for the argument.
- **Gas** was measured through PoolSwapTest, not through UR, and without Black–Scholes maths or an oracle read. It is not a production estimate.
- **Pricing is fixed-mid.** The Black–Scholes quote function, TWAP settlement and LP shares are out of scope here and were not integrated.
- **Clones (`LibClone`) for outcome tokens** were not prototyped.
