# Gap: one frozen v1 spec, and the economic backtest re-run on exactly that spec

**Date:** 2026-09-26. **Scope:** freeze one parameter set for a 1-day ETH series (L1 and L2 variants) that reconciles the four
normative gap reports; restate the quote-function theorems for the discrete-Asian mid and the ramp payoff; re-run the backtest
(stage A σ policy, stage B grid, final OOS evaluation, 1-second latency) with TWAP settlement, the new σ rule, the cutoffs, the
spread, all caps enforced together, and the settlement-manipulation charge; and check whether the binding cap leaves a meaningful
market in USD.

**Where things are.**
- `$I` = `docs/research/gaps/integrated-spec-scripts/`: every script, config list and raw output (`$I/out/*.txt`, `$I/qf/out_*.txt`).
  The working copy (with data links and result pickles) is `…/scratchpad/econ2/`.
- Reports cited: `Q` = `quote-function-spot-input-and-size-impact.md`, `S` = `settlement-rule-and-in-band-manipulation.md`,
  `V` = `lp-vault-structure-and-exposure-caps.md`, `O` = `underlying-oracle-source-and-sigma-estimator.md`,
  `E` = `economic-acceptance-criteria-and-backtest.md`, `05` = `../05-math-theory-proofs.md`.
- Data are the ones `E` built (Binance ETHUSDT 1-minute 2020-01..2026-09, 1-second 2026-06-01..09-24, Deribit DVOL, a 5 bp
  band-follower pool). IS = expiries 2021-01..2023-12, OOS = 2024-01..2026-09-25, as in `E`.

---

## 0. Findings in brief

1. **The frozen spec is not the combination the four reports assumed.** Two normative choices fail when you backtest them:
   - **σ "mode A" (3-day RV fixed at creation, `O` §3.1) fails.** On the frozen spec at L1 it gives D\*_OOS = ∞. The reason is that σ
     is stale inside the day: a trader who uses the live 1-day EWMA extracts 0.25–0.33 B per series. Any **live** σ fixes it.
     The frozen σ is a live, oracle-computed EWMA (half-life 1 d) of the same winsorised TWAP-return differences, ×3/2 + β.
   - **The Gaussian kernel is not robust at L1 under strict accounting.** It passes the original accounting (D\* at the grid floor).
     But a fat-tail adversary that trades only in the calendar years where it wins (2022, 2023, 2026) takes it to
     IS/OOS D\* 5.0/2.2 with weekly CVaR95 17%. The **variance-matched Student-t ν = 5 kernel on the Asian (μ, v)** survives
     that adversary. It has a closed-form CDF (atan plus a rational function, verified to 3e-16). This is the frozen kernel.
2. **Frozen v1 (§1).** It has the following parts:
   - binary payoff, settled on a strict TWAP over **w = 4 h** of the v3 5 bp pool;
   - Asian (μ, v) mid through F₅;
   - live EWMA σ;
   - **h₀ = 2¢** plus the gamma term with c_lag;
   - **λB = 0.5 per block**, reset at each epoch;
   - **cutoff T − w − 5 min = 245 min**;
   - p_min = 0.02, with a halt instead of a clamp;
   - Q_epoch with m_a = 1 (anchor off);
   - B = $20k per market and B_s = $60k per 7-strike series (exact ladder);
   - the delta-weighted Q_safe = 8π·h₀·k_w·v_cut OI cap;
   - a clairvoyant settlement-manipulation charge.

   The L1 and L2 variants differ only in their chain constants.
3. **Theorems (§2).**
   - These transfer to the Asian and ramp forms **verbatim**: E1, E2, E3/Lemma A/Theorem N, Lemma S and the per-epoch extraction
     bound. They never use the shape of P. The integer fuzz shows 0 violations in all three modes (Asian, ramp, t).
   - **Lemma M** generalises: if P′ is log-concave, the band halt makes the quote monotone for any k. Gaussian-Asian and ramp
     satisfy this (Prékopa).
   - Student-t does **not** satisfy it. Numerically, g⁺ dips at most 6.9e-5 below 1 on its decreasing set (ν = 5), so with
     p_min = 0.02 monotonicity still holds: 0 violations in 250k points and in the integer fuzz. For t, this is a numerical lemma
     and should be certified with interval arithmetic.
   - The martingale/QV identity behind Theorem L holds for the Asian mid (checked by MC).
   - Near the cutoff the Asian mid needs ~1.7× the European gamma term and allows only ~0.6× the per-epoch Q_epoch.
4. **Economics of the frozen spec (§4.5)**, OOS 2024-01..2026-09, strict accounting (an adversary is counted in every calendar
   year it wins), latency charge floored at 0, M2 manipulation charge applied to every series:

   | | D\*_IS | D\*_OOS | E3 at D = 2: OOS edge / series, LB95 of vault return | E4 at D = 2: weekly CVaR95 / CVaR99 / maxDD | years at D = 2 | E5 D\*_stress |
   |---|---|---|---|---|---|---|
   | **L1** (12 s, v3 5 bp mainnet) | **0.68** | **0.68** | +$6,097, **+102 %/yr** | **1.39 % / 3.32 % / 4.8 %** (passes) | all 6 positive (+85 … +128 %) | **∞** |
   | **L2** (2 s, Base v3 5 bp) | 0.86 | 0.76 | +$5,784, +85 %/yr | 4.03 % / 5.41 % / 7.1 % (**fails** CVaR bounds) | all positive | ∞ |
   | Gaussian kernel, L1 (for comparison) | 4.97 | 2.18 | +$2,628, **−10 %/yr** | 17.0 % / 21.0 % / 113 % (fails) | 2022, 2023, 2026 negative | ∞ |

   D\* counts noise turnover per day per unit of per-market budget. `E`'s old claim was D\* ≈ 1.35/day, obtained with snapshot
   settlement, EWMA σ and no caps. On the integrated spec it becomes **≈ 0.7/day (L1)**. The integrated spec is not cheaper to run;
   it is cheaper because the modeled adversaries lose to the 2¢ + gamma spread under TWAP settlement.

   The **stress result is worse than before**: a trader with perfect foresight of realised volatility takes 1.3–2.0 B per series.
   No D ≤ 8 covers that (`E` had 12/day). The claim remains conditional on "no vol foresight beyond EWMA/DVOL".
