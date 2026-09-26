# 05 — Mathematical foundations and proof methodology

**Topic:** what can be proven analytically, what must be enforced as invariants, and what can only be shown by simulation, for a Uniswap v4 hook that prices YES/NO outcome tokens with Black–Scholes binary-option math.
**Date:** 2026-09-25. **Status:** fact-checked research report that feeds the proof plan. Apart from a small verification harness (§2.3, `05-math-scripts/evm/`), nothing has been implemented in Solidity yet. Corrections made during fact-checking are marked **[FC]** inline. The checks themselves are listed in the *Verification log* at the end.

**How to reproduce.** Every number in this report comes from the scripts in `docs/md/research/05-math-scripts/`, and the raw outputs are saved next to them as `outNN.txt`. Run a script from that directory with:
`uv run --with mpmath --with scipy --with numpy python NN_name.py`
The environment used mpmath 1.4.1, scipy 1.18.1 and numpy 2.5.3. Reference values use 40–50 significant digits in mpmath. Foundry was **not** installed in this environment, so the on-chain math was emulated bit-for-bit in Python integer arithmetic (see §2.4). **[FC]** During fact-checking, the real Solidity (solstat `Gaussian.cdf`, solady `expWad`/`lnWad`, and a Solidity port of the Hart/West CDF) was compiled with solc 0.8.26 (optimizer on, 200 runs) and executed on revm through `pyrevm`. This confirmed the Python emulation bit for bit and produced the gas numbers in §2.3. Scripts are in `05-math-scripts/evm/`. The fact-check scripts are `10_factcheck_analytic.py`, `11_factcheck_mc.py` and `12_hl_null.py`, with outputs `out10.txt`, `out12.txt` and `evm/out_run2.txt`.

**Source versions read** (all under `scratchpad/repos/`):

| repo | commit | date |
|---|---|---|
| solady | `2afba69` (v0.1.26) | 2026-09-02 |
| OpenZeppelin uniswap-hooks | `80bd724` (v1.2.2) | 2026-09-24 |
| v4-core | `46c6834` | 2026-04-02 |
| v4-periphery | `9969eec` | 2026-09-19 |
| solstat | `80c603f` | 2023-11-15 |
| lyra-v1 | `ea9e36a` | 2023-09-01 |
| prb-math | `71af01d` (package.json 4.2.0) | 2026-09-21 |
| solmate (the version solstat pins, `lib/solmate`) | `ed67fed` | 2022-09-29 |

**[FC]** solstat's `Gaussian.erfc` calls **solmate's** `expWad` from its pinned 2022 commit, not solady's (`Gaussian.sol:4,117`). That submodule is empty in the shallow clone, so it was fetched separately for the EVM check.

---

## 0. Key results at a glance

| # | Result | Status |
|---|---|---|
| R1 | Price is `YES = e^{-r_c τ}·N(d2)` with `d2 = [ln(S/K) + (b − σ²/2)τ] / (σ√τ)`. The discount rate `r_c` must equal the yield on the **locked collateral**. With idle USDC, `r_c = 0`, so **YES + NO = 1 exactly**; any `r_c > 0` opens an arbitrage against mint/merge. The drift `b` is ETH's carry in USDC terms, ≈ 0 for short-dated markets. | proven (§1.1, §3.4) |
| R2 | Worked example: S=4000, K=5000, σ=0.8, τ=30d, r=b=0 → d2 = −1.087603, **YES = 0.138385154823**, NO = 0.861614845177, Δ = 2.407e-4 per $, vega = 0.2369 per 1.00 vol, θ = −0.00316 per day. | verified with mpmath (50 digits) |
| R3 | Greeks in closed form, checked against finite differences to relative error ≤ 1e-19. Maximum delta over S is `1/(K σ √(2π τ))`, reached at d1 = 0, and it does not depend on r. Vega and theta change sign at d1 = 0. | proven + verified (§1.2) |
| R4 | **Approximation theorem.** A fixed-point implementation keeps weak monotonicity in S and K *exactly* only if every stage is monotone **and** the CDF is assembled as c(\|x\|) with c non-increasing and `c(0) ≤ 1/2`. solstat `Gaussian.cdf` breaks this: it has a **3.0e-8 downward jump at d2 = 0**, i.e. it is non-monotone at the money. Premia's Choudhury CDF drops **2.8e-4** at 0 and has error 1.4e-4. A WAD port of the Hart/West algorithm (the one Lyra uses) plus a clamp gives max error **4.3e-17** and exact symmetry. Monotonicity *across 0* is proven by Lemma C. **[FC]** Monotonicity *within each half-line* is only shown empirically: 0 violations in 150k Python pairs plus 124k on-EVM pairs. It is **not** proven, because `c = e·n/d` is not a composition of monotone stages. Measured gas on revm: ≈1.3k for Φ̂ (unchecked) and ≈3.1k for the whole quote. | proven (Lemma C) + bit-exact emulation + EVM execution (§2) |
| R5 | **Solvency does not depend on pricing.** With complete sets (1 USDC ↔ 1 YES + 1 NO) and vault netting, `C = supply(YES) = supply(NO)` is an inductive invariant. The LP's worst-case loss per market is at most the per-market budget `B_m`. Quotes must satisfy `bid_Y + bid_N ≤ 1 ≤ ask_Y + ask_N`; breaking this drains the vault, which we demonstrated. | proven + fuzzed reference model (§3) |
| R6 | **Model-free variance identity** for any binary market priced at its true conditional probability: `Σ_k E[(ΔP_k)²] = P0(1 − P0)`. It follows that total expected arbitrage loss ("LVR") against block-refreshed depth ℓ is `ℓ·P0(1−P0)/2 ≤ ℓ/8`. Monte Carlo agrees: 124,016 ± 700 vs a bound of 124,965. An independent re-run gave 126,183 ± 2,537. | proven + MC (§4.5) |
| R7 | Stale pricing hurts about linearly: a 1 → 150-block oracle lag multiplies arbitrage loss by 205×. **Pricing off a TWAP is ruinous.** **[FC]** A 30-min geometric TWAP behaves like a lag of W/3 = 10 min = 50 blocks, i.e. ≈ **70×** the 1-block loss, not 200×. A flat price with no impact is exploitable without limit. The per-block fair-price std at the money is `n(0)·√(Δt/τ)`, which does not depend on σ. | MC (§4.5–4.6) |
| R8 | The realized-variance estimator is unbiased under GBM with any (stopping-time) sampling, with `Var(σ̂²) = 2σ⁴ ΣΔᵢ²/W²`. **However**, the underlying pool price only moves inside a fee band, which biases RV downward. At σ = 0.8 on a 5 bp pool the variance bias is −63.5% at 12 s sampling, −6.7% at 5 min and ≈0 at 1 h. On a 30 bp pool it is −60% even at 5 min. **[FC]** The bias depends on σ: it is worse at lower σ, e.g. −12.9% at 5 min for σ = 0.5 on a 5 bp pool. | MC (§5) |
| R9 | The binary on a geometric TWAP over the final window w has a closed form, `d2^G = [ln(S/K) + m(τ − w/2)] / (σ√(τ − 2w/3))`, confirmed by MC. Pricing it with the European formula is off by up to 4.9¢ (1h market, 30-min window) and 0.17¢ (1d market, 30-min window). | proven + MC (§6) |
| R10 | Moving the pool price **inside the ±fee band costs almost nothing**, because arbitrageurs do not push it back. For a 1-day at-the-money market, P(settlement lands within 5 bp of K) ≈ 1%. Settlement from a single Uniswap pool therefore needs open-interest caps and a design fix. Reading spot inside the transaction is safe only for per-block size `q ≤ f·L√S·σ√τ / n(d2)`. | first-order model (§4.7) |

---

## 1. The pricing model

### 1.1 Derivation (cash-or-nothing call under GBM, risk-neutral measure)

**Setup.** Use the USDC collateral account as numeraire, paying rate `r_c`. Under Q, the ETH/USDC price follows
```
dS_t = b S_t dt + σ S_t dW_t^Q
```
where `b` is ETH's cost of carry in USDC: USDC rate minus ETH yield. The equivalent forward is `F = S e^{bτ}`, with `τ = T − t` in years.

Solving the SDE:
```
S_T = S_t · exp( (b − σ²/2) τ + σ √τ · Z ),   Z ~ N(0,1)
{S_T > K}  ⟺  Z > −d2,  d2 = [ ln(S_t/K) + (b − σ²/2) τ ] / (σ √τ)
Q(S_T > K | F_t) = N(d2)
```

**Prices.**
```
YES_t = e^{−r_c τ} E^Q[ 1{S_T > K} | F_t ] = e^{−r_c τ} N(d2)
NO_t  = e^{−r_c τ} N(−d2)
YES + NO = e^{−r_c τ}            (parity)
d1 = d2 + σ√τ
```

**Two equivalent derivations**, useful as test oracles:
- **Static replication.** `YES = −∂C_BS/∂K`, the limit of a call spread `[C(K−ε) − C(K)]/ε`.
- **PDE.** `V_t + ½σ²S²V_SS + b S V_S − r_c V = 0` with terminal condition `V(T,S) = 1{S>K}`.

**Choosing `r_c`: it is not a free parameter.**
- A complete set costs exactly 1 USDC to mint and redeems for exactly 1 USDC.
- If the hook quoted `YES + NO = e^{−rτ} < 1` while collateral sits idle, anyone could buy both legs for less than 1 and redeem for 1. That is a riskless transfer from LPs.
- So `r_c` = the yield on the vault's collateral. That is **0 for idle USDC**, which gives `YES + NO = 1`.
- If collateral is ever re-hypothecated (e.g. a yield-bearing USDC wrapper), `r_c` becomes that yield and parity becomes `e^{−r_c τ}`.

**The drift `b`.** This is the only place a "risk-free rate" legitimately enters, through the forward. Effects measured in `out01.txt`:
- For the 30d example, b = 5% raises YES from 0.13839 to 0.14238 (+0.40¢).
- For τ ≤ 7d the effect is ≤ 0.1¢.

Recommendation: take `b = 0` (driftless forward), or feed it from a funding-rate or forward estimate as a governance parameter.

**[FC] Consistency of `r_c = 0` with `b ≠ 0`.** Suppose the market USD rate r is non-zero. The market value of a claim paying 1{S_T>K} is then `e^{−rτ}·Q^T(S_T>K)`, where Q^T is the T-forward measure. Under Q^T the forward `F = S e^{bτ}` (market forward, `b = r − y_ETH`) is a martingale, so `Q^T(S_T>K) = N(d2(F))`. The protocol's par mint/merge makes a complete set worth exactly 1 at all times, so the in-protocol fair value is the **undiscounted forward-measure probability** `N(d2(F))`. That is what the recommended `r_c = 0`, `b = forward carry` computes. So the two parameters are not inconsistent: b comes from the ETH forward or perp basis, and r_c comes from what the collateral earns.

### 1.2 Greeks (general `r = b = r_c` shown; for r = 0 set D = 1)

Let `D = e^{−rτ}`, `n` be the standard normal pdf and `v = σ√τ`.

| Greek | Formula | Sign |
|---|---|---|
| Δ = ∂P/∂S | `D n(d2) / (S v)` | > 0 always |
| Γ = ∂²P/∂S² | `−D n(d2) d1 / (S² σ² τ)` | < 0 iff d1 > 0 |
| Vega = ∂P/∂σ | `−D n(d2) d1 / σ` | < 0 iff d1 > 0, i.e. iff `K < S e^{(b+σ²/2)τ}` |
| Θ = ∂P/∂t (calendar) | `r D N(d2) + D n(d2) [ d1/(2τ) − r/v ]`; for r=0: `n(d2) d1/(2τ)` | r=0: sign(d1) |
| ∂P/∂K | `−D n(d2) / (K v)` | < 0 always |
| ∂P/∂ln S | `D n(d2)/v ≤ 1/(σ√(2πτ))` | Lipschitz constant in log-price |

Verification (`01_pricing_greeks.py`): analytic vs central finite differences at h = 1e-12 in 50-digit arithmetic. Worst relative error was 1.4e-19 (theta, τ = 0.001).

