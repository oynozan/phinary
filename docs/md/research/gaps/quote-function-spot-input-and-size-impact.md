# Gap: one quote function for PredictionHook (spot input, size impact, dual price, spreads, clamps)

Date: 2026-09-25. Scope: the follow-up gap "one quote-function spec". This report defines the single deterministic
function that every differential test, invariant, attacker test and LP simulation in the proof plan will exercise. It
settles the conflicting spot-input recommendations in reports 01, 02, 04, 05 and 06, and proves the required
properties. The proofs are checked by an integer-exact Python reference, fuzzing, a Solidity prototype of the amount
solvers, and Monte Carlo.

Artifacts, all in `docs/md/research/gaps/quote-function-scripts/`:

| file | what it is |
|---|---|
| `quote_ref.py` | Integer-exact reference model of the spec. Python ints throughout; only Φ/φ use 50-digit mpmath, rounded in the prescribed direction. |
| `quote_fuzz.py`, `out_fuzz.txt` | Property fuzzing (F1–F9), including counterexamples for the variants the spec rules out. |
| `quote_mc.py`, `out_mc.txt`, `out_mc_a3.txt` | Monte Carlo economics: spot-input rules, carried vs reset impact, epoch-key choice, per-epoch cap, manipulation. |
| `solidity/` (`src/QuoteMath.sol`, `test/*.t.sol`), `out_forge.txt` | Solidity prototype of the four amount solvers (solady `sqrt`), with 20,000-run Foundry fuzz tests and gas numbers. |

Notation: `P(x) = Φ(d2(x))` with r = 0; `w = σ²τ`; `φ` is the standard normal pdf. An **epoch** is one value of
`block.timestamp`. `I` is the market's single signed impact variable: net YES-equivalent the vault has sold in the
current epoch. YES buys and NO sells increase I; YES sells and NO buys decrease it.

---

## 0. The answer in one page

**Spot input S (resolves the conflict).**
- The quote's mid uses the **start-of-epoch (SoB) price** of the underlying pool. This is the price in force before
  the first swap of the current `block.timestamp`.
- A pool-attached oracle hook records it in its `beforeSwap`. The pricing hook reads it through one rule:
  `sobSqrtP = (oracle.sobTs == block.timestamp) ? oracle.sobSqrtP : slot0.sqrtPriceX96`.
- It is converted to a fixed-point log price from `sqrtPriceX96`, with no tick flooring.
- **A TWAP is never used as the mid.** Measured LP arbitrage loss is ×1.35 for a 2-block TWAP, ×2.8 for 5 blocks,
  ×14 for 25 and ×93 for 150, relative to SoB.
- A short TWAP **anchor** (window `W_a`) enters only as a **worst-of overlay**: `ask = max(g⁺(x_sob), g⁺(x_twap))`,
  `bid = min(g⁻(x_sob), g⁻(x_twap))`.
  - It never raises LP arbitrage loss (measured ×0.77 to ×0.57).
  - It is **not** an efficient spread. A flat spread with the same average does as well or better (§1.3).
  - Its only job is manipulation resistance. Against attackers who control a single block close, it multiplies the
    safe per-epoch size by about `W_a/Δt`.
  - `W_a = 0` switches it off. Every theorem below holds for both settings.
- Rejected for S:
  - live `slot0`;
  - a first-touch snapshot in our hook (04 §9.3);
  - a ring buffer fed by our own trades (01 §11.5);
  - an intra-block-deviation widening that reads live `slot0` (02 §4.5), because it breaks epoch constancy.

**Size and impact.**
- Linear impact λ, **reset every epoch**, on **one signed variable per market** shared by the YES and NO pools.
- A hard per-epoch cap `|I| ≤ Q_epoch` on top, sized from the manipulation cost of the S source.
- **No permanent inventory or probit skew.** It raises extraction by ×1.92 (measured), confirming the "extract twice"
  concern. Inventory may only *widen* the risk-increasing side, never discount the other side.

**Closed forms.**
- All amounts are one quadratic over the common denominator `D = 2·10⁶·10¹⁸`:
  `N(q) = Λq² + βq` (buys, trader pays `⌈N/D⌉`) and `M(q) = −Λq² + βq` (sells, trader gets `⌊M/D⌋`),
  with `β = 2·10⁶·price + 2Λ·I₀`.
- Exact-in buys use `q = ⌊(isqrt(β² + 4Λ·A·D) − β)/(2Λ)⌋`. Exact-out sells use `q = ⌈(β − isqrt(β² − 4Λ·A·D))/(2Λ)⌉`.
- **With this exact-integer discriminant, the floor `isqrt` is provably exact**: it is maximal and minimal
  respectively, with no fix-up needed (Lemma S).
  - 05 §3.5's worry is real only for a WAD fixed-point port. We measured such a port over-delivering in 7 of
    60,000 cases, and under-delivering in 7,654 of 60,000.
- NO pools reuse the same solver in mirrored coordinates: price `1 − b` or `1 − a`, state `−I`.

**Spread.**
- `a = max_i g⁺(x_i) + h₀ + h_inv⁺` and `b = min_i g⁻(x_i) − h₀ − h_inv⁻`, where
  `g^±(x) = P(x) ± k·φ(d2(x))` and `k = c_Δ·γ_S/√w`.
- `γ_S = γ₀ + c_lag·σ√Δt` is the log-price uncertainty of the S input: fee band + tick quantisation + one epoch of
  lag.
- The gamma term goes **inside** the max/min. Putting it outside breaks monotonicity (F7x: 398 violations out of
  11,562 checks).
- Shaping the spread by gamma cuts LP arbitrage loss ×6.7 compared with a flat spread of the same average (175 vs
  1,173 USD).

**Band and cutoff.**
- Quotes are **never clamped**. A side whose base quote or any executed marginal price leaves `[p_min, 1 − p_min]`
  **halts** (reverts). Clamping hands buyers +2¢ per token every epoch (F9).
- Trading stops at `τ < τ_min`, or when `k·φ(0) > h_Δ,max`.
- A new **Mills-ratio lemma** shows that the band halt alone makes the quote monotone in S for *any* k. No k cap is
  needed for monotonicity.

**Proved (real-number proofs, plus integer fuzz and Foundry fuzz, 0 violations):**
- `bid_Y + bid_N ≤ 1 ≤ ask_Y + ask_N` at every impact state, with rounding;
- every same-epoch round trip loses at least `(a − b)·q ≥ 2h₀q`;
- no split advantage for all 8 swap types;
- monotone in each S input;
- per-epoch extraction ≤ `((|F − P_sob| − h₀)⁺)²/(2λ)`.

