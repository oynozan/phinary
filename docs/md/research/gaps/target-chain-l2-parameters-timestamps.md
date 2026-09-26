# Gap: target chain — L2 parameters, timestamp/sequencer semantics, deployments and gas (Arbitrum One vs Base vs L1)

**Date:** 2026-09-26. **Scope:** declare a chain for the proof and for the product, and replace the L1-only or
simulated inputs of the settlement, quote, oracle and economic reports with measured values for Arbitrum One and Base:
κ_in, y_v, band bias, C(δ), Q_safe (w ∈ {30 min, 2 h, 4 h}), pool-vs-CEX lead–lag, start-of-block (SoB) oracle error,
`block.timestamp`/`block.number` semantics and sequencer power, the v4 deployment set, and per-swap gas in USD.
**Status:** research result. Every number comes from code I ran on data I fetched on 2026-09-25/26 unless it is cited
to another report.

**Where things are.**
- `$L` = `docs/md/research/gaps/l2-chain-scripts/`: scripts `01`–`11`, outputs `out*.txt`, data `data/` (22 MB).
- To run: `cd $L && uv run --with numpy --with scipy --with pandas python <script> <args>`. Script `02` imports the
  settlement report's simulator (`../settlement-scripts/common.py`, `05_attack_econ.py`) unchanged.
- Data (all `eth_getLogs`/headers from public RPCs, Binance 1 s klines from `data-api.binance.vision`):

| set | source | range (UTC) | rows |
|---|---|---|---|
| Arbitrum v3 WETH/USDC 5 bp `0xC696…E8D0` Swap logs | arb1.arbitrum.io, blocks 508,114,694–508,805,894 | 2026-09-23 13:10 → 09-25 15:34 | 62,098 swaps, 23,679 blocks |
| Arbitrum block headers (every swap block + 12,000 contiguous blocks) | 8 public RPCs, sharded (`arb_ts.py`) | same | 23,679 + 12,000 |
| Base v3 WETH/USDC 5 bp `0xd0b5…F224` Swap logs | mainnet.base.org, blocks 51,478,346–51,780,746 | 2026-09-18 15:40 → 09-25 15:40 (7 d; 2 d subset also used) | 177,969 swaps |
| Ethereum v3 USDC/WETH 5 bp `0x88e6…5640` (same-period control) | publicnode/tenderly, blocks 26,040,652–26,055,411 | 2026-09-23 14:04 → 09-25 15:34 | 15,747 swaps |
| Binance ETHUSDT 1 s closes | klines API | 2.1 d and 7.1 d windows ending 2026-09-25 | 181,441 / 613,441 |

**Tooling gotcha (Arbitrum):** the public arb1 RPC returns `blockTimestamp = 0` in about 72% of `eth_getLogs` rows.
Timestamps therefore come from block headers (`arb_ts.py`), not from the log field.

**Conventions.** As in the settlement report: r = 0, σ annualised over 365 d, f = 5 bp, `y_v` = virtual USDC reserve of
the active range (`L·√P_raw`, or `L/√P_raw` for the flipped mainnet pool), `n_w = w/Δ` where **Δ is the oracle's sample
spacing**: 12 s on L1, **1 s on Arbitrum** (v3 writes one observation per distinct `block.timestamp`; §3.1), and 2 s on
Base. "Real path" means that the band-follower simulator is driven by the actual Binance 1 s path sampled at Δ.

---

## 0. Findings in brief

1. **Arbitrum is the deepest and fastest source; Base is about 3× thinner.**
   - y_v (harmonic mean over swaps): Arbitrum **$162.5M** (live $168.6M), Base **$65.1M** over 2 d and **$55.0M** over 7 d
     (p5 $37.4M), L1 $151.4M.
   - Ring spans (live): Arbitrum **46.9 h**, Base **26.4 h**, L1 6.9 h (`out10_ring.txt`).
2. **κ_in is now measured on L2.** Per oracle slot on the real path, κ_in is **0.018 on Arbitrum (Δ = 1 s), 0.032 on
   Base (2 s), and 0.116 on L1 (12 s).** Per window this gives k_w = κ_in·n_w·y_v, per unit log²:
   - Arbitrum **7.1·10⁹**, Base **2.1·10⁹**, L1 **3.1·10⁹** at w = 30 min.
   - Per dollar of y_v, in-band shifts cost **1.7–1.8× more on L2 than on L1**. This confirms the settlement report's
     simulated 1.75× (`out02_*.txt`).
3. **Q_safe for a binary market** (committed attacker, 1¢ spread, σ_G at 0.52, real-path cost curve):

   | | 30 min | 2 h | 4 h |
   |---|---|---|---|
   | Arbitrum | **$12.5k** | $122k | **$487k** |
   | Base | $3.7k | $37k | $151k |
   | L1 (same period) | $5.6k | $62k | $249k |

   - The GBM curves the settlement report used overstate these figures by 1.3–1.6×.
   - Ramp h = 100 bp at 30 min: Arbitrum $88k, Base $27k, L1 $45k.
4. **A real tail event on Arbitrum breaks the band-follower cost model for large shifts.**
   - On **2026-09-24 at 19:39:58 UTC**, about $6M of buys pushed the Arbitrum 5 bp pool **+3% to +6% above Binance for
     about 6 minutes**. Base and L1 did not move (`06_arb_event.py`).
   - Buyers lost **$200k** against the CEX mark and shifted the 30-min TWAP by **+47 bp**. The band-follower model prices
     that shift at about $1.9M, so the real cost was roughly **10× cheaper** than modelled.
   - Arbitrage reverted the deviation with a half-life of about 30–90 s, not within one 1 s slot.
   - The same event made up **47.8% of the 2-day Σr²** of the 5-min TWAP-return σ estimator. It pushed that estimate from
     56% to 77% (pool/Binance variance ratio 1.88). The oracle report's 400-tick clamp did not bind: the largest return
     was 239 bp.
   - Outside the event, the band follower fits every pool well: tracking MAD is 1.4 bp on Arbitrum, 1.4 bp on Base and
     1.6 bp on L1 (`out08_rho.txt`).