**Extremal delta.**
- Setting ∂Δ/∂S = 0 is the same as Γ = 0, i.e. d1 = 0. So `S* = K e^{−(r+σ²/2)τ}`.
- Substituting gives `Δ_max = e^{−rτ} n(−σ√τ) / (S* σ√τ) = 1/(K σ √(2πτ))`. The r terms cancel. **[FC]** They cancel only when discount rate = drift (r_c = b = r). In general `S* = K e^{−(b+σ²/2)τ}` and `Δ_max = e^{(b−r_c)τ}/(Kσ√(2πτ))`. With the recommended r_c = 0, that is `e^{bτ}/(Kσ√(2πτ))`.
- Numerically checked for r = 0 and r = 0.05. Example: K=5000, σ=0.8, τ=30d gives S* = 4870.2075 and Δ_max = 3.47885e-4 both ways.
- The largest price change for a 1% spot move is ≈ `0.01/(σ√(2πτ))`. This is the Lipschitz bound of T8, since `max ∂P/∂ln S = n(0)/(σ√τ)` at d2 = 0. **[FC]** The draft's 1.69¢ was `Δ_max·S*·1%`, which is evaluated at d1 = 0 and is not the maximum of ∂P/∂ln S. The linear formula also overstates the true finite 1% move for very short τ:

| σ, τ | linear bound `0.01/(σ√(2πτ))` | exact `max_S [P(1.01S) − P(S)]` |
|---|---|---|
| 0.8, 30d | 1.74¢ | 1.73¢ |
| 0.6, 1d | 12.7¢ | 12.6¢ |
| 0.6, 1h | 62¢ | 56¢ |

**Limits** (all checked numerically in `out01.txt`):
- **τ → 0:** P → `1{S>K}` for S ≠ K. At S = K, d2 = (b − σ²/2)√τ/σ → 0, so P → 1/2. Sequence: 0.48405, 0.49840, 0.4999840, … for τ = 1e-2, 1e-4, 1e-6.
- **σ → ∞:** d2 → −∞, so P → 0. Values: 0.443 (σ=1), 0.076 (σ=10), 6.7e-47 (σ=100). The lognormal median collapses toward 0.
- **σ → 0:** P → `e^{−rτ}·1{F>K}`, and → 1/2 exactly when F = K.
- **S → 0 ⇒ P → 0; S → ∞ ⇒ P → e^{−rτ}; K → 0 ⇒ e^{−rτ}; K → ∞ ⇒ 0.**
- **At the money with r=0, P = N(−σ√τ/2) < 1/2.** Examples: 0.4543 for σ=0.8, τ=30d; 0.3446 for σ=0.8, τ=1y. Users will notice that "at the money" is not 50%. That is correct: the event is `S_T > K`, not `E[S_T] > K`.

**Worked examples** (r = b = 0 unless noted, ACT/365), from `out01.txt`:

| S | K | σ | τ | YES | Δ (per $) | vega (per 1.00 σ) | θ per day |
|---|---|---|---|---|---|---|---|
| 4000 | 5000 | 0.8 | 30d | **0.138385154823** | 2.4071e-4 | +0.23691 | −0.003159 |
| 4000 | 5000 | 0.8 | 30d, r=b=5% | 0.141796629743 (NO 0.854102214021, sum = e^{−rτ} = 0.995898843764) | 2.4440e-4 | +0.23552 | −0.003255 |
| 4000 | 4000 | 0.8 | 30d | 0.454350796091 | 4.3201e-4 | −0.05681 | +0.000757 |
| 4000 | 4400 | 0.6 | 7d | 0.117297830057 | 5.9226e-4 | +0.36269 | −0.015544 |
| 4000 | 4040 | 0.6 | 1d | 0.369741755266 | 3.0049e-3 | +0.18945 | −0.056836 |
| 4000 | 4000 | 0.6 | 1h | 0.498721270973 | 1.5558e-2 | −0.00213 | n/a (τ < 1d) |
| 3000 | 5000 | 0.8 | 97d | 0.074251439004 | 1.1354e-4 | +0.18129 | −0.000748 |

---

## 2. Formal properties and what survives approximation

### 2.1 Exact theorems (real-number model; r = b = 0 unless stated)

- **T1 (range).** `0 < P < e^{−r_c τ}` for τ > 0 and 0 < S, K, σ < ∞.
- **T2 (parity).** `YES + NO = e^{−r_c τ}`, which is 1 when r_c = 0.
- **T3 (strict monotonicity).** ∂P/∂S > 0 and ∂P/∂K < 0 (see §1.2).
- **T4 (degree-0 homogeneity).** `P(λS, λK, σ, τ) = P(S, K, σ, τ)` for all λ > 0.
- **T5 (vega sign).** sign(∂P/∂σ) = −sign(d1). The boundary is `K_v = S e^{(b+σ²/2)τ}`, i.e. K slightly above spot. Checked: for S=4000, σ=0.8, 30d, K_v = 4106.60, vega is −0.021 at 0.99·K_v and +0.021 at 1.01·K_v.
- **T6 (theta sign, r=0).** sign(∂P/∂t) = sign(d1). YES in the money (d1 > 0) accretes toward 1; out of the money it decays toward 0.
- **T7 (limits).** As listed in §1.2.
- **T8 (Lipschitz).** `|P(S1) − P(S2)| ≤ |ln S1 − ln S2| / (σ√(2πτ))` and `|∂P/∂S| ≤ 1/(Kσ√(2πτ))`.
- **T9 (martingale).** `e^{−r_c(T−t)}`-discounted YES is a Q-martingale (tower property). This underlies §4.

### 2.2 How approximation and rounding interact with T1–T9

The on-chain value is `P̂ = R(Φ̂(d̂2(S, K, σ, τ)))`, where d̂2 is computed in fixed point and R is integer rounding.

**Theorem A (error propagation).**
If `|Φ̂(x) − Φ(x)| ≤ ε_Φ` and `|d̂2 − d2| ≤ ε_d`, then
```
|P̂ − P| ≤ ε_Φ + ε_d/√(2π) + 1 ulp
```
Proof: Φ is Lipschitz with constant n(0) = 1/√(2π), then apply the triangle inequality.

The error in d2 is dominated by `ε_ln/(σ√τ) + |d2|·ε_rel(σ√τ)`. It blows up as σ√τ → 0, so the implementation must clamp `τ ≥ τ_min` and `σ ≥ σ_min`. Lyra does this: `MIN_T_ANNUALISED` = 1 s and `MIN_VOLATILITY = PRECISE_UNIT/10000` at `lyra-v1/contracts/libraries/BlackScholes.sol:50-51,189-190`. **[FC]** The source comment says "0.001%", but the value is 1e-4 = **0.01%** vol.

Measured end to end (`out02.txt`): solady `lnWad` + integer `sqrt` + floor divisions + solstat `cdf`, over 20k random inputs with S ∈ [1000, 10000], |ln(K/S)| ≤ 0.5, σ ∈ [0.2, 2], τ ∈ [60 s, 1 y]. Max `|P̂ − P| = 4.151e-8`. Almost all of it is the Numerical Recipes erfc approximation itself: that approximation evaluated in exact arithmetic already has error 4.133e-8.

**Theorem B (exact weak monotonicity via monotone composition).**
If every stage `S ↦ ⌊S·WAD/K⌋ ↦ lnWad ↦ (· − c) ↦ trunc(·WAD/v) ↦ Φ̂ ↦ R` is weakly monotone, then P̂ is weakly non-decreasing in S. The same holds for non-increasing in K, since `⌊S·WAD/K⌋` is non-increasing in K.
Proof: a composition of weakly monotone maps is weakly monotone.
- Floor and truncating division by a positive constant are monotone.
- Solady documents `expWad` and `lnWad` as "Monotonically increasing" (`solady/src/utils/FixedPointMathLib.sol:206,276`). We found 0 violations in 100k consecutive-integer checks of `lnWad` and 100k random ordered pairs of `expWad`.
- So **the property reduces to monotonicity of Φ̂.**
- Strict monotonicity cannot survive rounding: there are plateaus of width about 1 ulp / (∂P/∂S). Fuzz tests must therefore assert `≥` (or `≤`), never `>`.

**Lemma C (monotone assembly).**
Let `c: [0,∞) → [0, ½]` be non-increasing and define `Φ̂(x) = c(−x)` for x ≤ 0 and `Φ̂(x) = 1 − c(x)` for x > 0. Then:
- Φ̂ is non-decreasing on ℝ.
- `Φ̂(x) + Φ̂(−x) = 1` holds exactly in integers for x ≠ 0.

Proof: on x ≤ 0, Φ̂ = c(|x|) is non-decreasing because |x| decreases. On x > 0, Φ̂ = 1 − c(x) is non-decreasing. Across 0, `Φ̂(0) = c(0) ≤ ½ ≤ 1 − c(0⁺)` exactly when `c(0) ≤ ½` holds together with c non-increasing.
**Clamping `c := min(c, ½)` preserves the non-increasing property**, so the condition can always be enforced at the cost of one comparison.

**[FC] What Lemma C does and does not give.** Lemma C turns "c non-increasing on [0,∞)" into "Φ̂ non-decreasing on ℝ with exact symmetry". It does **not** show that a particular integer `c` is non-increasing.
- For the Hart/West port, `c = ⌊e·n/d⌋`, where e = expWad(−z²/2) decreases while n(z) and d(z) (Horner with floors) both increase. That is not a composition of monotone stages, so Theorem B does not apply to `c` itself.
- Its monotonicity is therefore an **empirical** property: 0 violations in 150k Python pairs (`out02b.txt`). On the EVM there were 0 violations in 104k consecutive-step scans (step sizes 1 wei, 1e3, 1e6 and 1e9 wei at 13 locations, including z = 0 and the 7.07 branch switch) plus 20k random close pairs (`evm/run.py`).
- In exact arithmetic, a 1-wei step in z changes c by about 4e-19 wei. So c is locally flat at the ulp scale, and any violation could only come from rounding jitter.
- To make it a *proof*, either run a symbolic/SMT check (e.g. Halmos) of `tail(z+1) ≤ tail(z)` over bounded z, or restructure c so that every stage is monotone.
- Until then, the Foundry invariant should assert exact `≥` (it has held everywhere tested) and keep the Theorem D 2ε tolerance as a documented fallback.

**Theorem D (ε-monotonicity for any ε-accurate approximation).**
If `|P̂ − P| ≤ ε`, then S1 < S2 implies `P̂(S2) ≥ P̂(S1) − 2ε`. In addition, `P(S2) − P(S1) > 2ε` implies `P̂(S2) > P̂(S1)`.
This is the fallback tolerance whenever Lemma C does not hold (e.g. solstat): the observed drop of 3.0e-8 is ≤ 2 × 4.15e-8.

**Which properties hold exactly and which only up to ε:**

| Property | Exact in fixed point? | How to get it / tolerance |
|---|---|---|
| Range `0 ≤ P̂ ≤ 1` | yes | clamp; Hart port gives c ∈ [0, ½] |
| Parity YES + NO = 1 | **yes, if `NO := WAD − YES`** | computing Φ̂(−d2) separately gives 1 wei error (solstat, measured) |
| Weakly monotone in S, K | yes, if Φ̂ satisfies Lemma C **and** its tail c is non-increasing (**[FC]** empirical for the Hart port, see above) | solstat: only within 3.0e-8, and only near d2 = 0 |
| Strictly monotone | no | plateaus |
| Vega and theta signs | only for \|d1\| > η | assert only where \|vega\|·Δσ > 2ε |
| Limits τ→0, σ→0, σ→∞ | only up to ε | clamp τ_min and σ_min; \|d2\| ≳ 8.8 returns an exact 0 or 1 (Φ(−8.8)·1e18 = 0.68 wei; **[FC]** Φ(x)·1e18 = 1 at x = −8.757) |
| Homogeneity T4 | only up to `ε_d ≈ 1e-18/(σ√τ)` | `⌊S·WAD/K⌋` rounding |
| Lipschitz T8 | up to `+2ε` | |
| Martingale T9 | model property | tested by MC, not by fuzzing |

### 2.3 Survey of on-chain Φ implementations (measured, `out02.txt`, `out09.txt`)

Max |Φ̂ − Φ| is measured on x ∈ [−9, 9] with step 1e-3. "Drop at 0" is `Φ̂(0⁻) − Φ̂(0⁺)`; positive means non-monotone.