All of these hold together with dual pricing, impact and a binding band.

**Epoch key.**
- Store `{uint40 epochTs, int104 I, int112 E}` in one slot and reset I when `epochTs ≠ block.timestamp`.
- Use **`block.timestamp`, not `block.number`.** It is the key the oracle writes by.
  - On Arbitrum, `block.number` is about the L1 block number and several L2 blocks share a timestamp.
  - A key finer than the oracle's raises extraction ×1.92; a coarser one ×1.76 (measured).

**Quoter.**
- `V4Quoter` equals execution bit for bit **in the same epoch with the same pre-trade I**. Assert this in Foundry.
- Off-chain `eth_call("latest")` runs in the latest block's epoch, while the transaction lands in a later one: I is
  reset, S and τ are fresh. So quotes are not execution-exact; users need slippage bounds.
- A `quoteNextEpoch` view can be exact for the first trade of the next block (§6.4).

---

## 1. Resolving the spot-input conflict

### 1.1 Candidates, verdicts and evidence

| # | Source (report) | Proposal | Verdict | Why |
|---|---|---|---|---|
| C1 | 02 §4.4/§8.1 | SoB **or** 2–5 block TWAP as the price | SoB yes; TWAP as mid **no** | Sim A: TWAP-2 ×1.35, TWAP-5 ×2.79 LP arbitrage loss vs SoB (1-day ATM, L1). 02's "sweet spot" was about manipulation, and the dual anchor (C3) delivers that without pricing off the lagged value. |
| C2 | 05 §4.5/§8.6 | SoB only, never TWAP | **Adopted for the mid** | Confirmed: TWAP-150 ×92.9 (05 had ×68 with s = 0.2¢ and no cutoff; same order). |
| C3 | 06 §5.4/§9.6 | `ask = max(P(spot), P(twap)) + h`, `bid = min(...) − h`, TWAP ending at the last observation | **Adopted as an optional overlay**, with "spot" = SoB (never live slot0) and the gamma term inside the max/min | Pointwise `ask_dual ≥ ask_sob` and `bid_dual ≤ bid_sob`, so extraction can only fall (Sim A: ×0.77 / 0.66 / 0.57 for n = 2/5/25). It is not LVR-efficient (§1.3), but it raises the per-epoch manipulation-safe size ×n against attackers who control only one block close (§7.2). |
| C4 | 04 §9.3 | Snapshot at our hook's first touch in the block, plus EMA worst-of | **Rejected** | 05 §4.7b [FC]: the attacker moves the underlying and then touches our hook in the same `unlock`, so the "first touch" is already manipulated and persists for the block. Our hook cannot tell whether the underlying was swapped earlier in the block unless the underlying pool's own hook recorded it. That is exactly the rule below. |
| C5 | 01 §11.5 | In-hook ring buffer fed by market trades + `poke()` | **Rejected for S**, acceptable for σ | Same defect as C4: samples are taken whenever *we* are touched, possibly after an in-block push. It is fine for σ once winsorised and rate-limited (05 §8.9). |
| C6 | 02 §4.5 | Widen the spread when live `slot0` deviates from SoB | **Excluded from the quote function** | It makes the quote depend on intra-epoch underlying state. That breaks epoch constancy, and with it path independence, no-split and quoter = execution. It is also griefable. A deviation *circuit breaker* between two epoch-constant inputs (`|x_sob − x_twap| > δ_cb` → halt) is allowed. |

### 1.2 Exact S input (answer to (a))

**Primary, Uniswap-native, used in local proofs: an oracle hook on the underlying ETH/USDC v4 pool.**
- It extends the OZ `BaseOracleHook` write semantics. OZ writes the pre-swap tick in `_beforeSwap`
  (`oz-uniswap-hooks/src/oracles/panoptic/BaseOracleHook.sol:114-137`), once per timestamp
  (`libraries/Oracle.sol:108`: `if (last.blockTimestamp == blockTimestamp) return`).
- Our extension additionally stores the **pre-swap `sqrtPriceX96`** and a fixed-point log-price cumulative.
- Why not reuse OZ as-is: OZ stores only `int24` ticks (`Oracle.sol:38-58`), so its SoB is floored to a tick (up to
  1 bp; 4.8¢ of price error at 1 min, 03 §6.2).

```solidity
// underlying-pool oracle hook, in beforeSwap (runs before Pool.swap moves the price)
(uint160 sp,,,) = poolManager.getSlot0(id);                    // pre-swap
if (st.sobTs != uint40(block.timestamp)) {
    int256 lnP = 2 * (FixedPointMathLib.lnWad(int256(uint256(sp))) + LN_OFFSET); // 03 §5.1, ≤2.6e-18, ~878 gas
    st.lnCum += st.lastLnP * int256(block.timestamp - st.sobTs);                  // closing price of prior activity
    st.lastLnP = lnP; st.sobSqrtP = sp; st.sobTs = uint40(block.timestamp);       // + ring checkpoint for TWAPs
}

// view used by PredictionHook (pure function of pre-epoch state)
function sobSqrtPrice(PoolId id) view returns (uint160) {
    return st.sobTs == block.timestamp ? st.sobSqrtP : slot0(id).sqrtPriceX96;
}
```