5. **Band bias (TWAP-return RV, H = 300 s).**
   - Implied c in `v_pool = v_ref − c·γ²/H`: **Base c = 0.37** (7 d; bootstrap ratio CI [0.946, 0.976]), **L1 c = 0.40**,
     and **Arbitrum c ≈ 0.13 excluding the event** (2 d only).
   - The oracle report's β = 0.5·γ²/H therefore over-corrects by about 1–3 variance points on L2. Use a per-chain c.
6. **Pool vs CEX (normal regime).**
   - Correlation of 12 s returns with Binance: Arbitrum **0.715** (ex-event), Base 0.60, L1 0.54.
   - The Arbitrum pool moves in the same second as Binance (peak at lag 0). A Base block stamped t reflects Binance up
     to about t (peak at +2 s on the Δ = 2 s grid). Honest timestamps on both L2s are therefore aligned with wall-clock
     time to within about 1 s.
   - SoB oracle error SD at the chain's own oracle age: **Arbitrum 3.0–3.1 bp** (≤ 1 s), **Base 3.5 bp** (2 s), **L1
     4.9 bp** (12 s). At a common 12 s age the three are 4.45 / 4.60 / 4.85 bp.
7. **Timestamps.**
   - **Arbitrum.** The sequencer sets them from its own clock. They are monotone, and it is **4 blocks per timestamp for
     89% of seconds** (3 for 10%), with no skipped seconds in a 50-min sample.
     - The on-chain bound is `maxTimeVariation = (7200 blocks, 64 blocks, 86,400 s, 768 s)`, read from SequencerInbox on
       L1. That is up to 24 h behind and 768 s ahead. The docs say "1 hour" ahead; the chain says 768 s.
     - `block.number` is the **L1** block number. It advances every 15.5 s on average (+1 or +2) and lags the L2 timestamp
       by 3–24 s.
   - **Base.** `timestamp = 1,686,789,347 + 2·n`, exactly. I checked blocks from genesis to head, including the 2026-06-25
     halt.
     - During that halt the chain produced deposit-only blocks with regular timestamps. They were built after the fact,
       so chain time lagged wall-clock time.
8. **Sequencer power.**
   - On **both** L2s a malicious sequencer can shift a TWAP for the cost of about one push. Two ways:
     - **Censor arbitrageurs** (both chains). Force-inclusion bounds: about 24 h on Arbitrum (delayed inbox); on Base,
       about 30 min through `max_sequencer_drift`, derived from the spec (UNVERIFIED in practice).
     - **Arbitrum only:** re-weight time. Jump the timestamp forward by up to 768 s right after pushing, and that one tick
       carries 768 s of weight. For a 1% push on a 30-min window this is a **43 bp** TWAP shift for about **$1.6–4.5k**,
       against about $1.6M through honest time.
   - The honest ordering layer gives outside parties end-of-slot power too:
     - on Arbitrum, the Timeboost express lane (200 ms head start, 60 s rounds, bought at auction);
     - on Base, priority ordering within 200 ms Flashblocks, which cannot be back-run inside the same flashblock.
   - So **m_a = 1 on both L2s.** The trusted-sequencer assumption must be declared explicitly.
9. **Deployments are verified on-chain.** Canonical PoolManager, StateView, V4Quoter, PositionManager, UniversalRouter
   (V2 plus the newer V2_1_1 and V2_1_2) and Permit2 addresses all have code on Arbitrum and Base (§4). The PoolManager
   runtime is 24,009 bytes on all three chains.
10. **Gas.** An integrated PredictionHook swap (180–300k gas) costs **$0.010–0.017 on Arbitrum** (0.020 gwei) and
    **$0.003–0.0045 on Base** (0.0055 gwei), against **$0.40–0.66 on L1** at today's unusually low 0.82 gwei. The L1
    data fee is ≤ $0.0007 on both L2s (live receipts of 40 v4 swaps each, `out03_gas.txt`).
11. **Recommendation.**
    - **Primary fork-test chain for the proof: Base.** It has deterministic time (T ↔ block number), standard EVM
      semantics, free archive RPCs, and the full v4 stack. Its thinner pool makes every cap derived there conservative.
    - **Product chain: Arbitrum One.** It has 2.3× L1 and 3.4× Base in-band manipulation cost per window, the longest
      oracle ring, the lowest SoB error, and $0.01 swaps. Four conditions apply:
      - w ≥ 2–4 h for binaries;
      - caps from real-path κ_in with the event discount (§2.5);
      - a robust σ estimator;
      - sequencer-uptime and timestamp-consistency guards (§3.4).
    - A second Arbitrum fork suite must cover the chain-specific semantics (§5).

---

## 1. Pool-level measurements (`01_pool_vs_cex.py`, `09_arb_ex_event.py`, `10_ring_span.py`)

### 1.1 Summary table

| quantity | L1 v3 5 bp (control) | **Arbitrum v3 5 bp** | **Base v3 5 bp** |
|---|---|---|---|
| oracle sample spacing Δ | 12 s | **1 s** (3.91 blocks per timestamp) | **2 s** |
| y_v harmonic over swaps (2 d) | $151.4M | **$162.5M** (p5–p95 $155–173M) | **$65.1M** (7 d: **$55.0M**, p5 $37.4M, p95 $80.0M) |
| y_v live (`slot0`, `liquidity`) | $155.3M | $168.6M | $67.3M |
| ring (cardinality, span) | 723, **6.9 h** | 9,000, **46.9 h** | 5,000, **26.4 h** |
| USDC volume / swaps per day | $58M / 7.6k | $83M / 28.9k | $22M / 25.4k |
| realised σ on the grid (period) | 0.517 | 0.445 | 0.438 (2 d), 0.477 (7 d) |
| pool − Binance deviation SD (1 h median basis removed) | 3.67 bp | **2.98 bp ex-event** (11.85 bp with it) | 3.28 bp (7 d) |
| share within ±f / ±2f | 85.6% / 99.6% | 95.0% / 100% ex-event | 89.7% / 99.9% |
| slots with an up / down / no move | 26.9 / 31.6 / 41.5% | 4.7 / 4.5 / 90.8% | 14.8 / 17.3 / 67.9% |
| tracking error vs 5 bp band follower (sd; MAD, ex-event) | 2.33; 1.62 bp | 2.13; 1.39 bp | 1.55; 1.40 bp |
| gaps between swap timestamps (median / p99 / max) | 12 / 84 / 264 s | 3 / 107 / 538 s | 4 / 38 / 168 s |

