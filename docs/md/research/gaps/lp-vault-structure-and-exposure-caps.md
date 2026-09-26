# Gap: the LP (underwriter) layer: series tranches, NAV, entry and exit, and exposure caps across strikes

Date: 2026-09-25. Scope: this report specifies the LP layer precisely enough to write the code, the invariants and the attack proofs of concept (PoCs). It resolves 01 open question 3, 04 §9.8, 05 §3.3, 06 §9.9 / T15 / T16 / T27 and 06 open question 6.

Scripts and a working prototype are in `docs/md/research/gaps/lp-vault-scripts/`:
- `checks.py` and `out_checks.txt`: numeric checks A–G;
- `sigma_extremum.py`;
- `src/SeriesHook.sol`, `test/Series.t.sol` and `test/GasOps.t.sol`: a Foundry prototype running against the real v4 `PoolManager`;
- `out_forge.txt`.

---

## 0. Decisions at a glance

| Question | Decision | Why (one line) | Proof obligation |
|---|---|---|---|
| (a) Structure | **One LP tranche per *series*.** A series is `(underlying pool, expiry T, settlement window W)` and carries a ladder of up to 30 strikes. Capital is **subscribed before trading opens and locked until the series settles**. There is no entry or exit while trading is live. A per-market tranche is the special case n = 1. A shared multi-series vault with queues is deferred to v2. | LP entry and exit happen only at the two moments when NAV is pure cash, so NAV is exact and oracle-free. T16 (NAV manipulation, JIT LP, exit front-running) becomes unreachable by construction, not merely mitigated. | V7, V8, V12, P2–P4 |
| (b) USDC → collateral → inventory | Subscriptions become hook-owned USDC ERC-6909 claims in the hook's own `unlock`. Once subscriptions close, **complete sets are pre-minted into the PoolManager (PM) and held as hook ERC-6909 claims** (`topUp`), which is value-neutral. **The swap path only `mint`s and `burn`s claims**: no `sync`, no ERC-20 call, and no outcome-token supply change inside `beforeSwap`. | This settles 01 §3.3 vs 06 §9.4a in favour of 06. It is verified end to end on a fresh PM with zero ERC-20 balances (§3.4). | V1–V4, V13 |
| (c) NAV | v1: NAV is needed only at subscription (NAV = Σ deposits, 1 share = 1 USDC unit) and at finalisation (NAV = final cash). The mark-to-model formula `NAV = cash + Σ_m [invN_m + (invY_m − invN_m)·P_m]` is used for reporting and for the v2 queue, with **NAV⁺ for deposits and NAV⁻ for withdrawals** over a price box that includes the σ interior extremum (§4.3). First-depositor attacks: v1 needs no virtual shares (the price is fixed at 1 and the ledger is internal). The v2 ERC-4626 wrapper uses OZ `_decimalsOffset() = 6`. | Mark-to-model NAV near expiry is as manipulable as the quotes. At τ = 1 h, a 0.5 % push moves the NAV of a book with 20 % net inventory by **6.2 %** for about $25–$250 in fees (§4.4). | V8, P1–P3 |
| (d) Exposure caps | Use an **exact ladder cap per series**: `min_j W_j ≥ D − B`, where `W_j` is the terminal wealth in settlement region j. It is computed in **O(n)** with one prefix pass. An **O(1) union bound** `cash + Σ_m min(invY_m, invN_m)` acts as a fast path. `MAX_STRIKES = 30` (Lyra `maxStrikesPerBoard`). There is exactly one series per (pool, T, W). | Per-market caps bound the ladder only by their **sum**, and that sum is reached when exposures are aligned (§5.3). The exact cap admits about 2.3× more flow than the union bound (median) under random two-sided flow. | V5, V6, P5 |
| (e) Settlement and exits | `settle(series)` records **one** S_T for the whole ladder. `finalize(series)` is permissionless and O(n). `redeem` and `claim` read no oracle, have no pause modifier and do not depend on other series. They can pay out as **ERC-6909 claim transfers, which need no `unlock` and no USDC transfer**. LP exit uses **sequential pro-rata**: exact, with no dust. If no valid settlement exists by `T + GRACE`, anyone can resolve the series **INVALID (50/50)**, following the CTF `[1,1]` precedent. | T27: redemptions are never locked, and finalisation needs no admin. | V9–V11, P6–P9 |

The prototype implements all of this. **21/21 Foundry tests pass**, including 1,000 fuzz runs of random 40-step operation sequences through `PoolSwapTest` → `PoolManager` → hook, with every invariant checked after every step (`out_forge.txt`).

---

## 1. What earlier reports and prior art already establish

- **Solvency is structural, not model-based.** It follows from complete sets at par with 6-decimal outcome tokens (05 §3.2, I1–I7). Mispricing changes *who* ends up with the value, never *whether* the hook can pay.
- **Worst-case loss bound per market.** 05 §3.3: `U_0 − U_t ≤ B_m` bounds the LP's terminal loss in market m.
- **Swap-path settlement.** Inputs are credited as ERC-6909 claims (`PM.mint`). For outputs, 01 §3.3 preferred `sync → YES.mint(PM) → settle` inside `beforeSwap`, while 06 §9.4a argued for pre-minted claims to avoid a `sync` inside the callback. This report resolves that in §3.
- **Thales.** `ThalesAMMLiquidityPool.sol` (Sourcify source in `scratchpad/thales/src/...`):
  - Weekly rounds. `deposit` credits the *next* round (`:134-170`).
  - A market is mapped to the round containing its maturity (`getMarketRound`, `:570-579`).
  - A round closes only when every traded market has resolved (`canCloseCurrentRound`, `:509-525`, which loops over markets).
  - P&L per round is `sUSD.balanceOf(roundPool)/allocation` (`:306-328`, `:313`).
  - Users are processed in batches (`processRoundClosingBatch`, `:330-373`, which loops over users).
  - Partial withdrawal is limited to 10–90 % (`:289-304`).
  - Markets that mature in a later round are funded by a `defaultLiquidityProvider` (`:196-200`, `_depositAsDefault :604`).
  - **Key point:** Thales never marks to model. Entry and exit happen only when everything has settled. Its LP lost money anyway (04 §1.6, −13.9 %), but for pricing reasons, not NAV-gaming ones.
