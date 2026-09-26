# Gap: economic acceptance criteria and a historical backtest of the whole mechanism

**Date:** 2026-09-26. **Scope:** define what "the BS-priced hook works" means as falsifiable claims, then test those claims on historical ETH data with an agent-based replay of the quote function and baseline mechanisms. **Status:** research result. Every number below comes from code I ran; nothing is copied from the earlier reports unless it is cited to them.

**Where things are.**

- `$E` = `docs/md/research/gaps/economic-backtest/`. It holds all scripts and raw outputs (`$E/out/*.txt`).
- Working copies and data are in the scratchpad at `…/scratchpad/econ/`. The 1-minute grid is `data/eth1m.npz`, 1-second klines are in `data/s1/`, and DVOL is in `data/dvol_1h.json`. The data are not copied into `docs/md/` because of size. `$E/fetch1m.sh`, `$E/f1s.sh`, `$E/build.py` and `$E/dvol.py` rebuild them.
- To run: `uv run --with numpy --with scipy --with numba [--with pandas --with mpmath] python <script>` from the econ directory.
- Earlier reports are cited as `04 §x` (`../04-prior-art-economics.md`) and `05 §x` (`../05-math-theory-proofs.md`).

---

## 0. Findings in brief

1. **Two kinds of claim, proven in different ways.**
   - *Mechanism correctness* can be proven unconditionally: solvency, conservation, quote fidelity, calibration under Q, the LVR formula, and manipulation bounds.
   - *Economic viability* (E[LP P&L] > 0) can only be proven **conditionally**: given a declared flow mix (noise turnover D), a declared adversary set, a chain/block time, and a tenor. The backtest's deliverable is therefore a **break-even frontier D\*** (§1, §7), not a yes/no answer.
2. **The naive design fails for sub-day tenors.** The naive design is normal BS, σ = 1-day-half-life EWMA of realized vol, s = 1%, no cutoff. At **1 h** it needs noise turnover of **67–86× the per-strike budget per day** just to break even against walk-forward "tail/IV-informed" traders (conservative accounting). With a 60 s stale oracle that becomes ~700×/day. At 4 h it needs 14–19×/day.
3. **Fat tails matter; seasonality alone does not fix sub-day tenors.** A variance-matched **Student-t kernel (ν ≈ 3.5–4)** with a **4 h-half-life σ̂** removes all measurable model-based extraction at 1 h and 4 h in the 1-minute simulation. Realistic adversaries then *lose* to the LP.
   - Out of sample (2024-01..2026-09), the t-kernel cuts the 1 h calibration error from ±4–6 pp to ≤ 1.1 pp.
   - Gram–Charlier is unusable: calibration errors of 5–30 pp.
   - A **vol premium (σ×1.1–1.25) or using DVOL as σ is harmful.** It over-prices the wings, and informed flow sells them: at 1 h, D\* rises from 67 to 180–336/day.
4. **Latency, not tails, is the binding cost once the kernel is right.** Measured on 116 days of Binance 1 s data with a start-of-block oracle and 5 bp pool:
   - On **L1 (12 s blocks)** the LP loses 0.02–0.07 B per market to a CEX-leading arbitrageur (B = per-market loss budget).
   - On **L2 (2 s blocks)** the loss is 0.003–0.03 B.
   - Impact that **decays** over time is 1.5–3× worse than impact that **resets each block**. This confirms 05 §9 Q4: persistent skew lets arbitrageurs extract twice.
   - The real v3 5 bp pool lags Binance: correlation of 12 s returns is 0.54 contemporaneous, 0.26 at +12 s and 0.16 at +24 s. The start-of-block oracle error has an SD of 4.9 bp at 12 s age.
5. **Viable region with IS-frozen parameters, OOS 2024-01..2026-09, L1 latency charged.**

   | Tenor | Selected configuration | Result |
   |---|---|---|
   | **1 d** | t-kernel, s = 2%, λB = 0.1, 10% cutoff | **D\* ≈ 1.3–1.4 budget-turnovers/day**. At D = 2/day: edge +0.014 B/market, vault +36%/yr with 95% CI lower bound +29% (1% NAV per market), weekly CVaR95 1.1%, max DD 2.9%. At D = 5: every calendar year 2021–2026 positive; 2022-06 stress week −1.5%. |
   | **4 h** | same family | D\* ≈ 5–6/day |
   | **1 h** | same family | D\* ≈ 12/day on L1; ≈ 3.4/day on L2 |
   | **7 d** | — | Fragile: implied-vol-informed flow extracts 0.13–0.18 B/market OOS when a cutoff is used, and 2023 is negative at D = 5. |

6. **The LP cannot survive vol foresight.** A clairvoyant agent that knows future realized variance raises D\* to ~12/day (1 d), ~25–37/day (4 h / 1 h) even for the best configuration. So the economic claim is explicitly conditional on "no counterparty forecasts realized vol materially better than DVOL or a walk-forward ECDF". A backtest cannot prove that.
7. **Reserve-based baselines lose an order of magnitude more.** On identical markets and agents, a single informed agent class takes **27–29% (LMSR), 39–45% (dynamic pm-AMM) and 55–62% (CPMM/FPMM)** of pool value per market, at 1 d and 1 h alike. The pm-AMM figure is consistent with its theoretical LVR of V₀/2 (04 §4.3), minus fees. The hook's realistic extraction is ≈ 0 against the same agents. Thales-style odds (driftless, DVOL, 3% spread, skew) lose 0.013 B per 1 d market and 0.053 B per 1 h market to tail flow.
8. **Reality check failed, and this is a caveat.** Our simulator says a Thales-style 7 d book loses almost nothing to modeled informed flow (−0.002 B/market), yet the real Thales LP lost 13.9% (04 §1.6). The modeled adversary set is therefore **weaker than reality** for weekly and jump regimes. I propose a mandatory "Thales replay" gate (E7) before any economic claim is published.
9. **History has limited statistical power.**
   - With 143 OOS weeks, the smallest weekly mean detectable (α = 5% one-sided, power 80%) is 0.46% NAV/week at 1 d, i.e. ≈ 0.009 B per market.
   - Historical calibration can certify ≤ 2.5 pp bins only at 1 h (~2,400 quotes per bin). At 1 d (~100 per bin) and 7 d (~14 per bin) it certifies nothing finer than about 12 pp and 33 pp.
   - Synthetic Monte Carlo is therefore required for M-claims, and history is used for E-claims.