The L1 control reproduces the settlement report (deviation SD 3.67 vs 3.63 bp; up-move share 26.9% vs 26.9%).

### 1.2 Lead–lag and SoB error (question b)

Correlation of pool returns with Binance returns lagged L seconds (L > 0: Binance earlier):

| chain, return interval | L = −Δ | 0 | +1 s | +2 s | +12 s | +24 s | +60 s |
|---|---|---|---|---|---|---|---|
| Arbitrum, 1 s (ex-event) | +0.03 | **+0.453** | +0.270 | +0.117 | +0.040 | – | – |
| Base, 2 s (7 d) | +0.012 | +0.131 | +0.408 | **+0.542** | +0.069 | +0.032 | +0.011 |
| 12 s returns: L1 / Arbitrum / Base | +0.05 / −0.00 / +0.01 | **0.544 / 0.715 / 0.599** | – | – | 0.249 / 0.317 / 0.404 | 0.133 / 0.146 / 0.145 | 0.055 / 0.046 / 0.029 |

- **How to read the timing.** `Y[g]` is the price after the last swap stamped before g.
  - On Arbitrum, the pool's change during second g−1 matches Binance over (g−1, g].
  - On Base, the change between the blocks stamped g−4 and g−2 matches Binance over (g−4, g−2].
  - Both L2s' timestamps therefore track wall-clock time to within the 1 s kline resolution. This is also the evidence
    that the honest Arbitrum sequencer does not skew timestamps.
- **Absorption.** The beta of the pool return on the same-interval Binance return:
  - at 12 s: 0.53 (Arbitrum), 0.43 (Base), 0.45 (L1);
  - at 60 s: 0.79 / 0.73 / 0.73.

  The CEX leads on every chain. Arbitrum absorbs fastest.

SoB oracle error vs Binance (SD, bp) by oracle age. The chain's own age is in bold:

| age | 0 s | 1 s | 2 s | 4 s | 12 s | 60 s |
|---|---|---|---|---|---|---|
| Arbitrum (ex-event) | **2.98** | **3.12** | 3.26 | 3.52 | 4.45 | 8.02 |
| Base (7 d) | 3.28 | 3.40 | **3.53** | 3.77 | 4.60 | 7.89 |
| L1 | 3.67 | 3.76 | 3.86 | 4.08 | **4.85** | 8.11 |

**Consequence for the economic report.**
- Its L2 latency column assumed 2 s blocks (§6.4 there). Base's measured SoB error at 2 s (3.53 bp) and its band-model
  fit (1.2–1.4 bp) support that column as the Base charge.
- Arbitrum's 1 s epochs are at least as good. Its latency charge should be ≤ the 2 s column, but it was **not
  re-simulated (UNVERIFIED)**.
- The γ_S default for the quote function's gamma term (05/04 "5 bp on L1") becomes about **3.5 bp on Base and 3 bp on
  Arbitrum.**

---

## 2. κ_in, C(δ) and Q_safe on real L2 paths (question a; `02_attack_cost.py`)

### 2.1 Method

The method is the settlement report's band-follower replay (§2.1 and §2.4 there), with Δ set to the chain's oracle
spacing:
- 199 overlapping 30-min windows on Arbitrum (n_w = 1,800);
- 670 on Base 7 d (n_w = 900);
- 196 on L1 (n_w = 150).

Two further choices:
- **Linear scaling in w.** Costs scale linearly in n_w (a stationary per-slot cost), so the 2 h and 4 h curves are the
  30-min curve × 4 and × 8. The settlement report's own 2 h run confirms this: $4,782 vs 4 × $1,208.
- **Q_safe.** It uses the settlement report's numerical committed-attacker bound (`05_attack_econ.q_safe`: optimum over
  shift and moneyness at τ = w + 5 min, spread 1¢, σ_G at σ = 0.52). The only change is that the real-path cost curve
  replaces GBM.

**Is the band follower the right model on L2?**
- Yes in the normal regime. A partial-reversion family (fraction ρ of the excess beyond the band removed per slot) and
  an effective-band family were fitted by the robust tracking error against each real pool (`08_fit_rho.py`).
- **ρ = 1 wins on all three chains** (tracking MAD Arbitrum 1.39, Base 1.40, L1 1.62 bp), and f_eff = 4–5 bp.
- The exception is §2.5.

### 2.2 κ_in (cost / (n_w·y_v·δ²), in band)

| s/f → shift | L1 real (GBM 0.52) | **Arbitrum real** (GBM) | **Base 7 d real** (GBM) |
|---|---|---|---|
| 0.5 → 1.25 bp | 0.123 (0.158) | **0.022** (0.032) | **0.037** (0.054) |
| 1.0 → 2.5 bp | 0.116 (0.154) | **0.018** (0.026) | **0.032** (0.045) |
| 2.0 → 5 bp (pin) | 0.156 (0.208) | 0.028 (0.070) | 0.049 (0.097) |
| above band (≥ 12.5 bp) | 0.33 | 0.33 | 0.33 |

- κ_in per slot falls as Δ shrinks, because each slot's reference move σ_b is smaller.
- n_w grows as 1/Δ, and the product κ_in·n_w is what matters. In-band cost per $ of y_v per 30 min at 2.5 bp:
  - L1 1.09·10⁻⁶;
  - Arbitrum 2.01·10⁻⁶ (**1.84×**);
  - Base 1.82·10⁻⁶ (**1.67×**).
- This replaces the settlement report's open item "L2 κ_in, simulated ≈ 1.75×".
- Recommended conservative constants, set from the real path, which is 20–35% below GBM: **κ_in = 0.015 per 1 s slot
  on Arbitrum, 0.03 per 2 s slot on Base**, and 0.10 on L1 (as before).

### 2.3 C(δ) in $ (real path; GBM σ = 0.52 in brackets)