- **Lyra v1.** `lyra-v1/contracts/LiquidityPool.sol` at `ea9e36a`:
  - Deposits are instant only when there are no live boards (`:276`); otherwise they are queued (`:287-298`).
  - `initiateWithdraw` burns LP tokens immediately (`:366`), but the value is computed at *processing* time. Queued withdrawals remain in `getTotalTokenSupply` (`:854-856`), so exiting LPs keep bearing risk during the delay.
  - `_canProcess` requires the delay, no active circuit breaker (CB) and a non-stale greek cache, or a guardian bypass (`:492-510`).
  - The withdrawal fee applies only while boards are live (`:512-519`).
  - Withdrawals process partially, bounded by `burnableLiquidity` (`:422-431`).
  - The NAV is `quoteAsset.balanceOf + base·spot − settlements − queued deposits − optionValueDebt`, with a `longScaleFactor` insolvency haircut (`_getTotalPoolValueQuote`, `:933-975`, `balanceOf` at `:939-940`). **It reads `balanceOf`**, the anti-pattern that 06 T26 warns about.
  - Circuit breakers are in `_updateCBs` (`:538-590`).
  - Boards are capped at `maxStrikesPerBoard = 30` (`OptionGreekCache.sol:44, 315-316`; `deployments/mainnet-ovm/params.realSNX.json:21`).
- **Premia v3 `UnderwriterVault`** (`premia-v3-contracts` `fe3b821`):
  - Deposit and withdrawal are *instant* at a single mark-to-model price per share: `pps = (assetsAfterSettlement − lockedSpread − Σ BS(spot-oracle)·size)/supply` (`UnderwriterVault.sol:239-251`, liabilities `:131-186`, which loops over every unexpired listing).
  - Withdrawals are limited by available assets (`:392-404`).
  - **Spread is not recognised when earned.** It vests linearly until maturity (`_afterTrade :491-511`, `_getLockedSpreadInternal :189-226`). That is Premia's anti-JIT device, and it is reusable by us in v2.
- **OZ ERC-4626.**
  - Share and asset conversion uses `assets·(supply + 10^offset)/(totalAssets + 1)` (`ERC4626.sol:225-234`, OZ 5.4.0 copy in `repos/flaunchgg-contracts/lib/openzeppelin-contracts`).
  - The contract's own NatSpec (`:25-45`) warns that with virtual shares, "if the vault experiences losses … the first user to exit [experiences] reduced losses in detriment to the last users". That matters for an underwriting vault that has losing rounds. Our v1 claim rule avoids virtual shares entirely (§6.3).

---

## 2. (a) Structure: series tranches locked from subscription close to settlement

### 2.1 Definition

A **series** is the unit of LP risk:

```
SeriesKey = (underlyingPoolId, expiry T, settlementWindow W, settlementRuleVersion)
Series    = { strikes K_1 < … < K_n (n ≤ 30), subscriptionEnd, openTime, T, cutoff, B, D, cash, … }
```

- Every market in a series settles on the **same** number S_T: the same pool, the same window and the same rule. That is exactly the condition under which the ladder analysis (§5) is exact.
- Two markets that differ in any of these must be in different series.
- Enforce **uniqueness**: `seriesOf[keccak(SeriesKey)]` holds at most one live series. The "aggregate cap per (asset, expiry)" of 04 §8.6 is then just the series cap.

### 2.2 Lifecycle (timestamps are immutable per series; see T28)

```
created ──► SUBSCRIBING ──(subscriptionEnd)──► PREMINT ──(openTime)──► TRADING ──(T − cutoff)──► CLOSED
             subscribe / unsubscribe             topUp/merge only        swaps + topUp/merge          no swaps
             shares = assets (1:1)               capital frozen                                      │
                                                                                                    (T)
  ──► settle(series) [oracle; permissionless]  or  settleInvalid(series) [after T + GRACE; permissionless]
  ──► SETTLED: redeem() open; finalize(series) [permissionless, O(n)]
  ──► FINALIZED: claim(series, shares) open forever; redeem() open forever
```

The prototype uses `PREMINT = 10 min` before `openTime`, `CUTOFF = 1 h` and `GRACE = 7 d`. These are placeholders: cutoff and window come from the settlement and quote gap reports.

Subscriptions close *before* any capital is converted into sets. The prototype originally allowed `topUp` during subscription. That lets an LP's `unsubscribe` underflow `cash` and revert, which is a liveness bug, and it is now fixed by the PREMINT phase.

### 2.3 Why not the alternatives

| Option | Verdict |
|---|---|
| **Per-market tranche, locked to settlement** (06 §9.9, first half) | This is the same design with n = 1. It gives up cross-strike netting, since each strike needs its own capital even when positions offset (§5.3), and it fragments LP UX across dozens of markets. Keep it as a configuration, not as the architecture. |
| **Shared multi-series vault with queued deposits and withdrawals** (Lyra) | It needs a mark-to-model NAV at every processing time. NAV then inherits every oracle and σ attack on the quotes (§4.4) plus model risk. Mitigations (queue delay, GWAV σ, CBs, NAV⁺/NAV⁻, withdrawal fee) *reduce* the leak but do not eliminate it. Lyra v1 used all of them and its LPs still lost in 6 of 8 rounds (04 §3.7), though mostly from delta, not NAV gaming. Defer to v2 (§4.5). |
| **Thales-style rolling rounds** | This is a *wrapper* over series (§4.5): one ERC-4626 that subscribes to consecutive non-overlapping series. It inherits exact NAV at roll boundaries. The loops over users and markets must not be copied (Thales `:342`, `:514`); we need none. |

The cost of the choice is idle capital between series and during subscription, plus no top-ups while trading. The prototype's `topUp` converts *existing* series cash into sets; it does not bring in new LP money. The mid-life exit path, if wanted, is **transferable series shares** (ERC-6909 ids on the hook). They could even trade in a vanilla v4 pool against USDC, giving a market-priced exit that never touches the vault's NAV. Demand for this is UNVERIFIED.

---

## 3. (b) How LP USDC becomes collateral and outcome inventory

### 3.1 Ledger (per series s, per market m ∈ s)