**Why the `slot0` fallback is safe.** In v4 only `Pool.swap` moves `sqrtPriceX96`. Modifying liquidity and donating
do not. Every swap on the underlying pool first runs this hook's `beforeSwap`
(`v4-core/src/libraries/Hooks.sol:248-256`). The only exception is `noSelfCall` at `:253`, which applies when the
oracle hook itself swaps, and it never does. So if no observation carries the current timestamp, `slot0` still holds
the previous epoch's closing price. The value is identical before and after the first swap of the epoch: it is
**epoch-constant**. The same argument makes `observe([W,0])` extrapolation atomic-safe (06 §5.4 #1 [corrected]).

**Pricing inputs.**
- `LN_OFFSET = ln(1e18) − 96·ln2`.
- `s_o = ±1` is the orientation. On mainnet WETH/USDC, USDC is currency0, so S = 1e12/P and `s_o = −1`.
- The strike is stored canonically as `sqrtPriceX96_K`, and `lnK` is derived from it with the same formula (03 §5.1).

```
x_sob  = s_o · 2·(lnWad(sobSqrtP) + LN_OFFSET)                  // WAD, no tick flooring
x_twap = s_o · (lnCum(now) − lnCum(now − W_a)) / W_a             // WAD, fixed point; only if W_a > 0
lnK    = s_o · 2·(lnWad(sqrtPriceX96_K) + LN_OFFSET)
```

**Fork fallback: the v3 USDC/WETH 5 bp pool.**
- v3 writes the *pre-swap* tick when the tick changes (`v3-core/contracts/UniswapV3Pool.sol:733-741`), once per
  timestamp (`libraries/Oracle.sol:90`). So `observe([1,0])` gives exactly the integer SoB tick.
- The conversion is `x_sob = s_o·(Δcum + ½)·ln(1.0001)`, using the 1e36 constant `99995000333308335333166680951131`
  (03 §5.1).
- The ±½-tick quantisation (0.5 bp) is covered by γ₀ (§4).
- The TWAP uses `Δcum·LN_1_0001_E36/(W·1e18)` plus the half-tick, and never `int24` floor division.

**σ.** For v1, fix σ per market (06 §9.6). If it is estimated, it must be read with the same virtual-write rule so
that it is epoch-constant.

### 1.3 Is dual pricing worth it? Measured trade-off

1-day ATM, σ = 60%, 12 s epochs, depth ℓ = 1/λ = 1e5 tokens per $1, h₀ = 0.3¢, cutoff 30 min, 3,000 paths
(`out_mc.txt` A, `out_mc_a3.txt`):

| rule | E[LP arbitrage loss] | avg half-spread | flat-spread SoB at the same avg half-spread |
|---|---|---|---|
| SoB | $5,304 ± 78 | 0.300¢ | — |
| dual n = 2 | $4,058 ± 61 | 0.395¢ | $4,233 ± 68 (dual is 4% better) |
| dual n = 5 | $3,478 ± 52 | 0.507¢ | $3,266 ± 58 (flat is 6% better) |
| dual n = 25 | $3,006 ± 45 | 0.830¢ | $1,636 ± 37 (flat is 1.8× better) |
| SoB + gamma term (c_Δ = 1, γ₀ = 5.5 bp) | **$175 ± 3** | 1.005¢ | $1,173 ± 30 (**gamma shape is 6.7× better**) |

Conclusions:
- Dual pricing is an insurance premium paid by honest flow in trending markets. It is roughly LVR-neutral for n ≤ 5.
- It is justified only by manipulation resistance (§7.2).
- The gamma-shaped spread is the efficient LVR tool.

Recommended default: `W_a = 5·Δt` (60 s on L1), because it multiplies manipulation-safe capacity ×5 for about +0.2¢
half-spread at 1-day ATM. The proof suite runs both `W_a = 0` and `W_a = 5Δt`.

---

## 2. The quote function (normative spec)

### 2.1 Per-market parameters (immutable after creation)

| param | unit | role | suggested start |
|---|---|---|---|
| `lnK` (from `sqrtPriceX96_K`), `expiry`, `s_o` | WAD, s, ±1 | strike, expiry, orientation | — |
| `σ²` (annual) | WAD | variance; per-second variance at 1e36 if estimated (03 §5.2) | fixed per market (v1) |
| `p_min` | WAD | band `[p_min, 1 − p_min]` | 0.02 (Thales 0.08/0.95, Lyra δ ∈ [0.1, 0.9], 04 §8.8) |
| `h₀` | WAD | base half-spread | 0.3–1¢ |
| `c_Δ`, `γ₀`, `c_lag` | WAD | gamma term: `γ_S = γ₀ + c_lag·σ√Δt` | c_Δ = 1, γ₀ = pool fee + 0.5 bp, c_lag = 0.8 |
| `Λ` | WAD per whole token | impact slope; λ = Λ/1e18 USDC per token per token | from §7.1 |
| `Q_max`, `c_manip`, `m_a` | tokens, $ per unit log, — | per-epoch cap `Q_epoch` | from §7.2 |
| `W_a` | s | TWAP anchor window (0 = off) | 5Δt |
| `τ_min`, `h_Δ,max` | s, WAD | cutoffs | `τ_min ≥ W_settle + margin`; `h_Δ,max` ≈ 3¢ |
| `c_inv`, `cap_inv` | WAD, tokens | one-sided inventory widening | 1¢ at `|E| = cap_inv` |
| `δ_cb` (optional) | WAD | halt if `|x_sob − x_twap| > δ_cb` | 1–1.5% (Lyra 1.5%, 04 §3.5) |

### 2.2 Epoch quote: a pure function of epoch-constant inputs

The inputs are `x_sob`, `x_twap`, `now = block.timestamp`, the parameters, and `E_start = E − I` (vault exposure at
epoch start). Rounding is shown with ⌈·⌉ and ⌊·⌋.

```
τ = expiry − now;  halt if τ < τ_min
w = ⌊σ²·τ / YEAR⌋ (WAD);  √w = isqrt(w·1e18)
γ_S = γ₀ + c_lag·σ√Δt;   k = c_Δ·γ_S/√w;   halt if k·φ(0) > h_Δ,max          (economic cutoff)
for each source x_i ∈ {x_sob} ∪ {x_twap if W_a > 0}:
    d_i  = (x_i − lnK − w/2)/√w
    g⁺_i = ⌈Φ(d_i) + k·φ(d_i)⌉,   g⁻_i = ⌊Φ(d_i) − k·φ(d_i)⌋                 (WAD)
A = max_i g⁺_i ;  B = min_i g⁻_i
h_inv⁺ = min(c_inv, c_inv·max(E_start, 0)/cap_inv);  h_inv⁻ = min(c_inv, c_inv·max(−E_start, 0)/cap_inv)
a = A + h₀ + h_inv⁺   (YES ask base)          b = B − h₀ − h_inv⁻   (YES bid base)
up side   (YES buy, NO sell)  enabled iff p_min ≤ a ≤ 1 − p_min
down side (YES sell, NO buy)  enabled iff p_min ≤ b ≤ 1 − p_min
Q_epoch = min(Q_max, m_a·c_manip·√w / max_i φ(d_i))                       (§7.2)
```

Every item is constant within the epoch. The only state a trade changes inside an epoch is `I` (and `E`, by the same
amount, so `E_start` is constant).

### 2.3 Amounts (answer to (c))

Marginal YES price at impact state x (in units): ask `a + Λx/10⁶`, bid `b + Λx/10⁶`. NO is the mirror:
`ask_N(x) = 1 − bid_Y(x)` and `bid_N(x) = 1 − ask_Y(x)`.

| pool / direction | solver | price arg | state arg | I update |
|---|---|---|---|---|
| YES buy (USDC→YES) | buy | `a` | `I` | `I += q` |
| YES sell (YES→USDC) | sell | `b` | `I` | `I −= q` |
| NO buy (USDC→NO) | buy | `1e18 − b` | `−I` | `I −= q` |
| NO sell (NO→USDC) | sell | `1e18 − a` | `−I` | `I += q` |

With `D = 2·10²⁴`, `β = 2·10⁶·price + 2Λ·I₀`, and `A` the USDC amount:

| swap type | formula (all exact integer arithmetic) | rounding favours |
|---|---|---|
| buy, exact-out q | `cost = ⌈(Λq² + βq)/D⌉` | vault |
| buy, exact-in A | `q = ⌊(isqrt(β² + 4Λ·A·D) − β)/(2Λ)⌋`; if Λ = 0, `q = ⌊A·D/β⌋` | vault (maximal q with cost ≤ A) |
| sell, exact-in q | `proceeds = ⌊(βq − Λq²)/D⌋` | vault |
| sell, exact-out A | revert if `β² < 4Λ·A·D`; `q = ⌈(β − isqrt(β² − 4Λ·A·D))/(2Λ)⌉`; if Λ = 0, `q = ⌈A·D/β⌉` | vault (minimal q with proceeds ≥ A) |

Checks after solving, all of which revert (never partial-fill; 01 §1.9):
- **Band on every executed marginal price.** For a trade from I₀ to I₁, `10⁶·p_min ≤ 10⁶·price + Λ·x ≤ 10⁶·(1e18 − p_min)`
  at `x ∈ {min(I₀,I₁), max(I₀,I₁)}`. The curve is linear, so the endpoints suffice. This also keeps β > 0 and sells on
  the increasing branch.
- **Cap:** `|I₁| ≤ Q_epoch`.
- The exposure caps and cash budget of 05 §3.3.

v4 plumbing is unchanged from 01 §1.7. Exact-in returns `BeforeSwapDelta(+A_specified, −out)`; exact-out returns
`(−q, +in)`.

**Worked check.** 01 §1.8 case A (100 USDC in at ask 0.41, Λ = 0) gives 243,902,439 YES. `test_gas` asserts this.

---

## 3. Size and impact: choice and closed-form properties (answer to (b), (c))

### 3.1 Choice

| option | verdict | evidence |
|---|---|---|
| Flat price, no cap | forbidden | 05 §4.5: unbounded LP loss |
| Flat price + per-epoch cap Q only | insufficient | loss grows like `Q·√#blocks` (05 §4.5), and extraction per epoch is `Q·(gap − h)` instead of the smaller triangle |
| **Per-epoch-reset linear λ on one signed I per market** | **adopted** | Theorem L gives `E[extraction] ≤ ℓ·P₀(1 − P₀)/2`, independent of the number of epochs and of epoch length |
| **+ hard cap `|I| ≤ Q_epoch`** | **adopted** | λ alone does not stop manipulation. With ℓ = 1e5 and no cap, a builder who shifts SoB earns up to $11–12k per attack on the v4 5 bp source (Sim E). The cap sized per §7.2 brings the maximum profit to $0 in every scenario tested. |
| Separate impact variables for the YES and NO pools | forbidden | F8: after 2k YES of flow, minting 100 sets and selling both legs earns **+1.30 USDC** (shared I: −0.70). It also doubles the depth that Theorem L charges for. |
| Permanent skew / probit shift `d2_eff = d2 + κ·inv` (04 §9.4, Thales skew) | forbidden | Sim B: extraction ×1.19 (ρ = 0.5 carry), ×1.72 (ρ = 0.9), **×1.92 (permanent)**. The stale mid plus carried skew is traded once when stale and again after the refresh. |
| One-sided inventory widening from `E_start` | allowed | It only raises the risk-increasing side's price and never discounts the other side, so there is no second extraction, and Theorem L still holds because `a ≥ P_sob + h₀` and `b ≤ P_sob − h₀`. |

### 3.2 Lemma A (additivity): exact integers

For any split `q = q₁ + q₂`:
- buys: `N(I₀, q₁) + N(I₀ + q₁, q₂) = N(I₀, q)`;
- sells: `M(I₀, q₁) + M(I₀ − q₁, q₂) = M(I₀, q)`.

Expand `Λq₁(2I₀ + q₁) + Λq₂(2I₀ + 2q₁ + q₂) = Λq(2I₀ + q)`. The linear terms are trivially additive. The within-epoch
cost is therefore the integral of one marginal price, a single potential (as in LMSR-style cost functions).

### 3.3 Lemma S (floor `isqrt` is exact): resolves 05 §3.5

Let `q* = max{q ≥ 0 : Λq² + βq ≤ R}`, with integers `Λ ≥ 1`, `β > 0` and `R = A·D`. Then
`q̂ = ⌊(⌊√Δ⌋ − β)/(2Λ)⌋ = q*` for `Δ = β² + 4ΛR`.

*Proof.*
- For `q ≥ 0`, feasibility ⟺ `2Λq + β ≤ √Δ`.
- The quantity `m = 2Λq + β` is an **integer**, so `m ≤ √Δ ⟺ m ≤ ⌊√Δ⌋`.
- Hence the feasible q are exactly those with `q ≤ (⌊√Δ⌋ − β)/(2Λ)`, and the maximal integer is its floor. ∎

The sell case is symmetric: minimal q with `βq − Λq² ≥ R` on the increasing branch is `⌈(β − ⌊√Δ'⌋)/(2Λ)⌉`, because
`m = β − 2Λq` is an integer.

Consequences:
- The floor `isqrt` needs no fix-up loop. F1/F2 found 0 deviations in 26,526 and 26,025 cases. Foundry
  `testFuzz_buyExactIn_maximal` and `testFuzz_sellExactOut_minimal` passed 20,000 runs each.
- A one-line `assert(N(q) ≤ R < N(q+1))` costs about 200 gas and is optional defence in depth.
- **05 §3.5's concern applies to a WAD fixed-point port** (`q = (sqrtWad(a0²/1e18 + 2λA) − a0)/λ` with λ per unit
  truncated). F3 measured that port **over-delivering in 7 of 60,000 cases**, which is a vault loss. Example:
  Λ = 1,000,000,000,007; q_naive = 13,966,543,228 costs 5,435,831,287 units, one unit more than A. It also
  **under-delivered in 7,654 of 60,000**, violating maximality, which is the premise of the no-split proof.