| chain | w | 2.5 bp | 5 bp | 10 bp | 25 bp |
|---|---|---|---|---|---|
| L1 | 30 min | 165 [220] | 883 [1,179] | 7,154 [7,205] | 45,306 [45,453] |
| L1 | 2 h | 661 | 3,530 | 28,616 | 181,222 |
| L1 | 4 h | 1,321 | 7,060 | 57,231 | 362,444 |
| **Arbitrum** | 30 min | 326 [473] | 2,040 [5,286] | 90,467 [91,748] | 583,087 [585,782] |
| **Arbitrum** | 2 h | 1,303 | 8,158 | 361,868 | 2,332,346 |
| **Arbitrum** | 4 h | 2,607 | 16,317 | 723,735 | 4,664,692 |
| **Base (7 d, y_v $55M)** | 30 min | 100 [141] | 605 [1,201] | 15,352 [15,495] | 98,742 [99,074] |
| **Base** | 2 h | 400 | 2,422 | 61,409 | 394,969 |
| **Base** | 4 h | 800 | 4,843 | 122,819 | 789,938 |

**Reading the table.**
- Above the band, L2 costs are 6–13× L1 at the same y_v. The attacker must re-pay the band offset every slot, and there
  are 12× (Arbitrum) or 6× (Base) as many slots.
- **This out-of-band multiplier is exactly what the Arbitrum event contradicts (§2.5).** Do not rely on it for large
  shifts.

### 2.4 Q_safe (max gross OI per settlement window, $)

| chain | w | sd_G | k_w (real) | binary real [GBM] | ramp h = 25 bp | ramp h = 100 bp |
|---|---|---|---|---|---|---|
| L1 | 30 min | 27.8 bp | 3.08·10⁹ | **5,618** [7,241] | 7,576 | 45,015 |
| L1 | 2 h | 48.1 bp | 1.23·10¹⁰ | 61,618 [82,124] | 67,231 | 195,514 |
| L1 | 4 h | 66.1 bp | 2.46·10¹⁰ | **249,238** [340,305] | 260,226 | 496,894 |
| **Arbitrum** | 30 min | 27.8 bp | 7.11·10⁹ | **12,501** [18,089] | 15,096 | 88,307 |
| **Arbitrum** | 2 h | 48.1 bp | 2.85·10¹⁰ | 121,579 [176,501] | 132,655 | 384,568 |
| **Arbitrum** | 4 h | 66.1 bp | 5.69·10¹⁰ | **487,332** [745,135] | 508,817 | 977,830 |
| **Base 7 d** | 30 min | 27.8 bp | 2.08·10⁹ | **3,674** [5,317] | 4,632 | 27,363 |
| **Base 7 d** | 2 h | 48.1 bp | 8.31·10⁹ | 37,303 [52,495] | 40,702 | 119,162 |
| **Base 7 d** | 4 h | 66.1 bp | 1.66·10¹⁰ | **151,004** [221,619] | 157,661 | 304,362 |

(Base 2 d, y_v $65.1M: $4.1k / $41k / $165k for the binary; `out02_base.txt`.)

- The closed form `8π·s·k_w·sd_G²` is within 10–35% of the numerical optimum: it gives 13.8k, 166k and 625k on
  Arbitrum.
- **Base's Q_safe tracks y_v, which moved from $37M to $80M within one week.** On Base, the on-chain `k_w` must be
  computed from a trailing harmonic-mean liquidity, as the settlement report already prescribes, and never from a
  constant.
- **The settlement report's "Q_safe ∝ w²" holds on L2 as well:** ×9.7 from 30 min to 2 h, and ×39 from 30 min to 4 h.

**Per-epoch SoB cap (quote report §7.2).** `Q_epoch = m_a·c·√w/φ(d2)` with fee-only `c = f·y_v`, ATM, σ = 0.6, and
**m_a = 1** on both L2s (§3.3). Values are tokens per epoch:

| source | c ($ per 1%) | 1 h | 1 d | 7 d | epoch length |
|---|---|---|---|---|---|
| L1 v3 5 bp | 757 | 1,216 | 5,959 | 15,767 | 12 s |
| Arbitrum v3 5 bp | 813 | 1,306 | 6,396 | 16,923 | **1 s** |
| Base v3 5 bp (y_v $55M) | 275 | 442 | 2,165 | 5,728 | 2 s |

- The per-epoch figures are nearly identical on Arbitrum and L1. The epoch, however, is 12× shorter.
- Both the depth budget (λ) and Q_epoch must therefore be specified **per unit time**, not per epoch, if the product is
  to be comparable across chains. The economic report's finding that depth must be budgeted per block or per unit of
  time applies directly.

### 2.5 The 2026-09-24 Arbitrum dislocation (`06_arb_event.py`, `07_reversion.py`)

- **The sequence.** Starting in block 508,540,310 at 19:39:58 UTC:
  - a $1.24M USDC→WETH swap moved the pool from $2,692.6 to $2,733.8;
  - further buys of $1.1M, $0.69M, $0.89M and **$2.12M** (block 508,540,740 at 19:41:45) took it to **$2,869.9**,
    against Binance at about $2,696 (+6.4%).
- **The reversion.** Sells arrived in $0.25–0.57M clips. The pool was still +3.1% at 19:42:40 and +0.4% at 19:46,
  and it closed at about 19:47. Base and L1 stayed within ±5 bp of Binance throughout.
- **Who paid.**
  - Marked to Binance × the pre-event basis over 15 min, ETH buyers paid $9.29M and lost **$200k**. Sellers received
    $9.08M and gained **$187k**.
  - Whether this was a whale, a mis-routed order or a manipulation of a third party's oracle is unknown.
- **Effect on TWAPs.**
  - A 30-min window: **+47.4 bp**; 403 seconds had |deviation| > 25 bp.
  - A 2-h window: +11.5 bp.
  - A 4-h window: +5.1 bp.
- **The model's price for the same shifts.**
  - 47 bp over 30 min on Arbitrum costs about **$1.9M** in the model (exact out-of-band formula, e = 42 bp). The real
    cost was ≈ $200k, so the model overstates by **≈ 10×**.
  - At 4 h the real $200k bought only 5 bp, which the model prices at $16k. The model is conservative there.