| Variable | Meaning |
|---|---|
| `D_s` | subscribed capital, equal to total shares (1:1) |
| `cash_s` | free USDC claims owned by the series LPs (the "U" of 05) |
| `collateral_m` | USDC claims backing *all* complete sets of market m, including user-split sets and vault sets |
| `invY_m`, `invN_m` | hook-held YES and NO ERC-6909 claims: the vault inventory |
| `B_s` | max loss budget; optional per-market `B_m` |
| `remShares_s`, `remCash_s` | after finalisation: unclaimed shares and cash |

Hook-level buckets: `Σ_s (cash_s + remCash_s) + Σ_m collateral_m (+ protocolFees)`. There is **no `balanceOf` read anywhere** in pricing, NAV or payouts.

### 3.2 Operations: PoolManager calls and ledger effects (as implemented in `SeriesHook.sol`)

| Operation | Where | PM / token calls | Ledger |
|---|---|---|---|
| `subscribe(s, a)` | hook `unlock` | `USDC.transferFrom(lp→hook)`; `sync(USDC)`; `USDC.transfer(PM)`; `settle()`; `PM.mint(hook, USDC, a)` | `shares += a`; `D += a`; `cash += a` |
| `unsubscribe(s, a)` (subscription phase only) | no unlock | `PM.transfer(lp, USDC.id, a)` (an ERC-6909 transfer is callable while locked: `v4-core/src/ERC6909.sol:25-33`, with no `onlyWhenUnlocked`, unlike `mint`/`burn` at `PoolManager.sol:322-337`) | `shares −= a`; `D −= a`; `cash −= a` |
| `topUp(m, c)` (PREMINT or TRADING) | hook `unlock` | for YES and NO: `sync(X)`; `X.mint(PM, c)`; `settle()`; `PM.mint(hook, X.id, c)` | `cash −= c`; `collateral += c`; `invY += c`; `invN += c` |
| `merge(m, c)` | hook `unlock` | for YES and NO: `PM.burn(hook, X.id, c)`; `PM.take(X, hook, c)`; `X.burn(hook, c)` | the inverse of `topUp` |
| **buy X (USDC → X)** | `beforeSwap` | `PM.mint(hook, USDC.id, in)`; `PM.burn(hook, X.id, out)` | `invX −= out` (revert `Capacity`); `cash += in` |
| **sell X (X → USDC)** | `beforeSwap` | `PM.mint(hook, X.id, in)`; `PM.burn(hook, USDC.id, out)` | `cash −= out` (revert `InsufficientCash`); `invX += in` |
| `finalize(s)` | hook `unlock` per market | burn every inventory claim, `take` the ERC-20 and burn it | `v = win ? invWin : 0` (INVALID: `⌊(invY+invN)/2⌋`); `collateral −= v`; `cash += v`; `inv = 0`; then `remCash = cash`, `remShares = D` |
| `redeem(m, X, q)` | no unlock (claims) or `unlock` (ERC-20) | `X.burn(user, q)`; then `PM.transfer(to, USDC.id, out)` or `burn` + `take` | `collateral −= out` |
| `claim(s, k)` | same | same | `out = ⌊k·remCash/remShares⌋`; `remShares −= k`; `remCash −= out` |

Return deltas in `beforeSwap` follow 01 §1.7: exact-in gives `(+in, −out)` and exact-out gives `(−out, +in)`. The rounding follows 06 §2.5: floor on outputs, ceil on inputs, and a revert on 0.

### 3.3 Why pre-minting, and what it costs

**Why pre-mint:**
- **Outcome-token supply changes only inside the hook's own `unlock`** (subscription, topUp, merge, finalize, redeem), never inside a swap. So V3 (`YES.totalSupply == NO.totalSupply == collateral_m`) holds after every swap *by construction*.
- The swap path cannot mint unbacked outcome tokens even if the pricing code is wrong. That makes T17 structurally impossible in the swap path.
- There is no `sync` in the callback, so the §1.3/T23 interleaving question disappears.
- There is no ERC-20 call in `beforeSwap`: 2 ERC-6909 operations instead of `sync` + ERC-20 mint (≈ 25–45k) + `settle`.
- The claims of each outcome token are automatically per market, because each market has its own token. Only USDC claims are shared, and they are separated by the internal buckets (V1). This matches the OZ `BaseAsyncSwap` warning that claims are "keyed by currency with no pool component" (01 §3.2(d)).

**Is it economically neutral?** Yes. Vault minting `q` sets and selling `q` YES at `p` is identical to the lazy-mint state machine of 05 §3.1: `cash −(1 − p)q` and `Nv += q` in both. `topUp` and `merge` leave every `W_j` (§5) and the NAV unchanged: `cash − c` and `invY + c`, `invN + c` means `W_j` changes by `−c + c = 0`. The prototype asserts V5 after every fuzz step, including random `topUp` and `merge` calls.

**Costs:**
1. **Capacity is bounded by `invX_m`.** A buy beyond inventory reverts (`Capacity`). A keeper `topUp` in the PREMINT phase and during trading restores capacity. It is value-neutral, so it can be permissionless for liveness. But allocation *is* a policy: anyone could `topUp` all the cash into one strike. In v1, restrict `topUp`/`merge` to a keeper with a rule-based target `c_m`, plus a minimum free-cash reserve `cash ≥ ρ·D`, because sells (buy-backs) are paid from `cash`.
2. **Pre-minted sets lock a full 1 USDC per set of capacity.** The economic lock per YES sold is only `1 − p`. Unused sets are value-neutral and return in full at `finalize`, so this costs only capacity, not P&L.
3. **Per-trade path gas** (measured, all slots cold via `vm.cool`, through `PoolSwapTest`, which adds router overhead): **≈ 204–210k** for a buy, including the USDC `transferFrom` and the outcome-token `take` done by the router. See §5.5 for the ladder check.

### 3.4 Verified on a fresh PoolManager

`test_endToEnd_claimsOnlySwapPath`:
- `deployFreshManagerAndRouters()` gives a PM with zero balances.
- Subscribe 600k + 400k USDC, `topUp` 300k sets in each of 3 strikes.
- Run 5 swaps covering buy/sell × exact-in/out × YES/NO.
- Settle at S_T = 5200 (strikes 4500 / 5000 / 5500), finalize, redeem (claims and ERC-20), and let both LPs claim (one as claims, one as ERC-20).