5. **Latency is no longer a cost.** The 1-second study used a start-of-block oracle, Q_epoch and a gamma term with c_lag. On it the
   CEX-leading arbitrageur **loses**: +0.034 ± 0.026 B per series on L1 and +0.028 ± 0.014 B on L2 (§4.3), against the old −0.029 B
   **per market**. TWAP settlement also removes the snapshot artefact `E` §6.4 flagged.
6. **Settlement manipulation is small at w = 4 h, and prohibitive at 30 min.**
   - The per-path clairvoyant charge on the book the simulation actually produces is $106–201 per series (2 % of series attacked).
     This is 1–2 % of the noise edge.
   - The stress charge assumes an attacker who builds the largest one-sided position the per-market budget allows (Q = 2B = $40k)
     and pushes the TWAP ex post. It costs 4.78 % × $40k = **$1,912 per series on L1** and $1,436 on L2. This is the gross transfer;
     the attacker's net M2 is 3.48 % and 2.95 %.
   - This charge raises D\* from the floor to about 0.6–0.7.
   - At w = 30 min the same attacker takes 30.6 % gross at $40k. A binary with a 30-minute window is unfinanceable.
7. **Cutoff (§4.2).**
   - With w = 4 h, T − w − b (245 min) dominates. The "10 % of tenor" rule (144 min) would allow trading inside a 4 h window, so it
     is illegal.
   - **Report 05's τ_cut = Δt(φ(0)/h₀)², restated for Asian v**, reduces to Δt(φ(0)/h₀)² + (w − w_eff) because σ cancels.
     It is redundant once the c_lag gamma term is in the spread: the per-block ATM price move is about σ√Δt/γ_S ≈ 0.4 of the
     gamma term, so the per-block move never exceeds the spread. At h₀ ≤ 1¢ on L1 it would stop 1-day markets 5.6–24 h early.
     Later cutoffs (144, 339, 399, 479 min) never improved OOS D\* in stage B.
8. **Spread (§4.2).**
   - With the Gaussian kernel, `Q`'s h₀ = 0.3–1¢ fails: D\*_OOS = ∞ in 19 of 20 L1 cells with w ≤ 2 h and h₀ ≤ 1¢. The gamma term is not enough.
     `E`'s s = 2 % is the right order.
   - With t and λB = 0.5, h₀ = 1¢ already works at w ≥ 2 h (D\*_OOS 1.0–1.1).
   - 2¢ is frozen, because it is needed for the E4 tail metrics and for Q_safe (Q_safe ∝ h₀).
9. **Which cap binds, in USD (§5).**
   - At w = 4 h, h₀ = 2¢, the settlement cap is Q_safe ≈ **$636k (L1) / $480k (L2) mean per series**. Its minimum is $61k/$46k,
     on the lowest-vol days.
   - **The LP budget binds first.** B = $20k per market and B_s = $60k per series admit about **$216k of payout-token flow per
     series per day at D = 2, $487k at D = 5 and $731k at D = 8** (65–78 % of demand is filled).
   - Polymarket's daily "Ethereum above ___" ladder traded a **median $366k per day (11 strikes)** over 24 events in Sep 2026, with
     open interest of $163–219k per event (3 events). The frozen spec therefore supports a market of **Polymarket size per series**.
   - At w = 30 min the binary Q_safe is **$9k** (h₀ = 2¢). Fill saturates at **$82k per series per day** whatever the demand, about
     ¼ of Polymarket's, and the manipulation charge (item 6) makes it loss-making at meaningful Q.
   - A ramp payoff (h = 100 bp) at 30 min raises Q_safe to $75k. Fill caps at $430k (L1) / $340k (L2). It is the only configuration
     in which the E5 vol-foresight stress is survivable (L2 D\*_stress = 2.8).
10. **B must stay small relative to depth.** At B = $50k the Gaussian L1 fails even the original accounting (OOS D\* 6.4). At
    B = $5k everything passes, but capacity drops fourfold. The capacity–robustness trade-off is set by B and λ, not by Q_safe,
    once w ≥ 2 h.

---

## 1. The frozen v1 parameter set

All values are immutable per series. They are one source of truth for Solidity and Python: `$I/spec.py`, plus the per-chain λ in
`$I/mkfinal.py` (the t rows of `cfgF.json`).