- **Reversion speed.**
  - Outside the event, excess deviations of 5–20 bp beyond the band vanish within one 1 s slot (median remaining 0).
  - Inside it, excesses above 20 bp had a median of **68% remaining after 60 s** and 32% after 120 s.
  - Arbitrage capacity on Arbitrum is **capital- or flow-limited, about $0.3–0.6M per clip**. Arbitrage is not
    latency-limited.
  - Base (7 d) had only 3 slots with excess > 20 bp, all closed within 2 s. L1 had 8 such slots, closed within 12 s.
- **Consequences.**
  1. For **large shifts at short w on Arbitrum**, use an empirical cost of about **$200k per 47 bp per 30 min**.
     - That is roughly `C_emp ≈ 0.1·C_model` at 30 min.
     - The committed-attacker Q_safe of §2.4 is unaffected: its optimum shift is 5–15 bp, where the fitted model holds.
     - The **clairvoyant (M2) bound, and any Q above about $100k on a 30-min binary, must use C_emp.**
     - Example: a $1M ATM binary position on a 30-min window gains about $450k from a 47 bp shift, which costs about
       $200k. **30-min binaries are not safe at size on Arbitrum.**
  2. **The σ estimator.**
     - In the 5-min TWAP-return RV, the event contributed **47.8% of Σr²** over 2 days. It raised the H = 300 s pool/CEX
       variance ratio from 0.987 (ex-event) to **1.88**. At H = 900 s the effect is 14.5% and 1.18.
     - The 400-tick clamp did not bind (max |r| 239 bp).
     - Use a **robust estimator** on Arbitrum:
       - a clamp tied to σ, e.g. |r| ≤ 6·σ̂·√H ≈ 60–70 bp at H = 300 s;
       - or bipower / median-RV;
       - and the regime flag (v_1d/v_3d) from the oracle report as a creation halt.
  3. A **deviation circuit breaker** (quote report `δ_cb`, 1–1.5%) would have halted quotes for about 5 min. It works
     only if a reference independent of this pool exists, e.g. a second venue. On a single-pool design, the SoB-vs-TWAP
     anchor is the only internal signal.

---

## 3. Timestamp and sequencer semantics (question c; `05_timestamps.py`, `11_ts_vs_l1.py`)

### 3.1 What the chains do (measured)

| | L1 | **Arbitrum One** | **Base** |
|---|---|---|---|
| who sets `block.timestamp` | proposer, = slot start (12 s grid) | **sequencer's clock**, monotone non-decreasing, in [L1 − 86,400 s, L1 + **768 s**] (SequencerInbox `maxTimeVariation()` on L1 returns `(7200, 64, 86400, 768)`) | **deterministic:** `1,686,789,347 + 2·n`; verified at n = 1, 10⁶, 2·10⁷, 47,806,540–47,812,000 and head |
| blocks per timestamp | 1 | **4 (89.3%), 3 (10.3%)**, mean 3.91; distinct timestamps always +1 s in 3,070 s sampled | 1 |
| `block.number` seen by contracts | L1 number | **L1 block number** (header `l1BlockNumber`): advances every 15.5 s (+1: 141 times, +2: 56 times); lags the L2 timestamp by a median of 9 s (3–24 s) | L2 number |
| oracle sample (v3 `Oracle.write` returns early when `last.blockTimestamp == blockTimestamp`, `v3-core/contracts/libraries/Oracle.sol:90`; writes only on a tick change, `UniswapV3Pool.sol:733`) | end of each 12 s block | **end of the last block in each second** | end of each 2 s block |
| halt signature | missed slots (12 s) | no blocks, then a timestamp **gap**. Last acknowledged outage 2026-05-20 (Chainlink uptime feed `startedAt` 20:06:47 UTC); Dec 2023 about 78–88 min | **no gap:** deposit-only blocks with regular timestamps, produced later. 2026-06-25: sampled blocks 47,806,600–47,808,800 (chain time 15:49–17:02 UTC) held 1 tx each; about 108 min of wall-clock halt |
| ordering | PBS builders | FCFS + **Timeboost** (express lane: 200 ms advantage, 60 s rounds, sealed-bid second-price auction) | priority fee within **200 ms Flashblocks**; ordering is final per flashblock |
| force inclusion | n/a | delayed inbox after 7,200 L1 blocks / 86,400 s (≈ 24 h) | deposits must be included once the L1 origin advances, which `max_sequencer_drift` = 1,800 s forces (spec) |

Sources: [Arbitrum block numbers and time](https://docs.arbitrum.io/build-decentralized-apps/arbitrum-vs-ethereum/block-numbers-and-time), [Timeboost](https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction), [OP Stack derivation spec](https://specs.optimism.io/protocol/derivation.html), [Base Flashblocks](https://docs.base.org/base-chain/network-information/block-building), Base halt ([summary](https://www.spotedcrypto.com/base-blockchain-outage-june-2026-sequencer-invalid-block/)), Arbitrum outages ([Offchain Labs](https://offchain.medium.com/todays-arbitrum-sequencer-downtime-what-happened-6382a3066fbc), [status page](https://status.arbitrum.io/clq6te1l142387b8n5bmllk9es)).

### 3.2 Effect on the design's time-keyed objects

1. **Epoch key `block.timestamp`** (quote report §epoch key, lines 90–94; SeriesHook cutoffs).
   - **Arbitrum.**
     - One epoch is 1 s, which is about 4 blocks. All of them see the same SoB: v3's observation at t is written by the
       first tick-changing swap stamped t, carrying the end-of-(t−1) tick.
     - `V3ObserveAdapter.sobTick` (`underlying-oracle-prototype/src/V3ObserveAdapter.sol:127-135`) derives that
       start-of-second tick when `ts == block.timestamp`. The quote report's per-epoch theorems (round-trip loss,
       extraction ≤ `((|F−P_sob|−h₀)⁺)²/(2λ)`) therefore hold **per second**, with "block" read as "second".
     - Keying by `block.number` would be wrong twice over: it is the L1 number, so the epoch would be about 15.5 s,
       irregular and occasionally +2. That would be coarser than the oracle and cost ×1.76 in extraction (quote report
       MC C). OZ `BaseOracleHook` also keys by `block.timestamp` (`oz-uniswap-hooks/src/oracles/panoptic/BaseOracleHook.sol:124-131`).
   - **Base.** The epoch is one 2 s block. No change from the report.