Assertions after every step:
- `PM.balanceOf(hook, USDC) == Σ buckets`;
- `PM.balanceOf(hook, X) == invX`;
- `X.totalSupply == collateral`;
- the PM physically holds ERC-20 ≥ claims;
- `NonzeroDeltaCount == 0`;
- the prediction pool's `slot0` never moves;
- the ladder cap holds.

End state:
- `remCash == 0`, `ledgerUSDC == 0`, and the hook holds 0 USDC claims;
- **Σ wealth of all actors is conserved to the unit**;
- **LP P&L = −(traders' P&L) exactly**: +722.973190 USDC of spread in this run, the I6 zero-sum of 05 §3.2.

---

## 4. (c) NAV, share pricing, inflation and JIT

### 4.1 v1 needs NAV only at two exact instants

- **Subscription.** No trade has happened, so `NAV = Σ deposits` and `shares = assets` (1:1). The share price is **exactly 1** throughout. Donations cannot change it because the ledger is internal.
- **Finalisation.** Every market has settled and inventory has been redeemed, so `NAV = remCash`, which is pure cash.
- **Between them**, shares are frozen (V12). No deposit or withdrawal is ever priced by a model or an oracle.

### 4.2 Mark-to-model NAV (reporting; the v2 queue; transferable-share UIs)

Collateral `collateral_m` backs every token, including the vault's. With `outY = collateral − invY` and `outN = collateral − invN`:

```
collateral_m − [outY·P_m + outN·(1 − P_m)] = invY·P_m + invN·(1 − P_m)

NAV_s(P⃗) = cash_s + Σ_m [ invN_m + (invY_m − invN_m) · P_m ]          (P_m = YES mark, r = 0)
```

At settlement `P_m ∈ {0,1}` and this reduces to the finalisation cash. NAV is **linear in each P_m** with slope `net_m = invY_m − invN_m`.

### 4.3 Conservative marks: NAV⁺ for deposits, NAV⁻ for withdrawals

**The price box.** For each market take a box `[P_m^lo, P_m^hi]` containing every plausible fair mark:
- `S ∈ {S_SoB, S_TWAP}` (06 §9.6, 04 §9.3);
- `σ ∈ [min, max]{σ_GWAV, σ_now}` (Lyra `optionValueIvGWAVPeriod`, 04 §3.6);
- widened by a model/oracle margin `ε_m`, for example the half-spread;
- clamped to `[0, 1]`.

**The NAV bounds:**
```
NAV⁺ = cash + Σ_m [ invN_m + max(net_m·P_m^lo, net_m·P_m^hi) ]
NAV⁻ = cash + Σ_m [ invN_m + min(net_m·P_m^lo, net_m·P_m^hi) ]
deposit:   shares = ⌊ a · (S + V) / (NAV⁺ + 1) ⌋            (V = 10^offset virtual shares; OZ ERC4626.sol:226)
withdraw:  assets = ⌊ k · (NAV⁻ + 1) / (S + V) ⌋
```

**Lemma (σ corners are not enough).**
- `∂N(d2)/∂σ = −φ(d2)·d1/σ`. For `S < K`, `N(d2)` is *increasing* in σ below `σ* = sqrt(2 ln(K/S)/τ)` and decreasing above it.
- The maximum over σ is `N(−sqrt(2 ln(K/S)))`, reached at σ*.
- So `P^hi` must evaluate σ* whenever `S < K` and σ* ∈ [σ_lo, σ_hi]. Monotonicity in S holds: the price is increasing in S.
- Verified numerically in `sigma_extremum.py`: S = 4800, K = 5000, τ = 7 d gives argmax σ = 2.0633 = σ* and P* = 0.387541, both equal to the closed form.

**Properties** (standard; the proofs are one line each):
- (i) If the fair NAV lies in `[NAV⁻, NAV⁺]`, a deposit or withdrawal never dilutes the others. Deposit: `(A + a + 1)/(S + s + V) ≥ (A + 1)/(S + V)` ⇔ `a(S + V) ≥ s(A + 1)`, which the floor guarantees. The withdrawal case is symmetric.
- (ii) A deposit followed by a withdrawal in the same state loses `k·(NAV⁺ − NAV⁻)/(S + V) ≥ 0`.
- (iii) Manipulation *inside* the box yields nothing. Manipulation that moves the box itself (a multi-block TWAP push) is bounded by the oracle report's cost analysis (06 §5).

### 4.4 Why v1 still refuses mid-life entry and exit

The NAV sensitivity equals the ladder's net digital delta:
```
∂NAV/∂ln S = Σ_m net_m · φ(d2_m)/(σ√τ)
```
`checks.py` E: with 200k units of net inventory ATM, σ = 60 %, a **0.5 % spot push** moves NAV by

| τ | ∂P/∂ln S | ΔNAV | % of a $1M NAV |
|---|---|---|---|
| 7 d | 4.80 | $4.8k | 0.5 % |
| 1 d | 12.70 | $12.7k | 1.3 % |
| 1 h | 62.23 | $62.2k | **6.2 %** |

- A round-trip push on a pool with virtual liquidity V costs on the order of `f·V·δ` in fees, which is an upper-bound estimate. For V = $10–100M at 5 bp that is **$25–$250**.
- With flash liquidity across separate unlocks, the attack is: push → deposit at the depressed NAV → restore → withdraw. That is as cheap as the quote attacks of 06 §5.2.
- Start-of-block (SoB), TWAP and NAV⁻/NAV⁺ make it *multi-block* but not impossible.
- v1 removes the whole class.

### 4.5 v2: shared rolling vault (specified so it can be built later without redesign)

`RollingSeriesVault is ERC4626` (OZ, `_decimalsOffset() = 6`) is an ordinary depositor into series. Two modes:

- **Non-overlapping series (recommended, Thales-like).** The vault holds at most one live series. Deposits and withdrawals are queued and processed only in the window `[finalize(s), subscriptionEnd(s+1))`, where `totalAssets = idle cash + claimable(s)` is **exact**. No model is involved and there are no loops over users.
- **Overlapping series (Lyra-like).**
  - `totalAssets = idle + Σ_live NAV_s` with NAV⁺/NAV⁻.
  - Queue delay ≥ one oracle window plus one block.
  - Circuit breakers on `|S_spot − S_TWAP|`, σ jumps (Lyra `ivVarianceCBThreshold`) and free liquidity.
  - Premia-style **spread vesting to maturity**, so JIT deposits cannot harvest spread already earned.
  - A withdrawal fee while series are live (Lyra `withdrawalFee`, `:512-519`).
  - Queued withdrawal shares remain in supply until processed (Lyra `:854-856`), so exiting LPs keep their share of losses during the delay.

### 4.6 First-depositor and inflation protection

`checks.py` D: the attacker deposits 1 unit and donates 10,000 USDC; the victim then deposits 9,999.999999 USDC.

| Accounting | Attacker P&L | Victim loss |
|---|---|---|
| naive `balanceOf`, no offset | **+9,999.999999** | 9,999.999999 |
| OZ virtual shares, offset 0 | −3,333.33 (not profitable) | **3,333.33** (still a griefing loss) |
| OZ offset 6 | −4,999.998751 | 0.002499 |
| **v1: internal ledger, 1:1 subscription** | **0** | **0** |

Verified on-chain in `test_inflation_and_donations_do_not_move_shares`:
- The attacker subscribes `10,000e6 + 1` units, unsubscribes 10,000e6 as ERC-6909 claims, donates those claims to the hook with `PM.transfer`, and donates 5,000 USDC as ERC-20.
- The victim receives exactly `10,000e6 − 1` shares, and after finalisation claims exactly `10,000e6 − 1` units.
- V1 holds with `donations` as a ghost variable.

### 4.7 JIT-LP

- **v1: impossible.** No deposits after `subscriptionEnd` (tested: `subscribe` reverts `WrongState` during PREMINT and during trading).
- **v2:** use queue delay plus spread vesting. With lock-to-settlement top-ups ("late subscription at NAV⁺, exit only at finalisation"), a JIT LP is simply a late underwriter who bears the same terminal risk. Its only possible edge is `NAV⁺ < fair`, which the box rules out.

---

## 5. (d) Aggregate exposure caps over the strike ladder

### 5.1 Exact worst case

Sort the strikes `K_1 < … < K_n`. The tie rule `S_T ≤ K ⇒ NO` gives n + 1 settlement regions:
- region 0: `S_T ≤ K_1`, where every NO wins;
- region j: `K_j < S_T ≤ K_{j+1}`, where markets 1..j pay YES and markets j+1..n pay NO;
- region n: `S_T > K_n`, where every YES wins.

The series' terminal wealth in region j is
```
W_0 = cash + Σ_m invN_m
W_j = W_{j−1} + invY_j − invN_j                       (crossing K_j flips market j to YES)
LP loss(j) = D − W_j ;   cap:   min_j W_j ≥ D − B
```

This is **model-free**: it uses no probabilities and holds for any mispricing. It is exact because every market in the series settles on the same S_T (§2.1). It is O(n): one pass with a running minimum (`ladderMin`, `SeriesHook.sol`).

`checks.py` A:
- 20,000 random ladders (n ≤ 30) against brute force over a dense S grid that includes the tie points S = K: **0 mismatches**.
- The union bound `LB1 = cash + Σ_m min(invY_m, invN_m)` never exceeds the exact minimum.

### 5.2 Per-market form, and the equivalence with 05 §3.3

For a market with pre-mint `c_m` and signed net cash `pnlCash_m` (premiums in minus buy-backs out):
```
loss_m(o) = c_m − pnlCash_m − inv_{o,m}     ⇒   max_o loss_m ≤ B_m  ⇔  pnlCash_m + min(invY_m, invN_m) ≥ c_m − B_m
```
With `c_m = 0` and netting (`min(inv) = 0`, the lazy-mint model of 05) this is exactly `U_0 − U ≤ B_m`. It was checked on 10,000 random cases in `checks.py` F. If per-market caps are wanted in addition to the series cap, store `pnlCash_m`: one signed slot per market.

### 5.3 Correction to 04 §8.6

Per-market caps *do* bound the ladder, but only by `Σ_m B_m`, the union bound. That bound is **attained** whenever the trader positions can all win at once. `checks.py` B uses 5 strikes (4000–6000), q = 100k and 7-day BS prices:

| Trader book | Σ per-market worst loss | Exact ladder loss | Worst region |
|---|---|---|---|
| YES at every strike | 250,070 | **250,070** | S > 6000 |
| Long the range (5000, 5500]: YES@K ≤ 5000, NO@K ≥ 5500 | 76,066 | **76,066** | inside the range |
| Offsetting: NO@K ≤ 4500, YES@K ≥ 5000 (cannot all win) | 427,248 | **227,248** | S > 6000 |

**Consequence:** to guarantee a series loss ≤ B with per-market caps alone, you need `Σ B_m ≤ B`, which is wasteful when books offset. The exact cap recovers the offsets. `checks.py` G: under random two-sided flow on 9 strikes (200 trades), the exact worst-case loss is a **median 0.44** (p10 0.17, p90 0.78) of the union bound. That is roughly 2.3× more flow for the same B, though the figure depends on the flow model.

**On-chain demonstration** (`test_ladderCap_exactAllowsOffsetting_blocksAligned`):
- Setup: D = 1,000,000, B = 100,000, and 300k sets pre-minted at 4500, 5000 and 5500.
- Trade 1: traders buy 120k YES@5500. This passes the O(1) fast path.
- Trade 2: traders buy 120k NO@4500. The union bound gives 822.4k < 900k, so the exact path runs and passes with `min W = 942,400` USDC.
- Trade 3: traders buy 120k YES@5000. This is aligned with trade 1 and reverts with `LadderCap(minW = 883,600e6, floor = 900,000e6)`, decoded from the PM's `WrappedError`.

### 5.4 Keeping it bounded on-chain

- Enforce `MAX_STRIKES` per series. Use 30, as Lyra does.
- Insert strikes in sorted order at creation, which is O(n) and happens once, before trading.
- There are **no loops over series or markets outside one series**. Swap gas is independent of the total number of markets (06 T19).
- **Two-tier check in `beforeSwap`:**
  - (1) O(1): `cash + sumMinInv ≥ D − B` passes immediately. `sumMinInv` is maintained incrementally, because a trade changes `min(invY, invN)` of one market only.
  - (2) Otherwise run the exact O(n) pass.
- A lazy segment tree (range-add, global-min) would make the update O(log n) in SSTOREs. At n ≤ 30 it is not cheaper than n cold SLOADs, so it is not recommended.

### 5.5 Measured gas

A buy of YES, exact-in, through `PoolSwapTest`, with hook, PM, tokens and router cooled via `vm.cool` (`test_gas_*`):

| Strikes in series | Exact path forced | Swap gas |
|---|---|---|
| 1 | yes | 209,763 |
| 8 | yes | 247,857 |
| 16 | yes | 291,374 |
| 30 | yes | 367,562 |
| 30 | O(1) fast path | **204,264** |

- The exact pass costs **≈ 5.44k gas per strike** in this layout (two cold slots per strike: the id array element and the packed `invY|invN` word).
- Storing the ladder as one packed `uint256[]` per series (`invY<<128 | invN`) would need one cold SLOAD per strike, about 2.3–2.6k per strike. That estimate is UNVERIFIED.

LP operations (same test file, `test_gas_lpOps`):

| Operation | Gas |
|---|---|
| subscribe | 200k first / 132k later |
| topUp | 282k first per market / 129k repeat |
| merge | 171k |
| settle | 57k (oracle stub) |
| finalize, 3 markets | 486k (one unlock per market; batching into one unlock is an easy saving) |
| redeem | 96–97k |
| claim | 82–84k |

### 5.6 Beyond LP protection: OI versus settlement-manipulation cost

- A series cap protects LPs. It does not protect *traders* against settlement manipulation. The incentive to push `S_T` scales with the payout that flips at the nearest strike: `max_j |W_j − W_{j±1}| = |invY_j − invN_j|`.
- Also cap the **per-strike flip size**, `|invY_j − invN_j| ≤ F_max`. That is O(1) per trade.
- Size it against the fee-band manipulation cost `C(δ)` from 05 §8.10 and 06 §5, which the settlement gap report covers.

---

## 6. (e) Settlement, redemption and LP exit, without ever locking funds

### 6.1 Sequence

1. **`settle(series)`** (permissionless, `t ≥ T`). It reads the settlement oracle **once**, sets `settlePrice` for the whole ladder, and moves to SETTLED. One S_T for all strikes guarantees monotone outcomes: if YES@K₂ wins, YES@K₁ wins for every K₁ < K₂. That cross-strike no-arbitrage at settlement comes for free.
2. **`settleInvalid(series)`** (permissionless, `t ≥ T + GRACE`, only if still unsettled). Every YES and every NO pays ½, using the CTF payout vector `[1,1]` with denominator 2 (`gnosis_conditional-tokens-contracts/contracts/ConditionalTokens.sol:78-96`, where `redeemPositions :218-255` pays `⌊stake·num/den⌋`).
   - It is solvent in integers. The collateral after finalize is `sets − ⌊(invY+invN)/2⌋`, and traders are owed at most `Σ ⌊q_i/2⌋ ≤ (2·sets − invY − invN)/2`.
   - At most 1 unit of dust per odd holding remains (tested: ≤ 1 unit).
   - The fallback ladder before INVALID (extended window, keeper checkpoints) belongs to the settlement gap report. The LP layer only needs "SETTLED eventually, with no admin".
3. **`finalize(series)`** (permissionless, O(n)). The vault's winning inventory moves `collateral → cash`. All inventory claims are burned and their ERC-20 destroyed, so afterwards `winning.totalSupply == collateral_m` (I1'). Then `remCash = cash` and `remShares = D`.
4. **`redeem(m, X, q, to, asClaims)`** (any time after SETTLED, including before `finalize`). It burns X from the caller and pays `q`, `0` or `⌊q/2⌋` from `collateral_m`.
5. **`claim(s, k, to, asClaims)`** (after FINALIZED) uses **sequential pro-rata**: `out = ⌊k·remCash/remShares⌋`, then both remainders are decremented.