- Rule: compute on the exact integer numerators, and never divide before the square root.

Overflow check: with `q ≤ 10¹⁵`, `A ≤ 10¹⁵`, `Λ ≤ 10¹⁶` and `|I| ≤ 10¹³`, we get `β² ≈ 4·10⁴⁸` and
`4ΛAD ≤ 8·10⁵⁵`. Both are far below 2²⁵⁶.

Gas (Foundry, solc 0.8.26, optimizer 10k, checked arithmetic, internal calls):

| solver | gas |
|---|---|
| buyExactIn | 1,734 |
| sellExactOut | 1,919 |
| buyExactOut | 1,147 |
| sellExactIn | 1,305 |

### 3.4 Theorem N (no split advantage), all eight swap types

Case by case:
- **Exact-out buys:** `⌈N₁/D⌉ + ⌈N₂/D⌉ ≥ ⌈(N₁ + N₂)/D⌉ = cost(q)`, by Lemma A.
- **Exact-in sells:** `⌊M₁/D⌋ + ⌊M₂/D⌋ ≤ ⌊M/D⌋`.
- **Exact-in buys:** `q₁ = q(A₁)` and `q₂ = q(A₂ | I₀ + q₁)` satisfy `N₁ ≤ A₁D` and `N₂ ≤ A₂D`. By Lemma A,
  `N(I₀, q₁ + q₂) ≤ (A₁ + A₂)D`, so `q₁ + q₂` is feasible for `A₁ + A₂`. It is therefore `≤ q(A₁ + A₂)` by
  **maximality**, which Lemma S guarantees.