2. **τ = expiry − block.timestamp.** Resolution is 1 s on Arbitrum and 2 s on Base. On Arbitrum up to about 4
   consecutive blocks price at the same τ; that is harmless because the SoB is also per second. Neither chain can move τ
   by more than the skew bounds: 0 on Base; honest ≤ 1 s on Arbitrum (§1.2), malicious ≤ +768 s or −24 h.
3. **T and T−w checkpoints.**
   - **Arbitrum.** `cum(T)` is identical in every block stamped T. Either an observation at T exists and `observeSingle`
     returns it (`Oracle.sol:256`), or the tick has been constant since the last write. So a checkpoint read at any
     block with ts ≥ T is exact.
   - **Base.** Block timestamps are **odd** (genesis 1,686,789,347 + 2n). A T on an even or 300 s grid falls between
     blocks, and `cum(T)` is v3's exact linear interpolation. The settlement statistic then has half-weight (1 s) edge
     samples. To make the discrete-Asian formula of the settlement report exact, **choose T ≡ 1 (mod 2)**, or add the
     1 s edge terms. With n = 900 per 30 min the error is negligible either way.
   - A fork test on Base can compute the exact block holding T as `(T − 1,686,789,347)/2`.
4. **Grid checkpoints for σ (H = 300 s).** These are unaffected on both chains. The rings (Arbitrum 46.9 h, Base 26.4 h)
   are shorter than the 3-day σ window, so the oracle report's keeper checkpoints are still required on both.

### 3.3 Can a sequencer profitably manipulate?

- **Arbitrum, time re-weighting.**
  - Two steps. First, push the pool by δ at the end of block k. Second, stamp block k+1 up to 768 s ahead, and keep
    later timestamps constant until wall-clock time catches up.
  - The manipulated tick then carries J ≤ 768 s of weight: `ΔTWAP = δ·J/w`.
  - For δ = 1% and w = 30 min this is **+43 bp**. The cost is one push, `push_cost` ≈ $4.5k (≈ `y_v(fδ + δ²/4)`), or ≈ $1.6k
    in fees if the sequencer back-runs itself.
  - The same shift through honest time costs about **$1.6M** (§2.5 model; `settlement-scripts/common.py` exact
    formula), or on the order of $200k at the event's real price.
  - Lagging timestamps (up to 24 h behind) allow the converse: they freeze a chosen tick's weight.
- **Both chains, censorship.**
  - Excluding arbitrage transactions for the window holds a pushed price at the cost of one push.
  - The bound is the force-inclusion delay: about 24 h on Arbitrum; about 30 min on Base per the spec (UNVERIFIED in
    practice).
- **Non-sequencer parties with end-of-slot power.**
  - **Arbitrum:** the Timeboost express-lane controller, whose 200 ms head start means non-express arbitrageurs cannot
    respond within the same second.
  - **Base:** any sender that lands in the last flashblock of a block. Back-runs cannot share its flashblock.
  - Both make the "push at the end of slot k, trade at k+1" attack of the quote report available without owning
    consecutive blocks, hence **m_a = 1**.
  - The dual-anchor multiplier (`m_a ≈ W_a/Δt`) must not be claimed on either L2.
- **Is it profitable?** For a malicious sequencer, yes, for any OI above a few thousand dollars. It is not preventable
  on-chain.
  - **Declare the trusted-sequencer assumption** for both L2s.
  - Base's trust surface is smaller: no timestamp freedom, and a shorter force-inclusion bound.
  - The honest sequencers' measured behaviour is benign: time aligned to within 1 s, and no skipped or duplicated
    seconds in the sample.

### 3.4 Guards to implement (cheap, per chain)

1. **Sequencer uptime.** Chainlink L2 Sequencer Uptime Feeds are live:
   - Arbitrum `0xFdB631F5EE196F0ed6FAa767959853A9F217697D`: answer 0 (up), `startedAt` 2026-05-20 20:06:47;
   - Base `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`: answer 0, `startedAt` 2026-06-26 16:31:47.

   Void or extend settlement, and halt quoting, if the feed was down or restarted within [T − w − grace, T + grace].
2. **Arbitrum timestamp consistency.** At each registered checkpoint, store `(block.timestamp, block.number)`, where
   `block.number` is the L1 number. Require `|Δts − 12·ΔL1| ≤ 120 s + 0.03·w` between the checkpoints bracketing a
   window.
   - Honest residuals over 2 days (`out11_ts_vs_l1.txt`), driven by L1 missed slots:
     - 30 min: median +13 s, p99 +65 s, max +192 s;
     - 4 h: median +132 s, max +350 s.
   - A 768 s jump is detected. Jumps under about 300 s are not (UNVERIFIED as sufficient).
3. **Base.** Timestamps need no guard. A halt is invisible in the timestamps (deposit-only blocks) and must come from
   the uptime feed. Optionally, `L1Block` (`0x4200000000000000000000000000000000000015`) supplies the L1-origin number
   and timestamp for a similar consistency check. Thresholds UNVERIFIED.

---

## 4. Deployed contracts (question d; `eth_getCode` 2026-09-26, `out` in §Verification)