### 6.2 What cannot block exits (T27)

- `redeem` and `claim` have no `paused` check, no oracle read and no dependence on other series or LPs. Tested: the pause is on and the oracle is dead; after `GRACE`, INVALID → finalize → redeem both sides at ½, and the LP claims.
- **ERC-6909 payouts** (`asClaims = true`) call only `PM.transfer`, which needs no unlock. A USDC blacklist or pause cannot make the *hook's* payout revert. The recipient later `take`s from the PM when USDC allows it. The ERC-20 path (`unlock → burn → take`) is offered for convenience.
- `finalize` is bounded by `MAX_STRIKES`, so it cannot run out of gas.
- Never sweep unredeemed winnings to LPs. `collateral_m` stays reserved forever (V4).
- Remaining dependency: settlement itself needs the oracle, or `GRACE` to elapse. That is a delay, not a lock.

### 6.3 Sequential pro-rata: exact, monotone, Bunni-safe

Let `p = remCash/remShares`. After paying `⌊k·p⌋`, the new price is
`(remCash − ⌊k p⌋)/(remShares − k) ≥ (remCash − k p)/(remShares − k) = p`.

- The remaining price per share is **non-decreasing**. This is the anti-Bunni property (06 §2.5): n tiny claims cannot lower the value for the others.
- The last claimer gets exactly the remainder, so `Σ payouts == final cash` with **zero dust**.
- Each payout is at least `⌊k·C/S⌋`, the one-shot floor.
- `checks.py` C: 20,000 random claim orders, all properties hold, and the maximum deviation from the exact fair share is 5.86 units.
- There are no virtual shares, so none of the "first exiter loses less" distortion that OZ warns about for loss-making vaults.