10. **How the Python simulation links to Foundry.**
    - *JSON vectors* (deterministic, in CI). 2,400 generated as a sample.
    - *`vm.ffi` differential fuzzing* (nightly, opt-in).
    - *Trade-tape replay* of historical and synthetic weeks through the real PoolManager and router, asserting per-market LP P&L equality to ≤ 1 wei per trade.
    - Statistical claims stay in Python. Foundry proves that Python's accounting *is* the contract's accounting.

---

## 1. What is claimed, and the pass/fail thresholds

### 1.1 Mechanism claims (M): unconditional, must all pass

| ID | Claim | Test | Pass threshold | Status here |
|---|---|---|---|---|
| M1 | Solvency / budget: vault USDC ≥ outstanding complete sets; per-market LP loss ≤ B_m | Foundry stateful invariants + every replay tape; Python engine assertion | 0 violations in ≥ 10⁶ fuzz calls and all tapes; min over markets of LP P&L ≥ −B exactly | Engine: min market P&L = **−1.0000 B** in every run, after fixing the budget check to an exact quadratic solve (`engine.py:95,107`). On-chain: pending |
| M2 | Conservation: flash-accounting deltas net to 0; Python P&L = on-chain P&L | Tape replay (§9) | \|ΔP&L\| ≤ 1 wei × #trades per market | pending (spec in §9) |
| M3 | Quote fidelity | `quote_vectors.json` + ffi fuzz; 05 §2 properties | \|mid − mpmath\| ≤ 1e-12 absolute; bid ≤ mid ≤ ask; ask_Y + ask_N ≥ 1 ≥ bid_Y + bid_N exactly; 0 monotonicity violations in ≥ 10⁵ pairs | vectors generated (2,400) |
| M4 | Calibration under Q (synthetic GBM) | 05 §7.1 | HL (df = 10) p > 0.01, \|Z\| < 2.58, \|CITL\| < 2.58, deciles within 3 SE, n ≥ 200k; power check must reject σ misspecification | 05 (done in Python) |
| M5 | Simulator correctness (makes E-claims trustworthy) | `validate.py`, `validate2.py` | latency loss = semi-analytic `Σ E[((\|gap\|−s−m)⁺)²]/(2λ) + m·E[q]` within 3 SE; noise P&L = spread × volume; uninformed agents non-extractive under GBM | **PASS**: −1.6194 ± 0.027 vs 1.6199 ± 0.007 (0.02 SE); tail and directional agents under GBM give +0.006 ± 0.005 and +0.007 ± 0.001 B to the LP |
| M6 | Manipulation bound | Fork test (05 §4.7, 06) | attack profit ≤ 0 for per-block size ≤ q_safe(τ) | pending |

### 1.2 Economic claims (E): conditional on a declared regime

**A claim is always stated as:** "For tenor T, chain block time Δ, flow mix (noise turnover D_decl per day per unit of budget, plus the modeled adversary set), and parameters frozen in-sample, the following holds out of sample."