- **Exact-out sells:** the same argument with minimality.
- **NO pools:** identical in the mirrored coordinates.

Fuzz F4: 1,841 split checks over all eight types, 0 violations. The 930 same-quantity pairs end in the same (I, E).
Foundry: two 20,000-run no-split tests pass.

---

## 4. Spread composition, band and cutoff (answer to (d))

`a − b = (A − B) + 2h₀ + h_inv⁺ + h_inv⁻`. With W_a = 0, `A − B = 2k·φ(d_sob)` up to rounding; with the anchor, it also contains the gap between the sources. The terms:

| term | formula | purpose | typical size |
|---|---|---|---|
| base | `h₀` | minimum edge; noise-flow revenue (05 §4.4) | 0.3–1¢ |
| gamma/delta | `k·φ(d_i)` with `k = c_Δ·γ_S/√w` and `γ_S = γ₀ + c_lag·σ√Δt` | neutralises S-input error: fee band `f`, ±½ tick, one epoch of lag. It equals `(φ(d2)/(σ√τ))·γ_S`, the rule in 02 §4.4 and 04 §8.1. | ATM, σ = 60%, c_Δ = 1, 5 bp pool (12 s epochs; 1 s epochs): 7d 0.41¢ (0.31¢); 1d 1.07¢ (0.81¢); 4h 2.63¢ (1.98¢); 1h 5.27¢ (3.95¢); 30 min 7.45¢ (5.59¢) |
| dual gap | `max_i g⁺_i − g⁺_sob`, `g⁻_sob − min_i g⁻_i` | manipulation anchor | +0.10¢ (n = 2), +0.21¢ (n = 5) average at 1-day ATM |
| inventory | `h_inv^±`, one-sided, from `E_start` | discourages piling on one side, with no discount | 0 to `c_inv` |

**Band.**
- There is no clamp. A side is enabled iff its base quote is in `[p_min, 1 − p_min]`, and every executed marginal
  price must also be in band (§2.3).
- Clamping instead (F9, 3 days, ETH 28% above K): fair YES is 1.000 but the clamped ask is 0.980, so buyers earn
  **+2¢ per token every epoch** without limit.
- Halting keeps the quote formula untouched wherever a quote exists. This is what makes the §5 theorems hold "when a
  clamp binds" (06 open question 5).
- Traders keep mint and merge and hold-to-settlement; exits are reduce-only if that extension is ever added.

**Cutoff.**
- Halt if `τ < τ_min` (≥ settlement window + margin, 06 §9.8).
- Halt if `k·φ(0) > h_Δ,max`. The explicit form is `τ_cut = YEAR·(c_Δ·γ_S·φ(0)/(σ·h_Δ,max))²`.
- With `h_Δ,max = 3¢` and σ = 60% on a 5 bp source this gives 185 min (12 s epochs), 116 min (2 s) and 104 min (1 s).
  Compare Thales 24 h and Lyra 12 h (04 §1.4, §3.4).
- The cutoff is **economic only**. Monotonicity does not need it (Lemma M).

---

## 5. Theorems: all hold together with dual pricing, impact, gamma, inventory widening and a binding band (answer to (e))

Fix an epoch. Its quotes `(a, b)` come from §2.2, and `a ≥ b` because `g⁺_i ≥ g⁻_i` and `h ≥ 0`.

**E1 (static no-arbitrage against mint and merge).**

*Marginal form.* At every state I:
- `ask_Y(I) + ask_N(I) = a + ΛI' + 1 − (b + ΛI') = 1 + (a − b) ≥ 1`;
- `bid_Y(I) + bid_N(I) = 1 − (a − b) ≤ 1`.

*Amount form, integers.* For every q and I:
- from the same state: `⌈N_a(I,q)/D⌉ + [q − ⌊M_b(I,q)/D⌋] ≥ q`, because
  `N_a − M_b = 2·10⁶(a − b)q + 2Λq² ≥ 0`;
- sequentially (YES then NO): `N_a(I,q) − M_b(I+q,q) = 2·10⁶(a − b)q ≥ 0`;
- the sell side is symmetric.

A halted side has no quote, and mint/merge still exist, so the inequality holds vacuously. It survives the dual
anchor because the NO quotes are *defined* as mirrors of the YES quotes. It fails with separate YES/NO impact states
(F8). Fuzz F6: 2,995 states × 4 checks, 0 violations.

**E2 (same-epoch round trips lose).**
- Buy q (exact-out) then sell q: trader net = `⌊M_b(I+q, q)/D⌋ − ⌈N_a(I, q)/D⌉ ≤ −(a − b)q/10¹⁸ ≤ −2h₀q/10¹⁸`,
  because `N_a(I,q) − M_b(I+q,q) = 2·10⁶(a − b)q`.
- The reverse order, the NO versions, buy-both-then-merge and mint-then-sell-both follow by E1 and Lemma A.

