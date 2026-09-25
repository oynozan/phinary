# Gap: is plain Black–Scholes N(d2) enough, or does v1 need a fat-tailed (Student-t) kernel?

**Date:** 2026-09-26. **Scope:**
- (a) Re-run the 1-day IS-selected configuration with N(d2) in place of the Student-t kernel, charging L1 and L2 latency, and report D\*, E3 and E4 with paired CIs.
- (b) Specify and measure an on-chain Student-t CDF.
- (c) Determine which proven properties survive a t kernel.
- (d) Recommend the v1 claim.

**Status:** research result. I computed every number here with code that is archived next to this report.

**Where things are.**
- `$K` = `docs/research/gaps/kernel-sufficiency-scripts/`.
  - `econ/`: backtest re-runs. They reuse the economic-backtest engine and data.
  - `solidity/`: the Foundry Student-t library, its tests, the vector generator and the symbolic derivation.
  - `math/`: lemma and Asian-formula numerics.
- Raw outputs are in `$K/econ/out/*.txt|log`, `$K/solidity/forge_out.txt` and `$K/math/out_math_t.txt`.
- Working copies are in the session scratchpad (`…/scratchpad/econ/kc_*`, `…/scratchpad/tcdf`, `…/scratchpad/tmath`). The 1-minute and 1-second ETH data come from the economic backtest (`economic-acceptance-criteria-and-backtest.md` §2; "EB" below).
- Other reports are cited as EB §x, QF §x (`quote-function-spot-input-and-size-impact.md`), SR §x (`settlement-rule-and-in-band-manipulation.md`), 03 §x and 05 §x.

---

## 0. Answer in brief

1. **At 1 d, N(d2) matches the selected Student-t (ν = 5) on every E-criterion.** The t kernel was not needed there. OOS 2024-01..2026-09, L1 12 s latency charged, same markets, same adversaries, common random numbers:

   | | N(d2) | t, ν = 5 | Paired N − t5 (95% CI) |
   |---|---|---|---|
   | D\* (noise turnover/day) | **0.18** | **0.23** | break-even difference −0.06 [−0.50, +0.15] |
   | Edge per market at D = 2 | +0.0396 B | +0.0392 B | **+0.0003 B [−0.0079, +0.0116]** |
   | E3 95% lower bound at D = 2 | +91.6%/yr | +92.9%/yr | vault difference +0.8%/yr [−20, +30] |
   | E4 at D = 2: CVaR95 / CVaR99 / max DD | 0.20% / 0.71% / 0.8% | ≤ 0 / ≤ 0 / 0.0% | both pass |

   - The same holds IS and on L2.
   - Calibration under P is also a tie. Log-loss difference N − t5 is −0.0007 [−0.0023, +0.0008], so N(d2) is nominally better.
   - **t with ν = 4 is significantly worse at 1 d.** Log-loss is worse, D\* is 1.70, and E4 fails (CVaR95 10%, max DD 44%) because the tail adversary sells its over-fat wings.
2. **Where t actually helps: vol foresight.** Against the clairvoyant realized-vol agent (E5 stress), N(d2) needs +2.65 [+0.33, +4.82] more noise turnover per day than t5: D\*_stress is 14.7 vs 11.7. The adversary is declared out of scope in EB §1.2, so this is a disclosure item, not a v1 blocker.
3. **The economic report's 1 d latency charge came from a different configuration.** EB §6.5 charged −0.0293 B/market, which was measured at λB = 0.05 with a 2% cutoff (`economic-backtest/lat1s_cut.py:35`).
   - At the selected λB = 0.1 with a 10% cutoff, the 1-s replay gives **−0.0030 (N) and −0.0043 (t5) B/market on L1**.
   - Over λB = 0.05 / 0.07 / 0.10 / 0.20 the charge is monotone: −0.0203 / −0.0099 / −0.0030 / +0.0007.
   - So D\* is ≈ 0.2/day, not 1.35/day, at the point estimate.
   - The latency sample is short: 116 days, 113 daily listings, SE ≈ 0.017 B/market. Carrying that SE into the bootstrap raises D\* to ≈ 1.5/day for either kernel. **Quote D\* ≈ 0.2–1.5/day at 1 d**, and treat the latency SE as the binding uncertainty.
4. **Sub-day: "a normal kernel fails at 1 h and 4 h" (EB §6.1, §7) was really about the σ policy, not the kernel.** It compared the *naive* σ (1-day EWMA, no seasonality, s = 1%) against t + seasonality + 4-hour EWMA. With the same σ policy, s = 2% and λB = 0.1:
   - N(d2) has *lower* realistic D\*: 4 h, 0.7 vs 4.1/day; 1 h, at the grid floor vs 12/day, on L1.
   - The difference is significant: paired edge +0.014 B [+0.006, +0.022] at 4 h and +0.018 B [+0.012, +0.023] at 1 h.
   - Almost all of it is latency. The t kernel's taller centre density (f(0) = 0.49–0.57 vs 0.40) raises Δ near the money, so a stale quote leaks more.
5. **But t is genuinely better calibrated at 1 h and much more robust to vol foresight at 1 h and 4 h.**
   - At 1 h, t with ν = 4 beats N(d2) on log-loss by +0.0016 [+0.0006, +0.0025] OOS and +0.0031 [+0.0013, +0.0053] IS. Worst calibration bin: 2.1 pp vs 5.1 pp.
   - The clairvoyant agent extracts 2.6× more from N(d2) at 1 h (−0.139 vs −0.053 B/market) and 1.9× more at 4 h. D\*_stress: 94 vs 48/day at 1 h, 39 vs 24/day at 4 h.
   - A combined latency + tail-informed adversary was not modeled (UNVERIFIED). Cross-belief latency arbitrageurs tested here all lost money.
   - **Verdict for ≤ 4 h: undecided on economics, t4 better on calibration and stress.** It stays research.
6. **On-chain Student-t CDF (b): the even-ν closed forms are algebraic, exact and cheap.**
   - With the variance-matched argument d (the same d2 as BS), and t/√(t²+ν) = d/√(d²+ν−2):
     - ν = 4: **F = ½ + d(d²+3)/(2(d²+2)^{3/2})**;
     - ν = 6: **F = ½ + d(1 + 2/y + 6/y²)/(2√y)**, with y = d²+4;
     - ν = 5: **F = ½ + [atan(d/√3) + √3·d(y+2)/y²]/π**, with y = d²+3.
   - All are verified symbolically against the integral of the t pdf (`derive.py`).
   - The formula in the gap statement, "½ + (t/√(t²+4))(1 + 2/(t²+4))", is **missing a factor ½** on the second term: it tends to 3/2.