| # | Item | Frozen value (L1 / L2) | Replaces / reconciles |
|---|---|---|---|
| 1 | Underlying source (S, σ, settlement) | L1: mainnet v3 USDC/WETH 5 bp (y_v $155.5M, Δt = 12 s). L2: Base v3 WETH/USDC 5 bp (y_v $67M, Δt = 2 s). Read through `IUnderlyingOracle` (`O` §2.2). The Foundry local path uses `VolOracleHookV2` with the same statistics. | `O` §1.5 |
| 2 | Series | 7 strikes, K = S₀·exp(k·σ_ref√τ), k ∈ {−1.5, −1, −0.5, 0, 0.5, 1, 1.5}. Listed daily at 08:00 UTC, tenor 1 d. One series per (pool, T, w). | `E` §3, `V` §2.1 |
| 3 | Payoff | Binary. YES iff the w-window TWAP statistic > threshold (strict). Integer rule `D > floor(w(κ − ½))` (up orientation) or `D < ceil(w(κ − ½))` (v3 orientation). | `S` §4.1 |
| 4 | Settlement window | **w = 4 h** (n = 1,200 / 7,200 samples), grid-aligned, checkpoints registered | `S` §3.3 ("w ≥ 2–4 h for 1-day markets") |
| 5 | Trading cutoff | **Stop at T − w − b, b = 5 min (245 min before T).** After the cutoff only mint, merge and redeem remain open. | `S` §6; §4.2 below |
| 6 | Mid | **P = F₅(√(5/3)·μ/√v)**, the variance-matched Student-t (ν = 5) on the discrete-Asian (μ, v): μ = x − lnK − ½σ²(τ − w + (n−1)Δ/2), v = σ²[(τ − w) + Δ(n−1)(2n−1)/(6n)]. F₅(z) = ½ + [atan(u) + u/(1+u²)·(1 + 2/(3(1+u²)))]/π with u = z/√5. r = 0. | `S` §4.4 (Asian), `E` §6.1 (t) |
| 7 | S input | Start-of-epoch `sqrtPriceX96` (virtual-write rule), log price with no tick flooring. TWAP anchor W_a = 0. | `Q` §1.2 |
| 8 | σ | **Live**: EWMA with a 1-day half-life of the oracle's winsorised (400 ticks) 300 s TWAP-return squared differences, ×3/2, + β = 0.5γ²/H (0.01314/yr for 5 bp), clamped to [0.20, 2.50]. Read with the virtual-write rule, so it is epoch-constant. No multiplier. | Replaces `O` mode A (§4.1). Estimator, β, winsor and clamp are unchanged from `O` §3.1. |
| 9 | Spread | ask = P + c_Δ·γ_S·P′ + h₀ and bid = P − c_Δ·γ_S·P′ − h₀, with the gamma term inside the max/min. **h₀ = 2¢**, c_Δ = 1, γ_S = 5.5 bp + 0.8·σ√Δt. No inventory widening (c_inv = 0). | `Q` §2.2 structure, `E` level |
| 10 | Band | p_min = 0.02. A side halts outside the band, and every executed marginal price must stay in band. | `Q` §4 |
| 11 | Impact | One signed I per market, shared by YES and NO, reset per epoch (`block.timestamp`). **λ·B = 0.5 per block** on both chains. | `Q` §3; §4.2 |
| 12 | Per-epoch cap | \|I\| ≤ Q_epoch = m_a·c·√v / (√(5/3)·f₅(·)) (P′ of the t kernel), with m_a = 1. c = $77.3k per unit log (L1) or $33.3k (L2), fees only. | `Q` §7.2 restated (§2.3) |
| 13 | LP budget | Per market: min(c_m, c_m + y_m) ≥ −B, **B = $20k = 1 % of NAV**. Per series: exact ladder min_j W_j ≥ −B_s, **B_s = 3B = $60k**. Both use an exact quadratic truncation. | `V` §5, `E` §3 |
| 14 | Settlement OI cap | Gross outcome tokens held by traders, delta-weighted: Σ_m gross_m·exp(−½((g − lnK_m)/sd_G)²) ≤ **Q_safe = 8π·h₀·k_w·v_cut**, checked at every strike and midpoint. k_w = κ_in·(w/Δt)·y_v with κ_in = 0.10 (L1) or 0.029 (L2); v_cut is the Asian v at the cutoff. | `S` §3.1/§3.3 |
| 15 | Manipulation charge | Per path: a clairvoyant attacker holds the counterparty of every adverse vault position and chooses δ to maximise gain − C(δ). C(δ) comes from the band-follower cost curve for the frozen (source, w). Stress: fixed M2 gross transfer at Q = 2B per series (L1 $1,912; L2 $1,436). | `S` §3.2 M2 |
| 16 | Data availability / INVALID | As in `S` §5 and `V` §6 (not simulated) | — |

Chain constants (`$I/spec.py`):
- `CHAIN['L1'] = {dt 12 s, y_v 155.5M, c 77,300}`;
- `CHAIN['L2'] = {dt 2 s, y_v 67M, c 33,309}`.

The L2 κ_in = 0.10·1.75/6 comes from `S`'s simulated 2 s row. It is **UNVERIFIED** on real L2 data.

**What the Foundry suite must add because of the freeze.**
- An on-chain F₅. It needs an `atan`, which neither solady nor PRBMath has (**UNVERIFIED**; a rational minimax port with an error
  budget is needed).
- The live-σ read.
- The Asian (μ, v) in integers.

Everything else in `Q`, `S`, `V` and `O` is used unchanged.

---

## 2. Quote-function theorems for the discrete-Asian mid and the ramp payoff

### 2.1 What changes in the formula

For the binary, the European form uses d₂ = (x − lnK − w/2)/√w with w = σ²τ. The Asian form uses d = (x − lnK − a)/√v, where
a = ½σ²(τ − w + (n−1)Δ/2) and v is as in §1 row 6. Both are **affine and increasing in x with slope 1/√v**. So:
- ∂P/∂x = φ(d)/√v;
- the gamma term becomes c_Δ·γ_S·P′ = k·φ(d) with **k = c_Δ·γ_S/√v**;
- Q_epoch scales as √v.

The size of the change, computed in `$I/specnums.py` (`out/specnums.txt`) at σ = 0.55:

| τ | √(v/σ²τ), w = 4 h | ATM gamma term Asian (European), L1 | Q_epoch ATM Asian, L1 | Asian − European price at +1 European sd |
|---|---|---|---|---|
| 24 h | 0.943 | 1.21¢ (1.14¢) | 5,259 tokens | +1.45¢ |
| 8 h | 0.816 | 2.42¢ (1.97¢) | 2,629 | +4.89¢ |
| 245 min (cutoff) | 0.589 | 4.69¢ (2.76¢) | 1,354 | +11.5¢ |

The ATM mid is almost unchanged (+0.03¢). The Asian adjustment is a **delta/variance** effect, which is exactly where `S` §1.2
found the European formula 7–10¢ off.

For the **ramp**, P(x) = [ψ(μ+h) − ψ(μ−h)]/(2h) with ψ(z) = z·Φ(z/√v) + √v·φ(z/√v). This gives:
- P′ = [Φ((μ+h)/√v) − Φ((μ−h)/√v)]/(2h) ≤ 1/(2h);
- g^± = P ± c_Δγ_S·P′.