Fuzz F5: 1,632 round trips of 6 kinds, 0 violations, all ≥ 2h₀q. Foundry `testFuzz_roundTrip`: 20,000 runs.

Across epochs, round trips can profit only from new information. That is Theorem L.

**E3 (path independence and no split).** Lemma A and Theorem N.

**Lemma M (Mills-ratio monotonicity, new).** For any k ≥ 0:
- `g⁺(d) = Φ(d) + kφ(d)` has `g⁺' = φ(d)(1 − kd)`, so it increases on `d ≤ 1/k`.
- For `d > 1/k`, the Mills inequality `1 − Φ(d) < φ(d)/d < kφ(d)` gives `g⁺(d) > 1 > 1 − p_min`.
- Symmetrically, `g⁻` increases on `d ≥ −1/k`, and `g⁻ < 0 < p_min` for `d < −1/k`.
- Hence `{g⁺ ≤ 1 − p_min}` is a half-line on which g⁺ is increasing.

Numerically: `max (1 − Φ(d))/(kφ(d))` over d > 1/k and k ∈ [0.01, 10] is 0.980 < 1 (`out_fuzz.txt`).

**E4 (monotone in S).**
- The up side is enabled ⇒ `A = max_i g⁺(d_i) ≤ 1 − p_min` ⇒ every source sits on its increasing branch. So a, and
  with it every YES-buy cost and every NO-sell proceeds, is non-decreasing in each of `x_sob` and `x_twap`.
- The same holds for b on the down side.
- The integer amounts are floor/ceil of monotone rationals in (a, b), hence monotone.

Four implementation conditions:
- the gamma term must sit **inside** the max/min. With `max(P_i) + kφ(d_sob)` instead, F7x found 398 violations in
  11,562 checks: when the anchor is the max, raising `x_sob` lowers `kφ(d_sob)`;
- the on-chain Φ must be monotone, which is a fuzz property of the Hart port (05 §2.2, not a proof);
- `lnWad` must be monotone;
- `Q_epoch` depends on S only through halting, so it does not affect monotonicity.

Fuzz F7: 12,641 checks with random dual/SoB, gamma and band-binding states, 0 violations. F7y with no k cap
(k·z_band up to about 7): 11,404 checks, 0 violations, confirming Lemma M.

**Theorem L (per-epoch extraction bound).**
- Suppose the epoch quotes satisfy `a ≥ P_sob + h₀` and `b ≤ P_sob − h₀`, which holds for SoB-only, dual, and any
  h_Δ, h_inv ≥ 0. Suppose also that I starts the epoch at 0.
- Then for any set of traders and any sequence of trades in the epoch, their total value gain at a common fair value
  F is at most `max(((F − a)⁺)², ((b − F)⁺)²)/(2λ) ≤ ((|F − P_sob| − h₀)⁺)²/(2λ)`, and at most `Q_epoch·(|F − P_sob| − h₀)⁺`.
- *Proof.* All trades move the one variable I. By E2, any path costs at least the direct path from 0 to `I_end`. The
  value of the direct path is `∫₀^{I_end}(F − a − λx)dx`, maximised at `I_end = (F − a)/λ` (or the cap). ∎
- Summing over epochs gives `E[total] ≤ (ℓ/2)·Σ_k E[(F_k − P_sob,k)²] ≈ ℓ·P₀(1 − P₀)/2`, by the martingale QV
  identity (05 §4.5), up to O(Δt) theta and basis terms.
- The bound does not depend on how many epochs there are. Faster chains do not raise it.
- Simulation: with h₀ = 0.3¢, the SoB loss of $5,304 sits below the h = 0 bound of $12,500.
- The bound needs **reset at the oracle epoch** and **one shared I**. Violating either multiplies it (Sims B, C; F8).

---

## 6. Epoch state, L2 keys and the quoter (answer to (f))

### 6.1 Storage and reset

```solidity
struct Epoch { uint40 ts; int104 I; int112 E; }        // one slot per market
function _roll(Epoch storage e) internal returns (int256 I, int256 Estart) {
    if (e.ts != uint40(block.timestamp)) { e.ts = uint40(block.timestamp); e.I = 0; }
    return (e.I, e.E - e.I);
}
```

- One cold SLOAD and one SSTORE per market per swap. Nothing is carried across epochs except E.
- The prediction hook is not called on the underlying pool's swaps, so reset is lazy, on the first trade of the
  market in the epoch.
- The (a, b) computation (~3–5k gas of BS math, 05 §9.8) may be recomputed on every swap. It is epoch-constant by
  §1.2, so recomputing is equivalent to caching.

### 6.2 `block.timestamp`, not `block.number`

The reset key must equal the key at which S (and σ, and the anchor) can change. For our oracle, which writes once per
timestamp, that key is `block.timestamp`.

| chain | block.number | block.timestamp | right key |
|---|---|---|---|
| Ethereum L1 (12 s) | per block | strictly increasing per block | either one; use timestamp for uniformity |
| OP-stack: Base (2 s), Unichain (1 s + 200 ms Flashblocks) | per block | increases by the block time; Flashblocks are sub-block preconfirmations inside one block | timestamp |
| Arbitrum | "a value *close to* … the block number of the first non-Arbitrum ancestor chain"; the L2 number comes from `ArbSys(100).arbBlockNumber()` | "equal to or greater than the previous child chain block timestamp", so several L2 blocks share one | **timestamp**. `block.number` is too coarse; `arbBlockNumber` is too fine. |

Measured on a 1 s-timestamp, 4-hour ATM market (`out_mc.txt` C):
- key = timestamp: $2,475;
- a finer key (reset on each of 4 sub-blocks per second, e.g. `arbBlockNumber`): $4,743, **×1.92**;
- a coarser key (reset every 12 oracle epochs, e.g. Arbitrum `block.number`): $4,362, **×1.76**.

Sequencer timestamp latitude is bounded on Arbitrum by the rules quoted in the table. Exact OP-stack drift bounds
remain **UNVERIFIED**; add margins around τ_min and expiry (06 §5.5).

### 6.3 V4Quoter vs execution

- `V4Quoter` runs the real `PoolManager.swap` and hook path inside `unlock`, then reverts with the amount
  (`v4-periphery/src/lens/V4Quoter.sol:32-44, 113-120`). It requires an exact fill (`BaseV4Quoter.sol:54-57`), which
  our full fill-or-revert satisfies.