| ID | Claim | Pass threshold (declared regime) |
|---|---|---|
| E1 | Economic calibration under P | OOS walk-forward: expected calibration error (ECE) ≤ s (base half-spread), and no decile with \|freq − p̄\| > s + 3 SE. HL is reported but not required when n > 10⁴, because it detects economically irrelevant errors (§6.1). |
| E2 | Bounded informed extraction | D\*_real ≤ D_decl. D\*_real is the break-even noise turnover under conservative accounting (§4.3), including the sub-minute latency charge for the target chain. |
| E3 | LP profitable at 95% | One-sided 95% moving-block-bootstrap (4-week blocks) lower bound of the mean weekly LP return > 0 on OOS, at D_decl. |
| E4 | Tail risk (per-market budget 1% of NAV) | Weekly CVaR95 ≤ 2% NAV, CVaR99 ≤ 4%, max drawdown ≤ 10% NAV (Thales' 22.8% is the failing reference), no negative calendar year |
| E5 | Stress disclosure | D\*_stress with the clairvoyant realized-vol agent must be published. The claim is qualified by "no counterparty has vol foresight beyond DVOL/ECDF". |
| E6 | Dominance | Hook LP P&L per market > CPMM, LMSR, dynamic pm-AMM and Thales-style at the same budget, agents and noise; paired CI > 0 |
| E7 | Simulator realism gate | Replay Thales' on-chain positional-market trades (Optimism) through the simulator's accounting and parameters. It must reproduce the **sign** and ±50% of the magnitude of Thales' realized LP P&L (−13.9%, 04 §1.6). If this fails, E2–E4 are downgraded to "against the modeled adversaries only". |

**What cannot be proven.**

- (i) That no better adversary exists. A backtest only lower-bounds adversarial skill.
- (ii) That D_decl noise volume will actually arrive. That is a market-adoption question.

Anchor for (ii), measured from the Polymarket Gamma API on 2026-09-25 (`pm.py`), with small samples so treat it as indicative:

- "Ethereum above ___ on <date>" (daily, 11 strikes): median **$366k per day per event**, top strike ≈ $60–180k.
- Hourly "Ethereum Up or Down": $18–32k per market (3 samples).
- 15-minute markets: median $3.4k. 5-minute markets: $0.8k.

With B = $20k per strike, the near-ATM daily volume corresponds to D ≈ 5–10 (in payout tokens). **UNVERIFIED** how much of this is uninformed.

---

## 2. Data

| Series | Source | Coverage | Checks |
|---|---|---|---|
| ETHUSDT 1 m closes | data.binance.vision monthly/daily zips | 2020-01-01 → 2026-09-24, 3,540,960 minutes | 2,326 missing minutes forward-filled; max gap 355 min; timestamps in µs from 2025 handled (`build.py`) |
| ETHUSDT 1 s closes | data.binance.vision | 2026-06-01 → 2026-09-24 (116 d) plus 2026-09-17..24 | realized vol (1 m sampled) 0.538 |
| ETH DVOL hourly | Deribit `get_volatility_index_data`, resolution 3600 | 2021-03-24 → 2026-09-25, 48,279 h | used with 1 h lag (candle close) |
| Uniswap v3 ETH/USDC 5 bp pool (`0x88e6…5640`) swaps | mainnet `eth_getLogs` (reused from 02's `v3_swaps.json`); block timestamps fetched (`blkts.py`) | 2026-09-18 → 25, 26,742 swap blocks | token0 = USDC, token1 = WETH; `ln P = ln 1e12 − tick·ln 1.0001` |
| Polymarket volumes | gamma-api.polymarket.com | Sep 2026 | §1.2 |

### 2.1 Pool vs CEX (`leadlag.py`, `out/leadlag.txt`)

**Lead–lag.** Correlation of 12 s pool log-returns with Binance 12 s returns shifted by L seconds (Binance earlier for L > 0):

| L (s) | −24 | −12 | 0 | +12 | +24 | +36 | +60 |
|---|---|---|---|---|---|---|---|
| corr | −0.007 | +0.082 | **+0.540** | +0.255 | +0.156 | +0.093 | +0.039 |

The CEX leads, and the pool absorbs moves over about 1–3 blocks.

**Basis.** Pool minus Binance(USDT): mean −1.36 bp (the USDC/USDT basis). De-meaned SD is 4.04 bp; |basis| > 5 bp in 21.9% of blocks and > 10 bp in 0.37%.

**Error of a start-of-block oracle vs the CEX, by oracle age:**

| Oracle age | 0 s | 2 s | 12 s | 60 s |
|---|---|---|---|---|
| Error SD | 3.80 bp | 3.92 bp | 4.92 bp | 8.26 bp |

This is γ_S for 04 §9.5's `h_Δ` term; 5 bp is a fair default on L1.

**Model check.** A "5 bp band follower of Binance" tracks the real pool with 2.34 bp error SD. This is the pool model used for the oracle and for settlement in the 6-year backtest (`lib.band_path`, `lib.py:15`).

---

## 3. The quote function that was replayed (exact)

This is the function every experiment uses (`engine.py:119` `run_hook`). All quantities are in units of the per-market budget B, and r = 0. **If the quote-function gap report settles on a different form, re-run `expA/B/F` with it.** The driver takes all of these as parameters (`bt.DEF`).

- **Oracle.** `S = pool log-price at the start of the step`. In the 1 m runs a step is one minute and lag is 0 (lag 1 = 60 s stale was also run). In the 1 s runs it is the start of the block, `pool[t − t mod Δ − 1]` (`engine.py:147`).
- **Volatility.**
  - σ̂ = EWMA of squared 5-minute pool log-returns with half-life H ∈ {4 h, 1 d, 3 d}, causal, annualized (`lib.ewma_sigma`).
  - Alternatively σ̂ = DVOL (lagged one hour).
  - σ_eff = clip(m·σ̂ + π, 0.30, 2.00), with m ∈ {1, 1.1, 1.25}.
- **Seasonality (optional).** Robust hour-of-day × weekday/weekend variance profile, estimated walk-forward on the prior 365 days (`lib.season_profile`). sd² = σ_eff²·τ·(1/τ)∫season.
- **Kernel.** Both use sd = σ_eff√τ.
  - `N(d2)`, with `d2 = (ln S/K − sd²/2)/sd`.
  - Variance-matched Student-t: `F_ν((ln S/K − sd²/2)/(sd·√((ν−2)/ν)))`, with ν = 3.5 (1 h), 3.8 (4 h), 5.0 (1 d, 7 d). ν comes from walk-forward MLE on EWMA-standardized returns (`calib.py`).
- **Half-spread.** `h = s + c_Δ·φ(d2)/sd·γ`, with γ = 5 bp and c_Δ = 1 (04 §9.5).
- **Price impact.**
  - Marginal ask for q more YES = `mid + h + λ(I + q)`; bid = `mid − h + λ(I − q)`.
  - I is the signed flow this step. It resets each step (or each block), or alternatively decays with half-life θ.
  - The YES and NO books share one I, because a NO buy is a YES sell at the bid.
  - Optional persistent skew `κ·(−Y_vault)/B` (Thales-style).
- **Gates.** No trading if mid ∉ [p_min, 1 − p_min] or τ < cutoff.
- **Budget.** The trade is truncated so the worst-case market loss `min(c, c + y) ≥ −B`. This is solved exactly as a quadratic in q (`engine.py:95,107`).
- **Settlement.** Pool (band) price at T > K. A snapshot, not the TWAP of 05 §6. Near-expiry results are therefore slightly optimistic for arbitrageurs that believe the CEX price (§6.4).
- **Markets.**
  - Strikes: 7 per listing at `K = S₀·exp(k·σ_ref√τ)`, k ∈ {−1.5, −1, −0.5, 0, 0.5, 1, 1.5}, with σ_ref = the 1 d EWMA. Strikes are identical across configurations, so comparisons are paired.
  - Listing: 1 h and 4 h back-to-back; 1 d daily at 08:00 UTC; 7 d daily in stage A (overlapping) and weekly in the 7 d sweeps.
  - Periods: in-sample (IS) expiries 2021-01..2023-12; out-of-sample (OOS) 2024-01..2026-09.

---

## 4. Agents, accounting and baselines

### 4.1 Agents

Each agent has a belief b and trades optimally against the linear-impact quote whenever `b − margin > ask` (or `b + margin < bid`). It trades up to the point where the marginal price equals b ∓ margin (`engine.py:88`).

| Agent | Belief | Margin / caps | Role |
|---|---|---|---|
| **lat** (latency, CEX-leading) | hook's own model evaluated at the *fresh Binance* price | 0.1 pp | stale-oracle arbitrage |
| **tail** (σ/tail-informed) | walk-forward empirical CDF of returns standardized by the *hook's own raw σ̂* and seasonality, demeaned (drift removed), by horizon bucket (2 min … 7 d), refit yearly on data before 1 Jan (`engine.py:14`) | 0.5 pp | knows the hook's inputs plus the real tails and intraday pattern |
| **iv** (options-informed) | Student-t, σ = DVOL, seasonal | 0.5 pp | an options desk |
| **orv** (stress bound, not realistic) | N(d2) with the *realized future* variance over [t, T] from 1 m CEX returns | 0.5 pp | clairvoyant vol |
| **dir** (directional crowd) | N(d2) shifted by half the trailing 24 h return, extrapolated | 0.5 pp; 0.02 B per step, 0.25 B position | momentum flow |
| **noise** | random YES/NO buy, ~20 trades per market spread uniformly over the trading window | pays the quote | separate ledger at unit intensity η = 1 (volume B per market), scaled linearly |

### 4.2 Why agents are simulated in isolation

In a joint run, agents with opposite beliefs trade against each other *through* the vault. Per-agent P&L then becomes meaningless: in one 1 d smoke run it was +11 B for one agent and −10 B for another. So each informed class is run **alone plus noise** (`bt.run`), and its LP P&L is well defined.

For reserve AMMs, noise and agents interact through reserves, so agent P&L = (agent + noise) − (noise only).

### 4.3 Conservative LP P&L and break-even

- **Conservative LP P&L** = η·noise + Σ over realistic classes {lat, tail, iv, dir} whose *total* P&L to the LP over the evaluation period is **negative**. An agent that loses money is assumed not to show up (`bt.lp_weekly`, `bt.py:89`).
- Summing isolated extractions is an upper bound on loss, because the budget is shared. For reserve AMMs I instead report the **largest single-agent** extraction, which is a lower bound on loss and so favors the baselines.
- **D\*** = the smallest daily noise turnover D = η·1440/tenor (noise volume per day ÷ per-strike budget) for which the one-sided 95% moving-block-bootstrap lower bound of the mean weekly LP return is > 0 (`bt.breakeven`).
- D\* has a floor at the first grid point: 1.2 (1 h), 0.3 (4 h), 0.05 (1 d), 0.01 (7 d). "At floor" means no realistic agent extracts.

### 4.4 Baselines (`engine.py:251` `run_amm`)

- **CPMM** (Gnosis FPMM): YES/NO reserves with `P = y/(x+y)`.
- **LMSR:** cost `b·ln(1 + e^{d/b})`.
- **Dynamic pm-AMM:** reserves `x = L(uP + φ(u) − u)` and `y = L(uP + φ(u))` with `u = Φ⁻¹(P)` (value `L·φ(u)`), and `L_t = L₀√((T−t)/T)`.

All three start at P₀ = BS mid with pool value = B, use fee = s, and face the same agents, which trade the price to `b/(1 ± fee)`. LP P&L is measured against holding the initial reserve bundle, which removes directional noise.

**Thales-style:** driftless odds `N(ln(S/K)/sd)`, σ = DVOL, s = 3%, persistent skew κ = 0.15, band [0.08, 0.92], 2% fee not paid to the LP, 24 h cutoff at 7 d (04 §1.3–1.4).

---

## 5. Validating the simulator (M5)

| Check | Result |
|---|---|
| Latency LVR vs semi-analytic (GBM σ = 0.6, 1 d ATM, s = 0.2%, 60 s stale, cutoff 60 min, 2,091 markets) | engine −1.6194 ± 0.0270 B vs formula 1.6199 ± 0.0071 (`validate2.py`). The margin term m·E[q] was required. |
| Budget invariant | min market LP P&L = −1.0000 B in every configuration after the exact-solve fix. Before the fix, iterative capping overshot to −1.48 B, so this bug would have invalidated risk numbers. |
| Uninformed agents under GBM | tail +0.0065 ± 0.0052 and directional +0.0072 ± 0.0008 B to the LP (they pay spread); noise earns ≈ h per unit volume (`validate.py`) |
| pm-AMM theory (04 §4.3: dynamic pm-AMM loses V₀/2 without fees) | 0.39–0.46 V₀ lost per market with a 1% fee (`expC_1d_b.txt`) |

---

## 6. Results

### 6.1 Calibration under P: walk-forward, out of sample (answers (d))

**Realized frequency minus model probability (pp)** by strike k (in units of σ√τ), OOS 2024-01..2026-09 (`out/calib.txt`). Seven columns: k = −1.5, −1, −0.5, 0, +0.5, +1, +1.5.

| Tenor | Kernel / σ | −1.5 | −1 | −0.5 | 0 | +0.5 | +1 | +1.5 | ECE |
|---|---|---|---|---|---|---|---|---|---|
| 1 h | normal / EWMA 1 d (naive) | +0.9 | +4.5 | +6.4 | +1.1 | −5.5 | −4.6 | −1.2 | 3.46 |
| 1 h | normal / DVOL | +5.4 | +8.6 | +8.8 | +1.1 | −7.9 | −8.7 | −5.7 | 6.60 |
| 1 h | normal + seas / EWMA 4 h | +0.4 | +1.7 | +2.6 | +1.0 | −1.7 | −1.9 | −0.7 | 1.43 |
| 1 h | **t (ν ≈ 3.5) / EWMA 1 d** | −1.1 | −0.9 | +0.2 | +1.1 | +0.7 | +0.7 | +0.8 | **0.78** |
| 1 h | Gram–Charlier / EWMA 1 d | −3.7 | −11.5 | −10.2 | +0.4 | +10.2 | +11.2 | +3.8 | 7.28 |
| 1 h | empirical ECDF / EWMA 4 h | — | — | — | — | — | — | — | 0.22 |
| 4 h | normal / EWMA 1 d | +0.1 | +3.5 | +6.2 | +1.2 | −4.4 | −3.3 | −0.3 | 2.71 |
| 4 h | t / EWMA 3 d | −1.1 | −0.7 | +1.1 | +1.3 | +0.8 | +0.8 | +0.9 | 0.95 |
| 1 d | normal / EWMA 1 d | −1.6 | +0.4 | +3.9 | +2.4 | −2.5 | 0.0 | +1.8 | 1.81 (SE ≈ 1.6) |
| 1 d | t / DVOL | −0.3 | −0.5 | +1.5 | +2.7 | +0.3 | +1.1 | +0.6 | 1.00 |
| 7 d | any | errors of 2–7 pp, all within ≈ 1–1.5 SE (SE ≈ 4.2) | | | | | | | — |

**Formal tests** (`calib2.py`, `out/calib2.txt`) use one random strike per non-overlapping listing, so samples are independent. HL uses df = 10.

- At 1 h (n ≈ 24k), **every** kernel fails HL. The best is t / EWMA 1 d: HL p = 0.009, ECE 1.0 pp, worst bin +2.3 pp (z 2.6).
- At 4 h, t / EWMA 1 d passes (p = 0.067, ECE 1.6 pp).
- At 1 d (n ≈ 1,000) and 7 d (n ≈ 140), "PASS" mostly reflects **low power**. The 1 d normal kernel passes HL (p = 0.45) with a 7.6 pp worst bin.

**Decision (d).**

1. **Sub-day tenors (≤ 4 h) require a fat-tailed kernel.** Use variance-matched Student-t with ν ≈ 3.5–4, which is closed form. Pair it with a short-half-life σ̂ (4 h).
   - Seasonality helps the normal kernel (ECE 3.5 → 1.4 at 1 h) but adds little to t.
   - Gram–Charlier is rejected: ETH's kurtosis (hourly excess ≈ 24, 04 §8.5) is far outside its valid range, and clipped densities give 5–30 pp errors.
   - A walk-forward quantile table ("empirical kernel", ECE 0.2–0.4 pp) is the most accurate. It needs governance/keeper updates, though, and was not adopted as a v1 kernel.
2. **1 d can use N(d2) or t.** History cannot tell them apart at 1 d.
3. **7 d is uncertifiable from history.**
4. **Economic calibration, not HL, should be the E1 criterion**, because HL at n > 10⁴ rejects errors smaller than any sensible spread.

### 6.2 Stage A: kernel and σ policy (1-minute sim, lag 0, s = 1%, λB = 0.05, no cutoff; `out/expA_*.txt`)

D\*_real (IS / OOS, noise turnover per day) and D\*_stress (with the clairvoyant vol agent):

| Tenor | Configuration | D\*_real IS / OOS | OOS LP P&L per market: tail / iv | D\*_stress OOS |
|---|---|---|---|---|
| 1 h | **naive** normal, EWMA 1 d | **67 / 86** | −0.065 / −0.024 | 312 |
| 1 h | naive with 60 s stale oracle | 780 / 696 | lat −0.20 | 1,056 |
| 1 h | normal, EWMA 1 d, σ × 1.25 | 288 / 336 | −0.21 / −0.19 | 696 |
| 1 h | normal, DVOL | 240 / 168 | −0.17 / — | — |
| 1 h | **t + seas, EWMA 4 h** | **floor (1.2)** | +0.020 / +0.062 | 79 |
| 4 h | naive | 14 / 19 | −0.033 / +0.004 | 129 |
| 4 h | normal, DVOL | 192 / 120 | −0.054 / −0.213 | 252 |
| 4 h | **t + seas, EWMA 4 h** | **floor (0.3)** | +0.019 / +0.097 | 51 |
| 1 d | naive | floor | +0.052 / +0.081 | 27 |
| 1 d | naive with 60 s stale oracle | 52 / 52 | lat −0.23 | 87 |
| 1 d | normal, σ × 1.25 | 37 / 40 | −0.12 / −0.14 | 78 |
| 1 d | normal, DVOL | 56 / 24 | +0.16 / −0.21 | 57 |
| 7 d | naive (weekly listing) | 0.01 / 3.9 | +0.02 / −0.038 | 10 |
| 7 d | t, DVOL | 0.43 / 0.67 | +0.19 / −0.009 | 5.5 |

Reading:

- **Vol premia and IV-as-σ are harmful at every tenor ≤ 1 d.** The premium suggested in 04 §8.4 (IV − RV ≈ +5 vol points) over-prices the wings, and informed flow harvests exactly that. Charge the premium as spread, not through σ.
- The directional (momentum) agent lost money to the LP in every run: +0.003 to +0.09 B per market.

### 6.3 Stage B: spread, impact, cutoff, band (`out/expB_*.txt`)

On the stage-A-selected policy, the realistic D\* stays at its floor across the grid s ∈ {0.5, 1, 2}%, λB ∈ {0.02, 0.1}, cutoff ∈ {0, 10%}, p_min ∈ {0.02, 0.08} at 1 h, 4 h and 1 d. The stress D\* improves with a **wider spread and less depth**:

| Tenor | D\*_stress at s = 1%, λB = 0.02 | D\*_stress at s = 2%, λB = 0.1 |
|---|---|---|
| 1 h | 104 | 37 |
| 4 h | 63 | 20–22 |
| 1 d | 32 | 12–13 |

**At 7 d** the IV agent extracts OOS whenever a 10% cutoff is used (−0.13 to −0.18 B per market). IS D\* = 0.01 but OOS D\* = 2.4–5.4, which is a regime shift. **7 d is not robust.**

### 6.4 Sub-minute latency (1 s data, 116 days; `out/lat1s_v2.txt`, `out/lat1s_cut.txt`)

Setup: latency agent plus noise; start-of-block oracle; λB = 0.05. Cells are LP P&L per market vs the arbitrageur, in units of B.

**1. Impact that resets each block vs impact that decays** (L1, s = 1%, no cutoff):

| Tenor | Reset per block | Decay, half-life 60 s | Decay, half-life 300 s |
|---|---|---|---|
| 1 h | −0.025 | −0.045 | −0.069 |
| 4 h | −0.041 | −0.068 | −0.100 |
| 1 d | −0.079 | −0.107 | −0.131 |

Decay is worse on L2 as well. **Specify impact that resets each block, not decaying skew.**

A per-*second* reset at 1 h with a 12 s stale oracle loses 0.24 B per market, 10× worse. (This comes from an earlier 8-day run on 2026-09-17..24 that was not archived; rerun it with `lat1s.py`, `block=0, lag=12`.) Depth must therefore be budgeted per block (or per unit of time), never per transaction.

**2. Block time, spread and cutoff** (reset per block). Break-even η per market is in parentheses.

| Tenor | L1 12 s, s = 1% | L1 12 s, s = 2% | L2 2 s, s = 1% | L2 2 s, s = 2% |
|---|---|---|---|---|
| 1 h, cutoff 2% | −0.039 (1.14) | −0.019 (0.48) | −0.017 (0.50) | −0.005 (0.13) |
| 4 h, cutoff 2% | −0.056 (2.75) | −0.023 (0.83) | −0.021 (1.03) | −0.006 (0.21) |
| 1 d, cutoff 2% | −0.068 (5.5) | −0.029 (1.50) | −0.033 (2.6) | −0.003 (0.14) |
| 1 d, cutoff 10% | −0.038 (3.1) | −0.020 (1.02) | −0.017 (1.4) | +0.003 (0) |

At 1 h, the cutoff-free runs lose *less* (−0.025 vs −0.039). The reason: an arbitrageur that believes the CEX price near expiry is wrong about the pool-settled outcome and loses. That is a settlement-basis artifact, so the cutoff numbers are used as the conservative charge.

The 1 d SEs are ≈ 0.016 B, because only 116 markets are available.

### 6.5 Final OOS evaluation of IS-selected configurations, with the L1 latency charge (`expF.py`, `out/expF_*.txt`)

**Selection rule:** minimize IS (D\*_real + latency η\*·1440/τ + 0.1·D\*_stress), with s ∈ {1%, 2%} where latency was measured. Vault convention: each market's budget = 1% of NAV, with no compounding.

- **1 d, selected:** t-kernel, EWMA 1 d, s = 2%, λB = 0.1, cutoff 144 min, p_min = 0.02; latency charge −0.029 B.
  - D = 2/day: OOS edge **+0.0142 B/market**; vault **+36.2%/yr (95% lower bound +29.3%)**; weekly SD 0.89%; VaR95 0.93%; CVaR95 1.07%; CVaR99 1.21%; max DD 2.9%; worst week −1.23%; P(losing week) 0.20. IS is similar (+34.1%, lower bound +26.4%).
  - D = 5: +202%/yr (lower bound +185%); max DD 1.0%. Per year: 2021 +223%, 2022 +86%, 2023 +299%, 2024 +247%, 2025 +212%, 2026 +289%.
  - Stress weeks at D = 5: 2021-05-19 +2.35%, 2022-06-13 −1.50%, 2022-11-07 −0.06%, 2024-08-05 +3.45%, 2025-04-07 +2.46%.
  - **D\*_real ≈ 1.35/day**, or ≈ 0.9/day using the measured cutoff-10% latency charge.
  - E4 passes. E5 stress at D = 5: −281%/yr, so the result is **conditional**.
- **1 d, naive** (normal, s = 1%, λB = 0.05, no cutoff; latency −0.068 B): D = 5: edge −0.0001 B, vault −0.1% (lower bound −17.5%), 2023 negative. **D\* ≈ 5/day.**
- **4 h, selected** (t + seas, EWMA 4 h, s = 2%, λB = 0.1, cutoff 24 min):
  - D = 5: edge +0.0003 B (lower bound < 0).
  - D = 10: edge +0.024 B, lower bound > 0, weekly CVaR99 0.5% (at 1% per market; scale ×1/6 for equal daily budget).
  - **D\* ≈ 5–6/day on L1**, ≈ 1.2 on L2.
- **1 h, selected** (t + seas, EWMA 4 h, s = 2%, λB = 0.1):
  - OOS edge −0.0115 B at D = 5 and −0.0035 at D = 10.
  - **D\* ≈ 12/day on L1**, ≈ 3.4 on L2.
- **1 h, naive:** edge −0.12 B/market at every D ≤ 10. Fails.
- **7 d, selected** (normal, EWMA 1 d, s = 1%, λB = 0.02, p_min = 0.08, weekly listing; latency not measured):
  - D = 2 (η = 14 per market): edge +0.066 B, lower bound +9.4%/yr.
  - D = 5: 2023 −26%, max DD 28.5%. The weekly risk is overstated because noise variance is scaled η².
  - **Fragile** (§6.3).

### 6.6 Baselines (`out/expC_*.txt`)

OOS LP P&L per market, in units of B or pool value.

| Mechanism | 1 d, η = 1 | 1 d, η = 5 | 1 h, η = 1 | 7 d, η = 5 |
|---|---|---|---|---|
| **Hook (naive)** | **+0.014** (no realistic extraction) | **+0.068** | **−0.058** (tail −0.065) | +0.046 |
| Thales-style | −0.013 | +0.057 | −0.080 | +0.091 |
| LMSR (noise + largest single agent) | −0.28 | −0.25 | −0.27 | — |
| Dynamic pm-AMM | −0.42 | −0.39 | −0.41 | — |
| CPMM / FPMM | −0.60 | −0.58 | −0.55 | — |

Each reserve AMM loses 27–62% of its value per market to *any one* informed class, which is its LVR. It earns only 0.007–0.15 B from noise. **E6 holds by more than an order of magnitude** against reserve AMMs.

At 7 d, the Thales-style design beats our s = 1% hook in simulation. It uses a wide spread, a persistent skew and a 24 h cutoff, and the modeled agents barely trade against it. This contradicts reality (next section).

### 6.7 The Thales contradiction: the adversary set is incomplete

Real Thales LPs lost 13.9% over 80 rounds, with losses clustered in jump weeks (04 §1.6). Our simulator, given Thales-style parameters at 7 d, shows only −0.0004 (tail) and −0.0013 (IV) B per market.

Candidate missing adversaries:

1. Event and jump information (ETF news, macro prints) that is not in price or implied-vol history.
2. Smile/skew-aware option desks (DVOL is ATM only).
3. Real flow that concentrated in a few markets and hit the caps.
4. Our noise assumption.

**Consequence.** Until gate E7 passes, every E-claim must say "against the modeled adversaries". E7 is a replay of Thales' actual on-chain trades from Optimism `ThalesAMM` events through the simulator's accounting. The next adversaries to add are a "jump-informed" agent and a "smile-informed" agent (Deribit option chains).

---

## 7. Parameter region where the LP is profitable at 95% (answers (c))

The region is conditional on the modeled adversaries, start-of-block oracle, 5 bp pool, and OOS 2024-01..2026-09 with IS-frozen parameters. D\* is noise volume per day ÷ per-strike budget.

| Tenor | Kernel / σ | s | λB | Cutoff | D\* on L1 (12 s) | D\* on L2 (2 s) | Vault risk at D = 2×D\* (1% NAV per market) | D\*_stress (vol foresight) | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 h | t (ν 3.5) + seas, EWMA 4 h | 2% | 0.1 | 0–2% | ≈ 12 | ≈ 3.4 | edge ≈ +0.01 B | ≈ 37 + latency | only on L2, or with very high flow |
| 4 h | t (ν 3.8) + seas, EWMA 4 h | 2% | 0.1 | 10% | ≈ 5–6 | ≈ 1.2 | CVaR99 < 1% weekly | ≈ 20–22 + latency | viable on L2 |
| **1 d** | **t (ν 5), EWMA 1 d** (N(d2) is equivalent in stage A but was not re-run with latency) | **2%** | **0.1** | **10%** | **≈ 0.9–1.4** | **≈ 0.1–0.2** | **CVaR95 1.1%, max DD 2.9%, all years positive (D = 5)** | **≈ 12** | **v1 target** |
| 7 d | N(d2), EWMA 1 d | 1–2% | 0.02–0.1 | 0 | ≈ 2–3.6 (OOS; IS ≈ 0) | n/a | max DD up to 28% (overstated) | ≈ 3–13 | not certifiable (§6.3, §6.7) |

**Parameters outside the region:**

- a vol multiplier > 1 or DVOL as σ, at any tenor ≤ 1 d;
- a normal kernel at ≤ 4 h;
- impact that decays instead of resetting per block;
- per-transaction (instead of per-block) depth;
- an oracle staler than one block. A 60 s lag multiplies the 1 d D\* by roughly 40–1,000×.

---

## 8. Implications for the proof plan

1. **State two theorems separately.**
   - (A) M1–M6 hold for all inputs: proven by Foundry and by analysis.
   - (B) "For 1 d ETH markets on chain X with block time Δ, IS-frozen parameters (§7 row), and noise turnover D ≥ D_decl, the LP's OOS 2024-01..2026-09 mean weekly return is > 0 at 95%, with CVaR/DD within E4, against adversaries {latency, tail-ECDF, DVOL-t, momentum}."
   - Never claim (B) without the adversary list and E7.
2. **Scope v1 to 1 d markets** with the t (or normal) kernel, s ≈ 2%, per-block depth λB ≈ 0.1 (trading one budget moves price 10¢), a 10% cutoff, and no σ premium. Keep 1 h/4 h as research with the t kernel, contingent on L2 block times. Keep 7 d out of scope.
3. **Quote-function requirements** that this backtest turned into acceptance items:
   - start-of-block oracle;
   - impact reset per block, with shared YES/NO impact state;
   - exact budget truncation;
   - the delta-scaled spread term;
   - the price band;
   - σ policy = EWMA with floor 0.30 and cap 2.00, **no multiplier**.
4. **Required extra evidence before economic claims:** E7 Thales replay; jump- and smile-informed agents; TWAP settlement in the simulator (05 §6), in place of the snapshot.

---

## 9. Linking the Python simulation to Foundry (answers (e))

**1. Vectors: deterministic, in CI.**
- `export_vectors.py` writes `out/quote_vectors.json` (2,400 vectors).
- Inputs are integers: `sqrtPriceX96` (as a string), `lnStrikeWad`, `sigmaWad`, `tauSeconds`, plus the source minute `block`.
- Outputs are `midWad`, `askMarginalWad`, `bidMarginalWad` and `tolWad = 1e6` (1e-12). The reference is mpmath at 40 digits, computed from the *integer* sqrtPriceX96, with token0 = USDC (6 dp) and token1 = WETH (18 dp).
- Vectors are sampled from historical states (2024–2026), so they cover the real regime distribution, including extreme σ.
- Foundry reads them with `vm.readFile` + `vm.parseJson`/stdJson.
- Add vectors from `run_hook` step states (I, budget truncation, band, cutoff) so that the full quote *path* is tested, not only the mid.

**2. `vm.ffi`: nightly, opt-in (`ffi = true`).**
- Fuzz inputs in Solidity, call `python ref_quote.py <args>`, and compare to the same tolerance.
- Target ≥ 10⁵ runs.
- Not for CI: ffi executes arbitrary commands, and Python must be present.

**3. Trade-tape replay: this is what establishes M2, i.e. that the Python accounting equals the contract's.**
- Python emits a tape per scenario:
  - per block, the ETH/USDC pool target `sqrtPriceX96`;
  - per trade: block, marketId, direction, exact-in amount, expected amount out, expected vault (c, y) and I.
- The Foundry test deploys the v4 PoolManager, the ETH/USDC pool with its oracle hook (05 §4.7b) and the PredictionHook. Then, for each block, it:
  - calls `vm.roll`/`vm.warp`;
  - moves the underlying pool to its target with a `sqrtPriceLimitX96` swap against a deep position;
  - executes the tape's trades through the router.
- At expiry it settles and asserts:
  - per-trade amounts within 1 wei;
  - per-market LP P&L within 1 wei × #trades;
  - the solvency invariant after every block.
- Tapes:
  - four historical weeks: a calm week, 2021-05-17, 2024-08-05, and the maximum-trade-count day;
  - 256 synthetic tapes (GBM and Merton, 05 §7.4) driven by `forge` invariant fuzzing of the tape seed.
- One 1-minute step spans 5 L1 blocks. Tapes are emitted per block so that the oracle semantics match §6.4.

**4. Sample sizes.**
- M4 calibration: ≥ 200k independent quotes (1 pp per bin at 80% power, 05 §7.5).
- LP-P&L Monte Carlo: per-market CV is 3.2 at 1 d (η = 5) and 2.5 at 4 h, so 4,040 and 2,478 paths give ±10% relative precision (`out/power.txt`). CV → ∞ near break-even, so use common random numbers and paired differences for all comparisons.
- Historical OOS: 143 weeks → minimum detectable weekly mean 0.46% NAV at 1 d (b = 1%/market), i.e. an edge ≈ 0.009 B per market. The 1 d selected configuration (+0.014 B at D = 2) is only about 1.5× above that. For 1 d/7 d calibration, history cannot certify below ≈ 12 / 33 pp per bin, so rely on synthetic data plus E1's economic test.
- Tape replay: 4 historical + 256 synthetic tapes, each ≤ 10⁴ swaps (raise `gas_limit`; Foundry runtime for 10⁴ v4 swaps per test is **UNVERIFIED**).

---

## 10. Verification

**Verified by running code:**
- data integrity (row counts, gaps, µs timestamps);
- simulator correctness against the semi-analytic LVR (0.02 SE), the budget invariant, GBM null tests and pm-AMM theory (§5);
- all tables in §2.1 and §6–§7 (script outputs in `$E/out`);
- Polymarket volumes via the Gamma API;
- the lead–lag and basis of the real v3 pool vs Binance 1 s.

**Corrected during the work** (bugs that would have biased results):
1. The budget truncation overshot to −1.48 B. Fixed with an exact quadratic solve.
2. Jointly simulated agents traded against each other, giving attribution of ±10 B. Fixed by isolation.
3. The ECDF adversary absorbed 2020–21 drift, which made it a donor. Fixed by demeaning.
4. The seasonality hour-of-week offset was wrong (2020-01-01 is a Wednesday). Fixed.
5. The clairvoyant-vol agent initially used band-filtered pool variance (biased low). Switched to CEX variance.

**Not verified / limitations (UNVERIFIED):**
- (a) Whether the modeled adversaries match real informed flow. The Thales contradiction (§6.7) says they are too weak at 7 d.
- (b) Noise volumes that would actually arrive, and the uninformed share of Polymarket flow.
- (c) Latency at 7 d, and at 1 d beyond 116 days of 1 s data (1 d SE ≈ 0.016 B).
- (d) Pool dynamics before 2026 are *modeled* as a 5 bp band follower of Binance. They were validated on only 7 days of real v3 data (2.34 bp tracking error).
- (e) Settlement is a snapshot, not the TWAP of 05 §6.
- (f) Linear noise scaling overstates noise variance at large η. This makes 7 d risk metrics conservative.
- (g) Selection across about 50 + 24 configurations per tenor uses IS only, with no multiple-testing correction on OOS. Only one selected configuration per tenor is reported OOS.
- (h) Foundry cheatcode usage and replay runtime were not executed here.
- (i) Polymarket hourly volume rests on 3 samples.

---

## Appendix: reproduction

Run from `…/scratchpad/econ` (the same files are in `$E`):

| Step | Script | Output |
|---|---|---|
| Data | `data/fetch1m.sh`, `data/build.py`, `data/dvol.py`, `data/f1s.sh`, `data/blkts.py` | `eth1m.npz`, `dvol_1h.json`, `s1/*.zip`, `v3_blockts.json` |
| Calibration | `calib.py`, `calib2.py` | `out/calib.txt`, `out/calib2.txt` |
| Simulator validation | `validate.py`, `validate2.py` | stdout (§5) |
| Stage A / B | `expA.py <tenor>`, `expB.py <tenor>` | `out/expA_*.txt`, `out/expB_*.txt` |
| Baselines | `expC.py <tenor_min> <mechs> <etas>` | `out/expC_*.txt` |
| Latency | `lat1s.py`, `lat1s_cut.py` | `out/lat1s_v2.txt`, `out/lat1s_cut.txt` |
| Final and power | `expF.py <tenor> '<latency-json>'`, `power.py` | `out/expF_*.txt`, `out/power.txt` |
| Pool vs CEX | `leadlag.py` | `out/leadlag.txt` |
| Foundry vectors | `export_vectors.py` | `out/quote_vectors.json` |