### 2.2 Transfer table

| Result (`Q` §3, §5) | Binary, Asian | Ramp | t-kernel (frozen) | Why / evidence |
|---|---|---|---|---|
| Lemma A (additivity), Lemma S (floor-isqrt exact), Theorem N (no split, 8 swap types) | ✔ verbatim | ✔ | ✔ | They use only the integer quadratic in (price, Λ, I₀), never P. Fuzz F1: 13,291 / 13,291 / 3,547 cases with 0 deviations. F4: 0 violations in every mode (`$I/qf/out_fuzz_{asian,ramp,t}.txt`). |
| E1: bid_Y + bid_N ≤ 1 ≤ ask_Y + ask_N (marginal and amounts) | ✔ verbatim | ✔ | ✔ | NO quotes are mirrors of YES quotes and a ≥ b. F6: 1,491 / 1,493 / 398 states × 4 checks, 0 violations. |
| E2: a same-epoch round trip loses ≥ 2h₀q | ✔ verbatim | ✔ | ✔ | N_a − M_b = 2·10⁶(a − b)q. F5: 0 violations. |
| E3: path independence | ✔ | ✔ | ✔ | Lemma A |
| **Lemma M** (the band halt gives monotonicity for any k) | ✔ | ✔ | **numerical only** | **Generalised form:** if P′ is log-concave in x, then {g⁺ decreasing} is a half-line where 1 − P = ∫P′ < P′/ρ < κP′, so g⁺ > 1 > 1 − p_min. The Gaussian is log-concave. The ramp's P′ is a convolution of a uniform with a Gaussian, which is log-concave (Prékopa); numerically the second difference of log P′ ≤ 0 for h/√v ≥ 0.2, and the h/√v = 0.05 residual is float cancellation. The t density is **not** log-concave. On a 160k-point grid, κ up to 10, the worst g⁺ on its decreasing set is 1 − 6.9e-5 (ν = 5) or 1 − 5.2e-4 (ν = 3.5): never in band for p_min = 0.02 (`$I/qf/out_lemmaM.txt`). |
| E4: monotone in S | ✔ | ✔ | ✔ (via numerical M) | F7: 0 violations in 5,160 (Asian), 5,208 (ramp) and 1,511 (t) checks. F7y (no k cap): 0. The broken "gamma outside max" variant is still caught: 165 / 159 / 34 violations. |
| Per-epoch extraction bound ((\|F − P_sob\| − h₀)⁺)²/(2λ), ≤ Q_epoch·(…) | ✔ verbatim | ✔ | ✔ | The proof uses only a ≥ P_sob + h₀, b ≤ P_sob − h₀ and E2. |
| Theorem L sum: E Σ(ΔP)² ≤ P₀(1 − P₀) | ✔ | ✔ (payoff in [0, 1]: E[Π²] ≤ E[Π]) | ✔ | The Asian mid is a martingale up to the cutoff. MC: E[P_cut − P₀] = +0.0014 ± 0.0020, E[pay − P_cut] = −0.0006 ± 0.0009, E Σ dP² = 0.1674 vs E[P_cut²] − E[P₀²] = 0.1686, both ≤ 0.2015 (`lemmaM.py`) |
| Q_epoch = m_a·c·√w/φ | restated as m_a·c/P′: √v replaces √w (0.59× at the cutoff) | ≥ m_a·c·2h | m_a·c/P′_t | Same derivation (`Q` §7.2) with Δ_bin = P′ |
| Q_safe (settlement OI) | 8π·s·k_w·sd_G² with sd_G² = v_cut | 16·s·k_w·h² | Gaussian formula (the settlement statistic is Gaussian under GBM, whatever kernel is used to price) | `S` §3.1 |

**Caveat that applies to all forms: Theorem L does not bound model error.** Its bound is independent of the number of epochs only
for **information** (latency) extraction. A persistent gap e = belief − mid is harvested once per epoch, as R·(e − h)²/(2λ) per
unit of time. The 1-minute simulation therefore emulates R = 60/Δt epochs per minute (λ_step = λ/R, per-minute cap R·Q_epoch).
With equal per-block λ, an L2 chain gives a persistent-error trader six times the depth per minute that L1 does. That is why the
frozen λB = 0.5 is steeper than `E`'s 0.1.

---

## 3. What the re-run implements (engine changes vs `E` §3)

`$I/engine2.py` (`run_series`) simulates a **whole series** (7 strikes) jointly. The same numba kernel runs on the 1-minute data
(stages A, B and F) and on the 1-second data (`lat2.py`).
- **Mid.** Asian (μ, v) with Δ equal to the oracle sample interval: 60 s in the minute simulation, the block time in the 1-second
  runs. Kernel N or F_t, or the ramp.
- **Quote and caps.** Gamma term with γ_S(σ, Δt), h₀, halt band plus the executed-price band, Q_epoch, per-market budget, the exact
  ladder (`ladder_R`, O(n)), and the delta-weighted OI cap (`oi_room`). All are enforced on every trade, informed or noise.