| Library / algorithm | Source | Max \|Φ̂ − Φ\| | Drop at 0 (+ = non-monotone) | Tail behaviour |
|---|---|---|---|---|
| solstat `Gaussian.cdf` (Numerical Recipes erfcc, Chebyshev) | `solstat/src/Gaussian.sol:89-120,183-188` | **4.15e-8** (bit-exact; **[FC]** emulation matched real EVM output on 3000/3000 random inputs) | **+3.0e-8** | rel. error 1.5e-4 at x=−8; returns exactly 0 for x < −8.82 (the ±6.24 erfc domain) |
| Lyra `_stdNormalCDF` (Hart 1968 / West 2005 rational) | `lyra-v1/contracts/libraries/BlackScholes.sol:355-380` | 2.2e-16 (float64 algorithm) | 0 | full double-precision tails |
| **Hart/West ported to WAD with c ≤ ½ clamp** (ours, `02b_monotone.py`; Solidity twin in `evm/T.sol`) | uses solady `expWad` | **4.3e-17** (Python); **[FC]** 4.2e-17 on EVM | 0; 0 violations in 150k + 124k ordered pairs (empirical); exact symmetry | good down to ~1e-18 |
| RMM-core `getCDF` (A&S 7.1.26) | `rmm-core/contracts/libraries/CumulativeNormalDistribution.sol:28-48` (comment claims 3.15e-3) | 7.0e-8 | −1e-9 (monotone) | |
| Premia `_N` (Choudhury) | `Premian-Labs_premia-contracts/contracts/libraries/OptionMath.sol:40-43,197-208` | **1.4e-4** | **+2.8e-4** | rel. error ~1% at x=−9 |

**Finding: solstat is not monotone at the money.**
- The NR erfcc formula gives `erfc(0⁺) = e^{3e-8} ≈ 1.00000003`. Its constants sum to 3e-8 instead of 0.
- solstat special-cases `input == 0 → ONE` at `Gaussian.sol:90`. For a negative erfc input (i.e. cdf argument x > 0, since `cdf(x) = erfc(−x/√2)/2`) it returns `2 − r(|input|)` (`Gaussian.sol:119`). **[FC]** The NR constant sum was checked exactly: Σ = −1.26551223 + … + 0.17087277 = **+3.0e-8**.
- Bit-exact values (**[FC]** confirmed by executing the real contract on revm):
  - `cdf(−1e8 wei)` = 0.500000014960105744
  - `cdf(−2 wei)` = 0.500000015000000225
  - `cdf(−1 wei)` = `cdf(0)` = `cdf(1 wei)` = 0.5 exactly (`x·1e18/√2` truncates to 0)
  - `cdf(+2 wei)` = 0.499999984999999775
  - `cdf(+1e8 wei)` = 0.499999985039894255
- So Φ̂ **decreases** by 2.999e-8 across `|d2| < 3.75e-8`.
- Economically this is negligible: 0.03 USDC on 1M contracts.
- **But** Foundry's fuzzer biases toward edge values such as 0, so an exact "monotone in S" invariant written on top of solstat will fail. Either use Lemma C (clamp `c ≤ ½` after computing the tail `c = erfc(|x|/√2)/2`) or use tolerance 2ε = 1e-7.

**Recommendation.** Use the Hart/West rational approximation in WAD (Python reference at `02b_monotone.py::hart_cdf`). It needs one `expWad` plus two degree-6/7 Horner evaluations. Keep a solstat-based implementation only as a differential cross-check.

**[FC] Gas, measured on revm** (solc 0.8.26, optimizer 200 runs, gas measured around an internal call via `gasleft()`; excludes external-call, calldata and storage costs; `evm/run.py`, `evm/run2.py`):

| function | gas |
|---|---|
| Hart/West Φ̂, checked arithmetic | ≈ 6.3k (4.1k on the z ≥ 7.07 branch) |
| Hart/West Φ̂, `unchecked` (bounded inputs: z ≤ 37·WAD) | **≈ 1.3k** |
| solstat `cdf` | ≈ 4.9k (0.7k at x = 0) |
| solady `lnWad` | ≈ 0.55k |
| full quote: `divWad` + `lnWad` + `sqrtWad` + `mulWad` + unchecked Hart | **≈ 3.1k** |

Over 3000 random inputs (S ∈ [1000, 10000], \|ln K/S\| ≤ 0.5, σ ∈ [0.2, 2], τ ∈ [60 s, 1 y]), the full on-EVM quote pipeline had max error |P̂ − P| = **9.3e-17** against 40-digit mpmath. The draft's estimate (2–4k for Φ̂, 6–10k per quote) was pessimistic for an unchecked implementation. Still re-measure inside the real hook with `forge test --gas-report`.

### 2.4 Bit-exact emulation (method)

`02_cdf_fixedpoint.py` ports the following to Python integers with EVM semantics:
- **solady `expWad`** (`FixedPointMathLib.sol:207-270`). Signed division truncates toward zero; `>>` is an arithmetic floor. It uses the solmate lower cutoff; the constants are the same Remco Bloemen rational approximation.
- **solady `lnWad`** (`:277-345`).
- **solstat `erfc`/`cdf`**, including the `muliWad`/`diviWad` truncation (`solstat/src/Units.sol:41-47`).
- **[FC]** Differential check against the real bytecode: 0 mismatches in 3000 random inputs each for solstat `cdf`, solady `expWad` and solady `lnWad` (`evm/run.py`). The "bit-exact" label is therefore confirmed.

Sanity checks: `lnWad` error ≤ 1.05 wei. `expWad` relative error equals the floor quantisation of the output: 4.7e-7 only because exp(−27)·1e18 ≈ 1.9e6 wei.

This lets the Foundry project re-use the Python functions as a **differential-testing oracle**. Precompute JSON vectors, or call Python through `vm.ffi`.

### 2.5 Input quantisation: take S from `sqrtPriceX96`, not from `tick`

- The v4 `slot0.tick` is `⌊log_{1.0001} P⌋`, so it is quantised to 1 bp in ln S. **[FC]** There is one exception. When a zeroForOne swap ends exactly on an initialized tick boundary, v4 sets `tick = tickNext − 1` (`v4-core/src/libraries/Pool.sol:431`), one below `getTickAtSqrtPrice(sqrtPrice)`. Otherwise it uses `getTickAtSqrtPrice` (`:435`). So `tick ≤ ⌊log P⌋` and it can be one lower at a boundary. This is another reason to read `sqrtPriceX96`.
- The resulting price error is up to `n(d2)·ln(1.0001)/(σ√τ)`:

| τ, σ | max price error from using the tick |
|---|---|
| 1h, σ=0.4 | 0.93¢ |
| 1h, σ=0.8 | 0.47¢ |
| 1d, σ=0.8 | 0.095¢ |
| 7d, σ=0.8 | 0.036¢ |

- `sqrtPriceX96` has Q64.96 resolution, so the error is negligible.
- For volatility estimation the tick is acceptable at ≥ 1 min sampling (§5.3).

---

## 3. Solvency and conservation in the complete-set design

### 3.1 State machine

The executable spec is `03_solvency_model.py`.

**Units and state.**
- USDC and outcome tokens share the same decimals (1e-6). This choice matters (§3.5).
- Per market m:
  - `C` = USDC locked as collateral
  - `Ys`, `Ns` = YES and NO supply
  - `Yv`, `Nv` = vault inventory
  - `U` = vault free cash
  - `cap` = outcome-risk cap
  - per trader i: `cash_i`, `Y_i`, `N_i`

**Operations.** Every operation is atomic: a revert means no state change.

| op | effect |
|---|---|
| `mint(i,a)` | trader pays a; C, Ys, Ns += a; Y_i, N_i += a |
| `merge(i,a)` | the inverse of mint |
| `buy(i,YES,q,p_ask)` | trader pays `⌈q·p_ask⌉` into U. If `Yv < q`, the vault mints `short = q − Yv` sets from U (U −= short, C/Ys/Ns += short, Yv/Nv += short). Deliver q YES, then **net** (below). |
| `sell(i,YES,q,p_bid)` | trader delivers q YES to the vault and receives `⌊q·p_bid⌋` from U, then net. |
| `net()` | `k = min(Yv,Nv)`; burn k of each; C −= k; U += k. |
| `settle(ω)` | vault redeems its own winning inventory. |
| `redeem(i)` | pays the trader's winning balance out of C and burns both balances. |

### 3.2 Inductive invariants and proofs

Let `Tot = Σ_i cash_i + U + C` (all USDC in the system).

- **I1 (full collateralisation).** Before settlement, `C = Ys = Ns`.
  *Proof.* Holds initially (0 = 0 = 0). Each op changes (C, Ys, Ns) by (+a,+a,+a) for mint/vault-mint, by (−a,−a,−a) for merge/net, or by (0,0,0) for pure transfers (buy/sell from inventory). ∎
- **I1' (post-settlement).** `C = supply(winning token)`. At settlement C = Ys = Ns, and every redemption removes equal amounts from C and from the winning supply. Losing tokens redeem for 0. So `Σ payouts = C` with **zero rounding**. ∎
- **I2 (balance identity, Solidity).** `USDC.balanceOf(vault/hook) == Σ_m C_m + U`. Every op moves USDC and updates these variables together.
- **I3 (conservation).** `Tot` is constant. Each op only moves USDC between `cash_i`, U and C; rounding changes the size of a transfer, not the total. ∎
- **I4 (netting).** `min(Yv, Nv) = 0` after every op, by construction of `net()`.
- **I5 (no overdraft).** `U ≥ 0`. Enforced by the preconditions `U + cost ≥ short` for buys and `U + k ≥ proceeds` for sells.
- **I6 (mark-to-market zero-sum).** For **any** common mark p ∈ [0,1]:
  `Σ_i (cash_i + pY_i + (1−p)N_i) + (U + pYv + (1−p)Nv) = Tot`.
  *Proof.* From I1, `Σ_i Y_i + Yv = Ys = C` and the same for NO, so the p-terms sum to `pC + (1−p)C = C`. Then apply I3. ∎
  Consequence: **trader P&L + LP P&L = 0 at any common mark**. Spread fees are a transfer inside this identity.
- **I7 (solvency is independent of prices).** No pricing function, oracle error or approximation error can break I1–I5. The only requirement is preconditions that keep U ≥ 0. Mispricing affects *who* ends up with the value, not whether the hook can pay.

Fuzz result (`out03.txt`): 60 seeds × 4000 random ops. Prices were drawn uniformly from (0.01, 0.99), which is deliberately not model-consistent. Buys, sells, mints and merges were mixed, followed by settlement and full redemption. All of I1–I6 held after every step, and `C = Ys = Ns = 0` after all redemptions.

### 3.3 LP worst-case loss bound

- **Theorem (per-market budget).** If the hook enforces `U_0 − U_t ≤ B_m` for market m at all times (the cash the market has drawn from the vault), then the LP's terminal loss in **every** outcome is ≤ B_m.
  *Proof.* Terminal LP wealth is `W_T(ω) = U_T + Yv·1{ω=YES} + Nv·1{ω=NO} ≥ U_T ≥ U_0 − B_m`, because inventory payoffs are ≥ 0 (and, by I4, one of them is 0). ∎
  This is the same concept as Thales' "Risk Cap per Market … how much USD per market the AMM is risking" (docs.thalesmarket.io).
- **Outcome-risk range.** `W_T(YES) − W_T(NO) = Yv − Nv`. So a cap `max(Yv, Nv) ≤ X` bounds the terminal outcome dispersion by X.
- **Cash drawn per mint.** Selling q YES by minting draws `q(1 − p_ask)` from U. With price bounds `p ∈ [p_min, p_max]`, `X·(1 − p_min) ≥` the cash at risk from a single side.
- **What the bound does not cover.** It is a hard bound. It says nothing about *expected* losses: repeated informed round trips can bleed U without increasing inventory. That is §4.

### 3.4 No-arbitrage constraints on quotes (against mint/merge)

**Theorem.** With complete sets at par, the quotes are free of static arbitrage iff
```
bid_Y + bid_N ≤ 1 ≤ ask_Y + ask_N      (in USDC units, after rounding)
```
- If `ask_Y + ask_N < 1`: buy both, merge, and earn `1 − (ask_Y + ask_N)`.
- If `bid_Y + bid_N > 1`: mint for 1, sell both, and earn the excess.
- Otherwise, every round trip through mint/merge loses at least the spread.

Demonstration in `out03.txt`: quoting bids of 0.51 on each side gives the trader +0.02 USDC per loop (2.0 USDC over 100 loops), paid by the vault.

**Construction that satisfies it exactly:**
- `ask_Y = ⌈P + s⌉`, `bid_Y = ⌊P − s⌋`
- `ask_N = ⌈1 − P + s⌉`, `bid_N = ⌊1 − P − s⌋`
- with s ≥ 0, P̂ ∈ [0, 1], and `NO := 1 − YES` computed in integers.