---

## 7. Invariants for this layer (Foundry `invariant_*` or post-step asserts)

★ marks invariants asserted after every step of the prototype's fuzz test.

| ID | Invariant | Status in prototype |
|---|---|---|
| V1 | `PM.balanceOf(hook, USDC.id) == Σ_s(cash_s + remCash_s) + Σ_m collateral_m (+ fees) + ghost_donations` | ★ |
| V2 | `PM.balanceOf(hook, X_m.id) == inv_X,m + ghost_donations_X` for X ∈ {YES, NO} | ★ (no outcome donations in fuzz) |
| V3 | Before settlement: `YES_m.totalSupply == NO_m.totalSupply == collateral_m`. After finalize: `winning_m.totalSupply == collateral_m`. INVALID: `collateral_m ≥ Σ⌊holdings/2⌋` | ★ |
| V4 | Solvency: `collateral_m ≥ outstanding winning supply` (follows from V3); never swept | ★ (end state) |
| V5 | While live: `min_j W_j ≥ D_s − B_s` (and the per-market form of §5.2 if enabled) | ★ |
| V6 | `ladderMin` == brute force over S (differential test) | Python A; add a Solidity harness |
| V7 | `Σ_lp shares_s,lp == D_s` before finalize; `== remShares_s` after | end-to-end |
| V8 | Share-price monotonicity under deposit/withdraw/claim alone: price == 1 while subscribing; `remCash/remShares` non-decreasing across claims | Python C; end state |
| V9 | After every LP has claimed: `remCash_s == 0` (no dust); Σ LP payouts == final cash | ★ (end state) |
| V10 | Conservation: Σ wealth (ERC-20 + claims) of all actors + hook buckets constant; LP P&L == −trader P&L | ★ (end state) |
| V11 | Isolation: an op on series s changes no ledger of s′ ≠ s | to add (multi-series handler) |
| V12 | `D_s` and shares are constant between `subscriptionEnd` and FINALIZED | tested (reverts) |
| V13 | `topUp`/`merge` leave `W⃗` and NAV unchanged | ★ via V5 across random topUp/merge |
| V14 | `NonzeroDeltaCount == 0` after each call; prediction-pool `slot0` unchanged | ★ |
| V15 | Settlement monotone across strikes (one S_T per series) | by construction; assert in the settle test |
| V16 | Liveness: `redeem`/`claim` succeed with pause on, oracle dead and other series broken | tested (pause, dead oracle); add a USDC-blacklist mock |