7. **Solidity, measured.** Solady `sqrt`/`fullMulDiv` only (Solady has no `atan`; I wrote one); solc 0.8.26; Cancun; 29,306 vectors against a 60-digit mpmath incomplete-beta reference.
   - Max absolute error ≤ **1.01e-18** for ν = 4, 5 and 6, versus 4.2e-17 for our Hart Φ.
   - Gas, net average/max: ν = 4 **829/1,192** (hp variant), ν = 6 **814/844** (hp), ν = 5 **1,390/1,726** (atan). Hart Φ is 685/976 on the same harness.
   - Symmetry F(d) + F(−d) = 1e18 holds exactly by construction (100k fuzz runs).
   - Monotonicity: 0 violations in 800k adjacent-wei pairs for hp-4, 5 and hp-6. The plain WAD-sqrt variants of ν = 4 and 6 show 1-wei reversals. There are 0 violations on a 240k-point grid and in 100k random-pair fuzz runs.
   - ν = 3.5 would need an incomplete-beta routine. Not implemented; UNVERIFIED gas. It is also unnecessary: t4 calibrates better than t3.5 at 1 h, and ‖F_3.5 − F_4‖∞ = 1.3 pp.
8. **(c) What survives a t kernel:**
   - **Unchanged (kernel-agnostic):** parity `bid_Y + bid_N ≤ 1 ≤ ask_Y + ask_N`, the round-trip loss, no split, Lemma S (isqrt), and the per-epoch extraction bound (Theorem L).
   - **Survives with φ → f_ν:** the gamma spread k·f_ν(d). Closed forms: 3/y^{5/2}, 24√3/(πy³), 60/y^{7/2}.
   - **Changes, and gets easier:** Lemma M. Mills' inequality fails for t, since (1−F)/f ≈ d/ν grows. Instead, g⁺ = F + k·f is *globally* monotone for k ≤ k\*_ν = 2√(ν−2)/(ν+1): 0.566 / 0.577 / 0.571 for ν = 4 / 5 / 6. For larger k the band still saves it numerically (dip minimum ≥ 0.995 > 0.98 for k ≤ 200), but that part is not a proof.
   - **Lost:** M4 as a *Q* theorem, because there is no martingale model whose τ-marginal is log-t (E[S_T] = ∞), and the martingale route to the P₀(1−P₀)/2 total-LVR identity.
   - **Discrete geometric-Asian formula:** no exact closed form. Under the scale-mixture (σ-uncertainty) reading, **YES ≈ F_ν^{vm}(μ/√v)** with the same μ and v. Its error is ≤ 0.46 pp at 1 d (ν = 4, σ ≤ 1) and ≤ 0.11 pp at the 1 h cutoff, checked by quadrature and MC. Under iid-t increments the CLT makes the *normal* Asian formula the right one (MC).
9. **Recommendation (d): v1 claims "Black–Scholes N(d2), 1-day tenor only".**
   - Settlement is on the discrete geometric-Asian digital (SR §0), which is still the lognormal model.
   - The existing proof programme applies as is: Hart Φ, the Asian closed form, Lemma M and M4 under GBM.
   - The t kernel has no statistically detectable economic benefit at 1 d, ν = 4 is harmful there, and it costs part of the proof programme.
   - Ship the ν = 4 algebraic t CDF as a *research* kernel for ≤ 4 h tenors, with the modified proof obligations in §6.
   - **Required edits to EB:**
     - §6.5/§7: the 1 d kernel is N(d2), not t.
     - §6.5: the latency charge for λB = 0.1 with a 10% cutoff is ≈ −0.003 B/market.
     - §6.1 decision 1 and §7: "normal kernel at ≤ 4 h is outside the region" is replaced by "normal with a naive σ policy is outside; with 4 h EWMA + seasonality it passes against modeled adversaries but has worse calibration and 2× stress exposure."

---

## 1. What was re-run, and how it differs from the economic report

**Engine.** The engine is the same as EB §3 (`economic-backtest/engine.py`), with one change. `engine2.py` passes a separate Student-t table and scale to the *hook* kernel and the latency agent, which uses the hook's own model. The iv adversary (Student-t, DVOL) therefore stays at the report's ν for every hook variant.
- A plain swap of `bt.NU` would also have changed the adversary.
- `engine3.py` additionally lets the latency agent use a *different* belief kernel than the hook (the cross-belief test, §3.3).

**Configuration.** This is the 1 d IS-selected configuration (EB §6.5):
- σ = 1-day-half-life EWMA of 5-min pool returns, clipped to [0.30, 2.00], no multiplier, no seasonality;
- s = 2%, λB = 0.1, cutoff 144 min (10%), p_min = 0.02;
- per-step impact reset; γ = 5 bp, c_Δ = 1.