**[FC] With intra-block impact (§3.6) the inequality must hold at every impact state, not just at I_b = 0.**
- That requires **one signed impact variable per market, in YES-equivalent units**: buying YES or selling NO increases I_b, and selling YES or buying NO decreases it. The NO quotes are then mirrors, `ask_N(I) = 1 − bid_Y(I)` and `bid_N(I) = 1 − ask_Y(I)`, which gives `bid_Y + bid_N = 1 − 2s` and `ask_Y + ask_N = 1 + 2s` at every I.
- If YES and NO had separate impact states, then after other flow pushed I_Y above 2s/λ we would get `bid_Y + bid_N = 1 − 2s + λI_Y > 1`. Anyone could then mint a set and sell both legs for a riskless profit.

This is also why **`r_c` must be 0** (§1.1). With `YES + NO = e^{−rτ}` and s < (1 − e^{−rτ})/2, the ask side breaks the constraint.

### 3.5 Rounding lemma and decimals

- **Lemma.** Round asks up and bids down. Then for any sequence of trades at fixed quotes, the vault's cash change is ≥ the exact-arithmetic cash change. And `⌈a⌉ + ⌈b⌉ ≥ ⌈a + b⌉`, so **splitting an order never reduces its cost**. That gives a "no split advantage" fuzz property. **[FC]** For exact-input swaps the matching statement is `⌊q(A₁)⌋ + ⌊q(A₂ | I_b + ⌊q(A₁)⌋)⌋ ≤ ⌊q(A₁+A₂)⌋`. It holds provided the implementation guarantees `cost(q_out) ≤ A`. An integer `sqrt` that rounds down on the discriminant does not by itself guarantee that, so add an explicit post-check or decrement step.
- **Decimals.** Outcome tokens must have **the same base unit as USDC** (6 decimals), or be ERC-6909 ids with the same unit.
  - Then mint and merge are exact 1:1 integer operations.
  - I1 never involves rounding, and redemption pays exactly C.
  - With 18-decimal outcome tokens, merges would need `/1e12` and would leave dust that breaks `C == Ys`.

### 3.6 Round-trip / path properties for the swap function (per block, fixed oracle state)

**Pricing with linear intra-block impact** (motivated in §4.5). Let `I_b` be the net YES the vault has sold in this block (reset each block). The marginal ask is `a(x) = P + s + λ(I_b + x)`.

- **Exact input A** (USDC → YES):
  - Solve `a₀q + λq²/2 = A`, with `a₀ = P + s + λI_b`.
  - `q = (√(a₀² + 2λA) − a₀)/λ`, rounded down.
- **Exact output q:** `A = ⌈a₀q + λq²/2⌉`.
- **Selling:** symmetric, with `b₀ = P − s + λI_b` and proceeds `⌊b₀q − λq²/2⌋`. Enforce proceeds ≥ 0, and keep the bid ≥ 0 / the ask ≤ 1.

**Properties** (fuzz with the oracle and block fixed):
1. **Round trip.** Buy q then sell q → trader's net USDC ≤ 0. Exactly −2sq − rounding.
2. **Path independence up to spread.** Any sequence that returns the trader's YES balance to its start leaves their USDC non-increasing.
3. **Splitting.** `cost(q1) + cost(q2 | after q1) ≥ cost(q1 + q2)`.

A cost function `C(I) = (P + s)I + λI²/2` for buys, and the mirror for sells, makes the within-block pricing an integral of a single marginal price. This is the same "price = gradient of a potential" structure as LMSR-style cost-function market makers.

**v4 sign convention.** For the custom-curve plumbing, `exactInput ⟺ params.amountSpecified < 0`. The returned `BeforeSwapDelta` is `(specified, −unspecified)` for exact-in and `(−specified, unspecified)` for exact-out. See `oz-uniswap-hooks/src/base/BaseCustomCurve.sol:97,112-127` (**[FC]** confirmed: exact-in returns `toBeforeSwapDelta(specifiedAmount, −unspecifiedAmount)` at `:119`, exact-out returns `toBeforeSwapDelta(−specifiedAmount, unspecifiedAmount)` at `:127`). The PoolManager then computes `amountToSwap = amountSpecified + hookDeltaSpecified`, which is 0 for a full NoOp (`v4-core/src/libraries/Hooks.sol:270-276`).

### 3.7 Foundry invariant-test spec (derived from the reference model)

**Handler actions.**
- `buyYes/buyNo/sellYes/sellNo` go through the **real** router → PoolManager → hook, with bounded random amounts and random traders.
- `mint/merge` are direct.
- `moveUnderlying` swaps in the ETH/USDC pool.
- `warp` advances the block and timestamp.
- `settle` and `redeem` run after expiry.

**Ghost variables.** `Σ trader USDC`, `Σ trader YES/NO`, `U`, initial totals, per-market cash drawn.

**Assertions after every call:**
- I1 / I1', I2, I3, I4, I5
- `U_0 − U ≤ B_m`
- `max(Yv, Nv) ≤ cap`
- quote constraints `bid_Y + bid_N ≤ 1e6·unit ≤ ask_Y + ask_N`
- `0 ≤ P̂ ≤ WAD`
- `YES + NO == WAD`

**Post-settlement.** Σ redemptions == C at settlement; the vault ends with `U_T = U_0 + LP P&L`, and no USDC is stuck.

**Stateless fuzz on the quote function** (Theorems B–D):
- monotone in S (≥), in K (≤)
- parity exact
- range
- `|P̂ − P_ref| ≤ ε` against Python vectors
- homogeneity within `ε_d`
- `P̂ ∈ {0, WAD}` exactly once `|d2| ≳ 8.8` (Hart port; solstat below −8.82)

---

## 4. LP P&L theory

### 4.1 Martingale theorem (fair quotes ⇒ zero expected P&L)

**Setup.** Let `P_k = E^Q[1{S_T>K} | F_k]` with r_c = 0 (T9). A trader holds `θ_{k−1}` YES over block k, with θ predictable and bounded. They trade at fair prices plus a half-spread s. Their P&L is
```
G = Σ_k θ_{k−1}(P_k − P_{k−1}) − s Σ_k |θ_k − θ_{k−1}|
```

**Claim.** `E^Q[G] = −s·E[Σ|Δθ|] ≤ 0`.

**Proof.** Since P is a martingale and θ_{k−1} is F_{k−1}-measurable, `E[θ_{k−1}(P_k − P_{k−1})] = E[θ_{k−1}·E[P_k − P_{k−1} | F_{k−1}]] = 0`. ∎

**Consequence.** By I6, `LP P&L = −G`, so `E^Q[LP P&L] = s·E[volume] ≥ 0`. The LP can only lose in expectation when quotes deviate from the true conditional probability. The three channels are §4.2–4.5.

Check (`out04.txt`): 20k paths, 1-day at-the-money market, 12 s blocks. E[payoff] = 0.48335 ± 0.0035 vs P0 = 0.49165. That is −2.4 se (p ≈ 0.016); the 200k-sample calibration test in §7 finds no bias. **[FC]** An independent 2M-sample check gave 0.49235 ± 0.00035 (+2.0 se, opposite sign), and `N(−σ√τ/2) = 0.491648` is exact analytically. Both deviations are sampling noise.

### 4.2 Wrong measure: real-world drift μ ≠ b

The hook quotes the Q-probability. Under P, `E_P[1{S_T>K}] = N(d2^μ)`, where d2^μ uses μ in place of b. A buy-and-hold edge per YES is
```
edge = N(d2^μ) − N(d2^b) ≈ n(d2)·(μ − b)√τ/σ
```
From `out01.txt`, with σ = 0.8:

| μ | τ | at the money | K = 1.1·S |
|---|---|---|---|
| +20%/y | 1d | +0.52¢ | +0.04¢ |
| +20%/y | 7d | +1.38¢ | +0.92¢ |
| +20%/y | 30d | +2.85¢ | +2.53¢ |
| +100%/y | 30d | +14.2¢ | +13.4¢ |
| −50%/y | 30d | −7.0¢ | −5.9¢ |