- **Settlement.** Mean of pool samples over [T − w, T), strict comparison. Then the per-path clairvoyant manipulation using C(δ)
  from `costcurve.py` (the band-follower of `S` §2; reproduces `S`'s table and M2 = 5.34 % at $100k, 4 h).
- **Noise** is $1,000 orders placed as real trades in the same book: opening positions, own impact at per-block λ, common random
  numbers across runs.
  - This replaces `E`'s "unit-intensity ledger scaled by η": caps depend on volume, so D is now run on a grid (0.25 … 8), not scaled.
  - All noise orders are counted as **opening** gross OI. That is conservative for the cap; Polymarket's OI/volume ratio is about
    0.55.
- **Accounting.** Each informed class (lat, tail-ECDF, DVOL-t, clairvoyant-vol, momentum) runs alone with the same noise.
  - A class contributes its own P&L plus the **worst single** crowd-out of noise revenue. Crowd-out is not additive, so summing it
    would double-count.
  - **Original accounting:** a class is counted if its total over the evaluation period is negative.
  - **Strict accounting (new):** a class is counted in every calendar year in which it is negative. This models an adversary that
    trades only in regimes where it wins.
- **Tail adversary** uses a walk-forward ECDF of the *Asian settlement statistic* (`prep2.py`), standardised by the live 1-day EWMA
  for every hook policy, so the adversary's information set is the same across σ policies.
- **Latency charge.** The 1-second (lat + noise) − (noise) per series, taken at the nearest D. It is floored at 0: a donor class is
  assumed absent.

Approximations, all UNVERIFIED as to size:
- The minute simulation holds S constant within a minute. Sub-minute effects come only from `lat2.py`.
- Noise orders that exceed one block's Q_epoch are split across the R blocks of the minute at the block's own impact.
- C(δ) is computed at σ = 0.52.
- The pool is a 5 bp band follower of Binance, validated on 7 days (`E` §2.1).

---

## 4. Results

### 4.1 Stage A: σ policy × kernel

Setup: L1, w = 2 h, cutoff 125 min, h₀ = 1¢, λB = 0.1, B = $20k, D grid 1–8 (floor 1.0), original accounting
(`$I/out/stageA_summary.txt`).

| σ policy (hook) | Kernel | D\* IS / OOS | OOS D = 2, per series (B): tail / iv / orv |
|---|---|---|---|
| **mode A: RV 3 d + β, fixed at creation** (`O` v1) | N | **∞ / ∞** | −0.33 / −0.19 / −1.00 |
| mode A | t | 3.10 / ∞ | −0.25 / +0.05 / −0.85 |
| EWMA 1 d, fixed at creation | N | 1.00 / ∞ | −0.29 / +0.01 / −0.88 |
| mode B: RV 3 d live, rate limit +20 %/h, −10 %/h | N | ∞ / ∞ | −0.26 / −0.16 / −1.07 |
| mode B, RV 1 d | N / t | 3.60 / ∞ ; 3.89 / 3.65 | −0.18 / −0.06 ; −0.17 / +0.08 |
| RV 1 d live, no rate limit | N | 1.00 / ∞ | −0.09 / −0.07 / −1.09 |
| **EWMA (1 d half-life) of TWAP-return RV + β, live (frozen)** | N / **t** | 1.00 / ∞ ; **1.00 / 1.33** | −0.10 / −0.10 ; **−0.10 / +0.11** |
| EWMA 1 d of 5-min point returns, live (`E`) | N / t | 1.00 / 1.00 ; 1.59 / 1.66 | −0.02 / +0.02 ; −0.14 / +0.05 |

Reading:
1. **Freshness, not the estimator, is what matters.** Fixing σ at creation costs 0.25–0.33 B per series whichever estimator is
   fixed (mode A −0.33, EWMA-fixed −0.29, live EWMA −0.02). Rate-limited or 3-day windows sit in between.
2. The frozen EWMA of TWAP-return RV keeps `O`'s estimator, β and winsorisation. It is computable from the oracle's per-window
   squared differences (one EWMA accumulator), and gives up only the "window chosen at read time" property.
3. Manipulation cost of a live σ, in place of `O`'s mode A:
   - A 1-day-half-life EWMA weights about 1.4 days of windows, so the cost to shift it is roughly half of `O` §3.4's $303k per
     10 vol points on L1 (**UNVERIFIED**; not simulated).
   - It must be read epoch-constant.
   - It must be listed as a new attack surface in the proof plan (fork test: push k windows, measure Δσ̂ and cost).

### 4.2 Stage B: window × cutoff × spread × kernel × λ

Setup: 148 configurations, frozen σ, original accounting with the 1-second latency charge (`$I/out/stageB_table.txt`,
`stageB_md.txt`). L1 excerpt; cells are D\*_IS / D\*_OOS, then OOS edge per series at D = 5.

| w | h₀ | cutoff (min) | Gaussian, λB 0.1 | Gaussian, λB 0.5 | t, λB 0.5 |
|---|---|---|---|---|---|
| 30 min | 2¢ | 35 (T−w−b) | 1.00 / 1.00 · +$1,523 | 1.00 / 1.00 · +$1,866 | 1.00 / 1.00 · +$2,715 |
| 30 min | 2¢ | 100 (τ_cut 05) | 1.00 / 5.34 · +$2,583 | 1.75 / 4.23 | 1.00 / 1.00 · +$8,943 |
| 30 min | 2¢ | 144 (10 %) | 2.45 / 7.85 · +$2,108 | 2.65 / 5.61 | 1.00 / 1.00 · +$11,435 |
| 2 h | 1¢ | 125 / 144 / 399 | 1.00 / ∞ ; 2.48 / ∞ ; 7.00 / ∞ | 1.91 / ∞ ; 3.09 / ∞ ; 6.37 / ∞ | 1.00 / 1.00 ; 1.00 / 1.08 ; 1.00 / 1.00 |
| 2 h | 2¢ | 125 / 144 / 160 | 1.91 / 1.00 ; 2.03 / 1.00 ; 3.01 / 1.00 | 2.29 / 2.46 ; … | 1.00 / 1.00 (all) · +$17.0k … +$19.0k |
| 4 h | 0.5¢ | 245 | ∞ / ∞ | 4.80 / ∞ | 1.00 / 1.85 |
| 4 h | 1¢ | 245 / 479 | 3.48 / 2.12 ; 7.23 / 2.66 | 4.09 / 6.72 ; … | 1.00 / 1.00 (both) |
| **4 h** | **2¢** | **245** | 1.00 / 1.00 · +$16,304 | 1.79 / 1.77 · +$12,270 | **1.00 / 1.00 · +$19,655** |

(D\* = 1.00 is the grid floor in stage B.)

**Cutoff.** Three rules were compared:
- **T − w − b**: 35 / 125 / 245 min for w = 30 min / 2 h / 4 h.
- **10 % of tenor** (144 min): legal only for w ≤ 2 h, and equal to 245 min at w = 4 h.
- **05's τ_cut** in Asian form. At h₀ = 1¢ it gives 339–479 min; at 2¢, 100–245 min. At h₀ = 0.5¢ it exceeds 20 h and kills a
  1-day market (`spec.py cut_05`).

A later cutoff raises capacity (noise fill at D = 8 grows from $82k to $394k per series at 30 min), but with the Gaussian kernel it
worsens OOS D\*, because informed flow gets more time. It never helped at w = 4 h.

T − w − b is frozen. It is the minimum legal cutoff (`S` §6) and it binds at w = 4 h anyway.

**Spread.** With the Gaussian kernel, h₀ ≤ 1¢ fails OOS in 19 of 20 L1 cells with w ≤ 2 h. The gamma term (`Q` §4) alone does not
cover fat-tail model error. With t (λB = 0.5), 1¢ passes at w ≥ 2 h.

`Q`'s 0.3–1¢ and `E`'s 2 % reconcile as follows: **h₀ = 2¢ with the Gaussian kernel; h₀ ≥ 1¢ with t**. 2¢ is frozen for tail risk
and because Q_safe is linear in h₀.

**λ.** For the Gaussian kernel, λB = 0.1 is better on L1. For t, 0.5 is better on both chains. 0.5 is frozen (§2.2, last caveat).

### 4.3 Sub-minute latency under the spec (`lat2.py`, `out/latB_summary.txt`)

Setup: 112 one-day series on 1-second data, start-of-block oracle, per-block reset, Q_epoch, all caps, TWAP settlement.

| Configuration (w = 4 h, h₀ = 2¢, cut 245) | LP P&L vs CEX-leading arbitrageur, per series (B) | Arbitrage volume |
|---|---|---|
| L1, t, λB 0.5 | **+0.034 ± 0.026** (D = 2) | 2.2 B |
| L1, N, λB 0.1 | +0.037 ± 0.060 | 5.4 B |
| L2, t, λB 0.5 | +0.028 ± 0.014 | 0.8 B |
| (`E`, snapshot settlement, s = 2 %, per **market**) | −0.029 ± 0.016 per market (≈ −0.2 per series) | — |

The arbitrageur is only charged where it extracts. That happens at h₀ = 0.5–1¢ with w ≤ 2 h or later cutoffs, for example L1
w = 2 h, h₀ = 0.5¢: −0.094 ± 0.039 B per series. With w = 30 min and cutoff 35 min, it extracts 0.01 B per series or less.

### 4.4 Settlement manipulation (`costcurve.py`, `m2charge.py`)

Cost curves reproduce `S`: L1 w = 30 min: $226 at 2.5 bp, $7,400 at 10 bp; w = 4 h: $1,770 and $59,128. For L2 (Base, 2 s,
$67M): w = 4 h costs $1,357 at 2.5 bp and $151,713 at 10 bp. The L2 curve is cheaper inside the band and much dearer above it.

Clairvoyant attacker at the frozen cutoff, σ = 0.55, worst moneyness; percentage of Q (net attacker gain / gross vault transfer):

| Source, w | Q = $10k | $40k (= 2B, the budget-bounded maximum) | $100k |
|---|---|---|---|
| L1, 30 min | 10.8 / 15.3 % | 20.3 / 30.6 % | 31.7 / 47.8 % |
| L1, 2 h | 3.7 / 5.0 % | 6.3 / 9.0 % | 9.5 / 14.0 % |
| **L1, 4 h** | 2.1 / 2.9 % | **3.5 / 4.8 %** | 5.1 / 7.3 % (`S`: 5.34 % net at σ 0.52) |
| **L2, 4 h** | 2.2 / 2.8 % | **3.0 / 3.6 %** | 3.7 / 4.9 % |

In the backtest:
- **Per path**, where the attacker is the counterparty of the vault's own book: $106–201 per series, 2.1 % of series attacked, worst
  −1.2 B. The noise book is two-sided, so the flip-exposed net is small.
- **Stress**, M2 gross at Q = 2B on every series: 0.096 B (L1) and 0.072 B (L2). This moves D\* from 0.25 to 0.6–0.9 (§4.5).
- For the ramp at w = 30 min, the per-path charge is $21–40 per series, but 56–63 % of series are nudged (Lipschitz payoff).

### 4.5 Final evaluation (`final.py`, `strict.py`, `m2dstar.py`, `frozen_eval.py`)

Setup: D grid {0.25, 0.5, 1, 2, 3, 5, 8}; B = $20k; latency charge from `latF`.

| Configuration | Original acct. D\* IS / OOS | + M2 stress | **Strict + M2 D\* IS / OOS** | Strict + M2, D = 2 OOS: edge, LB95, CVaR95 / CVaR99 / maxDD |
|---|---|---|---|---|
| **Frozen v1, L1 (t, λB 0.5)** | 0.25 / 0.25 | 0.61 / 0.67 | **0.68 / 0.68** | +$6,097; +102 %/yr; **1.39 / 3.32 / 4.8 %** |
| **Frozen v1, L2 (t, λB 0.5)** | 0.25 / 0.48 | 0.38 / 0.85 | **0.86 / 0.76** | +$5,784; +85 %/yr; 4.03 / 5.41 / 7.1 % |
| Gaussian, L1 (λB 0.1) | 0.25 / 0.25 | 0.61 / 0.59 | 4.97 / 2.18 | +$2,628; −10 %/yr; 17.0 / 21.0 / 113 % |
| Gaussian, L2 (λB 0.5) | 0.25 / 0.25 | 0.37 / 0.36 | 3.20 / 0.89 | +$6,169; +73 %/yr; 14.2 / 20.5 / 35 % |
| Gaussian, L1, σ = mode A | 3.84 / ∞ | — | 7.56 / ∞ (no M2) | −$5,472 |
| Gaussian, L1, σ = `E`'s EWMA | 1.79 / 0.25 | — | 3.87 / 1.24 (no M2) | +$4,293; CVaR95 12.8 % |
| Gaussian, L1, B = $5k / $50k | 0.25 / 0.25 ; 1.79 / 6.42 | 0.37 / 0.33 ; 4.66 / ∞ | 3.62 / 0.33 ; 6.24 / ∞ | $5k: +$1,810, CVaR95 0.38 % |
| Gaussian, L1, ramp h = 100 bp, w = 30 min | 0.25 / 0.25 | — | 0.25 / 0.25 (no M2) | +$7,336; CVaR95 −1.2 %; E5 L2 D\*_stress **2.8** |
| Gaussian, L1, no OI cap / no manipulation / no Q_epoch | 4.60 / 0.25 ; 0.25 / 0.25 ; 0.25 / 0.25 | — | ∞ / 2.32 ; 1.13 / 0.25 ; 3.54 / 0.25 | the OI cap *helps*: it throttles informed size |

Frozen v1, per calendar year and E5 (strict + M2):

| | D = 1 | D = 2 | D = 5 |
|---|---|---|---|
| L1 edge per series / vault %/yr (LB95) | +$1,807 / +33 % (+25) | +$6,097 / +111 % (+102) | +$17,491 / +317 % (+268) |
| L1 years 2021–2026 | +48, +34, +14, +47, +21, +27 % | +124, +102, +85, +128, +92, +107 % | all ≥ +258 % |
| L1 weekly CVaR95 / CVaR99 / maxDD | 2.84 / 5.65 / 8.1 % | **1.39 / 3.32 / 4.8 %** | 7.95 / 12.65 / 15.9 % |
| L2 years | +53, +43, **−16**, +52, **−4**, +55 % | all positive | all positive |
| E5 (+ clairvoyant vol), both chains | −481 %/yr | −441 %/yr | −336 %/yr |

E-criteria verdict for frozen v1, against the modeled adversaries only (E7 Thales replay still pending, `E` §6.7):

| Criterion | L1 | L2 |
|---|---|---|
| E2 (D\*_real ≤ D_decl) | Pass for D_decl ≥ 0.7/day | Pass for D_decl ≥ 0.9/day |
| E3 | Pass at D = 2 | Pass at D = 2 |
| E4 at D = 2 | **Pass** | **Fail** (CVaR95 4.0 % > 2 %, CVaR99 5.4 % > 4 %) |
| E4 at D = 5 (strict) | Fail (CVaR95 8 %) | Fail |
| E5 | D\*_stress = ∞ on both. It must be disclosed, as `E` requires. | same |

At D = 5 the CVaR rises because the strict rule re-admits an adversary class that has large weekly variance. The D = 5 figures are
dominated by that class, not by noise.

---

## 5. Which cap binds, and how big the market can be (USD)

Per series (7 strikes), frozen v1, OOS means (`out/final.txt`):

| Quantity | L1 | L2 |
|---|---|---|
| Q_safe (settlement OI, delta-weighted), mean / minimum over series | $636,542 / $60,603 | $480,436 / $45,741 |
| LP budget: per market B / per series B_s | $20k / $60k | same |
| Largest one-sided position per strike under the budget (ATM) | ≈ 2B = $40k | same |
| Noise demand → filled payout tokens per series per day, D = 2 | $280k → **$216k** | $280k → $217k |
| D = 5 | $700k → **$487k** | $700k → $487k |
| D = 8 | $1.12M → **$731k** | $1.12M → $716k |
| End-of-day gross OI of the noise book, D = 2 / 5 | $216k / $487k (vs Q_safe mean $637k) | $217k / $487k |

**Binding order at w = 4 h:**
1. band halts on the deep strikes (≈ 22 % of orders even at D = 0.25);
2. the per-market budget and ladder (thousands of truncations in the informed runs; see the `binds` lines);
3. Q_safe, only on low-σ days. Q_safe ∝ σ², so the minimum is $61k when σ sits at its floor.

**Compared with the Polymarket anchor** (Gamma API, re-queried 2026-09-26, `E`'s `pm.py` plus an OI read):
- The daily "Ethereum above ___ on <date>" events of Sep 1–24, 2026 traded a median **$366k** per event (11 strikes). The top strike's
  median was ≈ $90k.
- Event open interest was $219k, $179k and $163k on Sep 22, 23 and 24.
- The frozen spec fills **$216–487k of payout-token flow per series per day at D = 2–5**, and can hold ≈ $0.5M of gross OI.

So the binding cap leaves a market of **the same order as today's leading on-chain venue for this product**.
- Polymarket volume is premium notional; ours is payout tokens. Premium is roughly 0.3–0.6× payout across the ladder
  (**UNVERIFIED** conversion).
- The comparison is therefore favourable by about 1.5–3× in payout terms.

Growing beyond that requires a larger B, which fails robustness (§4.5: B = $50k), or more depth in the settlement source. A larger B
is also only safe with proportionally steeper λ. That combination was not tested (open question).

**With shorter windows the cap binds hard:**

| w | Payoff | Q_safe (h₀ = 2¢, per series) | Noise fill at D = 8 | Stress M2 at $40k (gross) |
|---|---|---|---|---|
| 30 min | binary | **$9k** (closed form, κ_in 0.10; numerical M1 gives $14k) | **$82k**; saturated from D = 2 | 30.6 % |
| 30 min | ramp 100 bp | $75k | $460k (L1) / $349k (L2); saturated from D ≈ 5 | 0.2–1.4 % (`S` M2 table) |
| 2 h | binary | $108k (closed form) / $196k (numerical) | $610k | 9.0 % |
| **4 h** | **binary** | **$410k at σ 0.6 (closed form) / $947k (numerical)** | **$731k (budget-bound)** | **4.8 %** |

The 30-minute binary is not an economically meaningful market: it holds about ¼ of Polymarket volume at best and is manipulable.
`S`'s recommendation of w ≥ 2–4 h is confirmed economically.

---

## 6. Implications for the proof plan (what M2 tape replay must now match)

1. **One spec file.** `spec.py` constants and the §1 table become `PredictionSpec.sol` constants, plus the per-series immutables
   (lnK or κ threshold, w, T, σ-read mode, h₀, λ, B, B_s, κ_in, c, y_v reference). The Python engine (`engine2.run_series`) is the
   tape generator.
   - The tape needs per-block `sqrtPriceX96`, oracle checkpoints (for the live σ and the TWAP), and per trade: series, strike,
     direction, amount, expected out, and the vault (c, y, I, gross).
   - At expiry: G, outcomes and the manipulated-outcome flag.
2. **New Foundry obligations created by the freeze:**
   - (a) F₅ CDF and pdf with an `atan` approximation: an error budget against mpmath, and monotonicity fuzz (Lemma M_t is
     numerical).
   - (b) The Asian (μ, v) in integers, with the in-window halt.
   - (c) A live EWMA σ accumulator in the oracle hook, epoch-constant reads, and the σ-manipulation fork test.
   - (d) The delta-weighted OI cap check (O(n²) at n = 7 strikes, 13 evaluation points).
   - (e) Ladder and budget truncation with exact quadratics (already prototyped in `V`).
3. **Keep the Gaussian path as a proof-complete fallback.** Every theorem is proven for it; only the economic claims differ.
   The ramp (h = 100 bp) is the only form with a finite vol-foresight stress. It is worth a v1.1 product option.
4. **Economic claim wording.** State it as: "For 1-day ETH series on L1 with the §1 spec, IS-frozen, against {latency, tail-ECDF,
   DVOL-t, momentum} with per-year adaptive participation and the budget-bounded M2 manipulation charge, D\* ≈ 0.7/day and E3/E4
   pass at D = 2; E5 fails (vol foresight)."

---

## 7. Open questions

1. Can **more depth or a larger B** be combined (λ ∝ 1/B held per dollar)? Only B ∈ {$5k, $20k, $50k} was tested at fixed λB.
2. **L2 E4 failure.** Would a steeper λ or h₀ = 2.5¢ pass on L2? Not run.
3. **Live-σ manipulation cost** for the 1-day EWMA on v3 5 bp (L1 and Base). Only estimated.
4. **E7 (Thales replay)** is still pending. The adversary set remains weaker than reality at the 7-day tenor, and was never
   validated at 1 day.
5. **Noise closing behaviour.** All noise is treated as opening OI. With Polymarket's OI/volume ≈ 0.55, capacity may be about 1.8×
   higher.

---

## Verification

**Verified by running code** (all outputs in `$I/out` and `$I/qf`):
- Cost curves and M2 reproduce `S`: 5.34 % net at $100k, w = 4 h, σ 0.52. Our σ 0.55 gives 5.06 %. Q_safe numerical $7,356 and
  $321,818 at h₀ = 1¢ match `S`'s $7.4k and $322k.
- Integer-exact fuzz of the quote function in three modes (Asian, ramp, t), with `Q`'s harness adapted
  (`qf/quote_ref_asian.py`): F1–F9 have 0 violations in every spec property, and the excluded variants still fail as in `Q`.
- Generalised Lemma M: log-concavity for the ramp, and the t deficit of 6.9e-5 (ν = 5). The F₅ closed form matches scipy to
  3.3e-16. The Asian mid martingale/QV check passed.
- The β check on the 1-minute pool:
  - the TWAP-return RV has a 4.5 % variance deficit before β and 2.4 % after it. The residual comes from 1-minute arbitrage in the
    simulation, compared with 12 s on chain;
  - the regime guard fires on 1.25 % of minutes;
  - the clamp binds 1 % of the time.
- All backtest tables: 148 stage-B configurations, 13 stage-A σ/kernel variants, 26 final configurations × 7 D × 6 runs, and
  148 + 16 latency configurations × 2–3 D × 2 runs.
- Polymarket volume (24 events) and OI (3 events) re-queried from `gamma-api.polymarket.com` on 2026-09-26.

**Not verified / modelled (UNVERIFIED):**
- The L2 manipulation-cost coefficient (κ_in = 0.029) and the L2 cost curve come from band-follower simulation, not real Base data.
  The L2 variant uses 1-minute CEX data with R = 30 emulated epochs per minute.
- The adversary set is a lower bound on real adversarial skill (Thales contradiction, `E` §6.7). The per-year strict rule is one
  choice of "adaptive participation".
- The 1-second latency study covers 112 series (SE 0.014–0.06 B per series).
- The manipulation cost of the live σ, and the on-chain `atan` for F₅ (error, gas), are not measured.
- Noise size ($1k orders, all opening), splitting across blocks, and the premium-to-payout conversion used in the Polymarket
  comparison.
- C(δ) at σ = 0.52 for every series. Tick rounding (±0.5 bp) and the half-tick threshold are not simulated; `S` showed them
  unbiased.
- D\* at the grid floor (0.25) means "no realistic class extracts". Values below 0.25 were not resolved.
- Multiple testing: 148 stage-B configurations were selected on IS. OOS is reported only for the selected and comparison rows.

## Reproduction

See `$I/README.md`. The order is:
1. `costcurve.py` → `prep2/3/4.py`;
2. `stage.py stageA bt cfgA.json`;
3. `mkcfg.py`; `stage.py latB lat cfgL.json '[2,5]'`; `stage.py stageB bt cfgB.json` → `select_cfg.py`;
4. `mkfinal.py`; `stage.py latF lat cfgFL.json '[0.5,2,5]'`; `stage.py stageF bt cfgF.json '[0.25,0.5,1,2,3,5,8]'` → `final.py`,
   `strict.py`, `m2charge.py`, `m2dstar.py`, `frozen_eval.py`, `peryear.py`;
5. theorem checks: `qf/quote_fuzz_asian.py` (`MODE=asian|ramp|t`) and `qf/lemmaM.py`.

Run everything with `uv run --with numpy --with scipy --with numba [--with mpmath] python …` from a working copy holding `lib.py`
and `engine.py` from `economic-backtest/`. Wall time is about 3 h on 10 cores.