---

## 8. Attack PoCs to include (each naive vs hardened)

| # | Attack | Naive target | Expected on the hardened design |
|---|---|---|---|
| P1 | First-depositor or inflation: 1-unit deposit, ERC-20 **and** ERC-6909 donations, then a victim deposit (T15) | `balanceOf` NAV, no offset: victim loses 100 % | victim shares == assets; victim loss 0 (**implemented**) |
| P2 | NAV manipulation across unlocks: flash-push the ETH/USDC pool, deposit at depressed NAV, restore, withdraw (T16) | shared vault with instant deposit at spot NAV: profit ≈ `a·ΔNAV/NAV` (6 % of `a` at τ = 1 h) | v1: `subscribe` reverts after `subscriptionEnd`. v2: profit ≤ 0 with NAV⁺/NAV⁻ and SoB/TWAP |
| P3 | JIT LP: deposit before a whale trade, withdraw after | earns a pro-rata share of the whale's spread risk-free | v1: reverts (**implemented**). v2: earnings ≤ vested share |
| P4 | Exit front-running (bank run): LP sees an ETH jump that makes the vault lose and exits before settlement | exiting LP escapes losses at a stale NAV | v1: `claim` reverts before FINALIZED (**implemented**). v2: exit at NAV⁻ after a delay, with shares still in supply |
| P5 | Ladder cap bypass: build an aligned book across strikes, each under its per-market cap | series loss = Σ B_m > B | reverts `LadderCap` (**implemented**); offsetting book accepted |
| P6 | Bunni-style micro-claims: n tiny claims to round other LPs down | per-share value falls | remaining pps non-decreasing; last claimer exact (Python C; add a Solidity loop) |
| P7 | Split-and-dump: user splits sets and sells both legs to drain `cash` | `bid_Y + bid_N > 1` gives riskless profit | quote invariant `bid_Y + bid_N ≤ 1` (quote report) plus the `cash`/ladder checks |
| P8 | Liveness grief: pause, dead oracle, USDC blacklist of one LP, a broken series | redemptions locked | redeem and claim still work; INVALID after `GRACE` (**implemented** for pause and dead oracle) |
| P9 | Cross-series contamination: adversarial series (tiny T, 30 strikes) trying to spend another series' cash | shared USDC claims drained | per-series buckets; V1 and V11 hold |
| P10 | Outcome-claim donation to make `PM.balanceOf(hook, YES)` exceed `invY` and confuse capacity | capacity or NAV read from `balanceOf` | ledger-only; donated claims never spent (V2 with ghost) |
| P11 | Allocation griefing: permissionless `topUp` of all cash into one strike (no cash left for buy-backs) | sells revert, capacity starved | keeper-only allocation or a reserve `cash ≥ ρD`; value-neutral either way (V13) |
| P12 | Settlement-edge LP: subscribe or unsubscribe around `openTime` with price information | — | capital frozen at `subscriptionEnd`; nothing trades before `openTime`; zero information edge |

---

## 9. Code-level specification (what the real contract should look like)

The prototype `SeriesHook.sol` has 467 lines and is not production code. Its pricing is a stub, and the oracle, settlement window and quote function come from the other reports. It demonstrates every mechanism above. For the real contract, change the following:

1. **Storage.** Use `struct Series { uint64 subscriptionEnd, openTime, T; uint32 cutoff; State; bool invalid; uint128 D, B, cash, sumMinInv, remShares, remCash; uint256 settleTick; }`. Keep the ladder as `uint256[] packedInv` (`invY<<128 | invN`) sorted by strike, plus `uint256[] strikesTick` and `mapping(PoolId => (seriesId, index, isYes))`.
2. **Series shares as ERC-6909 ids on the hook.** They should be transferable, and must be burned by `claim`.
3. **`createSeries` and `addMarket` are permissioned or bonded** (T19). All parameters are immutable (T28). Enforce uniqueness per `(pool, T, W)`.
4. **Keeper `rebalance(series, targets[])`** does `topUp`/`merge` in a single `unlock`, subject to `cash ≥ ρ·D`. Only one `unlock` per `finalize`.
5. **In `beforeSwap`**, the order is: resolve market → time window → quote (external module) → amounts with rounding → ledger effects → (per-market check) → two-tier ladder check → per-strike flip cap → claims `mint`/`burn` → return delta. The hook makes no external calls other than the PM.
6. **Events:** `Subscribed`, `Unsubscribed`, `SeriesOpened`, `ToppedUp`, `Merged`, `SeriesSettled(sid, S_T, invalid)`, `Finalized(sid, finalCash)`, `Redeemed`, `Claimed`. Swaps emit OZ `HookSwap`.

