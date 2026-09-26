# Gap report: settlement rule, matching pricing formula, and in-band manipulation

**Date:** 2026-09-25. **Scope:** this report settles the conflicts between reports 02, 03, 04, 05 and 06 on:
- the settlement statistic, the tie rule and the pricing formula that matches them;
- the cost of manipulating settlement, especially inside the pool's fee band;
- which remedies work, how data availability is handled, and whether trading may continue inside the settlement window.

**Reproduction.** Scripts and outputs are in `docs/md/research/gaps/settlement-scripts/`.
- Run a script from that folder with `uv run --with numpy --with scipy --with mpmath python NN_name.py`.
- Every table below cites its output file (`outNN.txt`).
- Real data is in `settlement-scripts/data/`, fetched 2026-09-25:
  - 2 days of `Swap` logs for the three mainnet Uniswap v3 USDC/WETH pools, blocks 26,040,846–26,055,146;
  - Binance ETHUSDT 1-second closes for the same period.

**Conventions**
- r = b = 0 (why is in report 05, R1).
- σ is annualised over 365 days.
- f is the pool's LP fee as a fraction.
- `y_v` is the pool's virtual USDC reserve in the active range.
- `n_w = w/Δ` is the number of blocks in the window, with Δ = 12 s on L1.
- A "tick" is `floor(log_1.0001(raw price))`.
- κ is the real-valued log-tick of the strike, in the pool's own orientation.

---

## 0. Decisions

| Question | Decision | Why (section) |
|---|---|---|
| Settlement statistic | **Time-average of the source pool's integer tick over `[T−w, T]`**, read from `tickCumulative`. This is a discrete geometric TWAP. Reject settling on spot at T (report 03 §5.5) and on `slot0` at settle time. | Spot at T costs 60–300× less to move than a 30-min TWAP. A `slot0` read can be moved for fees alone (§1.3, `out07.txt`). |
| Pricing formula | **Discrete geometric-Asian binary.** This is the left-endpoint sum that the oracle actually produces: `μ = ln(S/K) − ½σ²(τ − w + (n−1)Δ/2)`, `v = σ²[(τ − w) + Δ(n−1)(2n−1)/(6n)]`, `YES = N(μ/√v)`. It is not the European N(d2). As n → ∞ it tends to report 02/05's `d2_G`. | A Monte Carlo that uses the oracle's own per-block floor-tick sampling matches it to within 1 standard error when f = 0, and to ≤ 0.5¢ with a 5 bp band-follower pool (§4.4). European N(d2) is off by up to 10¢ at the cutoff. |
| Tie rule | **Strict: YES iff the statistic > threshold. An exact tie resolves NO** ("S_T ≤ K → NO"). This agrees with reports 03, 04, 05 and 06, and with the strict variant 02 suggested. | §4.1 |
| Integer comparison | Up orientation (ETH is currency0): `YES ⇔ D > floor(w·(κ − ½))`. Flipped orientation (v3 USDC/WETH): `YES ⇔ D < ceil(w·(κ − ½))`. Here `D = cum(T) − cum(T−w)`. For K = $5,000 and w = 1800 s the thresholds are −344,067,005 (up) and +344,065,205 (v3). | The half-tick term removes the floor bias. Without it the ATM price is off by 0.73¢; with report 02's `ceil(κ)` rule it is off by 1.95¢ (§4.2, `out02.txt`, `out08.txt`). |
| Effective strike shown to users | **K itself** (on average). The residual is ±0.5 bp of path-dependent tick rounding, and the display should say so. | §4.3 |
| Cost model | For shifts δ ≤ f: `C(δ) ≈ κ_in·n_w·y_v·δ²`, with κ_in ≈ 0.11 on the real path and 0.145 under GBM for L1 5 bp. For δ ≥ f, an exact offset formula (§2.3). Report 05 §4.7c's band-aware formula **underestimates by 20–30× at δ ≈ f**, because it omits the cost of holding the band edge. Report 02 §5.4's band-free formula **overestimates by 4–15× at δ ≤ f**. Both are correct for δ ≫ f. | §2, `out01.txt`, `out04.txt` |
| Can "attacker PnL ≤ 0" hold? | **Not as stated.** C(δ) is quadratic near 0, so every nonzero exposure has a small positive manipulation profit `Δ_G²/(4k_w)`. The provable invariant is "**attacker profit ≤ spread paid**" under an OI cap. A second, expected-loss bound is needed against adaptive attackers. | §3.1 |
| Remedies, ranked | (1) **Longer w.** The OI cap scales about as w². (2) **OI cap on gross exposure per settlement window.** This is mandatory. (3) **Ramp / log-call-spread payoff** of half-width h ≳ sd_G. The cap then scales as h². (4) **Cost-weighted mean** of the v3 5 bp and 1 bp pools, about 1.5×. **The median of the three v3 pools is not a remedy:** the 30 bp member is cheap to move and makes the settlement mis-priced. | §3, `out05.txt`, `out06.txt` |
| In-window trading | **No.** Stop at `T − w − b` with b ≥ 5 min on L1. Keep redemptions and price-free mint/merge open. The discrete in-window formula is exact, but the manipulation reach exceeds the remaining uncertainty once ≤ 10 blocks are left. | §6, `out03.txt` |
| Data availability | Checkpoints registered with the oracle hook (v4) or a permissionless snapshot within the ring span (v3: 7.4 h today for the 5 bp pool). Fallback chain: secondary pool → mark at the cutoff. Add a depth check through `secondsPerLiquidityCumulative`. | §5 |

---

## 1. The conflicts and how they resolve

### 1.1 Statistic: spot at T (report 03) or a TWAP (reports 02 and 05)?