- Quote = execution **exactly** when both run in the same epoch with the same pre-trade `(I, E)`. The hook's
  `beforeSwap` writes (the epoch roll, I) are rolled back by the quoter's revert.
- Foundry test: quote, swap in the same block, `assertEq`, for all 8 swap types and both token orderings, with
  `W_a ∈ {0, 5Δt}`.
- **Off-chain, quotes are not execution-exact.** `eth_call` at "latest" executes with the latest block's context.
  (Hardhat changed its default to exactly this; geth documents block-context calls. Node-by-node behaviour for
  "pending" is UNVERIFIED.) The transaction lands in a later block, where I is reset to 0, S is the new SoB and τ is
  shorter.

### 6.4 `quoteNextEpoch(market, side, exactIn, amount, tsNext)`

For a sealed latest block, the next epoch's SoB is the latest block's closing `slot0.sqrtPriceX96`, and I resets to 0.
- The anchor cumulative extrapolates as `lnCum + lastLnP·(tsNext − sobTs)`.
- The quote is then exact for the first trade of the market in the next block, provided `tsNext` is guessed right
  (L1: +12 s) and no other transaction before it touches the market or the underlying close.
- A frontend should use it with an `amountOutMinimum`/`amountInMaximum` bound. Price limits are ignored on a NoOp
  (01 §1.4).

---

## 7. Parameter sizing

### 7.1 Depth λ (LVR budget)

- `E[extraction] ≤ ℓ·κ(h)·P₀(1 − P₀)/2` with ℓ = 1/λ tokens per $1 of price. κ(h) is the fee-filtering factor from
  05 §4.5; the gamma term shrinks it further (Sim A2: $175 vs $5,304).
- Choose `ℓ ≤ 2L_target/(κ·P₀(1 − P₀))`.
- A per-epoch `ℓ_k ≤ ℓ_max` (for example ℓ shrinking near expiry) keeps the bound at `ℓ_max`.

### 7.2 Per-epoch cap from the S source (manipulation budget)

- Let c = the attacker's cost per unit log shift of the SoB. The conservative, fees-only case is 02 §4.3's "slot0
  (fees)" column × 100.
- Against a shift δ, the attacker's gain is at most `Q·(Δ_bin·δ − h)`, with `Δ_bin = φ(d2)/√w`.
- Hence `Q_epoch ≤ m_a·c·√w/φ(d2)`:
  - `m_a = 1` for SoB-only;
  - `m_a ≈ W_a/Δt` for dual, **only** against attackers who do not control `W_a/Δt + 1` consecutive blocks;
  - for a sequencer or multi-block builder, `m_a = 1`.

q_safe (tokens per epoch, ATM, σ = 60%):

| S source (c from 02 §4.3) | 7 d | 1 d | 1 h |
|---|---|---|---|
| v4 ETH/USDC 5 bp mainnet ($55 per 1%) | 1,146 | **433** | 88 |
| v4 ETH/USDC 5 bp Unichain ($37 per 1%) | 771 | 291 | 59 |
| v3 USDC/WETH 5 bp mainnet ($773 per 1%) | 16,100 | 6,085 | 1,242 |
| v4 ETH/USDC 30 bp mainnet ($5.5k per 1%; γ₀ = 30 bp makes h_Δ ~6× wider) | 114,553 | 43,297 | 8,838 |

Sim E, max attacker profit over δ with ℓ = 1e5:

| source | τ | SoB, uncapped | SoB, Q = q_safe | dual-5, uncapped | dual-5, Q = 5·q_safe |
|---|---|---|---|---|---|
| v4 5 bp | 1 d | $11,458 | $0 | $6,468 | $0 |
| v4 5 bp | 1 h | $12,150 | $0 | $11,680 | $0 |
| v3 5 bp | 1 d | $6,093 | $0 | $0 | $0 |

This sim uses linear fees-only cost, so it is conservative for large δ. Reading: **the depth of the S pool, not the
option math, bounds per-epoch capacity.** On the canonical v4 5 bp pool's depth, one-day ATM markets can safely take
only about 430 tokens (about $215 of premium) per 12 s block without the anchor.

---

## 8. Validation summary

| check | tool | result |
|---|---|---|
| exact-in maximal / feasible | Python F1 (26,526), Foundry (20,000 runs) | 0 violations |
| exact-out minimal / sufficient | Python F2 (26,025), Foundry (20,000) | 0 |
| floor-isqrt needs no fix-up (Lemma S) | Python F1 | 0 / 26,526 deviations |
| naive WAD solver | Python F3 | over-delivers 7 / 60,000; under-delivers 7,654 / 60,000 |
| no split, 8 swap types | Python F4 (1,841), Foundry (2 × 20,000) | 0 |
| round trips lose ≥ 2h₀q | Python F5 (1,632), Foundry (20,000) | 0 |
| `bid_Y + bid_N ≤ 1 ≤ ask_Y + ask_N` (marginal + amounts) | Python F6 (2,995 × 4) | 0 |
| monotone in x_sob, x_twap | Python F7 (12,641) | 0 |
| gamma outside max (broken variant) | F7x | 398 / 11,562 violations |
| no k cap (Lemma M) | F7y (11,404) + Mills grid | 0; max ratio 0.980 |
| separate YES/NO impact (broken) | F8 | +1.30 USDC free per 100 sets |
| clamp instead of halt (broken) | F9 | +2¢ per token per epoch to buyers |
| S rule vs LVR; dual vs flat; gamma | MC A, A2, A3 | tables in §1.3 |
| carried skew | MC B | ×1.19 / 1.72 / 1.92 |
| epoch key | MC C | ×1.92 (finer) / ×1.76 (coarser) |
| manipulation vs cap | MC E | $0 at Q = m_a·q_safe |

Reproduce:
```
uv run --with mpmath python quote_fuzz.py 3000                              # ~1 min
uv run --with numpy --with scipy python quote_mc.py                         # ~50 s
cd solidity && forge test                                                   # needs lib/forge-std, lib/solady
```

---

## 9. What the Foundry proof plan should now state

1. **`QuoteLib`**: `epochQuote` plus the four solvers exactly as in §2, with a Python-generated differential vector
   file (`quote_ref.py`), checked bit for bit, including halts.
2. **Stateless fuzz**: E1–E4 and Lemma S, as in §8, against the Solidity library.
3. **Stateful invariants through the real PoolManager and routers**:
   - (i) after any in-epoch sequence, `I` equals the signed sum of fills, and the vault cash change is at least the
     exact-arithmetic value;
   - (ii) the quote is invariant to any swaps on the underlying pool in the same epoch (handler `moveUnderlying`
     before and after);
   - (iii) V4Quoter equals execution in the same block;
   - (iv) the epoch roll happens on a `vm.warp` and not on a `vm.roll` alone.