**Implication.** For multi-week markets, the risk premium (or a crowd's directional view) is of the same order as any reasonable spread. LPs are *short a directional view* against informed directional flow. Short tenors (≤ 7d) keep this below ~1.4¢ even at μ = 20%.

### 4.3 Wrong σ

The edge of a trader who knows σ_true is `|P(σ_true) − P(σ_quote)| − s ≈ |vega|·|Δσ| − s`. Examples at 10% relative σ error:

| moneyness | τ | price error |
|---|---|---|
| ATM | 1d | 0.08¢ |
| K/S = 1.05 | 1d | 2.3¢ |
| K/S = 1.10 | 7d | 2.1¢ |
| K/S = 1.25 | 30d | 1.9¢ |

Vega exposure is concentrated **out of the money**, not at the money. Estimation SEs are in §5.

### 4.4 Spread revenue and a Glosten–Milgrom-style break-even

With uninformed volume V (in tokens) and half-spread s, revenue is `s·V`. Informed flow costs the channels of §4.2, §4.3 and §4.5. Break-even: `s·V_noise ≥ E[informed extraction]`. The sharpest channel is §4.5.

### 4.5 Stale-price arbitrage: the digital-option analogue of LVR

**Theorem (total quadratic variation of a binary market; model-free).**
Let `(P_k)` be a square-integrable martingale with `P_N ∈ {0,1}`. Then
```
Σ_{k=1}^N E[(P_k − P_{k−1})²] = E[P_N²] − P_0² = P_0 − P_0² = P_0(1 − P_0)
```
*Proof.* Martingale increments are orthogonal, and P_N² = P_N. ∎
In continuous time, `E[⟨P⟩_T] = P0(1−P0)`.
This holds under jumps, stochastic volatility and any model, as long as the quote is the true conditional probability. **The total "price-variance budget" of a binary market is at most 1/4.**

MC check: `E[ΣΔP²] = 0.249763 ± 0.00146` vs `P0(1−P0) = 0.249930`.

**Corollary (LVR with block-refreshed linear depth).** Assume:
- At each block the hook quotes around the fair price computed from the previous block's oracle price.
- It offers depth `ℓ = 1/λ` (the marginal price moves by λ per token traded), reset at each oracle refresh.
- Its half-spread is s.

An arbitrageur who sees the new fair price trades `q* = (|gap| − s)^+/λ` and earns `((|gap| − s)^+)²/(2λ)`. Summing:
```
E[total LVR] = (1/2λ) Σ_k E[((|gap_k| − s)^+)²]  ≤  ℓ·P0(1−P0)/2  ≤  ℓ/8
```
Equality holds at s = 0, up to the O(Δt) theta term inside `gap_k`.

The instantaneous rate is `½ ℓ σ²S²(∂P/∂S)² = ½ ℓ n(d2)²/τ`. This is the digital-option counterpart of the CFMM formula `LVR = (σ²P²/2)·|x*'(P)|` in Milionis–Moallemi–Roughgarden–Zhang, "Automated Market Making and Loss-Versus-Rebalancing" (arXiv:2208.06046). The hook's depth ℓ plays the role of |x*'(P)|, and the digital's price variance plays the role of σ²P².

**With fees and discrete blocks.** For X ~ N(0, v):
```
E[((|X| − s)^+)²] = 2[(v + s²)(1 − N(s/√v)) − s√v·n(s/√v)]
```
Verified by MC (`out08.txt`). Fees scale the loss down by a factor κ(s). This matches the qualitative result of Milionis–Moallemi–Roughgarden (arXiv:2305.14604): fees cut arbitrage profits by the fraction of blocks that present profitable opportunities.

**MC verification** (`out04.txt`): 1-day at-the-money market, σ = 0.8, 12 s blocks, λ = 1e-6 USDC per token per token (so ℓ = 1e6 tokens per $1 of price):

| half-spread s | E[arb profit] (USDC) | E[LP P&L] | κ(s) = loss / (s=0 loss) | break-even noise volume V*/ℓ = κ·P0(1−P0)/(2s) |
|---|---|---|---|---|
| 0 | 124,016 ± 700 | −123,552 ± 454 | 1 (bound: **124,965**) | ∞ |
| 0.002 | 81,254 | −80,583 | 0.655 | 40.9 |
| 0.005 | 45,190 | −45,279 | 0.364 | 9.1 |
| 0.010 | 22,079 | −22,419 | 0.178 | 2.2 |

**Sizing rule.** To keep expected arbitrage loss ≤ L per market, set `ℓ ≤ 2L/(κ(s)·P0(1−P0))`. Example: s = 0.5%, L = $10k → ℓ ≤ **220k** tokens per $1 of price, i.e. ≤ 2,200 tokens per 1¢ of impact. **[FC]** The draft said 222k; `2·10⁴/(0.364·0.24993) = 219.8k`.

**Staleness dominates** (same setup, s = 0.002, 5k paths):

| oracle lag | E[arb profit] | multiple |
|---|---|---|
| 1 block (12 s) | 82.5k | 1× |
| 5 blocks | 505k | 6.1× |
| 25 blocks | 2.75M | 33× |
| 150 blocks (30 min) | 16.9M | 205× |

- Loss is ≈ linear in lag, because `E[gap²] ∝ lag·σ²S²Δ²`.
- For a geometric TWAP with window W, the gap variance is `σ²·W/3` in log-price. So pricing off a TWAP is equivalent to a lag of W/3.
- **[FC] Checked by an independent MC** (`11_factcheck_mc.py`, 1500 paths, s = 0.002). Multiples relative to a 1-block lag:
  - lag 5: 6.3×
  - lag 25: 34×
  - lag 50: 69×
  - lag 150: 203×
  - quotes from a 150-block (30-min) geometric TWAP: **68×**, matching lag W/3 = 50 blocks.
- **Conclusion: price off the freshest non-manipulable price** (start-of-block, §4.7), **never off a TWAP.**

**Flat price (no impact) with a per-block cap Q** (s = 0.002, Q = 1000 tokens/block): E[loss] = $4,973 (1h market) vs $16,687 (24h market). Loss grows like `Q·Σ_k E(|gap_k| − s)^+ ~ Q·√(#blocks)`. With **no cap and no impact the loss is unbounded**, because the quoted price does not move against the arbitrageur. Some form of depth limit (λ > 0 or Q < ∞) is mandatory.

**Noise plus arbitrage** (s = 0.005, λ = 1e-6, 10k paths):

| noise volume | noise revenue | arb loss | E[LP P&L] | sd | P(LP<0) |
|---|---|---|---|---|---|
| 360k tokens | 1.8k | 45.4k | −42.7k | 76.6k | 0.78 |
| 4.32M tokens | 21.6k | 45.6k | −24.0k | 92.2k | 0.57 |

Break-even needs ≈ 9M tokens/day at this depth, consistent with V*/ℓ = 9.1. The LP P&L standard deviation (≈ 77–92k) is **much larger than its mean**; see §7 for sample sizes.

### 4.6 Pin risk near expiry

- **Where the variance lives.** At the money with small σ√T, the share of total price variance (and so of LVR) in the last h of a market's life is `1 + (2/π)·arcsin(h/T − 1)`.
  - Derivation: `E[n(d2_t)²] = (1/2π)√(τ/(τ + 2t))`, then integrate `∫dτ/√(τ(2T−τ))`.
  - MC vs formula: last 1% of life 0.092 vs 0.090; last 10% 0.286 vs 0.287; last 25% 0.459 vs 0.460; last 50% 0.666 vs 0.667.
  - Halting trading in the last 1% of the life removes ~9% of expected LVR.
- **Per-block price std at the money** is `n(0)·√(Δt/τ)`, **independent of σ**. With 12 s blocks: 17.8¢ at 1 min to expiry, 8.0¢ at 5 min, 2.3¢ at 1h, 0.47¢ at 1d.
- **When per-block moves exceed the half-spread:** `τ* = Δt·(n(0)/s)²`.

  | s | τ* at 12 s blocks | τ* at 1 s blocks |
  |---|---|---|
  | 0.5% | 21.2h | 1.8h |
  | 1% | 5.3h | 26.5 min |
  | 2% | 1.3h | 6.6 min |
  | 5% | 12.7 min | 1.1 min |

  On 1 s blocks (L2), τ* is 12× shorter. Block times for the target chain are **UNVERIFIED**.
- **Delta and gamma blow up.** Δ_max ∝ τ^{-1/2}, |Γ| ∝ 1/τ. The vault cannot hedge a digital near expiry, so risk must be controlled with a trading cutoff and exposure caps. Neither hedging nor pricing helps.
- **Settlement flip probability.** The probability that the settlement statistic lands within ±δ of K is ≈ `2δ·n(d2)/(σ√(τ − 2w/3))`: 0.95% (1d, 5 bp), 1.9% (1d, 10 bp), 0.36% (7d, 5 bp).

### 4.7 Oracle-manipulation economics (first-order, concentrated liquidity treated as locally constant-product)

**Model.** Moving the underlying pool by a fraction ε needs ≈ `L√S·ε/2` USDC. Write `L√S ≈ 200·D1`, where D1 is the USDC needed to move the price by 1%.

**(a) Reading live spot inside the transaction.** The attacker pushes S, trades YES, and pushes S back. Cost ≈ fees `f·L√S·ε`, since price impact is recovered. Gain ≈ `q·n(d2)·ε/(σ√τ)`. Profit is **linear in ε**, so the attack is unboundedly profitable once
```
q > q_safe = f·L√S·σ√τ / n(d2)
```
q_safe (tokens) at the money, σ = 0.8:

| D1 | fee | 7d | 1d | 1h | 5 min |
|---|---|---|---|---|---|
| $1M | 5 bp | 27.8k | 10.5k | 2.1k | 0.6k |
| $5M | 5 bp | 139k | 52k | 10.7k | 3.1k |
| $20M | 30 bp | 3.3M | 1.26M | 257k | 74k |

q_safe falls as √τ, which is another reason for an expiry cutoff.

**(b) Start-of-block price.** Use the price recorded before the first swap of the block. OZ `BaseOracleHook._beforeSwap` reads `getSlot0` and writes at most once per block; its source notes the observation "never reflects a price moved within the current transaction" (`oz-uniswap-hooks/src/oracles/panoptic/BaseOracleHook.sol:103-135`, `libraries/Oracle.sol:107-108`).
- The attacker must now hold the displacement across a block boundary, which costs roughly `L√S·(ε − f)^+(ε + 3f)/4` per block to arbitrageurs plus fees.
- Displacements **within ±f are not arbitraged back and are nearly free**.
- So the same q_safe per block still applies.
- **[FC] Where the start-of-block price has to come from.** It must be written by the **underlying pool's own hook** in its `beforeSwap`, as `BaseOracleHook` does. Our PredictionHook cannot build it by caching `slot0` of the ETH/USDC pool on its first interaction in a block. An attacker can push the ETH/USDC pool and then call our hook in the same `unlock`, so the "first-seen" value is already manipulated, and it would also carry into later blocks.
- **[FC] v4 flash accounting makes attack (a) capital-free.** The push, the YES trade and the push-back can all happen inside one `unlock` and net-settle at the end. So the attacker needs only fees and gas, never inventory.
- **[FC] The oracle hook only covers pools that use it.** An oracle hook serves only pools that were initialized with it; a hookless canonical ETH/USDC v4 pool has no such observation stream. `BaseOracleHook.observe(secondsAgos, underlyingPoolId)` (`BaseOracleHook.sol:152-169`) reads only pools that this hook itself records.
- Multi-block MEV (a proposer or sequencer controlling consecutive blocks) makes this cheaper. See Mackinga–Nadahalli–Wattenhofer, "TWAP Oracle Attacks: Easier Done than Said?" (IACR ePrint 2022/445).

**(c) TWAP settlement over window w (fee-band aware).**
```
C(δ) ≈ L√S·[ f·δ + (w/Δt)·(δ − f)^+ (δ + 3f)/4 ]
```

| D1 | fee | window | δ = 5 bp | δ = 10 bp | δ = 50 bp (12 s / 1 s blocks) |
|---|---|---|---|---|---|
| $5M | 5 bp | 30 min | **$250** | $47k | $1.10M / $13.2M |
| $5M | 30 bp | 30 min | $1.5k | $3k | $1.07M |

**Implication.** Any market whose settlement lands within about ±f of K can be flipped for roughly the cost of a fee on a small trade. That happens ~1% of the time for a 1-day at-the-money market on a 5 bp pool, and ~5.7% on a 30 bp pool (2f/(σ√τ)·n). **The open-interest cap per market must be sized against this, or settlement must change** (see §8 and §9). This model is first-order and **UNVERIFIED against real pool data**.

---

## 5. Volatility estimation from the underlying pool

### 5.1 Estimator and exact moments

**Estimator.** Observations `(t_i, x_i)` with `x_i = ln S_{t_i}`. From v4 state, `x = 2·ln(sqrtPriceX96/2^96) + ln(10^{dec0−dec1})`, or `tick·ln(1.0001)` from ticks. Then
```
r_i = x_i − x_{i−1},  Δ_i = t_i − t_{i−1},  W = ΣΔ_i
σ̂² = Σ r_i² / W        (using ticks: Σ (Δtick_i)²·ln(1.0001)² / W,  with ln(1.0001)² = 9.9990e-9)
```

**Moments under GBM**, where `r_i ~ N(mΔ_i, σ²Δ_i)` and `m = μ − σ²/2`:
```
E[σ̂²]   = σ² + m²·ΣΔ_i²/W                 (drift bias ≤ m²·max Δ; ≈ 7e-5 at μ = 300%/y with 5-min sampling; negligible)
Var[σ̂²] = (2σ⁴ΣΔ_i² + 4m²σ²ΣΔ_i³)/W² ≈ 2σ⁴ΣΔ_i²/W²  ≥  2σ⁴/n      (Cauchy–Schwarz; equality iff equal spacing)
SE(σ̂)/σ ≈ √(ΣΔ_i²)/(√2·W) → 1/√(2n)
```

**Unbiasedness with endogenous sampling.** If samples are taken whenever swaps occur (stopping times), `r_i² − σ²Δ_i` are martingale differences when the log-price has zero drift (m = 0). **[FC]** "Driftless GBM" (μ = 0) still has m = −σ²/2, which leaves the negligible `m²ΣΔ²/W` bias. So `E[σ̂²] = σ²` still holds (optional stopping / Wald's second identity), provided the window endpoints (and so W) are fixed and not random. Swap-driven, irregular sampling is **unbiased but less efficient**: effective `n_eff = W²/ΣΔ_i²`.

MC (`out05.txt`, σ = 0.8, 1-day window):

| sampling | n | Var(σ̂²) observed | Var(σ̂²) theory | relative SE of σ̂ |
|---|---|---|---|---|
| regular 5 min | 288 | 2.88e-3 | 2.84e-3 | 4.19% (1/√576 = 4.17%) |
| regular 1 min | 1440 | 5.71e-4 | 5.69e-4 | 1.87% |
| exponential gaps (mean 5 min) | 320 | 5.19e-3 | 5.23e-3 | 5.6% (n_eff ≈ n/2) |
| Pareto gaps | 345 | 6.31e-3 | 6.36e-3 | 6.1% |

In all four cases E[σ̂²] is within 0.1% of 0.64.

### 5.2 Confidence intervals

- **Method.** With equal spacing and m ≈ 0, `n·σ̂²/σ² ~ χ²_n`, giving the CI `σ ∈ [σ̂√(n/χ²_{n,0.975}), σ̂√(n/χ²_{n,0.025})]`.
- **Measured coverage** (40k paths): 0.9506 (n=24), 0.9517 (96), 0.9485 (288), 0.9493 (1440).
- **Typical 95% multiplier:** [0.925, 1.089] at n = 288.
- **Irregular spacing:** use Satterthwaite with `ν = n_eff`.

### 5.3 Error sources specific to Uniswap

1. **Tick quantisation** (`floor` to 1 bp). Relative bias `+ln(1.0001)²/(6σ²Δ)`. Predicted vs measured: 1.0068 vs 1.0069 at 12 s; 1.0014 vs 1.0014 at 1 min; 1.0003 at 5 min. Negligible at ≥ 1 min. Use `sqrtPriceX96` to remove it.
2. **The fee band is the dominant bias.** Model the pool as CEX-GBM reflected into a band `±γ ≈ fee`, which is the standard arbitrage model.
   - Pool RV is biased **downward**: the pool is sticky and moves only when the CEX price leaves the band.
   - E[σ̂²_pool]/σ² − 1:

   | pool fee | 12 s | 1 min | 5 min | 1 h |
   |---|---|---|---|---|
   | 5 bp | −63.5% | −30.2% | −6.7% | ≈0 (**[FC]** the draft said −0.1% ± 0.4%; with only 24 samples per 1-day window the MC standard error is ≈ 0.65% at 2000 paths) |
   | 30 bp | −91.3% | −82.0% | −60.2% | −9.5% |

   - **[FC]** The table is for σ = 0.8 (`05_vol_estimation.py`), with arbitrage once per 12 s block. An independent re-run (`11_factcheck_mc.py`, 400 paths) gave −63.6%, −30.2% and −6.5% (5 bp) and −91.3%, −82.1% and −60.4% (30 bp). The bias depends on σ√Δ/f. At **σ = 0.5** it is larger: −73.6%, −46.2%, −12.9% and ≈ −1% (5 bp), and −94.4%, −88.4%, −74.4% and −23.6% (30 bp), for 12 s, 1 min, 5 min and 1 h sampling.
   - Real pools also carry noise flow that moves the price *inside* the band, which adds positive bias. The net sign on real data is **UNVERIFIED** and should be measured on historical v4 pool data.
   - Mitigations: sample sparsely (≥ 5–15 min on a 5 bp pool); estimate a multiplicative correction by simulation or history; or use the lowest-fee deep pool.
3. **Truncated oracles.** The Panoptic-style oracle caps the per-observation tick move at `MAX_ABS_TICK_DELTA` (`oz-uniswap-hooks/src/oracles/panoptic/libraries/Oracle.sol:46-51`). Truncated returns bias RV down in high-vol or jump regimes. Keep the **untruncated** `tickCumulative` for RV and use truncation only for manipulation-sensitive prices.
4. **Manipulation of σ̂.** A round trip of size ε, if sampled at both ends, adds ≈ 2ε² to RV for ~fee cost; displacements inside the fee band are nearly free (§4.7). Mitigations: one sample per block (start-of-block), winsorise |r_i| at k·σ̂√Δ, bound σ̂ to [σ_min, σ_max], and rate-limit changes in σ̂.
5. **Jumps.** RV estimates total quadratic variation, i.e. diffusive plus jump variance. Using it in BS misprices digitals (§7, Merton table).
6. **On-chain cost.** Re-summing n observations per quote costs about n cold SLOADs. Instead maintain an **accumulator of squared returns** alongside `tickCumulative`, sampled at most once per `Δ_min`, so any window's RV is the difference of two accumulator reads. That is O(1).
7. **EWMA alternative.** `σ²_t = λσ²_{t−1} + (1−λ)r_t²/Δ_t`, with λ^{Δ_t} for irregular gaps. Effective `n_eff = (1+λ)/(1−λ)`, relative SE `1/√(2n_eff)`:

   | λ | n_eff | relative SE |
   |---|---|---|
   | 0.94 | 32 | 12.4% |
   | 0.97 | 66 | 8.7% |
   | 0.99 | 199 | 5.0% |
   | 0.997 | 666 | 2.7% |

### 5.4 From σ̂ error to price error

`dP/d ln σ = −n(d2)·d1`, so `SE(P) ≈ n(d2)|d1|/√(2n)` (`out05.txt`):

| moneyness | τ | SE(P), 1-day window @ 5 min | SE(P), 7-day window @ 5 min | price error from 10% σ error |
|---|---|---|---|---|
| ATM | 1d | 0.03¢ | | 0.08¢ |
| ATM | 30d | 0.19¢ | | |
| K/S = 1.05 | 1d | **0.94¢** | 0.36¢ | 2.3¢ |
| K/S = 1.10 | 7d | 0.88¢ | 0.33¢ | 2.1¢ |
| K/S = 1.25 | 30d | 0.79¢ | 0.30¢ | 1.9¢ |

Estimation noise costs about 1¢ out of the money, which is comparable to a 1% spread.

---

## 6. TWAP settlement: binary on the geometric average

### 6.1 What the v4 oracle measures

- The oracle stores `tickCumulative += tick × Δt` (`oz-uniswap-hooks/src/oracles/panoptic/libraries/Oracle.sol:57`).
- The tick is the one recorded before the first swap of each block (`BaseOracleHook.sol:122-133`). **[FC]** Because every block with a swap writes first, the tick written at block B is the post-swap tick of the previous swap block, and that tick was in effect over the whole interval. So `tickCumulative` is exact at block granularity, and `observe` interpolation between observations is exact too.
- **[FC]** Settlement at T needs the observation ring buffer to still hold an observation at or before T − w when `settle` is called. Size `cardinalityNext` for the number of swap blocks in `[T − w, latest settle time]`, otherwise `observe` reverts.
- So `(tc₂ − tc₁)/(t₂ − t₁)` is the time average of the **floored** log-price. That is a **geometric** mean price G, biased down by ≈ ½ tick: measured mean floor error −4.999e-5 vs −ln(1.0001)/2 = −4.9998e-5.

### 6.2 Closed forms (r = b = 0, m = −σ²/2)

**Before the window starts** (τ = T − t ≥ w):
```
ln G = ln S_t + m(τ − w/2) + σ(W_{T−w} − W_t) + (σ/w)∫_{T−w}^{T}(W_u − W_{T−w})du
     ~ N( ln S_t + m(τ − w/2),  σ²(τ − w) + σ²w/3 = σ²(τ − 2w/3) )
YES_G = N(d2^G),   d2^G = [ln(S/K) + m(τ − w/2)] / (σ√(τ − 2w/3))
```

**Inside the window** (τ < w), with running integral `A = ∫_{T−w}^{t} ln S_u du` known on-chain from tickCumulative:
```
ln G ~ N( (A + τ ln S_t + mτ²/2)/w ,  σ²τ³/(3w²) )
YES_G = N( [ (A + τ ln S_t + mτ²/2)/w − ln K ] / (σ τ^{3/2}/(√3·w)) )
```

**Exact adjustment.** Price with `σ_eff = σ√(1 − 2w/(3τ))` and drift time `τ − w/2`. There is no need to adjust K; only the variance and drift time change. No single K-shift can reproduce it, because the variance itself differs. This is the digital version of the Kemna–Vorst (1990) geometric-Asian result.

**MC checks** (200k paths, `out06.txt`):

| case | closed form | MC |
|---|---|---|
| ATM, 1h, w = 30 min | 0.49843 | 0.49793 ± 0.0011 |
| K = 4040, 1d, w = 30 min | 0.39737 | 0.39614 ± 0.0011 |
| K = 3950, σ = 1.2, 1h, w = 5 min | 0.84212 | 0.84242 ± 0.0008 (European 0.83514) |
| inside window, 10 min left | 0.00645 | 0.00658 ± 0.00018 |

### 6.3 Error if the European formula is used for TWAP settlement

The maximum over spot is independent of σ, because it depends only on w/τ:

| τ | w | max \|P_G − P_E\| | σ_eff/σ |
|---|---|---|---|
| 1h | 5 min | 0.69¢ | 0.972 |
| 1h | 30 min | **4.9¢** | 0.816 |
| 1d | 5 min | 0.03¢ | 0.999 |
| 1d | 30 min | 0.17¢ | 0.993 |
| 7d | 5 min | 0.004¢ | 0.9998 |
| 7d | 30 min | 0.03¢ | 0.999 |

The at-the-money difference is ≤ 0.02¢ everywhere. The error sits just off the money, e.g. at S/K ≈ 1.004–1.012 for 1h markets.

### 6.4 Settlement rule in exact integers, and sign conventions

- **Define the strike in tick space** (`K_tick`) and settle **YES iff `tc(T) − tc(T − w) > K_tick·w`**. This is an exact int56 comparison, with no division and no rounding ambiguity.
- Because ticks are floored, the effective strike used in pricing is `K_eff = 1.0001^{K_tick + 1/2}` (half-tick correction). When the window is short, the discrete sampling (one tick per block interval) should be simulated rather than assumed continuous.
- **Direction depends on currency ordering.**
  - With native ETH (currency0 = address(0)) and currency1 = USDC, raw price = USDC per ETH × 10^{6−18}. Then `tick(S=4000) = −193,380`, and ETH up ⟺ tick up.
  - With WETH/USDC the ordering is **chain-specific** (**[FC]** the draft said USDC always sorts first):
    - On Ethereum mainnet, USDC `0xA0b8…` < WETH `0xC02a…`, so USDC is currency0, the tick is inverted, and "ETH > K" ⟺ tick < K'_tick.
    - On Base (WETH `0x4200…0006` < USDC `0x8335…`) and Arbitrum (WETH `0x82aF…` < USDC `0xaf88…`), WETH is currency0 and the tick is **not** inverted.
    - These addresses come from memory and are UNVERIFIED here. Always derive the direction from the actual `PoolKey` at market creation.
  - Tests must cover both orderings.

---

## 7. Monte Carlo and statistical proof methodology

### 7.1 Calibration (proves "YES price = probability")

**Design.** 200k **independent** (path, quote-time) pairs: one quote per path, since quotes along one path are correlated. Initial moneyness `ln(S0/K) ~ N(0, 0.1²)`, T = 7d, quote time uniform. Tests:
- reliability diagram over 10 deciles
- Brier score with Murphy decomposition
- Spiegelhalter Z
- Hosmer–Lemeshow χ² (**[FC] df = 10, not 8**. The g − 2 correction applies only when the probabilities were fitted on the same data. Our quotes are pre-specified, so under perfect calibration HL ~ χ²_g. A simulation (`12_hl_null.py`, 2000 reps) gave mean 9.94 and variance 19.5, against χ²₁₀ = (10, 20) and χ²₈ = (8, 16). Using df = 8 over-rejects.)
- calibration-in-the-large `Σ(o − p)/√Σp(1−p)`, needed because Spiegelhalter is insensitive to uniform shifts

**Result under the model** (`out07.txt`):
- Brier 0.11528 vs expected `E[p(1−p)]` = 0.11473
- REL = 3.4e-6
- Z = +1.51
- HL χ² = 7.26, p = 0.51 with df = 8; **[FC] p = 0.70 with the correct df = 10**
- every decile within 2 SE. Examples: p̄ = 0.5518 vs frequency 0.5541 (2se 0.0070); p̄ = 0.1100 vs 0.1090.

**Power** (the test must be able to fail):

| misspecification | n | result |
|---|---|---|
| quoted σ = 0.7 vs true 0.8 | 20k | Z = +11.5, HL p ≈ 0 |
| quoted σ = 0.6 | 20k | Z = +19.9 |
| real drift μ = 0.3 | 200k | HL p = 1.6e-13 (Spiegelhalter Z = −1.3, blind to it) |

Under P ≠ Q the quotes are **not** real-world calibrated. That is expected and is the §4.2 risk premium.

**Acceptance criteria:**
- HL p > 0.01 (computed with df = 10)
- |Z| < 2.58
- |calibration-in-the-large| < 2.58
- each decile |freq − p̄| < 3 SE
- the σ-misspecification power check must reject

### 7.2 Martingale and variance identity
- `|E[P_T] − P_0| < 3 SE`
- `|E[ΣΔP²] − P0(1−P0)| < 3 SE`

### 7.3 LP P&L experiments (spec)

- **Noise only**, fair quotes, s ≥ 0: accept if `E[LP] = s·E[V]` within 3 SE, and E[LP] ≈ 0 when s = 0.
- **Stale arbitrage** (lag 1, 5, 25, 150 blocks; λ grid; s grid): accept if E[arb] matches the semi-analytic `Σ_k E[((|gap_k|−s)^+)²]/(2λ)`, and for s = 0 matches `P0(1−P0)/(2λ)` within 3 SE.
- **Break-even surface.** For assumed noise volume V, find (s, ℓ, cutoff h, lag) with `E[LP] > 0` at 95% confidence. Report `P(LP<0)`, 1% VaR, CVaR, and max drawdown of U. Check that `U_0 − U ≤ B_m` is never violated.
- **Directional flow** (μ ≠ 0), **σ-informed flow**, and **manipulators** (§4.7 strategies), each run as separate agent types.
- **End-to-end in Foundry.** Replay a simulated path by warping blocks and swapping the real ETH/USDC v4 pool to the path price. Drive the hook through the real router, then compare the hook's quotes and settlement with the Python reference (JSON vectors or `vm.ffi`) within ε.

### 7.4 Model-risk stress: Merton jump-diffusion

Parameters: diffusive σ = 0.6, λ = 10 jumps/yr, jump log-mean −5%, jump sd 8%, so total vol is 0.670. We quote BS with the total vol that an RV estimator would see. The Merton digital is `Σ_j Pois(j; λτ)·N(d2_j)`, with `d2_j = [ln(S/K) − (σ²/2 + λκ)τ + j·m_J] / √(σ²τ + j·δ_J²)` and `κ = e^{m_J + δ_J²/2} − 1`. **[FC]** The draft wrote λ'τ = λ(1+κ)τ. That intensity belongs to the call formula's S·N(d1) term; for the digital (−∂C/∂K), the (1+κ)^{−j} discount factors turn it back into Pois(λτ). The script `07_calibration_merton.py:57` already uses λτ, so the numbers are unaffected. Verified by MC (0.7092 ± 0.0007 vs 0.7097). Differences M − BS (`out07.txt`):

| τ | K/S = 0.9 | K/S = 0.95 | K/S = 1.0 | K/S = 1.05 | K/S = 1.1 | K/S = 1.2 |
|---|---|---|---|---|---|---|
| 1d | −0.60¢ | +1.35¢ | +1.05¢ | −1.47¢ | −0.06¢ | +0.01¢ |
| 7d | +0.75¢ | +1.60¢ | +1.16¢ | −0.01¢ | −0.73¢ | −0.42¢ |
| 30d | +0.79¢ | +0.86¢ | +0.74¢ | +0.50¢ | +0.22¢ | −0.23¢ |

Relative errors are largest deep out of the money: 1d, K/S = 1.1 gives 0.0025 vs 0.0031, a 20% relative error. **This argues for tradable price bounds** such as [0.02, 0.98]; Thales used [0.08, 0.95]. Next steps: add Heston or regime-switching σ, and add real ETH return bootstraps (historical block-by-block paths) as the final stress.

### 7.5 Sample sizes

- **Calibration bin at p ≈ 0.5**, α = 5%, power 80%:

  | effect to detect | n per bin |
  |---|---|
  | 2 pp | 4,906 |
  | 1 pp | 19,622 |
  | 0.5 pp | 78,489 |

  So use ≥ 200k quotes for 10 bins at 1 pp.
- **Mean LP P&L to ±10% relative precision:** `n = (1.96·CV/0.1)²`.

  | CV = sd/\|mean\| | paths needed |
  |---|---|
  | 5 | 9,604 |
  | 20 | 153,664 |
  | 100 | 3.8M |

  CV is 2–4 in the noise-plus-arbitrage runs above but can be 20+ near break-even. **Use common random numbers across parameter sweeps**, and report bootstrap CIs.

---

## 8. Implications for our design

1. **Parity and discounting.** Set `r_c = 0` and compute `NO := 1 − YES` in integers, which makes parity exact. Put any carry into `b` inside d2, or set it to 0. Never discount while collateral is idle.
2. **Solvency is structural.** Use complete sets at par, outcome tokens with **6 decimals (same unit as USDC)**, vault netting (`min(Yv,Nv) = 0`), `U ≥ 0` preconditions, and a per-market cash budget `B_m`. These give I1–I7 with proofs that do not depend on pricing. Make them the backbone of the Foundry invariant suite (§3.7).
3. **Quote construction.** `ask = ⌈P + s + λ(I_b + ·)⌉` and `bid = ⌊P − s + λ(I_b − ·)⌋`, with λ-impact reset each block and s ≥ 0. This enforces `bid_Y + bid_N ≤ 1 ≤ ask_Y + ask_N` exactly. A flat price with no impact and no cap is exploitable without limit.
4. **CDF.** Implement the Hart/West rational approximation in WAD with the `c ≤ ½` clamp (Lemma C). It gives exact symmetry, monotonicity across 0 by proof, and monotonicity elsewhere by extensive testing (**[FC]** not yet a proof; see §2.2), at ~4e-17 error and ≈1.3k gas unchecked. Do **not** use Premia/Choudhury (1.4e-4 error, non-monotone). Treat solstat as a cross-check only (non-monotone band at d2 = 0).
5. **Clamps.** `τ ≥ τ_min` (and stop trading well before that, see 7); `σ ∈ [σ_min, σ_max]`; `|d2|` saturation; tradable price band `[p_min, p_max]` (e.g. [0.02, 0.98]) to limit tail model risk and capital drawn per mint.
6. **Spot input.** Read S from `sqrtPriceX96`, **at the start of the block** (the observation written before the first swap of the block). Never read live in-transaction spot. Enforce per-block size `≤ q_safe(τ) = f·L√S·σ√τ/n(d2)` using a conservative on-chain proxy for L. **Never price from a TWAP**: loss scales roughly linearly with lag. **[FC]** A 30-min TWAP costs about **70×** more (equivalent lag W/3); the draft's 200× is for a 30-minute *lag*. **[FC]** The start-of-block price must come from the underlying pool's own oracle hook (§4.7b). Caching slot0 inside our hook is manipulable.
7. **Trading cutoff.** Stop trading at `τ_cut ≈ max(Δt·(n(0)/s)², horizon where q_safe falls below the minimum useful size)`. For s = 1% that is ~5.3h on 12 s blocks and ~27 min on 1 s blocks. The last 1% of life carries ~9% of expected LVR.
8. **LP depth sizing.** `E[LVR] ≤ ℓ·P0(1−P0)/2`. Choose ℓ per market from the expected noise volume: `V_noise ≥ κ(s)·ℓ·P0(1−P0)/(2s)`, e.g. V ≥ 9ℓ at s = 0.5%. Surface expected LVR to LPs.
9. **Volatility oracle.** Keep an O(1) accumulator of squared log-returns, one sample per block, downsampled to ≥ 5–15 min. Use the lowest-fee deep pool (the fee-band bias is −6.7% of variance at 5 min for 5 bp and −60% for 30 bp). Winsorise returns, bound σ̂, and rate-limit its changes. Either the underlying pool must carry an oracle hook, or our hook must sample the underlying `slot0` on every interaction plus keeper pokes; irregular sampling is fine statistically (§5.1). **[FC]** Self-sampling from inside our hook is acceptable for σ̂ once winsorised and rate-limited, but **not** for the spot S used in quotes (§4.7b).
10. **Settlement.** Use a tick-space strike with the exact integer rule `Δtc > K_tick·w`, and price with the §6 geometric-TWAP formula (plus the half-tick correction). Account for currency0/currency1 ordering, which is chain-specific for WETH (§6.4). **Size the per-market OI cap against the fee-band manipulation cost C(δ)**: the outcome can be moved by ±f almost for free. Consider settlement designs that are robust to this (§9).
11. **Tenor.** Short tenors (≤ 7d) keep drift and risk-premium edge small (≤ ~1.4¢ at μ = 20%/y), keep σ-estimation error manageable, and keep the TWAP-vs-European gap tiny. Very short tenors (≤ 1h) make pin risk and manipulation dominate.
12. **Proof plan layering:**
    - **Analytic:** T1–T9 and the approximation theorems A–D (this document).
    - **Deterministic / fuzz:** Foundry differential tests of the quote function against the Python oracles in `05-math-scripts`; stateless fuzz of monotonicity, parity and range; stateful invariant tests of I1–I7 through the real PoolManager and routers.
    - **Statistical:** the MC suite of §7 with the stated acceptance criteria.

---

## 9. Open questions

1. **Which underlying pool?** What is the actual liquidity and fee tier of the canonical ETH/USDC v4 pool on the target chain in 2026? Does it have an oracle hook? These are needed for L√S, D1, q_safe, C(δ) and the fee-band σ bias. **UNVERIFIED.** They must be measured from chain data.
2. **Is the fee-band model right?** On real v4 swap data, is the downward bias offset by noise flow inside the band? What sampling interval makes σ̂ closest to CEX or implied vol? This needs historical backtests.
3. **Settlement design against free in-band manipulation:**
   - a continuous "ramp" payoff (log-call spread) of half-width h ≫ f, which caps what free manipulation can gain at ~f/(2h) of open interest;
   - multi-pool or median settlement;
   - an external oracle (e.g. Chainlink) as fallback or cross-check;
   - a longer settlement window.
   Each changes the pricing formula, and closed forms exist for the ramp. Which one keeps the product "Uniswap-native"?
4. **Inventory skew.** With a permanent inventory skew (Avellaneda–Stoikov-style) instead of per-block-reset impact, oracle refreshes let arbitrageurs extract twice per stale event (§4.5 derivation). Can both be combined safely, e.g. skew with decay? This needs formal analysis.
5. **Hedging.** Could the vault delta-hedge in the underlying pool itself? Near expiry the digital's gamma makes this impractical. Is a partial hedge for long tenors worth the gas and LVR it creates in the underlying?
6. **Implied vs realized σ.** Should σ be realized-only, blended with an external implied vol (Thales used Deribit IV), or carry a volatility risk premium? This affects calibration under P, not solvency.
7. **Drift or risk premium.** For multi-week markets, should `b` include a risk premium so the quotes match real-world probabilities rather than Q? This is a product question: "probability" vs "fair price".
8. **Gas.** Hart CDF plus `lnWad`/`sqrt` plus the σ accumulator: is the per-swap overhead acceptable next to the v4 swap itself? **[FC]** The pure-math part is measured at ≈3.1k gas (unchecked) on revm (§2.3). Storage reads for market params and the oracle, the σ accumulator and the hook's token movements are still unmeasured; measure them with `forge --gas-report`.
9. **Jump or event risk** (e.g. ETF or regulatory news). Should the hook widen spreads or halt on detected jumps (|r| > kσ̂√Δ), and how does that interact with the martingale and calibration tests?
10. **Discrete-sampling corrections** for very short settlement windows (a few blocks). Should the continuous geometric-average formula be replaced by its discrete-sum version (variance `σ²Δt·(n+1)(2n+1)/(6n)`)?

---

## Appendix A — Scripts (in `docs/md/research/05-math-scripts/`)

| script | content | output |
|---|---|---|
| `01_pricing_greeks.py` | 50-digit pricing, Greeks vs FD, Δ_max, vega/theta sign change, limits, drift edge | `out01.txt` |
| `02_cdf_fixedpoint.py` | bit-exact solady `expWad`/`lnWad` and solstat `erfc`/`cdf`; library error survey; pipeline error; tick quantisation | `out02.txt` |
| `02b_monotone.py` | solstat around 0; Hart/West WAD port with clamp (reference implementation); monotonicity and symmetry tests | `out02b.txt` |
| `03_solvency_model.py` | reference vault state machine plus randomized invariant checks; bid-sum arbitrage exploit | `out03.txt` |
| `04_lp_pnl.py` | martingale / variance identity, stale-oracle LVR, staleness scaling, noise break-even, flat-price cap, pin-risk tables | `out04.txt` |
| `05_vol_estimation.py` | RV moments, irregular sampling, χ² CI coverage, tick quantisation, fee-band bias, vega impact, EWMA | `out05.txt` |
| `06_twap_binary.py` | geometric-TWAP binary closed forms vs MC, difference table, floor-tick bias | `out06.txt` |
| `07_calibration_merton.py` | calibration tests plus power, Merton digital vs BS, sample sizes | `out07.txt` |
| `08_manipulation_and_profiles.py` | closed form of E[((\|X\|−s)^+)²], variance time profile, q_safe and C(δ) tables | `out08.txt` |
| `09_misc.py` | CDF jumps at 0 (Choudhury, A&S, Hart, solstat), ETH/USDC tick, κ(s) | `out09.txt` |
| `10_factcheck_analytic.py` | **[FC]** independent re-derivation of the closed-form numbers (R2, Greeks, Δ_max, exact 1% move, limits, NR constant sum, CDF errors, tick, χ² CI, sample sizes, HL p, per-block std, τ*, pin share, TWAP gap, flip probability, q_safe, C(δ), EWMA, LVR bound) | `out10.txt` |
| `11_factcheck_mc.py` | **[FC]** independent MC: terminal martingale, s = 0 LVR vs bound, staleness multiples, TWAP-quoting multiple, fee-band RV bias at σ = 0.8 and 0.5 (slow, ~minutes) | printed |
| `12_hl_null.py` | **[FC]** HL null distribution for pre-specified probabilities (df = g) | `out12.txt` |
| `evm/T.sol`, `evm/compile.py`, `evm/run.py`, `evm/run2.py` | **[FC]** real solstat/solady bytecode plus a Solidity Hart port executed on revm (`uv run --python 3.12 --with pyrevm --with eth-abi --with eth-utils --with pycryptodome --with mpmath --with numpy --with scipy python run.py`; compile with `uv run --with py-solc-x python compile.py` after fixing the absolute paths in it; solstat needs solmate at `ed67fed`) | `evm/out_run2.txt` |

## Appendix B — References

**Code** (paths relative to the scratchpad `repos/`):
- `solstat/src/Gaussian.sol` — erfc at 89-120, cdf at 183-188, erfc(0) special case at 90, domain ±6.24 at 38
- `solady/src/utils/FixedPointMathLib.sol` — expWad at 207, lnWad at 277, monotonicity notes at 206 and 276, sqrtWad at 860
- `lyra-v1/contracts/libraries/BlackScholes.sol` — clamps at 50-51 and 189-190, `_d1d2` at 179-198, `_stdNormalCDF` at 355-380
- `Premian-Labs_premia-contracts/contracts/libraries/OptionMath.sol` — 40-43 and 197-208
- `rmm-core/contracts/libraries/CumulativeNormalDistribution.sol` — 24-48
- `oz-uniswap-hooks/src/base/BaseCustomCurve.sol` — 90-127
- `oz-uniswap-hooks/src/oracles/panoptic/BaseOracleHook.sol` — 103-135
- `oz-uniswap-hooks/src/oracles/panoptic/libraries/Oracle.sol` — 38-60 and 95-119
- `v4-core/src/libraries/TickMath.sol` — MIN/MAX_TICK at 20-23

**Papers and docs:**
- Milionis, Moallemi, Roughgarden, Zhang, "Automated Market Making and Loss-Versus-Rebalancing" — https://arxiv.org/abs/2208.06046 (**[FC]** Lemma 2, eq. (8): `ℓ(σ,P) ≜ σ²P²/2 · |x*′(P)|`)
- Milionis, Moallemi, Roughgarden, "Automated Market Making and Arbitrage Profits in the Presence of Fees" — https://arxiv.org/abs/2305.14604
- Mackinga, Nadahalli, Wattenhofer, "TWAP Oracle Attacks: Easier Done than Said?" — https://eprint.iacr.org/2022/445
- Thales AMM design (Black–Scholes digital, IV from Deribit, price range 0.08–0.95, per-market risk cap, skew) — https://docs.thalesmarket.io/using-thales/thales-amm-design
- Standard results cited without re-fetching:
  - Kemna & Vorst (1990), geometric Asian options
  - Merton (1976), jump-diffusion
  - West (2005), "Better approximations to cumulative normal functions" (Hart 1968 algorithm)
  - Numerical Recipes in C, 2nd ed., p. 221 (erfcc)
  - Abramowitz & Stegun 7.1.26
  - Spiegelhalter (1986)
  - Hosmer & Lemeshow (1980)
  - Murphy (1973), Brier decomposition
  - Barndorff-Nielsen & Shephard (2002), realized-variance asymptotics
  - Avellaneda & Stoikov (2008)

---

## Verification log (fact-check, 2026-09-25)

Each load-bearing claim was re-checked independently against primary code (paths relative to `scratchpad/repos/`), by fresh derivation, or by new numerics. Nothing was copied from the draft's scripts, except that the draft's Python emulation was compared against real EVM execution.

**Verdicts:** ✅ confirmed · ✏️ corrected · ❓ unverifiable here.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | R2 worked example: d2 = −1.087603, YES = 0.138385154823, Δ = 2.407e-4, vega = 0.2369, θ = −0.00316/day | ✅ | `10_factcheck_analytic.py`: closed form and mpmath numeric differentiation agree to 6+ digits |
| 2 | Greeks formulas (Δ, Γ, vega = −n(d2)d1/σ, θ = n(d2)d1/(2τ) for r = 0) | ✅ | Re-derived by hand: ∂d2/∂τ = −d1/(2τ) and ∂d2/∂σ = −d1/σ. Numeric FD matches |
| 3 | Δ_max = 1/(Kσ√(2πτ)) at d1 = 0, independent of r | ✏️ | True only when r_c = b. In general it is e^{(b−r_c)τ}/(Kσ√(2πτ)). S* = 4870.2075 and Δ_max = 3.47885e-4 confirmed |
| 4 | Max price move per 1% spot: 1.69¢ / 12.7¢ / 62¢ | ✏️ | The formula 0.01/(σ√(2πτ)) gives 1.74¢ (the draft used Δ_max·S*). Exact finite maxima are 1.73¢, 12.6¢ and **56¢** |
| 5 | r_c must be 0 with idle collateral; YES + NO = 1; any r_c > 0 is arbitraged via mint/merge | ✅ | Static-arbitrage argument (§3.4) re-derived. **[FC]** Added the T-forward-measure justification for r_c = 0 with b ≠ 0 |
| 6 | Lyra clamps: MIN_T = 1 s, MIN_VOL = 0.001% (`BlackScholes.sol:50-51,189-190`) | ✏️ | Lines confirmed. `PRECISE_UNIT/10000` = 1e-4 = 0.01% (the source comment is wrong) |
| 7 | solstat cdf is non-monotone at 0: cdf(∓1e8 wei) = 0.500000014960105744 / 0.499999985039894255; NR constants sum to 3e-8 | ✅ | Real solstat bytecode on revm gives exactly these values. Exact constant sum = +3.0000e-8. Special case at `Gaussian.sol:90`, domain 6.24 at `:38` |
| 8 | Python emulation of solstat/solady is bit-exact | ✅ | 0/3000 mismatches each for solstat `cdf`, solady `expWad` and `lnWad` against real bytecode (solc 0.8.26, pyrevm). solstat uses solmate `ed67fed` expWad |
| 9 | solady expWad/lnWad documented "Monotonically increasing" (`FixedPointMathLib.sol:206,276`) | ✅ | Source lines read at solady `2afba69` |
| 10 | Hart/West WAD port: max error 4.3e-17, 0 monotonicity violations, exact symmetry | ✅ / ✏️ | Solidity twin on EVM: max error 4.17e-17, symmetry exact, 0 violations in 124k further pairs. **But** within-half-line monotonicity is empirical, not proven (c = e·n/d is not a monotone composition). The R4 and §8.4 wording was fixed |
| 11 | Choudhury (Premia) error 1.4e-4, drop 2.8e-4; A&S (RMM) error 7.0e-8 | ✅ | Float re-implementation: 1.3994e-4 / 2.7989e-4 / 6.969e-8. Source lines `OptionMath.sol:41-43,197-207`, `CumulativeNormalDistribution.sol:26-47` |
| 12 | Gas UNVERIFIED (est. 2–4k Φ̂, 6–10k quote) | ✏️ | Measured on revm: Hart Φ̂ 1.3k unchecked / 6.3k checked, solstat cdf 4.9k, lnWad 0.55k, full quote 3.1k (unchecked), with pipeline error 9.3e-17 |
| 13 | v4 custom-curve sign convention: exact-in ⇔ amountSpecified < 0; delta (spec, −unspec) / (−spec, unspec) | ✅ | `oz-uniswap-hooks/src/base/BaseCustomCurve.sol:97,119,127`; `v4-core/src/libraries/Hooks.sol:270-276` |
| 14 | BaseOracleHook writes the pre-swap tick at most once per block; tickCumulative += tick·Δt | ✅ | `BaseOracleHook.sol:107-108,114-135`; `Oracle.sol:57,107`. **[FC]** Only covers pools that use this hook; our hook cannot synthesize a start-of-block price by caching |
| 15 | slot0.tick = ⌊log_1.0001 P⌋ | ✏️ | Can be one lower at an initialized boundary after a zeroForOne swap (`Pool.sol:431`) |
| 16 | Variance identity Σ E[ΔP²] = P0(1−P0); LVR bound ℓP0(1−P0)/2 = 124,965 for the 1d ATM example | ✅ | Proof re-derived. Independent MC: arbitrage profit 126,183 ± 2,537, E[QV] = 0.2548 ± 0.0054 vs 0.2499 |
| 17 | Staleness multiples 6.1× / 33× / 205× (lags 5 / 25 / 150); "30-min TWAP ≈ 200×" (§8.6) | ✅ / ✏️ | Independent MC: 6.3× / 34× / 203×. A 30-min TWAP quote is **68×** (lag 50 = 69×), so the §8.6 statement was fixed |
| 18 | E[((\|X\|−s)^+)²] closed form | ✅ | Re-derived: 2v[(1+a²)(1−N(a)) − a·n(a)] with a = s/√v |
| 19 | Instantaneous LVR analogue; Milionis et al. formula σ²P²/2·\|x*′(P)\| | ✅ | arXiv 2208.06046, Lemma 2, eq. (8), read from the PDF |
| 20 | Per-block ATM std n(0)√(Δt/τ): 17.8¢ / 8.0¢ / 2.3¢ / 0.47¢; τ* table | ✅ | Recomputed; all values match (e.g. s = 1% → 5.31 h at 12 s, 26.5 min at 1 s) |
| 21 | Pin-risk share 1 + (2/π)arcsin(h/T − 1) | ✅ | Re-derived from E[n(d2)²] = (1/2π)√(τ/(2T−τ)). Values 0.090 / 0.287 / 0.460 / 0.667 |
| 22 | q_safe table and C(δ) table ($250, $47k, $1.10M / $13.2M; $1.5k, $3k, $1.07M) | ✅ | Recomputed all cells. C(δ)'s (δ−f)(δ+3f)/4 term re-derived as arbitrage loss plus fee on each re-push. The model itself stays first-order and UNVERIFIED on real data |
| 23 | Flip probability 0.95% / 1.9% / 0.36%; 5.7% on a 30 bp pool | ✅ | Recomputed |
| 24 | RV moments, CI multipliers [0.925, 1.089] at n = 288, EWMA n_eff table, tick-quantisation bias 1.0068 | ✅ | Recomputed. The "driftless GBM" wording was refined (needs m = 0 and fixed W) |
| 25 | Fee-band RV bias table | ✅ / ✏️ | Independent MC matches at σ = 0.8. σ-dependence added. The 1 h "±0.4%" noise claim was understated (≈ 0.65%) |
| 26 | Geometric-TWAP binary d2^G; max European–TWAP gap 4.9¢ (1h / 30 min), 0.17¢ (1d / 30 min); worked values 0.49843, 0.39737, 0.84212 vs 0.83514 | ✅ | Re-derived mean m(τ − w/2) and variance σ²(τ − 2w/3). All numbers recomputed; the gap is σ-independent to 3 digits (σ = 0.3 vs 0.8) |
| 27 | tick(S = 4000, native ETH / USDC) = −193,380; ordering "USDC sorts first" | ✅ / ✏️ | Tick recomputed. Ordering is chain-specific: true on mainnet, false on Base and Arbitrum (addresses from memory, flagged UNVERIFIED) |
| 28 | Hosmer–Lemeshow df = 8 | ✏️ | For pre-specified probabilities df = g = 10. Null simulation: mean 9.94, var 19.5. The worked p changes from 0.51 to 0.70 |
| 29 | Calibration sample sizes 4,906 / 19,622 / 78,489; LP paths 9,604 / 153,664 / 3.8M | ✅ | Recomputed (19,623 with ceiling) |
| 30 | Merton digital Σ Pois(j; λ'τ) N(d2_j); total vol 0.670 | ✏️ | The correct intensity is λτ (the script already used λτ, so the numbers are unaffected). Total vol 0.6701 confirmed |
| 31 | Thales: BS digital, Deribit IV, price range 0.08–0.95, per-market risk cap | ✅ | docs.thalesmarket.io/using-thales/thales-amm-design (fetched 2026-09-25) |
| 32 | Solvency invariants I1–I7, budget theorem, quote no-arbitrage | ✅ / ✏️ | Proofs re-read and `03_solvency_model.py` re-run (all invariants held). Added the requirement of a shared signed impact state for YES/NO (§3.4) and the exact-in rounding post-check (§3.5) |
| 33 | Sizing example ℓ ≤ 222k | ✏️ | 219.8k |

**Omissions filled:**
- the forward-measure justification of r_c = 0 with b ≠ 0
- the manipulability of self-cached spot, and the capital-free flash-accounting attack in v4
- the oracle ring-buffer cardinality needed for settlement
- the chain-specific WETH/USDC ordering
- the v4 tick-at-boundary exception
- measured gas and the on-EVM pipeline error
- the HL degrees of freedom

**Still UNVERIFIED:**
- liquidity and fee tier of the target ETH/USDC v4 pool and whether it has an oracle hook
- net sign of the RV bias on real pool data
- target-chain block times
- the token addresses used for the ordering example
- gas inside a real hook with storage and PoolManager overhead