- **Report 03 §5.5** settles on `sqrtPriceX96_T > sqrtPriceX96_K` and prices with European N(d2).
- **Reports 02 §5.1 and 05 §6** settle on a geometric TWAP and price with `d2_G`.

**The TWAP wins, for two reasons.**

1. **Cost.** Shifting one end-of-block sample (spot at T) by 10 bp costs **$72**. Shifting a 30-minute TWAP by 10 bp costs **$7,398**, 103× more. At 55 bp the ratio is 147× (`out07.txt`; v3 5 bp pool, y_v $155.5M, σ = 0.52).
2. **`slot0` is worse still.** A `slot0` read inside the settling transaction can be pushed and restored within one `unlock` for fees alone: about $233 for a 30 bp move (report 02 §4.2).

Prior art agrees:
- Deribit settles on a 30-minute TWAP of its index (07:30–08:00 UTC, 450 snapshots, one every 4 s) ([Deribit Settlement](https://support.deribit.com/hc/en-us/articles/29734325712413-Settlement)).
- CME CF's BRR averages 12 five-minute volume-weighted medians over one hour ([CF Benchmarks methodology](https://docs.cfbenchmarks.com/CME%20CF%20Reference%20Rates%20Methodology.pdf), [CME FAQ](https://www.cmegroup.com/articles/faqs/cme-cf-cryptocurrency-benchmarks-faq.html)).
- Polymarket moved its 5-min, 15-min and 4-h markets from snapshot settlement to TWAP settlement (report 04 §6.2).

### 1.2 Pricing formula

Once the statistic is a TWAP, the European formula is simply the wrong model:
- at the cutoff (τ = 35 min, w = 30 min) it differs from the Monte Carlo by **7–10¢** at ±1 sd;
- at τ = 65 min, by 4.5¢ (`out02.txt`).

Report 06 §6.1 ("cutoff ≥ W is enough") is right that a cutoff removes the need for an *in-window* formula. It is wrong if read as "the European formula is then fine". The Asian adjustment applies **before** the window, which is what reports 02 and 05 say.

### 1.3 Tie rule

- Report 02's `Δcum ≥ K_tick·w` resolves an exact tie as YES.
- Reports 03, 04 and 06 say `S_T ≤ K → NO`, and 05 uses a strict `>`.

The recommendation is the **strict** rule. Section 4.1 shows that ties are possible only when `w(κ − ½)` is an integer. With the half-tick threshold, that happens only when K is set to an exact tick price with specific w-divisibility, and then the tie resolves NO.

### 1.4 Cost models

- **Report 02 §5.4** uses `n_w·(y_v δ²/4 + f y_v δ/2)`, which has no fee band.
- **Report 05 §4.7c** uses `y_v[fδ + n_w(δ−f)^+(δ+3f)/4]`, which treats in-band shifts as almost free.

A band-follower simulation shows both are wrong at small δ, in opposite directions (§2). They agree with each other and with the simulation for δ ≫ f.

For reference:
- 02's "$70k to move v3 by 0.3% over 30 min" is confirmed at **$65.6k** (`out05.txt`).
- 05's "$250 for 5 bp at D1 = $5M" should be **≈ $7.8k** at that depth: $1,208 at y_v = $155.5M scaled to y_v = $1B.

---

## 2. (a) Verified cost of shifting a w-window geometric mean

### 2.1 Model

Per block k, in this order:
1. The reference (CEX) log-price X moves.
2. **Arbitrageurs at the top of the block** clip the pool's log-price Y into `[X − f, X + f]`, moving it to the nearest band edge. This band-follower model follows Milionis–Moallemi–Roughgarden and reports 02 §3.4 and 05 §4.7.
3. **The attacker at the bottom of the block** buys up to a floor `X − f + s`.
4. The oracle sample for the interval (k, k+1] is the end-of-block Y. This matches v3 `Oracle.write` being called with `slot0Start.tick` on the first tick-changing swap of the next block (`v3-core/contracts/UniswapV3Pool.sol:732-748`), and OZ `BaseOracleHook._beforeSwap` writing the pre-swap tick at most once per block (`oz-uniswap-hooks/src/oracles/panoptic/BaseOracleHook.sol:116-135`).

Notes on the model:
- **Why this order.** It is the order most favourable to the attacker: arbitrageurs do the free part of every push.
- **The floor s covers every case.** s < 2f is an in-band shift, s = 2f pins the pool at the upper edge, and s > 2f pushes above the band, where the next block's arbitrageurs revert it.
- **Cost accounting.** The cost is exact within the range (constant L), includes the LP fee, and is marked to X (`common.py: push_cost`).
- **Shift measurement.** The shift is the window mean of `Y_attacked − Y_counterfactual` on the same X path (common random numbers).

### 2.2 Results (σ = 0.52, L1 Δ = 12 s, y_v = $155.5M, w = 30 min unless noted; `out01.txt`)

v3-style 5 bp pool:

| shift δ | sim cost | report 05 §4.7c | report 02 §5.4 | exact offset formula (§2.3) |
|---|---|---|---|---|
| 1.2 bp (s = 0.5f) | **$56** | $10 | $815 | – |
| 2.5 bp (s = f) | **$223** | $19 | $1,820 | – |
| 3.8 bp | **$550** | $29 | $3,012 | – |
| 5.0 bp (pin, s = 2f) | **$1,210** | $54 | $4,388 | $1,191 |
| 7.0 bp | **$3,095** | $2,638 | $6,957 | $3,075 |
| 10 bp | **$7,398** | $7,389 | $11,685 | $7,373 |
| 25 bp | **$46,683** | $46,890 | $51,068 | $46,650 |
| 45 bp | **$140,003** | $140,375 | $144,399 | $139,950 |

Other settings (sim cost):

| setting | 2.5 bp | 5 bp | 10 bp | 30 bp |
|---|---|---|---|---|
| 5 bp, w = 30 min | $226 | $1,208 | $7,400 | $65,645 |
| 5 bp, w = 2 h | $883 | $4,782 | $29,498 | $262,421 |
| 5 bp, L2 Δ = 2 s, w = 30 min | $395 | $3,380 | $43,766 | – |
| 1 bp (f_eff 3 bp, y_v $58M), w = 30 min | $147 | $739 | $2,922 | $22,928 |
| 30 bp (y_v $199M), w = 30 min | $83 | $215 | $552 | $13,424 |

The table has three regimes:

- **δ < f (in band).** The cost is **quadratic**: `C ≈ κ_in·n_w·y_v·δ²`.
  - The mechanism: each time the reference rises past the lower band edge, the arbitrageur pushes the pool to the edge for free, and the attacker then pays `∫(u+f)du/2 = s²/4 = δ²` (in y_v units) to lift it the extra s = 2δ.
  - Averaged over blocks, the shift is s/2, which the simulation confirms.
  - Fitted values: κ_in = 0.145 under GBM and **0.111 on the real Binance path** (§2.4).
- **δ ≈ f (pinned at the band edge).** The cost is `n_w·y_v·E[min(fΔX − ΔX²/4, f²)·1{ΔX>0}]`.
  - At L1 σ_b = 3.2 bp, this is **$1.2k per 30 min** on the $155.5M pool.
  - Report 05 omitted this "hold the edge" term.
  - The continuous-time reflected-Brownian-motion limit `y_v σ² w δ/(4(f−δ))` holds only when σ_b ≪ f. At L1 it overestimates in-band cost 2–6× (`out01.txt`, column `reflBM`).
- **δ > f (above the band).** Per block, the cost is the **exact offset formula** (§2.3), which reduces to report 05's `(δ−f)(δ+3f)/4` (δ in log units, cost in y_v units) plus the pin term.

### 2.3 Closed form for δ ≥ f

Let `e = δ − f ≥ 0`. The attacker holds the end-of-block price at `X + f + e`. The next block's arbitrageurs pull it to `u0 = clip(f + e − ΔX, −f, f)` relative to the new reference X, and the attacker pushes it back. The exact per-block expected cost is:

```
c(e) = y_v · E_ΔX[ ((2f + e)² − (clip(f + e − ΔX, −f, f) + f)²) / 4 ],   ΔX ~ N(0, σ_b²)
C(δ) = n_w · c(δ − f)
```

This matches the simulation to within 0.5% in every row with δ ≥ f (`out01.txt`, column "exact pin/offset"). With ΔX = 0 it reduces to `fe + e²/4`, the term report 05 derived.

### 2.4 Real-data validation (`04_real_data.py` → `out04.txt`)

The three v3 USDC/WETH pools were compared with Binance at 12-second slots, with the USDC/USDT basis removed using a 1-h rolling median.

| pool | pool − Binance deviation, sd | share within ±f | share within ±2f | slots with an up / down / no move |
|---|---|---|---|---|
| 5 bp | **3.63 bp** | 86.4% | 99.7% | 26.9% / 31.5% / 41.6% |
| 1 bp | 2.02 bp | 51.3% | 81.3% | 43.6% / 43.2% / 13.1% |
| 30 bp | 11.2 bp | 98.4% | 100% | 4.4% / 3.5% / 92.1% |

- **The band model fits the 5 bp pool.** A uniform ±5 bp band gives sd 2.89 bp; the extra comes from latency and noise.
- **The 1 bp pool has a wider effective band** because of gas, priority fees and latency. The calculations therefore use f_eff ≈ 3 bp for it.
- **Realised σ at 12 s:** 0.49 over the 2 days.

**Replay on the real reference.** The attack was replayed with a band-follower driven by the **actual Binance path** (190 overlapping 30-min windows), against GBM at σ = 0.49:

| s/f | shift | real-path cost | GBM cost |
|---|---|---|---|
| 0.5 | 1.25 bp | $43 | $54 |
| 1.0 | 2.52 bp | $165 | $211 |
| 2.0 (pin) | 5.05 bp | **$907** | $1,164 |
| 3.0 | 10.05 bp | $7,406 | $7,380 |
| 4.0 | 15.05 bp | $17,539 | $17,521 |

In band, the real path is about 20% cheaper than GBM. Out of band the two agree.

**Noise flow.** The real pool trades a median $414k of ETH sold per 30-min window. An up-pin would have to buy back noise sells at a premium of about 2f, which adds **at most $414–555 per window**. This is an upper bound, because real sells include arbitrage at the band edge. Ignoring it makes C(δ) a **lower bound**, which is the conservative choice for the protocol.

**Conclusion (deliverable a).**
- In-band shifts are **not free.** They cost about `0.11–0.15·n_w·y_v·δ²`: $165–$226 for 2.5 bp and $0.9–1.2k for 5 bp per 30 minutes on the deepest ETH/USDC oracle pool.
- They are **cheap relative to what they buy.** A 5 bp shift of a 30-min TWAP moves an at-the-money binary at the cutoff by about 8.8¢ (§6).

---

## 3. (b) Remedies, each with a closed-form price

### 3.1 How much manipulation profit an exposure allows

Near δ = 0 the cost is quadratic: `C(δ) ≈ k_w δ²`, with `k_w = κ_in·n_w·y_v`. For v3 5 bp and w = 30 min, `k_w ≈ $3.6·10⁹` per unit log².

Let `Δ_G = Σ_markets q·∂P/∂ḡ` be the dollar sensitivity of all open positions on one settlement window to the settlement log-mean ḡ. An attacker holding exposure Δ_G earns at most:

```
max_δ (Δ_G·δ − k_w δ²) = Δ_G² / (4 k_w)        (committed attacker, small-δ regime)
```

- This is **strictly positive for any Δ_G ≠ 0**, so the invariant "attacker PnL ≤ 0" from reports 02 and 05 **cannot hold** without friction.
- The friction is the **spread** s per token the attacker pays to build the position.
- **Safe condition:** `Δ_G²/(4k_w) ≤ s·Q`.
  - At-the-money binary (`Δ_G = Q·n(0)/sd_G`): **`Q_safe ≈ 8π·s·k_w·sd_G²`**.
  - Ramp with half-width h ≳ sd_G (`Δ_G ≤ Q/(2h)`): **`Q_safe ≈ 16·s·k_w·h²`**.
- Check against the numerical optimum in `out05.txt`: the closed forms give $7.0k (binary) and $57.6k (ramp, h = 100 bp), against $7.4k and $63.0k numerically.

**Clairvoyant (adaptive) attacker.** Such an attacker waits and pushes only when the unmanipulated statistic lands near K. Their expected extraction is bounded by `E_G[max_δ(Q·(Π(G+δ) − Π(G)) − C(δ))⁺]` (M2 in `05_attack_econ.py`). For a binary this bound is large even at small Q (below).

### 3.2 Numbers (`out05.txt`, `out06.txt`)

Setup:
- source v3 5 bp unless noted;
- σ = 0.52, L1;
- cutoff τ = w + 5 min, worst-case moneyness at the cutoff;
- spread s = 1¢.

**M1 (committed attacker): Q_safe, the maximum gross OI per settlement window**

| source / window | sd_G | binary | ramp h = 25 bp | h = 50 bp | h = 100 bp |
|---|---|---|---|---|---|
| v3 5 bp, w = 30 min | 27.8 bp | **$7.4k** | $9.3k | $17.1k | $63k |
| v3 5 bp, w = 1 h | 35.9 bp | $23k | – | $41k | $126k |
| v3 5 bp, w = 2 h | 48.1 bp | $82k | $90k | $117k | $270k |
| v3 5 bp, w = 4 h | 66.1 bp | **$322k** | $339k | $396k | $695k |
| v3 5 bp, w = 12 h | 112 bp | $3.5M | – | $3.9M | $5.1M |
| v3 5 bp, w = 24 h | 158 bp | **$19.9M** | – | $20.6M | $22.9M |
| v3 1 bp (f_eff 3 bp), 30 min | 27.8 bp | $4.1k | $5.3k | $10.4k | $45k |
| v3 30 bp, 30 min | 27.8 bp | $3.2k | $3.8k | $5.9k | $13.5k |
| median(1, 5, 30 bp), 30 min | 27.8 bp | $8.2k | $10.2k | $17.4k | $63k |
| cost-weighted mean 5 bp/1 bp (0.62/0.38), 30 min | 27.8 bp | **$11.4k** | $14.7k | $27.4k | $106k |

**M2 (clairvoyant upper bound): expected extraction as a % of Q**

| source | payoff | Q = $10k | $100k | $1M |
|---|---|---|---|---|
| 5 bp, 30 min | binary | 11.4% | 33.5% | 66.2% |
| 5 bp, 30 min | ramp h = 25 bp | 1.7% | 8.1% | 50.8% |
| 5 bp, 30 min | ramp h = 100 bp | 0.16% | 1.4% | 8.8% |
| 5 bp, 4 h | binary | 2.2% | 5.3% | 16.5% |
| 5 bp, 4 h | ramp h = 100 bp | 0.00% | 0.17% | 1.3% |

### 3.3 The remedies one by one

**1. Longer w: the strongest lever.**
- Q_safe grows about as **w²**: C ∝ n_w and sd_G² ∝ w. Going from 30 min to 4 h multiplies it by 44; going to 24 h, by 2,700.
- **Pricing:** the same discrete-Asian formula with the larger n. It stays exact (§4.4).
- **Cost:**
  - the product becomes "average of the last w hours";
  - the Asian adjustment grows (report 02 §5.1 table), but the formula handles it exactly;
  - the cutoff moves earlier by w.
- **Recommendation:**
  - w ≥ 2–4 h for 1-day markets;
  - w = 24 h for markets of 7 days or longer;
  - 30 min only with a tiny cap (≤ $5–7k per window on today's deepest pool).

**2. Ramp (log-call-spread) payoff of half-width h.**
- **Payoff:** `Π = clip((ḡ − ln K + h)/(2h), 0, 1)`, with NO paying `1 − Π`. Complete sets and solvency are unchanged, because the two payouts sum to 1.
- **Closed-form price:** with `μ, v` from §4.4 and `ψ(z) = z·Φ(z/√v) + √v·φ(z/√v)`,

  ```
  YES = [ψ(μ + h) − ψ(μ − h)] / (2h)
  ```

  - It has two Φ and two φ terms, and tends to N(μ/√v) as h → 0.
  - Checked against a discrete-oracle Monte Carlo with f = 0: 0.18929 ± 0.00037 vs 0.18856, 0.49912 vs 0.49935, 0.73059 vs 0.73061 (`out06.txt`).
  - With a 5 bp band-follower pool the error is ±0.33¢ at ±1 sd. That is the same pool-stickiness effect the binary shows (§4.4).
- **Integer settlement (up orientation):**

  ```
  Π_6dp = clamp(floor(1e6·(D − C_lo)/(C_hi − C_lo)), 0, 1e6)
  C_lo/hi = w·(κ − ½ ∓ h/ln 1.0001)
  NO pays 1e6 − Π_6dp
  ```

- **What it buys:** the Lipschitz payoff turns the attacker's gain into `Q·δ/(2h)` in every state. Q_safe then scales as h² once h ≳ sd_G, and the clairvoyant attacker loses its advantage.
- **Cost:** it departs from the literal "$1 if S_T > K" spec. Use it as an optional "robust mode" parameter, with h = 0 meaning binary.

**3. Median of several pools: not recommended with today's pools.**
- The three v3 USDC/WETH oracle pools (1 bp, 5 bp, 30 bp) have y_v of $58M, $155.5M and $199M, and oracle cardinalities of 8192, 723 and 1440.
- The median's cost is the sum of the **two cheapest** pools' costs.
- The 30 bp pool is almost free to move inside its ±30 bp band: $552 for 10 bp.
- The median therefore gains only 1.1× over the 5 bp pool alone ($8.2k vs $7.4k).
- Worse, the 30 bp pool's stickiness makes its TWAP a poor lognormal-Asian variable: the pricing error is **±9–10¢** at ±1 sd at the cutoff (`out02.txt`).

**4. Cost-weighted mean instead of a median.**
- Settle on `Σ w_i ḡ_i`, with weights fixed at creation and `w_i ∝ k_i`.
- With quadratic costs, the attacker's minimum cost is then `δ²·Σk_i`: **the costs add up.** With the 5 bp and 1 bp pools the cap rises 1.55×, to $11.4k.
- **Pricing:** the same formula. The mixture's band noise is smaller than any single pool's.
- **Guard:** weights must not be manipulable. Fix them at creation, and void a source whose window depth (§5.3) falls below a set fraction of its depth at creation.

**5. OI cap sized to C(δ): mandatory.**
- **Scope.** A single manipulation of ḡ moves **every** market that shares the same (source, T, w). The cap must therefore bind the **gross** outcome-token supply of those markets. Where strikes differ, it should bind the delta-weighted form `Σ_K q_K·φ(d_K)/sd_G ≤ 4·s·k_w·sd_G/n(0)`.
- **Why gross.** It is gross, not the LP's net exposure, because a flip also transfers value between traders (NO holders to YES holders).
- **What it needs on-chain:**
  - `k_w = κ_in·n_w·y_v`, where y_v comes from the harmonic-mean liquidity over a trailing window;
  - κ_in fixed conservatively at 0.10 for L1 5 bp and re-fitted per chain.

---

## 4. (c) The final settlement rule

### 4.1 Integer comparison

**Notation**
- `D = cum(T) − cum(T − w)`, an int56 difference. With aligned timestamps it equals `Δ·Σ tick_i` over the end-of-block ticks of the blocks at `T−w, T−w+Δ, …, T−Δ`.
- `κ = log_1.0001(p_raw(K))` in the **pool's own orientation**.
- `s = +1` if ETH up means tick up (native ETH currency0 / USDC currency1), and `s = −1` for mainnet v3 USDC(token0)/WETH(token1).

```
YES  ⇔  D > floor(w·(κ − ½))        if s = +1
YES  ⇔  D < ceil (w·(κ − ½))        if s = −1
exact equality is impossible unless w·(κ − ½) is an integer; then it resolves NO
```

**Why this holds**
- For an integer D, `D > x ⇔ D > floor(x)` and `D < x ⇔ D < ceil(x)`.
- In the flipped orientation the pool's ℓ is `−ℓ_ETH`. A larger ETH price therefore means a smaller D, and the half-tick correction has the same sign in pool units.

**K = $5,000, w = 1800 s (mpmath, `out08.txt`)**

| orientation | κ | threshold | YES iff |
|---|---|---|---|
| up | −191147.8360 | −344,067,005 | D > −344,067,005 |
| v3 | +191147.8360 | +344,065,205 | D < +344,065,205 |

**On-chain computation**
- Store `sqrtPriceX96_K`.
- Compute `κ = 2·ln(sqrtPriceX96_K/2⁹⁶)/ln(1.0001)` with solady `lnWad`; report 03 §5.1 measured an error ≤ 2.6e-18.
- Store the integer threshold at market creation. It is **the** rule, and should be emitted in an event.

### 4.2 Half-tick floor bias (verified)

The tick is `floor(ℓ)`, so the mean of the recorded ticks is about ℓ̄ − ½ (report 05 §6.1). Monte Carlo with 1M paths per point runs the real chain: band-follower → end-of-block floor tick → cumulative → integer rule (`out02.txt`). At the cutoff (τ = 35 min, w = 30 min, f = 5 bp, ATM):

| rule | P(YES) | error vs the continuous-mean rule R0 |
|---|---|---|
| R0: continuous mean of the pool log-price > ln K (reference) | 0.49971 | – |
| **R1: `D > floor(w(κ−½))`** | **0.49970** | 0.00 |
| R4: flipped, `−D3 > floor(w(κ+½))` (≡ `D3 < ceil(w(κ_v3 − ½))`) | 0.49970 | 0.00 (path-identical to R1) |
| R2: `D > floor(wκ)` (no half-tick) | 0.49242 | **−0.73¢** |
| R3: report 02, `D ≥ ceil(κ)·w` | 0.48019 | **−1.95¢** |

- R1 equals R0 to within 1 standard error at every moneyness, for w = 5 and 30 min and f = 0, 5 and 30 bp.
- The bias of R2 and R3 is largest at the money, where it matters most for flips.
- **Boundary quirk.** After a zeroForOne swap that ends exactly on an initialised tick boundary, the stored tick is `tickNext − 1`, one below `getTickAtSqrtPrice` (`v4-core/src/libraries/Pool.sol:409-431`, `v3-core/contracts/UniswapV3Pool.sol:725`).
  - This biases one sample by −1 tick, i.e. `1/n` tick in the mean.
  - It is inside the ±f band that §2 already prices as a manipulation budget, so no normalisation is needed.

### 4.3 What to show users

"**YES pays $1 if the time-weighted average of pool P's tick over [T − w, T] is above −191148.336**, i.e. if the w-minute geometric-mean ETH price measured by pool P is above **$5,000**. The error from tick rounding is within about ±0.5 bp, and a tie resolves NO."

- With the half-tick threshold, the **effective strike equals K on average**.
- For comparison:
  - the no-correction rule behaves like K ≈ $5,000.25;
  - report 02's `ceil` rule behaves like $5,000.67, with its displayed $5,000.418 on the tick.

### 4.4 Pricing formula that matches the rule (verified against the oracle's discrete sampling)

The oracle samples are the **left endpoints** `T−w, …, T−Δ`, with n = w/Δ samples. Before the window starts (τ ≥ w):

```
μ = ln(S/K) − ½σ²·(τ − w + (n−1)Δ/2)
v = σ²·[(τ − w) + Δ·(n−1)(2n−1)/(6n)]
YES = N(μ/√v),  NO = 1 − YES
```

- As n → ∞ this tends to report 02/05's `d2_G`, since `(n−1)(2n−1)/(6n)·Δ → w/3`.
- For n = 150 the variance term is 0.330w rather than w/3. That is worth up to 0.08¢ at ±1 sd.

**Results** (`out02.txt`, 1M paths per point, σ = 0.52; "MC − formula" is in cents):

| case | x/sd | MC (R1) | discrete Asian | continuous Asian | European | MC − discrete |
|---|---|---|---|---|---|---|
| f = 0, τ = 35 m, w = 30 m | 0 | 0.49912 | 0.49926 | 0.49926 | 0.49915 | −0.015 (0.3 SE) |
| f = 0, τ = 35 m, w = 30 m | +1 | 0.84147 | 0.84171 | 0.84090 | 0.74297 | −0.024 (0.6 SE) |
| f = 5 bp, τ = 35 m | −1 / 0 / +1 | 0.15245 / 0.49970 / 0.84647 | 0.15740 / 0.49926 / 0.84171 | | 0.25566 / 0.49915 / 0.74297 | −0.50 / +0.04 / +0.48 |
| f = 5 bp, τ = 65 m | −1 / 0 / +1 | 0.15650 / 0.49927 / 0.84228 | 0.15774 / 0.49893 / 0.84097 | | 0.20188 / 0.49885 / 0.79649 | −0.12 / +0.03 / +0.13 |
| f = 30 bp, τ = 35 m | ±1 | 0.066 / 0.934 | 0.157 / 0.842 | | | **−9.1 / +9.2** |

**What the residual is.** With f = 0 the formula is exact. The residual with f > 0 is **pool stickiness**:
- the band-follower's window mean has less variance than the reference's;
- the effect is about 0.5¢ at ±1 sd for 5 bp at the cutoff, 0.13¢ an hour out, and vanishing for 1-day markets.

**Calibration with the hook's actual input.** The hook sees the pool's start-of-block price, not the CEX price. Calibration by probability bin (`out02.txt`, bottom block, 1M paths, bin standard errors ≈ 0.1¢):

| input to the formula | largest bin bias |
|---|---|
| discrete Asian, S = pool (5 bp pool) | **≤ 0.28¢** |
| adding an empirical band term `v += −f²/2` | ≤ 0.2¢ |
| 1 bp pool | ≤ 0.3¢ (noise) |
| 30 bp pool | up to 9.5¢ |

Rules that follow:
- **Use only 1–5 bp pools as sources.**
- The `−f²/2` term is optional.
- **A 30 bp pool is unusable** as a short-window settlement source.

---

## 5. (d) Data availability

### 5.1 Ring coverage today (read live, `eth_call` `slot0` + `observations(oldest)`, 2026-09-25)

| v3 USDC/WETH pool | cardinality | span of the ring | mean write interval |
|---|---|---|---|
| 5 bp `0x88e6…5640` | 723 | **7.41 h** | 36.9 s |
| 1 bp `0xE055…939F` | 8192 | 41.6 h | 18.3 s |
| 30 bp `0x8ad5…e6D8` | 1440 | 104.5 h | 261 s |

- `observe` reverts with `'OLD'` for targets before the oldest observation (`v3-core/contracts/libraries/Oracle.sol:226`). OZ reverts with `TargetPredatesOldestObservation` (`panoptic/libraries/Oracle.sol:15,244`).
- **Coverage requirement:** both `cum(T−w)` and `cum(T)` must be read, or snapshotted, while `now − (T − w) < span`. For the 5 bp pool and w = 30 min, that leaves **about 6.9 h after T**.
- Interpolation between observations is exact, because the tick is constant between writes (report 02 §1.3). So one `observe([now−(T−w), now−T])` call is enough.

### 5.2 Mechanism

**(i) v3 source: permissionless `snapshot(windowId)`.**
- It stores both cumulatives (and `secondsPerLiquidityCumulativeX128`) the first time it is called in `[T, T − w + span)`.
- `settle()` calls it itself.
- A keeper bounty is paid from market fees.
- At creation, require `cardinality × recent write interval ≥ w + grace`. Otherwise refuse, or pay to grow the ring: about 22.1k gas per slot, at most about 750 slots per transaction under EIP-7825 (report 02 §1.5).

**(ii) Our v4 oracle hook: registered checkpoints.**
- A market registers `T − w` and `T` with the oracle hook.
- The first `beforeSwap` at or after a registered time writes `cum(t_c) = last.cum + tick·(t_c − last.ts)`. This is exact, because the tick has not changed since `last.ts`.
- Checkpoints are permanent (one SSTORE each), O(1), and independent of the ring's size.
- A permissionless `poke()` writes due checkpoints when there are no swaps. That is correct for the same reason: any swap after `t_c` would have written first.

**(iii) Tick and liquidity accumulators.**
- OZ's `Observation` has no liquidity accumulator: it holds only `tickCumulative` and `tickCumulativeTruncated` (`panoptic/libraries/Oracle.sol:23-29`).
- Our oracle should add v3's `secondsPerLiquidityCumulativeX128`.
- Settle on the **untruncated** `tickCumulative`. The truncation cap of 9,116 ticks per block never binds at ETH scale (report 02 §3.8).

### 5.3 Fallback chain (deterministic, no admin)

1. **Primary source valid:** the snapshot exists, and the window's harmonic liquidity `L_h = w·2¹²⁸/ΔsplCum ≥ λ·L_ref(creation)`, e.g. λ = 0.5. The depth check stops a large LP from withdrawing to make manipulation cheap.
2. **If the primary is unreadable or fails the depth check:** use the secondary pool fixed at creation (for example v3 1 bp, whose 41.6 h span covers most failures), with the same rule and threshold.
3. **If nothing is valid:** settle at the **mark recorded at the trading cutoff**, `P_cut`, stored on-chain at `T − w − b`. YES pays `P_cut` and NO pays `1 − P_cut`.
   - Under complete sets this is solvent, since the payouts sum to 1 per set.
   - The attacker gets optionality only if they can censor every `snapshot` call for about 7 h. That is not credible on L1, but on L2 it amounts to trusting the sequencer (report 06 §5.5).

**No swaps in the window** is not a failure: `cum(T)` extrapolates exactly (report 02 §5.3).

**Dead pool.** A stale price is caught by the depth check and by an optional cross-source deviation check, e.g. |ḡ_5bp − ḡ_1bp| ≤ 10 bp.

---

## 6. (e) Trading inside the window: no

`out03.txt` (n = 150, σ = 0.52):

1. **Formula accuracy.** The discrete in-window formula is exact. The continuous one (report 02/05) drifts as the window closes.

   With `Σ_known` the sum of the fixed samples' log-moneyness and k samples remaining (the first being the current block's end-of-block price):
   ```
   μ = [Σ_known + k·ln(S/K) − ½σ²Δ·k(k−1)/2]/n
   v = σ²Δ·(k−1)k(2k−1)/(6n²)
   ```

   | samples left k | MC | discrete formula | continuous formula |
   |---|---|---|---|
   | 75 | 0.3996 ± 0.0005 | 0.4000 | 0.4010 |
   | 10 | 0.4009 | 0.4000 | 0.4074 |
   | 2 | 0.4008 | 0.4000 | **0.4383** |

   With k = 1 the outcome is fully determined by the current block's closing price, which the trader can move.

2. **Leverage.** The in-band manipulation reach is `f·k/n`, and the remaining sd is `σ_b·√((k−1)k(2k−1)/6)/n`.

   | samples left k | reach / remaining sd | max ATM price move |
   |---|---|---|
   | 150 (window start) | 0.22 | 8.8¢ |
   | 25 | 0.56 | 22¢ |
   | 10 | 0.92 | 36¢ |
   | 5 | 1.42 | 52¢ |
   | 1 | ∞ | 100¢ |

   At the start of the window a nearly-free 5 bp shift is worth 8.8¢ at the money. With 10 or fewer blocks left, the attacker controls the outcome.

3. **Staleness.** The per-block price standard deviation at the money scales as `1/√τ_eff`, so LVR explodes as well (report 05 §4.6).

**Rules**
- **Hard cutoff at `T − w − b`**, with b ≥ max(oracle lag, 5 min on L1, the L2 timestamp slack).
- Before the cutoff, use the pre-window discrete-Asian formula (§4.4). Report 06's "cutoff ≥ W" is necessary but not sufficient on its own; the Asian formula is still required.
- After the cutoff, keep open only operations that do not depend on price: complete-set mint and merge, and redemption after settlement.

---

## 7. Implications for the Foundry proof plan

1. **Replace** the invariant "attacker PnL ≤ 0" with two tests:
   - (a) **M1:** with gross window OI ≤ Q_safe, a scripted in-band pin attacker's PnL ≤ the spread it paid. Run it in a Foundry band-follower simulation: an arbitrage bot plus the attacker against a real v4 pool with an oracle hook.
   - (b) **M2:** a statistical bound on expected extraction, E[loss] ≤ ε·Q.
2. **Differential tests of the settlement integer rule:**
   - exact ties at `w(κ−½)` integer → NO;
   - K on a tick boundary;
   - both orientations, with `t_v3 = −t_up − 1` off-boundary;
   - the `tickNext − 1` boundary quirk;
   - the half-tick threshold against an mpmath reference (`08_strike_thresholds.py`).
3. **Monte Carlo calibration** of the on-chain discrete-Asian quote against the oracle-produced statistic, reusing `02_pricing_mc.py` as the reference. Acceptance: |bias| ≤ 3 SE for f = 0, and ≤ 0.5¢ for 5 bp sources at the cutoff.
4. **Cost-model regression.** The Solidity band-follower harness must reproduce `out01.txt` within MC error: $223 ± 10% at 2.5 bp and $7.4k at 10 bp.
5. **Data-availability tests:**
   - ring overwritten → secondary source;
   - no swaps → exact extrapolation;
   - depth drop → fallback;
   - `P_cut` fallback pays exactly 1 per complete set.
6. **Parameters to expose per market:** source(s) and weights, w, b, h (0 means binary), `C_threshold`, orientation, `L_ref`, κ_in, spread s, and `Q_safe`.

## 8. Open questions

1. **Product:** is "average price over the last 4 h (or 24 h)" acceptable to users, given that Q_safe scales as w²? Or should short windows run with tiny caps?
2. **Ramp mode by default** for markets above about $50k OI per window?
3. **L2 deployment:** κ_in and C(δ) at 1–2 s blocks, measured on real Unichain or Base data. The simulation gives about 1.75× the L1 in-band cost at 2 s (`out01.txt`). There is also the sequencer trust issue.
4. **Dynamic κ_in estimation on-chain,** e.g. from the observed fraction of up-moving blocks. The real pool's 26.9% up-move share includes noise flow and so overstates the arbitrage share (`out04.txt`).
5. **Routing effects under a pin.** Aggregators route retail sells to the pinned pool, adding up to $414–555 of cost per window. This favours the protocol and is ignored here.

---

## Verification

**Verified (with evidence)**
- **Oracle write semantics:**
  - v3 writes the pre-swap tick once per block, only on a tick change (`UniswapV3Pool.sol:732-748`, `Oracle.sol:90`);
  - OZ writes on every swap block in `beforeSwap` (`BaseOracleHook.sol:116-135`);
  - the `'OLD'` and `TargetPredatesOldestObservation` reverts;
  - the `tickNext − 1` boundary behaviour in both v3 and v4 (`Pool.sol:409-431`, `UniswapV3Pool.sol:725`).
  - Read at v3-core `d0831dc`, v4-core `46c6834`, oz-uniswap-hooks `80bd724`.
- **Live state (tenderly and publicnode RPC, 2026-09-25):**

  | pool | L | y_v | cardinality | ring span |
  |---|---|---|---|---|
  | v3 5 bp | 2.998e18 | $155.5M | 723 | 7.41 h |
  | v3 1 bp | 1.119e18 | $58.0M | 8192 | 41.6 h |
  | v3 30 bp | 3.84e18 | $199.1M | 1440 | 104.5 h |

  ETH was about $2,690.
- **Cost model:**
  - the band-follower simulation against the exact offset formula (δ ≥ f, within 0.5%);
  - the simulation against a replay on the real Binance path (in band 20% cheaper, out of band equal);
  - the band model against the real pool deviation (5 bp: sd 3.63 bp, 86% within ±f).
- **Settlement rule and pricing:** Monte Carlo through floor ticks and the integer rule, 1M paths per point:
  - half-tick correction unbiased; the naive rules biased by −0.73¢ and −1.95¢;
  - orientation equivalence;
  - the discrete Asian formula exact at f = 0;
  - the ramp closed form within 2 SE at f = 0;
  - the in-window discrete formula exact.
- **Thresholds for K = $5,000:** computed with mpmath at 50 digits.
- **Settlement precedents:**
  - Deribit's 30-minute TWAP at 4-second snapshots ([support page](https://support.deribit.com/hc/en-us/articles/29734325712413-Settlement));
  - the CF BRR one-hour window of 12 five-minute medians ([methodology PDF](https://docs.cfbenchmarks.com/CME%20CF%20Reference%20Rates%20Methodology.pdf)).
  - Both were confirmed through web search result summaries; the PDFs themselves were not read in full.

**Not verified / caveats**
- **Band-follower timing.** The model puts arbitrage at the top of the block and the attacker at the bottom, and ignores multi-pool routing, builder bribes and the USDT basis at sub-hour scales. The real-path replay suggests the error is within about ±30% in band.
- **Optimality of the attacker strategies.** "Floor" and "offset" are natural attacks, not proven optimal. A cheaper in-band strategy could exist, so treat C(δ) as an estimate, not a lower bound. The clairvoyant M2 bound is an upper bound on attacker gain only *given* this C(δ).
- **Blocks and σ.** Only L1 12 s blocks were measured with real data; the L2 figures are simulation only. σ = 0.52 was used, while the realised σ at 12 s over the 2 days was 0.49.
- **Liquidity.** y_v is the active liquidity at the current tick, and deep moves cross ticks. A single constant-L range was used, which is fine for ≤ 60 bp given the density near the price that report 02 §4.2 measured.
- **1 bp pool band.** The effective band f_eff = 3 bp is a calibration from the deviation sd, **UNVERIFIED** as a structural parameter.
- **On-chain κ.** Computing κ with solady `lnWad` is recommended based on report 03's error measurements. The threshold's floor/ceil against `lnWad` rounding was **not** tested in Solidity.
- **EIP-7825.** The ≈750 slots per transaction limit on ring growth comes from report 02 and was not re-checked.

## Sources

- Code: `scratchpad/repos/v3-core` (`d0831dc`), `v4-core` (`46c6834`), `oz-uniswap-hooks` (`80bd724`), with the files and lines cited inline.
- Reports 02, 03, 04, 05 and 06 in `docs/md/research/`.
- [Deribit Support: Settlement](https://support.deribit.com/hc/en-us/articles/29734325712413-Settlement)
- [CME CF Reference Rates Methodology (CF Benchmarks)](https://docs.cfbenchmarks.com/CME%20CF%20Reference%20Rates%20Methodology.pdf)
- [CME Group FAQ: CME CF Cryptocurrency Benchmarks](https://www.cmegroup.com/articles/faqs/cme-cf-cryptocurrency-benchmarks-faq.html)
- Uniswap Labs, "Uniswap v3 TWAP Oracles in Proof of Stake" (<https://blog.uniswap.org/uniswap-v3-oracles>), via report 02 §1.4.
- Data: Ethereum mainnet `eth_getLogs` (tenderly and mevblocker public RPCs); Binance `data-api.binance.vision` 1 s klines.