Kernels:
- `normal` = N(d2);
- `t4`, `t5`, `t6` = variance-matched Student-t with ν = 4, 5 (the report's selection) and 6.

For sub-day tenors I used the report's stage-A policy (σ = 4 h EWMA + seasonality). The selected cutoffs are 0 (1 h) and 24 min (4 h). Kernels are `normal`, `t_fit` (ν = 3.5 / 3.8) and `t4`.

**Reproduction check.** `t5` at 1 d, `t_fit` at 1 h and `t_fit` at 4 h reproduce the EB `expF` "selected" per-agent OOS attributions to the fourth decimal:
- 1 d: tail +0.0036, iv +0.0846, orv −0.2194, dir +0.0108, noise +0.0218 (`$K/econ/out/attrib.txt` vs `economic-backtest/out/expF_1d.txt`).

**Latency.** I re-ran the latency charge with the 1-second replay of EB §6.4 (Binance 1 s, 2026-06..09, 116 days), using the **exact selected configuration** (λB = 0.1, s = 2%, 10% cutoff, p_min 0.02, start-of-block oracle, per-block reset), once per kernel with the same seed (`kc_lat.py`).
- EB's `lat1s_cut.py:35` hard-codes `lam=0.05` and uses the default normal kernel.
- EB `expF` then charged the λB = 0.05 / 2%-cutoff value (−0.0293) to the λB = 0.1 / 10%-cutoff selection.

Sensitivity check (`kc_lat_lam.py`, 1 d, L1, 10% cutoff, B/market; the λB = 0.05 row reproduces EB §6.4's −0.0203 exactly):

| λB | N(d2) | t5 |
|---|---|---|
| 0.05 | −0.0203 | — |
| 0.07 | −0.0099 | −0.0160 |
| **0.10** | **−0.0030** | **−0.0043** |
| 0.20 | +0.0007 | +0.0036 |

The fall is faster than 1/λ. As depth shrinks, the arbitrageur's gross gain shrinks while its model and settlement-basis losses near expiry stay (EB §6.4 notes the latter).

**Accounting.**
- Conservative LP P&L follows EB §4.3: a realistic agent class is included only if its total over the period is negative for the LP.
- I apply the same rule to the latency agent: a latency charge > 0 is clamped to 0.
- D\* is the smallest noise turnover per day with a one-sided 95% moving-block-bootstrap (4-week blocks) lower bound of the mean weekly LP return > 0.
- "D\* incl. latency SE" additionally draws the per-market latency charge from its listing-clustered sampling distribution in each bootstrap replicate.
- Paired CIs use **common bootstrap indices** for both kernels, plus the paired per-market latency difference, which has its own listing-clustered SE.
- Vault numbers use EB's convention of 1% NAV per market.

Scripts: `kc_run.py` (1-minute replay), `kc_lat.py` / `kc_latx.py` (1-second latency), `kc_an.py` (D\*, E3, E4, pairs), `kc_calib.py` (calibration), `kc_diag.py` (per-year and per-agent).

---

## 2. (a) One day: N(d2) vs Student-t

### 2.1 Per-agent OOS LP P&L per market (B units; positive = LP gains; `attrib.txt`)

| Kernel | tail (ECDF) | iv (DVOL-t) | orv (clairvoyant σ, stress) | dir | noise per unit η |
|---|---|---|---|---|---|
| N(d2) | +0.0300 | +0.0409 | −0.2714 | +0.0138 | +0.0213 |
| t4 | **−0.0107** | +0.1054 | −0.1962 | +0.0084 | +0.0215 |
| t5 | +0.0036 | +0.0846 | −0.2194 | +0.0108 | +0.0218 |
| t6 | +0.0083 | +0.1020 | −0.2368 | +0.0118 | +0.0217 |

- No realistic agent extracts from N(d2), t5 or t6 over OOS.
- The tail adversary extracts from t4. Its weekly swings are ±20% NAV, which is why t4 fails E4.
- The only kernel-dependent loss is to the clairvoyant-σ stress agent. The fatter the kernel, the less it loses.

### 2.2 D\*, E3 and E4, OOS 2024-01..2026-09 (`an_1440.txt`)

**L1, 12 s blocks.** The latency charge is per market, from the same configuration and kernel.

| Kernel | latency (B/mkt) | D\* /day | D\* incl. latency SE | D\*_stress | edge D=2 | E3 lo95 D=2 (incl. lat. SE) | E4 D=2: CVaR95 / CVaR99 / maxDD | edge D=5 | E3 lo95 D=5 | E4 D=5: CVaR95 / CVaR99 / maxDD |
|---|---|---|---|---|---|---|---|---|---|---|
| **N(d2)** | −0.0030 ± 0.017 | **0.18** | 1.45 | 14.70 | +0.0396 | **+91.6%** (+28.0%) | 0.20 / 0.71 / 0.8% | +0.1034 | +240% | 0.28 / 1.57 / 1.7% |
| t4 | −0.0068 ± 0.018 | 1.70 | 2.43 | 11.60 | +0.0255 | +17.4% (−21.4%) | **10.1 / 16.0 / 44.3% FAIL** | +0.0900 | +181% | **8.0 / 12.9 / 20.2% FAIL** |
| **t5** | −0.0043 ± 0.018 | **0.23** | 1.60 | 11.65 | +0.0392 | **+92.9%** (+26.9%) | −0.15 / −0.01 / 0.0% | +0.1046 | +249% | −0.70 / −0.35 / 0.0% |
| t6 | −0.0033 ± 0.018 | 0.18 | 1.50 | 12.40 | +0.0401 | +96.3% (+30.2%) | −0.32 / 0.03 / 0.3% | +0.1053 | +253% | −1.04 / −0.16 / 0.4% |

A negative CVaR means the worst 5% (or 1%) of weeks were still profitable.

**L2, 2 s blocks.**
- The latency agent loses money for every kernel, so the charge is clamped to 0.
- D\* is at the grid floor (0.03) for N, t5 and t6, and 1.38 for t4.
- D\*_stress is 14.55 (N), 11.45 (t5), 12.20 (t6) and 11.25 (t4).

**IS (2021–2023), L1.**
- D\* is 0.15 (N), 0.35 (t4), 0.23 (t5) and 0.18 (t6).
- D\*_stress is 13.8, 10.9, 11.95 and 12.65.

### 2.3 Paired differences, N(d2) − t

Common bootstrap indices; latency difference propagated; OOS unless marked.

| Pair | Chain | Δ edge at D=2 (B/mkt) | Δ vault at D=2 (%/yr) | Δ edge at D=5 | Δ break-even η₀ | Δ stress break-even | Δ latency (B/mkt) |
|---|---|---|---|---|---|---|---|
| N − t5 | L1 | **+0.0003 [−0.0079, +0.0116]** | +0.8 [−20.1, +29.6] | −0.0012 [−0.0173, +0.0163] | −0.06 [−0.50, +0.15] | **+2.65 [+0.33, +4.82]** | +0.0013 ± 0.0048 |
| N − t5 | L2 | −0.0010 [−0.0064, +0.0077] | −2.6 [−16.3, +19.5] | — | +0.00 [−0.33, 0.00] | +2.68 [+0.40, +4.85] | +0.0005 ± 0.0041 |
| N − t5 | L1, IS | +0.0019 [−0.0050, +0.0121] | +4.9 [−12.7, +30.6] | — | −0.07 [−0.52, +0.14] | +1.45 [−0.50, +3.34] | — |
| N − t6 | L1 | −0.0006 [−0.0075, +0.0083] | −1.5 [−19.1, +21.2] | −0.0019 [−0.0154, +0.0120] | −0.00 [−0.34, +0.15] | +1.89 [−0.05, +3.82] | +0.0003 ± 0.0038 |
| N − t4 | L1 | +0.0141 [−0.0138, +0.0393] | +35.7 [−35.2, +100] | +0.0134 [−0.0159, +0.0391] | −0.62 [−1.87, +0.63] | +3.07 [+0.66, +5.41] | +0.0038 ± 0.0065 |

Reading:
- The N − t5 and N − t6 differences on D\*, E3 and E4 are statistically zero, with CIs about ±0.01 B/market (±25%/yr of vault return).
- The one significant difference is the stress break-even. With perfect foresight of realized variance, an adversary needs ≈ 2.7 extra noise turnovers per day to be absorbed when the hook is normal.

### 2.4 Calendar years: E4's "no negative year"

Setup: conservative rule applied *per year* (an agent shows up in a year it wins), L1 latency charged (`an_1440.txt`, `kc_diag.py`).

| Kernel | D = 2 | D = 5 |
|---|---|---|
| N(d2) | 2021 +93%, **2022 −73%, 2023 −130%**, 2024 +102%, **2025 −35%**, 2026 +110% | all positive; lowest 2023 +49% |
| t5 | 2021 +79%, **2022 −79%**, 2023 +95%, 2024 +88%, 2025 +30%, 2026 +104% | all positive; lowest 2022 +75% |
| t6 | **2022 −73%**, others positive | all positive |
| t4 | **2022 −36%**, others positive | all positive |

- At D = 2 **both N(d2) and t5 fail** "no negative calendar year". At D = 5 both pass.
- The kernel-specific year is **2023**, a low-vol year: the DVOL-t agent took −0.097 B/market from N(d2) and −0.010 from t5.
- 2025 is mixed: N lost to both tail and iv, t5 only to tail.
- This is the one place the fat tail visibly helps at 1 d, and it is a regime, not a mean effect. It is subsumed by declaring D_decl ≥ 5 or by the stress disclosure (E5).

### 2.5 Calibration under P, paired (`kc_calib.py`, `calib.txt`)

Setup: all 7 strikes per listing, mid in [0.02, 0.98], week-block bootstrap. "ΔLL" is log-loss(N) − log-loss(t); negative means N is better.

| Tenor, σ | Period | N: LL / ECE / worst bin | t4 | t5 (or t_fit) | t6 | ΔLL N − t4 | ΔLL N − t5 (t_fit) |
|---|---|---|---|---|---|---|---|
| 1 d, EWMA 1 d | OOS | 0.4682 / 2.05 / 4.5 pp | 0.4706 / 2.62 / 5.5 | 0.4689 / 2.17 / 5.0 | 0.4683 / 2.03 / 4.8 | **−0.0025 [−0.0046, −0.0002]** | −0.0007 [−0.0023, +0.0008] |
| 1 d | IS | 0.4836 / 1.73 / 4.0 | 0.4882 / 3.33 / 6.2 | 0.4859 / 2.63 / 5.0 | 0.4849 / 2.31 / 4.4 | **−0.0046 [−0.0078, −0.0013]** | −0.0023 [−0.0044, +0.0001] |
| 4 h, EWMA 4 h + seas | OOS | 0.4660 / 2.20 / 4.0 | 0.4666 / 2.01 / 3.0 | 0.4671 / 2.25 / 3.1 (ν = 3.8) | — | −0.0006 [−0.0018, +0.0006] | −0.0012 [−0.0025, +0.0003] |
| 1 h, EWMA 4 h + seas | OOS | 0.4550 / 2.39 / **5.1** | 0.4535 / 1.25 / 2.1 | 0.4546 / 1.90 / 2.7 (ν = 3.5) | — | **+0.0016 [+0.0006, +0.0025]** | +0.0004 [−0.0008, +0.0016] |
| 1 h | IS | 0.4429 / 2.75 / 5.4 | 0.4397 / 0.85 / 1.7 | 0.4405 / 1.45 / 2.6 | — | **+0.0031 [+0.0013, +0.0053]** | +0.0024 [+0.0001, +0.0054] |

- At 1 d the normal kernel is the best-calibrated candidate, and t4 is significantly worse.
- This agrees with EB's own `out/calib.txt` (1 d, EWMA 1 d, OOS 2024–26): N LL 0.4766 / ECE 1.70 vs t LL 0.4785 / ECE 2.24.
- It also agrees with the walk-forward ν fits rising with horizon: 3.5 at 1 h, 3.8 at 4 h, ≈ 5.2 at 1 d (EB `bt.py:18`). Aggregation pushes the τ-horizon law toward normal.
- At 1 h, t4 is significantly better calibrated than N and than the fitted ν = 3.5.

**Kernel gap in probability units** (variance-matched, `out_math_t.txt` §1):

| Pair | max \|ΔF\| | at d ≈ |
|---|---|---|
| Φ vs t5 | 3.82 pp | ±0.69 |
| Φ vs t4 | 5.29 pp | ±0.69 |
| Φ vs t6 | 2.99 pp | ±0.69 |
| t3.5 vs t4 | 1.29 pp | ±0.6 |
| t3.8 vs t4 | 0.45 pp | ±0.6 |

All kernel gaps sit below a 2% half-spread plus agent margin except where they matter: 1 h, for which N's worst bin is 5 pp.

---

## 3. Sub-day check: does a normal kernel really fail at 1 h and 4 h?

### 3.1 The EB claim and what it compared

EB §7 lists "a normal kernel at ≤ 4 h" as outside the viable region. The evidence was stage A (EB §6.2), where *naive* normal meant EWMA 1 d, no seasonality, s = 1%, λB = 0.05, compared against t + seasonality with EWMA 4 h.

EB's own stage-A table (`economic-backtest/out/expA_1h.txt`, `expA_4h.txt`) already shows the normal kernel reaching the D\* floor under the good σ policy:

| Tenor | Configuration | D\* IS / OOS (η per market) |
|---|---|---|
| 4 h | normal + seas, EWMA 4 h | **0.30 / 0.30** (floor) |
| 1 h | normal + seas, EWMA 4 h | 8.4 / **1.2** (floor OOS) |

So the "failure" was σ, not Φ.

### 3.2 Paired re-run at the selected s = 2%, λB = 0.1 (`an_60.txt`, `an_240.txt`)

D is converted as D/day = η × 1440/tenor.

| Tenor, chain | Kernel | latency (B/mkt) | D\* /day | D\*_stress /day | orv P&L (B/mkt) |
|---|---|---|---|---|---|
| 4 h, L1 | **N** | −0.0029 | **0.7** | 39 | −0.163 |
| | t (ν = 3.8) | −0.0179 | 4.1 | 24 | −0.084 |
| | t4 | −0.0164 | 3.9 | 25 | −0.088 |
| 4 h, L2 | N / t3.8 / t4 | 0 / −0.0084 / −0.0066 | floor / 2.0 / 1.7 | 38 / 22 / 23 | — |
| 1 h, L1 | **N** | +0.009 (clamped to 0) | **floor (≤ 0.7)** | 94 | −0.139 |
| | t (ν = 3.5) | −0.0178 | 12 (= EB's 12) | 48 | −0.053 |
| | t4 | −0.0127 | 8.4 | 54 | −0.066 |
| 1 h, L2 | N / t3.5 / t4 | 0 / −0.0163 / −0.0069 | floor / 10.8 / 4.8 | 94 / 48 / 50 | — |

Paired N − t_fit edge at η = 2 per market, L1:

| Tenor | Δ edge (B/mkt) | Δ latency (B/mkt) | Δ stress break-even |
|---|---|---|---|
| 4 h | +0.0140 [+0.0056, +0.0224] | +0.0150 ± 0.0043 | +2.40 [+1.97, +2.82] η, i.e. +14/day |
| 1 h | +0.0176 [+0.0122, +0.0232] | +0.0178 ± 0.0028 | +1.80 [+1.59, +2.02] η, i.e. +43/day |

IS gives the same signs.

- At the 1-minute scale no realistic agent extracts from any kernel. The tail and iv agents lose to all of them.
- The whole realistic difference is the latency cost, which is higher for the t kernel because of its taller centre (larger Δ at the money).
- The whole stress difference favours t.

### 3.3 Is N's latency advantage an artifact of the latency agent believing the hook's model?

At 1 h, the own-model latency arbitrageur *loses* against N (+0.009 B/market). An arbitrageur that believes N at the fresh CEX price is wrong about near-expiry tails.

`kc_latx.py` tests cross-belief arbitrageurs (a normal hook vs a t-believing arbitrageur, and the reverse). Every cross combination is LP-positive:

| Tenor | N hook vs t-belief arbitrageur | t hook vs N-belief arbitrageur |
|---|---|---|
| 1 h | +0.006 ± 0.014 | +0.045 |
| 4 h | +0.038 ± 0.047 | +0.032 |
| 1 d | +0.045 ± 0.128 | +0.021 |

So the own-model arbitrageur is the binding latency adversary among those tested.

A fully informed "latency + ECDF-tail" agent was **not** built (UNVERIFIED). The 5 pp calibration bin of N at 1 h is larger than s + margin = 2.5 pp, which is a standing warning that such an agent may exist.

**Verdict for ≤ 4 h.**
- Economics against the modeled adversaries is a tie or favours N.
- Calibration (1 h) and vol-foresight robustness (1 h and 4 h) favour t4.
- Neither is proven. Sub-day stays research. If it ships, use t4: best calibrated, algebraic, and a smaller latency penalty than t3.5.

---

## 4. (b) On-chain Student-t CDF

### 4.1 Closed forms in the BS argument d

Let d = (ln(S/K) − w/2)/√w, the same d2 the BS path already computes (03 §5; QF §2), and c_ν = √((ν−2)/ν).

The variance-matched kernel is F_ν(d) = T_ν(d/c_ν), where T_ν is the Student-t CDF. With t = d/c_ν:

  t/√(t² + ν) = d/√(d² + ν − 2),  and  1 − t²/(t²+ν) = (ν−2)/(d² + ν − 2).

So no √(ν/(ν−2)) constant survives.

The textbook even-ν series F = ½ + (α/2)·Σ_{k<ν/2} [C(2k,k)/4^k]·(1−α²)^k, with α = t/√(t²+ν), and the odd-ν form F = ½ + (1/π)[θ + sinθ·Σ …], with θ = atan(t/√ν), give:

| ν | CDF F_ν(d) | density f_ν(d) | f(0) | tail 1 − F |
|---|---|---|---|---|
| 3 | ½ + [atan d + d/(d²+1)]/π | 2/(π(d²+1)²) | 0.637 | 2/(3π)·d⁻³ |
| **4** | **½ + d(d²+3)/(2(d²+2)^{3/2})** | **3/(d²+2)^{5/2}** | 0.530 | ¾·d⁻⁴ |
| 5 | ½ + [atan(d/√3) + √3·d(y+2)/y²]/π, y = d²+3 | 24√3/(π y³) | 0.490 | (24√3/5π)·d⁻⁵ |
| 6 | ½ + d(1 + 2/y + 6/y²)/(2√y), y = d²+4 | 60/y^{7/2} | 0.469 | 10·d⁻⁶ |
| ∞ | Φ(d) | φ(d) | 0.399 | — |

**Checks.** `derive.py` (sympy) shows for each ν that dF/dd equals the variance-matched t density exactly, and that F(0) = ½.

**The ν = 4 form in the gap statement.** In raw t, the exact form is F = ½ + **t/(2√(t²+4))**·(1 + 2/(t²+4)). The stated form, without the ½, tends to 3/2.

**Log-density slope** (used in §5): f′/f = −(ν+1)d/(ν−2+d²).

**ν = 3.5.** T_{3.5}(t) = 1 − ½·I_{ν/(ν+t²)}(1.75, ½), the regularized incomplete beta. That needs a continued fraction or series with `lnWad`/`expWad` for x^a(1−x)^b and a constant Γ ratio. I did not implement it (gas UNVERIFIED; my estimate is several thousand gas). It is not needed: t4 calibrates at least as well at 1 h (§2.5), and ‖F_3.5 − F_4‖∞ = 1.29 pp.

### 4.2 Implementation (`$K/solidity/src/StudentTCdf.sol`)

**Primitives.** Solady `FixedPointMathLib.sqrt` (`repos/solady/src/utils/FixedPointMathLib.sol:778`) and `fullMulDiv` (`:460`), Solady v0.1.26 at commit `2afba69`. Solady and PRB-math have **no** trigonometric functions: I grepped both for `atan`/`arctan` and found none. So ν = 5 uses a custom `atan36`:
- argument reduction a > 1 → π/2 − atan(1/a);
- then b > tan 15° → π/6 + atan((b√3 − 1)/(b + √3)), giving |c| ≤ 0.268;
- then a 15-term Taylor series at 1e36 scale, with truncation < 0.268³¹/31 = 8.6e-20.

**Structure.**
- Every CDF is ½ ± g(|d|), with g floored, so **F(d) + F(−d) = 10¹⁸ exactly**.
- Intermediates are kept at 1e36. The `hp` variants take the square root at 1e27 (`sqrt(Y·1e18)`) so that the only WAD rounding is the final floor.
- Saturation happens where the true tail falls below ≈ 0.5 wei: |d| ≥ 34,000 (ν = 4), 5,500 (ν = 5), 1,600 (ν = 6). A first version saturated at 10⁶; there the floored-sqrt bias could round g up to exactly ½ while the true tail was < 1e-15 wei, and fuzzing found a 1-wei reversal at d ≈ −5.7e5. Moving saturation to the ≈ 0.5-wei point removes it (edge dump in `forge_out.txt`).
- The ν = 4 kernel is **5 lines**:

```solidity
uint256 Y   = u*u + 2e36;                           // (d²+2)·1e36, u = |d| in WAD
uint256 v   = fullMulDiv(u*1e18, Y + 1e36, Y);      // d(1 + 1/y)      at 1e36
uint256 s27 = sqrt(Y * 1e18);                       // √y              at 1e27
uint256 g   = fullMulDiv(v, 1e9, 2*s27);            // d(y+1)/(2y√y)   in WAD
return d < 0 ? 5e17 - g : 5e17 + g;
```

### 4.3 Accuracy, gas, symmetry, monotonicity (`$K/solidity/forge_out.txt`)

**Setup.**
- forge 1.8.3, solc 0.8.26, `evm_version = cancun` (no CLZ needed), optimizer 10,000 runs.
- 29,306 vectors:
  - a 1e-3 grid on [−12, 12];
  - 4,000 random wei-level points on [−50, 50];
  - 800 log-spaced points out to |d| = 2e6;
  - 500 points in |d| ≤ 1e-3.
- Reference: mpmath at 60 digits via the regularized incomplete beta (`gen.py`), independent of the closed forms.
- Gas is net of the 2,330-gas harness, which includes a cold `SLOAD` of the vector. Hart Φ is measured on the same harness for comparison.

| Function | Max \|error\| | Gas avg / max | Adjacent-wei scan, 800k pairs on [−12, 12] | 1e-4 grid, 240k steps | Fuzz, 100k: monotone, symmetric |
|---|---|---|---|---|---|
| Hart/West Φ (03 §4) | 4.20e-17 | 685 / 976 | 0 violations | — | — |
| `cdf4` (WAD sqrt) | 1.00e-18 | 714 / 1,076 | 1,185 one-wei reversals | 0 | pass |
| **`cdf4hp`** | **1.00e-18** | **829 / 1,192** | **0** (also 0 on [−4e4, 4e4]) | — | pass |
| **`cdf5`** (atan) | **1.01e-18** | **1,390 / 1,726** | **0** (also 0 on [−6e3, 6e3]) | 0 | pass |
| `cdf6` (WAD sqrt) | 1.00e-18 | 774 / 803 | 2,781 one-wei reversals | 0 | pass |
| **`cdf6hp`** | **1.00e-18** | **814 / 844** | **0** (also 0 on [−2e3, 2e3]) | — | pass |
| `pdf4` / `pdf5` / `pdf6` | ≤ 1.0e-18 | 576 / 368 / 621 avg | — | — | — |

- Absolute gas is not comparable with 03 §0's "≈ 900 gas" for Hart, which used a different harness. The ratios on one harness are the meaningful comparison: t4 costs ≈ 1.2× Hart and t5 ≈ 2×.
- Replacing Φ by F₄ in the pool path (03 §5: ≈ 2.2k gas end to end) adds ≈ 150 gas.
- The error is ≈ 1 wei, 40× below Hart and far below the 1e-12 target of 03 §0.

**What is proven vs tested.**
- **Proven:** symmetry is exact by construction, and F is monotone in exact arithmetic (F′ = f > 0).
- **Tested only:** fixed-point monotonicity, as for Hart (05 §2.2, QF E4). The `hp` variants remove the only observed reversal mechanism, the floored WAD sqrt. A proof that `fullMulDiv(v, 1e9, 2·s27)` never reverses is not attempted. Its residual risk is a 1-wei step where two floors interact at a ≈ 1e-9-wei margin.

---

## 5. (c) Which proven properties survive a t kernel

| Property (source) | Normal N(d2) | Student-t kernel | Status under t |
|---|---|---|---|
| Parity `bid_Y + bid_N ≤ 1 ≤ ask_Y + ask_N`, integer form (QF §5 E1) | holds | holds | **Unchanged.** NO quotes are defined as mirrors of YES quotes (a, b), so the proof never uses the kernel. |
| Round trips lose ≥ 2h₀q (E2); path independence / no split (Lemma A, Theorem N); floor-`isqrt` exactness (Lemma S) | hold | hold | **Unchanged.** All are statements about the amount quadratic given (a, b, λ, I). |
| Per-epoch extraction ≤ ((\|F − P_sob\| − h₀)⁺)²/(2λ) (Theorem L) | holds | holds | **Unchanged per epoch.** |
| Sum over epochs ≈ ℓ·P₀(1−P₀)/2 via martingale QV (QF Theorem L; 05 §4.5) | theorem under GBM: Φ(d2(S_t, τ)) is the Q-martingale | no standard model makes F_ν(d(S_t, τ)) a martingale | **Becomes an assumption.** It holds only if the kernel is the true conditional probability. |
| Gamma spread `k·φ(d)`, k = c_Δ·γ_S/√w (QF §2, §4) | φ | f_ν (closed forms §4.1, 370–620 gas) | **Survives with φ → f_ν**, since h_Δ = γ_S·∂P/∂x = γ_S·f_ν(d)/√w. EB's engine used t-mid with a φ-spread (`engine.py:156`), which is inconsistent. |
| Lemma M: band-halt monotonicity for any k (QF §5) | Mills: 1 − Φ(d) < φ(d)/d | Mills fails: (1 − F)/f ≈ d/ν grows (2.5 at d = 10 and 12.5 at d = 50 for ν = 4) | **Replaced by an easier global lemma for k ≤ k\*_ν**, and numeric-only beyond (§5.1). |
| On-chain CDF monotone (QF E4 condition 2) | Hart fuzz-monotone | hp/atan variants: 0 violations | **Same status (tested only), better margins.** |
| M4: calibration under Q with synthetic GBM (EB §1.1) | exact by construction | no Q exists (§5.2) | **Lost as a Q theorem.** Restate under P or a σ-uncertainty generator. |
| Discrete geometric-Asian closed form (SR §0, §4.4; 05 §6) | exact (Kemna–Vorst digital) | no closed form; scale-mixture analogue has error ≤ 0.46 pp (§5.3) | **Approximate only; model-dependent.** |

### 5.1 Lemma M_t (Student-t band monotonicity)

For g⁺(d) = F_ν(d) + k·f_ν(d):

  g⁺′(d) = f_ν(d)·[1 − k(ν+1)d/(ν − 2 + d²)].

The bracket's minimum over d is attained at d = √(ν−2), where (ν+1)d/(ν−2+d²) reaches its maximum (ν+1)/(2√(ν−2)).

**Lemma M_t.** If k ≤ k\*_ν := 2√(ν−2)/(ν+1), then g⁺ is non-decreasing on ℝ. Symmetrically, g⁻ = F − k·f is non-decreasing. So the quote is monotone in S **with no band, cutoff or Mills argument**.

| ν | 3.5 | 4 | 5 | 6 |
|---|---|---|---|---|
| k\*_ν | 0.544 | 0.566 | 0.577 | 0.571 |
| k\*·f_ν(0) (largest centre gamma term covered) | 0.309 | 0.300 | 0.283 | 0.268 |

- QF §4 already halts when k·f(0) > h_Δ,max. Any h_Δ,max ≤ 0.268 therefore puts every enabled quote under Lemma M_t, which is a complete analytic proof.
- For comparison, the normal g⁺′ = φ(1 − kd) has a decreasing branch for *every* k > 0, which is why QF needed Mills.
- For k > k\*, g⁺ rises, dips on [d₁, d₂] (the roots of d² − k(ν+1)d + ν − 2 = 0), then rises back to 1 from below. Monotonicity on the enabled set requires g⁺(d₂) ≥ 1 − p_min.
  - Numerically, min over k ∈ (k\*, 200] of g⁺(d₂) is 0.9926 (ν = 3.5), 0.9950 (ν = 4), 0.9976 (ν = 5) and 0.9988 (ν = 6).
  - So p_min = 0.02 suffices, and any p_min ≥ 0.0075 would too.
  - This part is numeric, not proven (`math_t.py` §2).
- **The EB engine's mixed spec** (t mid with a φ spread) is monotone for k ≤ 0.3. At k = 1 it dips on d ∈ [0.87, 3.37] with a minimum of 0.9969 (ν = 4), so the band still rescues it. Spec the consistent f_ν term anyway.

### 5.2 Why M4 and "Black–Scholes-priced" do not transfer

- If ln(S_T/S) has a Student-t law, E[S_T] = E[e^X] = ∞, because t has no moment-generating function. No risk-neutral measure with finite forward can have log-t marginals. Log-t option-pricing work, such as Cassidy, Hamp and Ouyed's "Gosset formula" (Physica A 389, 2010), has to confront this; I did not re-read how they handle it.
- The −w/2 centring in the t kernel is therefore a **median convention**, not a drift correction.
- t is not closed under convolution. If σ is uncertain but constant over the life (the Gaussian scale mixture that generates t), continuous observation reveals it through quadratic variation, and the fair conditional price collapses back to normal.
- So a t kernel is a **statistical forecast of P(S_T > K) under σ-forecast uncertainty**, not an arbitrage-free BS price.
- M4 must become a P-claim (EB E1), or use a synthetic generator σ_true = σ̂·√V with V ~ InvGamma(ν/2, (ν−2)/2) redrawn per quote horizon. Under that generator F_ν is exactly calibrated at quote time, but the price process is not a martingale.
- **The project could not honestly call a t-kernel market "Black–Scholes-priced".** At best: "BS-structured, fat-tailed probability kernel".

### 5.3 The discrete geometric-Asian formula under t

SR §0 settles on the w = 30 min, Δ = 12 s (n = 150) left-endpoint geometric TWAP and prices it with:
- μ = ln(S/K) − ½σ²a, with a = (τ − w) + (n−1)Δ/2;
- v = σ²[(τ − w) + Δ(n−1)(2n−1)/(6n)];
- YES = Φ(μ/√v).

That relies on the average of Gaussian increments being Gaussian.

**t-analogue under the scale mixture.** Conditional on V the path is GBM with variance σ²V, so the TWAP is conditionally Gaussian with mean ln(S/K) − ½Vσ²a and variance V·v. The exact price is E_V[Φ((x − ½Vσ²a)/√(Vv))], a 1-D integral with no closed form. Freezing the convexity term at V = 1 makes the mixture exactly variance-matched t:

  **YES_t ≈ F_ν^{vm}(μ/√v)**, with the same μ and v.

Error vs the exact mixture integral (quadrature, max over σ ∈ {0.3, 0.6, 1.0} and ±3 sd; `math_t.py` §4):

| Quote time | ν = 4 | ν = 5 | Asian vs European gap under t (the adjustment still matters) |
|---|---|---|---|
| 1 d at listing | 0.46 pp | 0.32 pp | 0.16 pp |
| 1 h market, 95 min out | 0.11 pp | 0.08 pp | 2.6 pp |
| At the cutoff (τ = w + 5 min) | 0.06 pp | 0.04 pp | 9.0 pp |

- The largest errors come from σ = 1.0 and from the heavy V tail (InvGamma(2, 1) has infinite variance at ν = 4).
- MC check (1 d, σ = 0.6, 400k paths): at z = −1.5, −0.5, +0.5, +1.5 the mixture MC gives 0.0523 / 0.2668 / 0.7227 / 0.9439, against the closed form's 0.0529 / 0.2662 / 0.7218 / 0.9443. That is within ≈ 1.7 SE.
- **Under iid variance-matched t increments per 12 s block**, the 7,200-step sum is essentially Gaussian by the CLT. The MC gives 0.0617 / 0.3011 / 0.6901 / 0.9304, which matches the *normal* Asian formula (0.0635 / 0.3018 / 0.6872 / 0.9325), not the t formula. There is no closed form in that model: the characteristic function is a product of Bessel-K terms.
- So the t-Asian "formula" is only as good as the scale-mixture story. The existing proof ("MC matches to 1 SE at f = 0", SR §4.4) would need to be redone per generator.

---

## 6. (d) Recommendation

**v1 claim: "Black–Scholes N(d2), 1-day tenor only".** Settlement uses the discrete geometric-Asian digital, which is the same lognormal model, with r = 0.

1. **Evidence.**
   - At 1 d, N(d2) vs t5/t6 is a statistical tie on D\* (0.18 vs 0.23/day, L1), E3 (+91.6% vs +92.9% 95% lower bound at D = 2) and E4. Paired CIs are ±0.01 B/market.
   - N(d2) is also the best-calibrated kernel at 1 d, and t4 is significantly worse on both calibration and E4.
   - The honest label "Black–Scholes-priced" is therefore available at no measured economic cost.
2. **What v1 gives up.**
   - About 2.7 turnovers/day of stress robustness (D\*_stress 14.7 vs 11.7) against a clairvoyant-vol adversary.
   - A worse 2023-type low-vol year at D = 2.
   - Disclose both under E5. Mitigate with D_decl ≥ 5, which makes every calendar year positive for N(d2), and with the spread, **not** a σ multiplier (EB §6.2).
3. **Proof programme unchanged for v1:** Hart Φ differential tests, Lemma M (Mills), the gamma spread with φ, the discrete Asian formula, and M4 under GBM, where N(d2) is exactly the Q-price.
4. **Sub-day (research, v2).** If 1 h / 4 h ship, use variance-matched **t with ν = 4** (`cdf4hp` + `pdf4`: 829 + 576 gas, ≤ 1e-18). The extra proof obligations:
   - (i) the Lemma M_t condition h_Δ,max ≤ 0.268 (or numeric band coverage for k > k\*);
   - (ii) the f₄ gamma spread;
   - (iii) calibration restated under P, or under the σ-uncertainty generator;
   - (iv) the t-Asian approximation error bound (≤ 0.11 pp at 1 h), validated per generator;
   - (v) the martingale-QV LVR total downgraded to an assumption.
   - First build the missing adversary: latency + ECDF-tail combined. N(d2)'s 5 pp calibration bin at 1 h exceeds s + margin.
5. **Corrections to propagate into EB:**
   - §6.5 and §7, 1 d row: the kernel is N(d2) (or "N or t5/t6, equivalent"), not "t (ν 5)".
   - Latency charge for λB = 0.1 with a 10% cutoff: ≈ −0.003 (N) / −0.004 (t5) B/market on L1, and ≈ 0 on L2.
   - D\* ≈ 0.2/day at the point estimate, ≈ 1.5/day with latency-sample uncertainty.
   - §6.1 decision 1 and §7 "outside the region": replace "normal kernel at ≤ 4 h" with "normal kernel with a naive σ policy at ≤ 4 h". Add that with a 4 h EWMA plus seasonality, normal ties or beats t against modeled adversaries but has 2× the stress exposure and worse 1 h calibration.

---

## 7. Verification

**Verified by running code** (outputs archived under `$K`):
- EB `expF` selected-configuration attributions reproduced exactly by `kc_run.py` at 1 d (t5), 1 h (t3.5) and 4 h (t3.8).
- EB §6.4 λB = 0.05 / 10%-cutoff latency (−0.0203) reproduced exactly by `kc_lat_lam.py`, then extended to λB = 0.07, 0.1 and 0.2.
- All D\*, E3, E4, paired-CI, per-year, stress and calibration numbers in §2–§3 (`an_*.txt`, `calib.txt`, `attrib.txt`, `lat*_*.log`).
- Closed forms for ν = 3, 4, 5, 6 checked symbolically (`derive.py`), and the missing-½ in the gap statement's ν = 4 formula confirmed (its limit is 3/2).
- Solidity accuracy (max error ≤ 1.01e-18 vs a 60-digit incomplete-beta reference), gas, exact symmetry (100k fuzz), and monotonicity (800k adjacent-wei scans × 3 ranges, a 240k-step grid, 100k random-pair fuzz), all 22 tests passing (`forge_out.txt`).
- The saturation-boundary bug was found by fuzzing and fixed.
- Solady has no `atan`/trig functions (grep of `repos/solady/src`, `repos/prb-math/src`).
- Lemma M_t thresholds and dip minima, mixed-spec behaviour, kernel gaps, and the t-Asian error by quadrature and MC (`out_math_t.txt`).

**Not verified / limitations:**
- (a) **The latency sample is short:** 116 days, 113 daily listings. The 1 d latency SE (≈ 0.017 B/market) dominates E3/D\* uncertainty. Paired kernel differences are tighter (±0.004–0.006).
- (b) **Adversary set:** a combined latency + tail-informed agent, a smile-aware agent and a jump agent were not built (EB §6.7's E7 Thales gate is still open). Every economic statement is "against the modeled adversaries".
- (c) The 1-minute engine keeps EB's inconsistent φ-based gamma term for t kernels (`engine.py:156`). With γ = 5 bp it is small against s = 2%, but I did not re-run with f_ν.
- (d) ν = 3.5 (incomplete beta): not implemented, gas UNVERIFIED.
- (e) Lemma M_t for k > k\* is numeric, not proved. Fixed-point monotonicity of the `hp` variants is tested, not proved.
- (f) The t-Asian error was evaluated only for the Gaussian scale-mixture and iid-t generators, not for GARCH-type clustering, which is the empirically relevant one.
- (g) Per-year E4 uses per-year conservative agent inclusion, which is stricter than EB `expF`'s full-sample inclusion. It is reported as such.
- (h) The Cassidy–Hamp–Ouyed (2010) paper was located by title only; I did not check how it handles E[S_T] = ∞ (UNVERIFIED). The divergence argument in §5.2 is my own and does not rely on it.
- (i) Selection effects: the 1 d configuration was chosen IS by EB with the t kernel. A normal-kernel IS selection could pick different (s, λ, cutoff). N(d2) is evaluated here on t's selected configuration, which, if anything, disadvantages N.

---

## Appendix: reproduction

Data and engine are from EB (`…/scratchpad/econ`, `data/eth1m.npz`, `data/s1/`, `out/arrays.pkl`). Run from `…/scratchpad/econ` with `uv run --with numpy --with scipy --with numba python <script>`.

| Step | Command | Output |
|---|---|---|
| 1-minute replay, per kernel | `kc_run.py 1440` / `60` / `240` | `kc/run_*.pkl` |
| 1-second latency, same configuration | `kc_lat.py 86400` / `3600` / `14400` | `kc/lat_*.pkl`, `.log` |
| Cross-belief latency | `kc_latx.py <tenor_s>` | `kc/latx_*.log` |
| λ sensitivity | `LAMX=0.05 kc_lat_lam.py` | `kc/latlam_*.pkl` |
| D\*, E3, E4, paired CIs | `kc_an.py 1440` / `240` / `60` | `kc/an_*.txt` |
| Calibration (paired) | `kc_calib.py` | `kc/calib.txt` |
| Per-year and per-agent | `kc_diag.py`, `kc_chk2.py` | stdout, `kc/attrib.txt` |
| Solidity | `cd …/scratchpad/tcdf; uv run --with mpmath python gen.py; forge test -vv` (forge 1.8.3, `../foundry-bin/solc-0.8.26`) | `forge_out.txt` |
| Symbolic derivation | `uv run --with sympy python derive.py` | stdout |
| Lemmas and Asian | `…/scratchpad/tmath/math_t.py` | `out_math_t.txt` |