4. **Attacker suite**, fork and local:
   - flash-accounted push, trade, restore in one `unlock` (P&L ≤ 0 by (ii));
   - last-tx-of-block push, then trade next block, with the cap at `m_a·q_safe` (P&L ≤ 0 net of pool fees);
   - split orders, and mint/sell-both / buy-both/merge loops.
5. **LP simulation**: reuse `quote_mc.py` as the reference, adding noise flow, and run the same flow through the
   Solidity hook on sampled paths.

## 10. Open questions

1. **Threat-model constant `m_a`.** Do we assume multi-block builders (L1) or a trusted sequencer (L2)? If so, the
   anchor adds nothing and caps fall to the SoB column.
2. **Adaptive depth.** Should `Λ` and `Q_epoch` vary with τ, e.g. `Q ∝ √w/φ` as in §2.2? The LVR bound tolerates it
   (`ℓ_k ≤ ℓ_max`). The honest-flow impact on UX needs the noise-flow sim.
3. **Basis noise in Theorem L.** The pool-vs-CEX band is not a martingale increment. If it mean-reverts quickly, the
   γ₀ term covers it. A persistent basis is extracted once per change. Quantify on historical v4 swap data.
4. **Anchor source for the fork path.** On v3 the anchor has integer-tick TWAP resolution (±½ tick). This is
   harmless for a worst-of overlay, but should the SoB also use the v3 tick (0.5 bp error) or a v4 oracle-hook pool
   when both exist?
5. **Reduce-only exits outside the band.** Halting both sides strands holders of a 0.99 NO until settlement. A
   reduce-only exit at the in-band edge price is a product choice. It needs an E1-style proof with the exposure sign.
6. **Φ monotonicity in integers.** It remains a fuzz property (05 §2.2). A proof for the Hart rational on the tradable
   domain `|d| ≤ z_band + 1/k` would close the last gap in E4.

---

## Verification

**Verified in this session.**
- **Source code read:**
  - `BaseOracleHook._beforeSwap` writes the pre-swap tick (`oz-uniswap-hooks@80bd724`,
    `src/oracles/panoptic/BaseOracleHook.sol:114-137`); `observe` extrapolates with the current slot0 tick (`:152-169`).
  - Once-per-timestamp early return (`libraries/Oracle.sol:108`); tick-only `transform` (`:38-58`).
  - The v3 pool writes `slot0Start.tick` post-swap only if the tick changed (`v3-core/contracts/UniswapV3Pool.sol:733-741`);
    v3 `Oracle.sol:90`.
  - v4 `Hooks.beforeSwap`/`noSelfCall` (`v4-core@46c6834`, `src/libraries/Hooks.sol:248-256`, `:253`).
  - `StateLibrary.getSlot0` (`:40-63`).
  - `V4Quoter` (`v4-periphery@9969eec`, `src/lens/V4Quoter.sol:32-44, 113-120`) and the exact-fill check
    (`src/base/BaseV4Quoter.sol:54-57`).
  - solady `FixedPointMathLib.sqrt` is floor (`solady@2afba69`, `src/utils/FixedPointMathLib.sol:778-826`).
- **Proofs:** Lemmas A, S, M and Theorems N, E1–E4 and L were derived here. Their integer statements were fuzzed in
  Python (`out_fuzz.txt`) and in Solidity (`out_forge.txt`, 5 × 20,000 runs), with 0 violations. Every broken variant
  that the spec excludes was reproduced as a counterexample.
- **Monte Carlo:** all numbers in §1.3, §3.1, §6.2 and §7.2 come from `out_mc.txt` / `out_mc_a3.txt` (seeded).
- **Arbitrum semantics:** `block.number` and `block.timestamp`, quoted from docs.arbitrum.io ("Block numbers and time").
- **Unichain:** 1 s blocks with 200 ms Flashblocks (blog.uniswap.org, "flashblocks are live"; docs.unichain.org).
- **`eth_call`:** uses the latest block's context by default (Hardhat v1.3.0 release notes; geth RPC docs).

**Taken from earlier reports, not re-derived:**
- pool depth and cost constants ($55/1%, etc.; 02 §4.3);
- the Hart CDF monotonicity and error (05 §2.2, 03 §3.9);
- the `lnWad`-from-sqrtPrice error of 2.6e-18 (03 §5.1);
- Thales and Lyra parameters (04).

**UNVERIFIED or modelled:**
- MC manipulation costs are linear fees-only (conservative for large δ). Real concentrated-liquidity cost is convex.
- The basis between the pool and CEX is omitted from Sim A (the γ₀ term is tested only as lag filtering).
- The 3–5k gas for the BS part of `epochQuote` is from 05 §9.8, not re-measured with the dual evaluation (two Φ, two φ,
  about 2× that).
- OP-stack timestamp drift bounds.
- `eth_call("pending")` behaviour across clients.
- The oracle-hook extension (sqrtPrice SoB plus `lnCum`) is specified, not yet implemented or gas-measured. Estimate:
  +~1.1k gas on the first swap of each epoch on the underlying pool (one `lnWad` plus one SSTORE to a warm slot),
  UNVERIFIED.

**Sources.**
- Code: repos listed above (scratchpad clones, commits shown).
- Previous reports: 01 §1.7–1.9, §7.3, §11.5; 02 §4.2–4.5, §8; 03 §5.1–5.3, §6; 04 §1.4, §3.4–3.5, §8, §9.3–9.4;
  05 §3.4–3.6, §4.5–4.7; 06 §5.2–5.5, §9, §10.
- [Arbitrum: block numbers and time](https://docs.arbitrum.io/build-decentralized-apps/arbitrum-vs-ethereum/block-numbers-and-time)
- [Unichain Flashblocks](https://docs.unichain.org/docs/technical-information/flashblocks)
- [Uniswap blog: Flashblocks are live](https://blog.uniswap.org/flashblocks-are-live)
- [Hardhat v1.3.0 release (eth_call uses latest block context)](https://github.com/NomicFoundation/hardhat/releases/tag/v1.3.0)
- [geth eth namespace](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth)
- Milionis–Moallemi–Roughgarden–Zhang, arXiv:2208.06046 (LVR), and arXiv:2305.14604 (fees and discrete blocks), via
  05 §4.5.