Canonical v4 addresses come from the [Uniswap v4 deployments page](https://developers.uniswap.org/contracts/v4/deployments).
UniversalRouter versions come from `universal-router/deploy-addresses/{arbitrum,base}.json`. The repo is at commit
a9c574f (2026-09-22) with `package.json` version 2.1.0. Runtime sizes are in bytes:

| contract | Arbitrum One (42161) | size | Base (8453) | size |
|---|---|---|---|---|
| PoolManager | `0x360e68faccca8ca495c1b759fd9eee466db9fb32` | 24,009 | `0x498581ff718922c3f8e6a244956af099b2652b2b` | 24,009 |
| StateView | `0x76fd297e2d437cd7f76d50f01afe6160f86e9990` | 3,531 | `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71` | 3,531 |
| V4Quoter | `0x3972c00f7ed4885e145823eb7c655375d275a1c5` | 5,820 | `0x0d5e0f971ed27fbff6c2837bf31316121532048d` | 5,820 |
| PositionManager | `0xd88f38f930b7952f2db2432cb002e7abbf3dd869` | 23,877 | `0x7c5f5a4bbd8fd63184577525326123b519429bdc` | 23,877 |
| UniversalRouter V2 (docs) | `0xa51afafe0263b40edaef0df8781ea9aa03e381a3` | 19,499 | `0x6ff5693b99212da76ad316178a184ab56d299b43` | 19,499 |
| UniversalRouter V2_1_1 (repo) | `0x8B844f885672f333Bc0042cB669255f93a4C1E6b` | 24,546 | `0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7` | 24,546 |
| UniversalRouter V2_1_2 (repo) | `0x2d01411773c8C24805306E89A41F7855C3c4Fe65` | 24,380 | `0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40` | 24,380 |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | present | same | 9,152 |
| v3 WETH/USDC 5 bp (oracle source) | `0xC6962004f452bE9203591991D15f6b388e09E8D0` | 22,142 | `0xd0b53D9277642d899DF5C87A3966A349A798F224` | 22,142 |

**Notes.**
- **The PoolManager is v4.0.0.** The local `v4-core` clone is tagged `v4.0.0` (HEAD 46c6834, 2026-04-02). Its runtime
  size is identical on L1 (`0x0000…4444c5…8A90`), Arbitrum and Base. The code hashes differ per chain, as expected from
  the immutable owner and address. A bytecode match against a compiled v4.0.0 was **not** done (UNVERIFIED).
- **Which UniversalRouter to fork against.** The docs page still lists UR V2. The repo lists two newer UR deployments
  (2.1.1 and 2.1.2) on both chains. Fork tests should route through **UR V2_1_2**, the latest, and V2 as a compatibility
  check.
- **V4Quoter works with NoOp hooks.** It simulates the swap through the real PoolManager and returns the result
  revert-encoded, so a NoOp hook's quote is exact within the same epoch (quote report §Quoter).
- **Permit2 on Arbitrum.** The first probe of Permit2 on Arbitrum returned empty because of a rate limit. A retry
  returned code (`0x6040608081…`).

---

## 5. Per-swap gas in USD (question e; `03_gas_fees.py`)

Live receipts of the last 40 v4 swaps (PoolManager `Swap` topic `0x40e9cecb…112f`) on each chain, 2026-09-26. ETH is
$2,690.

| chain | median execution gas (other v4 swaps) | median gas price | median total fee | L1 data part (median / max) | p90 total | **hook swap 180k / 250k / 300k gas** |
|---|---|---|---|---|---|---|
| Arbitrum | 161,216 | 0.0204 gwei | $0.0091 | $0.0002 / $0.0007 | $0.041 | **$0.010 / $0.014 / $0.017** |
| Base | 196,910 | 0.0055 gwei | $0.0047 | < $0.0001 / $0.0003 | $0.057 | **$0.0027 / $0.0037 / $0.0045** |
| L1 | 331,195 | 0.824 gwei | $0.71 | – | $9.96 | **$0.40 / $0.55 / $0.66** |

Where the gas budget comes from:
- **Prototype path.** PoolSwapTest buy is 185k warm and about 236k cold (swap-path report); the LP-vault path is
  204–210k cold.
- **Pricing and oracle.** Black–Scholes maths adds 3–5k. The oracle read adds 6–11k in mode A and 20–28k in mode B
  (oracle report).
- **Routing.** UR/Permit2 routing adds about 30–50k (**UNVERIFIED**; not measured through UR).

**The p90 tails come from priority fees**, not from base fees. The quote report's per-trade friction is
**< 0.1¢ per trade on either L2**. On L1 a $50 trade pays about 1% in gas.

---

## 6. Recommendation (the declared chain)

### 6.1 Primary fork-test chain for the proof: **Base mainnet (8453)**

1. **Deterministic time.** `ts = 1,686,789,347 + 2n` makes every claim that depends on T, T−w, H-grids and τ
   reproducible from a block number. `vm.warp` and `vm.roll` stay consistent (warp = 2·roll). The quote/settle cutoff
   and the discrete-Asian n are exact.
2. **Standard EVM semantics.**
   - `block.number` is the L2 number, there are no chain-specific precompiles, and the OP predeploys are ordinary
     contracts.
   - Arbitrum forks need Foundry ≥ v1.8.3 for L1 `block.number` semantics. That release note reads "Preserved Arbitrum L1
     `block.number` semantics during local execution…"; its date was not verified. Arbitrum forks also have no stock
     ArbSys (0x64).
3. **Free archive state.** `mainnet.base.org`, `base.drpc.org` and `base.gateway.tenderly.co` all served 30-day-old
   state. On Arbitrum only tenderly and blastapi did; arb1 and drpc refused.
4. **The full v4 stack plus a deep enough oracle.** The 26 h ring covers w ≤ 4 h plus margin.
5. **Conservative.** y_v is about 1/3 of Arbitrum's, so every cap proven on Base (Q_safe, Q_epoch, C(δ)) is a lower
   bound for Arbitrum's normal regime.

Pin the fork block and record `y_v`, `σ̂` and the ring state in the test log. Useful anchors: the 7-day window
51,478,346–51,780,746, and the June-2026 halt blocks around 47,806,542 for a liveness/void-rule test.

### 6.2 Product chain: **Arbitrum One (42161)**, with conditions

**Why Arbitrum.**
- In-band manipulation cost per window is 2.3× L1's and 3.4× Base's.
- The oracle ring is the longest (46.9 h) and y_v is the largest ($163–169M, stable within ±6% over 2 d).
- It has the tightest pool-CEX tracking and the lowest SoB error (3.0–3.1 bp), 1 s epochs for latency, and $0.01
  swaps.
- It supports the economic report's 1 h and 4 h tenors, which are viable only on L2.

**Conditions, all derived above.**
1. **Binary settlement windows w ≥ 2 h (1 d markets) and 4 h (≥ 7 d markets).** On Arbitrum, per-window gross OI must
   not exceed:

   | w | binary | ramp h = 100 bp |
   |---|---|---|
   | 30 min | $12.5k | $88k |
   | 2 h | $122k | $385k |
   | 4 h | $487k | $978k |

   Apply the event discount (C_emp ≈ 0.1·C_model for shifts ≥ 25 bp at 30 min) to any M2 or large-Q analysis.
2. **κ_in = 0.015 per 1 s slot and y_v from trailing harmonic-mean liquidity** in the on-chain k_w.
3. **A robust σ estimator** (σ-scaled clamp or bipower RV) plus the regime halt. Measured band-bias c ≈ 0.1–0.4, so use
   c = 0.3 rather than 0.5, and re-fit it on 30 days.
4. **Guards:** the Chainlink sequencer uptime check, and the `Δts` vs `12·ΔL1(block.number)` consistency check (§3.4).
   Declare the **trusted-sequencer assumption** and m_a = 1.
5. **Epoch = `block.timestamp` (1 s), never `block.number`.** Budget λ and Q_epoch per unit time.
6. **A second, Arbitrum-specific fork suite** covering:
   - 4 blocks per timestamp: the same SoB and the same `cum(T)` across them;
   - L1 `block.number`;
   - the absence of ArbSys;
   - a replay of the 2026-09-24 event window (blocks 508,540,300–508,541,700) through the settlement and σ code.

**When to choose Base instead.** Choose Base as the product chain only if the team will not accept Arbitrum's
timestamp trust (§3.3). Base's caps are then about 30% of Arbitrum's:

| w | binary | ramp h = 100 bp |
|---|---|---|
| 30 min | $3.7k | $27k |
| 2 h | $37k | $119k |
| 4 h | $151k | $304k |

**Excluded chains.**
- **Unichain:** no deep oracle (the v3 5 bp pool holds $37k; oracle report §1.4).
- **L1:** viable for 1 d only, with a 7 h ring that needs checkpoints and $0.4–0.7 swaps.

---

## 7. Verification

**Verified (code run on primary data, or direct on-chain reads):**
- **Swap logs and pool series.** Arbitrum (62,098 swaps) and Base (50,715 over 2 d; 177,969 over 7 d) swap logs were
  fetched with exact block headers. The L1 control reproduces the settlement report's deviation statistics.
- **κ_in, C(δ), Q_safe** from the settlement report's unchanged simulator, driven by the real Binance path on each
  chain's grid (`out02_*.txt`). GBM controls are printed alongside.
- **Band-follower fit.** It fits the Arbitrum, Base and L1 pools best, ex-event, with ρ = 1 (`out08_rho.txt`).
- **The Arbitrum event**, reconstructed swap by swap. The buyer/seller P&L and the TWAP shifts are computed
  (`out06_arb_event.txt`). Its size in the σ estimator: `out04_arb.txt`.
- **Band-bias ratios**: Base 7 d with a day-block bootstrap, L1 2 d, Arbitrum 2 d ex-event.
- **Lead–lag, β absorption and the SoB error by age** on all three chains.
- **Timestamps.**
  - Base `ts = genesis + 2n` at 13 blocks, including the June-2026 halt window. Deposit-only blocks confirmed by
    sampling every 100 blocks.
  - Arbitrum: 12,000 contiguous headers, the L1 `block.number` cadence and lag, and the 2-day `Δts` vs `12·ΔL1`
    residuals.
  - `maxTimeVariation()` read on L1: (7200, 64, 86400, 768).
- **Deployments.** Code present at every v4 and UR address; UR versions from the repo JSON.
- **Chainlink uptime feeds** read live.
- **Gas** from 40 live receipts per chain.
- **Archive-RPC availability** for forks.

**Not verified / caveats:**
- **Short samples.**
  - Arbitrum covers only 2 days, and one tail event dominates it. κ_in and the band-bias c there carry wide uncertainty.
    The event may be rare or common; a 30+ day Arbitrum study is needed, both for the event frequency and for C_emp.
  - Base covers 7 days and L1 2 days.
- **Model ↔ reality for large shifts.** The ≈ 10× figure rests on **one** event and on its non-optimal attacker. The
  counterfactual is marked to Binance × the pre-event basis.
- **Latency charge for Arbitrum's 1 s epochs** was not re-simulated. The economic report's L2 (2 s) column is assumed to
  be an upper bound.
- **Force-inclusion bounds.** Base's ~30 min is derived from the spec (`max_sequencer_drift` = 1,800 s), not
  observed. Arbitrum's 24 h comes from the on-chain delayBlocks and delaySeconds.
- **Timestamp guard tolerance.** Adequacy of `120 s + 0.03·w` against a strategic sequencer is UNVERIFIED. It detects
  jumps of ≥ ~300 s only.
- **Tooling and bytecode.**
  - Foundry v1.8.3's Arbitrum `block.number` handling comes from its release notes only; the date was not verified.
  - The deployed PoolManager was not bytecode-matched to v4.0.0.
  - UR V2_1_x changelogs were not read.
  - UR/Permit2 routing gas (+30–50k) was not measured.
- **Incident records.** The Base 2026-06-25 halt duration comes from a secondary article; the on-chain evidence is the
  deposit-only block range. The Arbitrum 2026-05-20 incident is dated only by the uptime feed's `startedAt`, and its
  duration was not verified.
- **y_v is per swap, not time-weighted.** It is a harmonic mean over swaps. Base's liquidity varied from $37M to $80M
  within one week.

**Reproduce:**
```
cd docs/md/research/gaps/l2-chain-scripts
uv run python fetch_swaps.py arb 2; uv run python fetch_swaps.py base 2; uv run python fetch_bn.py; uv run python fetch_l1.py
uv run python arb_ts.py                                  # Arbitrum headers (logs lack timestamps)
uv run python fetch_swaps7.py base 7; uv run python fetch_bn7.py
R="uv run --with numpy --with scipy --with pandas python"
$R 01_pool_vs_cex.py arb; $R 01_pool_vs_cex.py base; $R 01_pool_vs_cex.py eth
$R 01_pool_vs_cex.py base data/swaps_base_7d.json.gz data/bn1s_7d.json.gz base7
$R 02_attack_cost.py {arb|base|base7|eth}
$R 04_band_bias.py data/swaps_base_7d.json.gz data/bn1s_7d.json.gz base   # and arb / eth
$R 05_timestamps.py; $R 06_arb_event.py; $R 07_reversion.py; $R 08_fit_rho.py; $R 09_arb_ex_event.py
uv run python 10_ring_span.py; uv run python 03_gas_fees.py 2690; $R 11_ts_vs_l1.py
```