---

## 10. Open questions and residual risks

1. **Capacity policy.** Choose `c_m` per strike and the reserve ρ. Should capacity follow model delta (more sets near ATM) or the observed order flow? This is not a safety question (V13), but it drives LP returns.
2. **Idle capital.** Subscription and PREMINT phases plus post-expiry idle time reduce annualised LP yield by roughly `(subscription + grace)/tenor`. This is not quantified. Weekly series with a one-day subscription window cost about 1/7 of yield on idle capital, UNVERIFIED as a product trade-off.
3. **Value of `B_s`.** Should `B_s` be a fixed fraction of D (for example 20–30 %), or chosen by LPs at subscription, with tranching into senior and junior slices of the same series (a junior slice absorbs the first `B_j` of loss)? Tranching fits this design (terminal wealth is known exactly at finalisation), but it is not specified here.
4. **INVALID after `GRACE`.** Is 50/50 acceptable to users, or should the fallback be an external oracle? Coordinate with the settlement gap report.
5. **Transferable LP shares in a vanilla v4 pool.** Is that a meaningful mid-life exit, and does it leak information (the share price reveals the book)?
6. **v2 overlapping-series vault.** Its NAV⁺/NAV⁻ box needs the quote module to expose `P^lo`/`P^hi`, including the σ* interior point (§4.3).

---

## Verification

**Verified (primary source or executed):**
- ERC-6909 `transfer`/`transferFrom` are public without `onlyWhenUnlocked` (`v4-core/src/ERC6909.sol:25-48`), while `PM.mint`/`burn`/`take`/`settle` are `onlyWhenUnlocked` (`PoolManager.sol:291-337`, v4-core `46c6834`, 2026-04-02). Exercised by `unsubscribe`, `redeem` and `claim` with `asClaims = true` in the prototype.
- The claims-only swap path (no `sync`, no ERC-20 call in `beforeSwap`) works through `PoolSwapTest` on a fresh PM with zero balances, for all four swap types (buy/sell × exact-in/out) on YES and NO pools. Invariants V1–V5, V9, V10, V13 and V14 were asserted after every step over 1,000 fuzz runs × 40 random ops (`out_forge.txt`: 21/21 pass).
- The ladder O(n) algorithm matches brute force (20k cases). The union bound is always ≤ exact. The aligned, range and offsetting examples, and the flow-ratio statistics, come from `out_checks.txt`.
- The per-market budget equivalence with 05 §3.3 was checked on 10k random cases.
- Sequential pro-rata exactness and monotonicity were checked on 20k random orders.
- Inflation attack outcomes for naive, OZ-0, OZ-6 and internal-ledger accounting (Python), and on-chain for our design.
- The digital-price interior maximum in σ (σ* closed form versus a numerical argmax).
- Gas numbers for swaps with n = 1/8/16/30 strikes and for LP ops, measured with `vm.cool` on forge 1.8.3 / solc 0.8.26 / `via_ir`, optimizer 200 runs. These are relative figures in a test harness, not mainnet receipts.
- Prior-art mechanics were read in source:
  - Lyra v1 queue, CBs, NAV via `balanceOf` and `maxStrikesPerBoard = 30` (`ea9e36a`);
  - Thales round logic;
  - Premia v3 instant mark-to-model pps and spread vesting (`fe3b821`);
  - OZ 5.4.0 ERC-4626 virtual shares and the losses caveat;
  - CTF `[1,1]` payouts.

**Not verified / estimates:**
- **Manipulation cost ≈ `f·V·δ`** is a first-order CPMM upper-bound estimate, not a fork measurement on a real ETH/USDC v4 pool.
- **Packed-ladder gas (≈ 2.3–2.6k per strike)** is UNVERIFIED.
- **The capital-efficiency ratio (median 0.44)** depends on the synthetic flow model.
- **V11 (multi-series isolation) and the USDC-blacklist liveness PoC** are specified but not implemented.
- **Pre-minting at production scale:** gas economics for 30-strike series are not benchmarked.
- **The Thales and Lyra LP outcomes** are taken from 04 and were not re-queried.
- **The v2 queued vault** is specified, not prototyped.

## Sources

- Local code:
  - `v4-core` (`46c6834`): `src/ERC6909.sol`, `src/PoolManager.sol`, `src/test/PoolSwapTest.sol`, `test/utils/Deployers.sol`;
  - `lyra-v1` (`ea9e36a`): `contracts/LiquidityPool.sol`, `contracts/OptionGreekCache.sol`, `deployments/mainnet-ovm/params.realSNX.json`;
  - Thales `ThalesAMMLiquidityPool.sol` (Sourcify copy, `scratchpad/thales/src/contracts/AMM/LiquidityPool/`);
  - `premia-v3-contracts` (`fe3b821`): `contracts/vault/strategies/underwriter/UnderwriterVault.sol`;
  - OpenZeppelin Contracts 5.4.0 `ERC4626.sol` (copy under `repos/flaunchgg-contracts/lib/openzeppelin-contracts`);
  - `gnosis_conditional-tokens-contracts/contracts/ConditionalTokens.sol`.
- Earlier reports: 01 §1.7, §3.2–3.3, §11–12; 04 §1.5–1.6, §3.6–3.7, §8.6, §9.8; 05 §3.1–3.7; 06 §2.5, §2.10, §2.12, §6 (T15–T19, T26–T28), §7, §9.4a, §9.9.
- Scripts: `docs/md/research/gaps/lp-vault-scripts/` (`checks.py`, `sigma_extremum.py`, the Foundry prototype, and outputs).
