# Gap: simulator realism — Thales replay (gate E7), jump- and smile-informed adversaries

**Date:** 2026-09-26. **Scope:** carry out gate E7 of `economic-acceptance-criteria-and-backtest.md` (cited below as **EA §x**). Rebuild Thales' LP result from its on-chain tape and replay it through the simulator's accounting. Attribute the loss. Add jump-, smile- and drift-informed adversaries. Re-evaluate D\* for the 1-day v1 configuration and find the parameter changes that let E3/E4 hold against the extended adversary set. **Status:** research result. Every number comes from code I ran on 2026-09-25/26 unless it is cited.

**Where things are.**

- `$X` = `docs/research/gaps/simulator-realism/`. It holds all scripts and small outputs (`$X/out/*.txt`).
- The working directory with the large data is the scratchpad `…/scratchpad/e7/`. It holds the tape (`logs_all.json`, 60,357 logs), markets (`markets_all.json`, `markets_destroyed.json`), Deribit trades (`deribit/*.json`) and 1-minute prices (`px1m.npz`). The scripts rebuild all of it.
- The simulator (`econ/engine.py`, `econ/bt.py`) is unchanged. The new agents and defences live in `engine_x.py` and `btx.py`, which import the old engine. Old results are reproduced exactly (tail agent OOS +0.0036 B, as in EA §6.5).
- Units: **B** is the per-market loss budget. **D** is noise turnover per day ÷ per-strike budget. "1% NAV per market" is the vault convention of EA §6.5.

---

## 0. Findings in brief

1. **As written, E7 cannot discriminate.** Thales' −13.9% is statistically indistinguishable from zero. The 80 active weekly returns have mean −0.16% and SD 2.20%, so t = −0.66. The SE of the cumulative log return is 19.7 pp. A simulator of *expected* P&L can match "sign and ±50%" only by chance. I therefore split E7 into three testable layers: accounting, quote and flow (§1).
2. **Accounting layer: PASS.** I rebuilt all 54,297 Thales AMM trades in the LP era (6,640 markets, $11.30M of volume), with settlement taken from the markets themselves. 105 self-destructed markets were read through archive `eth_call`. Pushed through the simulator's ledger convention at the prices actually paid, the tape gives **−$44.4k, cumulative 0.852**, against **−$39.7k, 0.8615** on-chain. That is −14.8% vs −13.9%, the same sign and 7% apart. Per-round correlation is 0.961 and 95% of rounds have the same sign. Two things were needed for the match: the per-address fee overrides, and settling DOWN tokens separately.
3. **Quote layer: FAIL, and the cause is known.** The same tape re-priced with the simulator's "Thales-style" quote (EA §4.4) turns the loss into a **profit of +$76k (cumulative 1.145)**, or +$338k when the persistent skew uses B = $5k. Three causes:
   - Real Thales executions were on average **0.86 pp below** base ± nominal spread (3%, or 0.5% for whitelisted addresses), because of discounts for trades on the side the AMM already holds.
   - **45.7% of volume** came from 4 whitelisted contracts with `min_spreadPerAddress = safeBoxFeePerAddress = 0.5%`. RangedMarketsAMM alone was 34%.
   - Thales' price impact is measured against pool capacity, not against a per-market budget.
   
   The effective margin was **2.09¢/token** for ordinary traders and **0.83¢/token** for whitelisted ones.
4. **Flow layer: FAIL. This is what the adversary set was missing.** At the Thales mid (zero spread), the real flow took **−$342k from the LP (t = −4.3 across rounds)**. That is about 3.2% of notional. Spread income of +$320k almost cancelled it.
   - The extraction is **directional**: long-UP flow took −$493k and long-DOWN flow gave +$151k.
   - UP resolved **+7.7 pp (ETH) and +5.0 pp (BTC)** more often than Thales' odds, weighted by tokens, during a bull market.
   - The 24-hour markout is +0.67 pp/token (t ≈ 8). The 1-minute, 5-minute and 1-hour markouts are ≈ 0. The share of trades in the direction of the prior 5-minute move is 0.519. **So the flow shows no latency pattern.**
   - Jump weeks carry only 17% of the rebuilt loss.
   - The missing −σ²τ/2 drift term *helped* the LP by $5.9k.
   - Thales' own RangedMarketsAMM, trading at a 0.5% spread, cost the LP **−$100.6k**, which is more than the whole net loss.
   - On the 53% of ETH/BTC trades where a same-expiry Deribit smile exists, **the trades a smile desk would have taken (edge > +1¢) cost the LP −$98.4k**. LP P&L is monotone in the smile edge, from +11.5% to −17.3% of volume. Thales' IV was 0.83× the smile's (median σ ratio 1.20). Smile information is the one modeled-adversary class that reproduces a Thales-sized loss.
5. **Walk-forward drift agents do not capture the Thales edge.** Trailing-drift agents (30/90/365 days) *lose* to the LP at 1 d and at 7 d. The Thales loss is realized bull-market drift picked up by net-long flow (+0.79M net UP tokens), plus fee discounts. Neither is forecastable skill. **An expected-value simulator should not reproduce it. A path-conditional replay should, and it does (item 2).**
6. **New adversaries for 1 d:**
   - **jump** is the tail ECDF plus the walk-forward excess variance of CPI/FOMC/ETF/upgrade events.
   - **jump\_ev** is the same agent trading *only* markets that contain an event.
   - **smile** is the Deribit digital `N(d2(σ(k))) − φ(d2)√τ·σ′(k)`, taken from 3-hourly fits on the *same daily expiry*. 11,629 fits were made from Deribit mark prices.
   - **drift** is described in item 5.
   
   At v1 (t-kernel, s = 2%, λB = 0.1, cutoff 10%):
   - jump never nets extraction over a full period, but on event markets it takes −0.084 B (IS) and −0.099 B (OOS) per market.
   - smile takes **−0.028 B/market OOS** with 4.2 B of volume per market. The 95% day-clustered CI is [−0.066, +0.017].
   - Decomposed, **the edge is the short-dated ATM IV *level*** (level-only −0.037). The skew shape alone *loses* (+0.010).
   - **D\*\_OOS rises from 1.45 to 4.50/day.** E3 fails: the lower bound at D = 2 is −135%/yr. E4 fails by 10×: weekly CVaR95 18%, max DD 250%.
   - The failure mechanism: impact resets each block, so a persistent-belief agent re-trades every block until the budget is gone. Near-ITM strikes then lose the whole budget.
7. **The fix is persistent inventory skew, not halts, not p_min and not cutoffs.** The recommended v1.1 is **κ = 0.10** (mid moves 10¢ per budget of vault inventory, on top of per-block impact), **s = 3%**, and **event-aware σ** (the hook adds a governance-set event variance for scheduled CPI/FOMC releases). Results with the full extended set and the L1 latency charge:
   - **D\* = 1.10/day** (IS and OOS);
   - D = 2: vault +75%/yr with a 95% lower bound of **+65%**, weekly **CVaR95 1.44%, CVaR99 2.00%, max DD 2.5%**, every year 2021–2026 positive;
   - clairvoyant-vol stress **D\*\_stress 15 → 1.55**.
   
   Event halts of ±30 min or −60/+90 min, p_min 0.05/0.10, a static skew add-on, a 25% cutoff and λB = 0.2 each left D\* unchanged or made it worse.
8. **Caveat on κ, which is the next gate.** When noise flow also moves the inventory skew, informed agents harvest the skew that noise creates:
   - D = 2 still passes E4 (CVaR95 1.87%, CVaR99 3.19%, max DD 4.2%; lower bound +63%/yr).
   - D = 5 fails E4 under the conservative *sum* of per-agent extractions (CVaR95 15%). It passes under max-single-agent aggregation (§6.3).
   
   κ ≥ 0.15 is worse. κ therefore has to be tuned jointly with noise-inventory dynamics before E4 can be claimed above D ≈ 2.
9. **Latency is event-concentrated.** On 116 days of 1-second data (L1, κ = 0):
   - Markets containing CPI/FOMC lose −0.045 B each to a CEX-leading arbitrageur; others gain +0.016 B. Effective n = 7 event days.
   - A **±5-minute halt** removes it (+0.011).
   - With κ = 0.10 and s = 3%, the latency cost is −0.0105 ± 0.0027 B/market. That is below the −0.029 charge used in every D\* here, so that charge is conservative.
10. **Revised E7.** E7 = (E7a) tape-rebuild accounting within 1% of volume per round, **PASS**; (E7b) quote fidelity, where the simulator's venue quote must reproduce executed prices within ±0.25 pp volume-weighted, **FAIL** for the old Thales-style config; and (E7c) flow sufficiency. For E7c, the path-conditional model edge of the real tape must lie inside the envelope of modeled adversaries *plus* a declared directional-flow stress. It FAILS for the old set. It is now covered in magnitude by the smile agent (§4.5), and the directional-flow part is covered by a disclosure (§7). E2–E4 may now be stated "against {lat, tail, iv, dir, jump, jump\_ev, smile} at κ = 0.10, s = 3%, event-aware σ, D ≤ 2", with the directional-flow stress disclosed.

---

## 1. What E7 can and cannot test

EA §1.2 defines E7 as: *replay Thales' on-chain trades through the simulator's accounting; reproduce the sign and ±50% of −13.9%.*

**The target is noise.** From `prior_art/thales_lp_rounds.txt`, over the 80 active rounds (1–91, excluding the 11 rounds with no trading), weekly LP return has mean −0.165%, SD 2.20% and **t = −0.66**. The rebuilt series (§2) gives t = −0.56. The cumulative log return is −0.149, with SE √80 × 2.20% = **0.197**. A correct simulator of *expected* LP P&L would land anywhere in roughly [−53%, +25%] at ±2 SE. "Within ±50% of −13.9%" is therefore not a test of expected-value realism.

What the Thales episode *can* test is layered:

| Layer | Question | Test here | Result |
|---|---|---|---|
| E7a accounting | Given the executed trades and outcomes, does the simulator's ledger reproduce the LP's P&L? | Tape rebuild vs `profitAndLossPerRound` | **PASS** (§2) |
| E7b quote | Does the simulator's quote function for that venue reproduce the prices actually executed? | Re-price the tape with the simulator's Thales-style quote | **FAIL** (§3) |
| E7c flow | Is the realized, path-conditional informed extraction within what the modeled adversaries (plus declared stresses) can generate? | Model edge at mid vs agent extraction on comparable markets | **FAIL** for the old set; the cause is identified (§4) |

---

## 2. Data and the tape rebuild (E7a)

### 2.1 Sources

| Item | Source | Coverage / checks |
|---|---|---|
| `BoughtFromAmm`, `SoldToAMM`, `SetImpliedVolatilityPerAsset` logs of ThalesAMM `0x278B…1A1A` | Optimism public RPC, `eth_getLogs` in 10k-block chunks, blocks 84.0M–132.0M (`fetch_rpc.py`) | 58,246 trades (48,953 buys), 2023-03-27 → 2025-01-28; 2,111 IV updates across 20 assets. Topics: `0xf3bfbc08…` and `0x1d6ff70c…` (keccak of the event signatures in `ThalesAMM.sol:1083-1101`). The event data are all non-indexed (7 words). |
| Pre-Bedrock timestamps | 3,174 legacy blocks via batched `eth_getBlockByNumber` (`blockts.py`) | all filled |
| Market details: `getOracleDetails()`, `times()`, `result()` | Batched `eth_call` via 4 public RPCs (`fetch_markets3.py`) | 6,720 of 6,825 markets |
| 105 self-destructed markets (`eth_getCode` = `0x`) | Archive `eth_call` at the last trade block (details) and at maturity + 3 days (`resolved`, `result`, `finalPrice`) on `mainnet.optimism.io` (`fetch_destroyed.py`) | 105 of 105 resolved; $866k of pre-Oct-2023 volume |
| Per-address overrides | `safeBoxFeePerAddress(addr)` `0x65f56772` and `min_spreadPerAddress(addr)` `0x2972e8ab` for the top-200 traders (`overrides.py`) | 4 addresses with overrides = **45.7% of LP-era volume** (table below) |
| Round results | `profitAndLossPerRound`, `allocationPerRound` (04 §1.6; `prior_art/thales_lp_rounds.txt`) | 80 active rounds |
| Spot | Binance 1-minute closes for BTC, ETH, SNX, LINK, OP, SOL, CRV, 2023-03 → 2025-02 (`pxbuild.py`) | 93.6% of trades and 94.5% of volume have spot data; 80 missing minutes forward-filled |

**Whitelisted counterparties.** The values are live and read on 2026-09-25. Historical values are **UNVERIFIED**.

| Address | Identity | Override (safeBox, min_spread) | LP-era volume |
|---|---|---|---|
| `0x2d35…e1df` | RangedMarketsAMM (Blockscout implementation name) | 0.5%, 0.5% | $3.93M (34.3%) |
| `0x6c7f…a29f` | Thales-deployed proxy (same deployer `0x8314…`), probably an AMM vault (**UNVERIFIED**) | 0.5%, 0.5% | $0.87M |
| `0x4331…9c83` | same deployer | 0.5%, 0.5% | $0.28M |
| `0xb484…6f93` | same deployer | 0.05%, 0.05% | $0.05M |

TeaVaultV2 (`0xf70a…5b05`, third-party) has no override.

### 2.2 Ledger

This is `recon.py` and `replay.settle(yes_equiv=False)`. Per trade:

- A buy credits the LP with `paid/(1+f)`, where f is the per-address safeBox fee, else 2%.
- A sell debits the LP `paid/(1−f)`.
- UP and DOWN token positions are settled separately against `result()`.

This follows `ThalesAMM.sol:430-443` (sell: `commitTrade(pricePaid + safeBoxShare + referrerShare)`) and `:696-717` (buy: the safeBox share is skimmed). Markets are assigned to round `(maturity − 1683629766)/604800 + 1` (`ThalesAMMLiquidityPool.sol:570-578`).

| Variant | Σ over 80 rounds | Cumulative | Per-round corr | Same sign | Median \|diff\| |
|---|---|---|---|---|---|
| On-chain | **−$39,671** | **0.8615** | — | — | — |
| Rebuild, flat 2% fee, all trades | −$119,063 | — | 0.958 | 0.90 | $687 |
| Rebuild, per-address fees, trades after pool start | −$49,294 | — | 0.968 | 0.95 | $486 |
| Rebuild, per-address fees, all trades, markets maturing before the pool start counted in round 1 (`recon.py`) | −$42,336 | — | 0.959 | 0.95 | $535 |
| **Rebuild, per-address fees, all trades, markets maturing in rounds 1–91** (`replay.py`; used below) | **−$44,358** | **0.8518** | **0.961** | 0.95 | — |

**Residuals.**
- Rounds 1–15 are 1.5–5k below on-chain. Rounds 29–58 are 1.5–3k above.
- Rounds 43 and 50 are about −10k below on-chain. Their worst markets are deep-ITM BTC/ETH strikes with large buy-then-sell round trips.
- Candidate causes, all **UNVERIFIED**: historical override values that differ from today's; referrer payouts (`referrerFee` is 0 today); default-LP top-ups (`_depositAsDefault`, `ThalesAMMLiquidityPool.sol:198`), which change `allocationPerRound` of future rounds.

The residual is 0.04% of volume ($4.7k on $11.3M), far below the effects measured in §4.

---

## 3. Simulator quote on the real tape (E7b)

`replay.sim_replay` re-prices each trade with the simulator's Thales-style quote (EA §4.4):

- mid = driftless `N(ln(S/K)/(σ√τ))`, with σ = the on-chain `impliedVolatilityPerAsset` in force at that time and S = the Binance close of the previous minute;
- buy floor 0.08;
- spread s (the per-address override, else 3%);
- persistent skew `κ·(−inventory)/B` and linear impact λ, both in units of B;
- the 2% fee is kept out of the LP.

Trades without spot data use the executed cash.

| Replay | Σ P&L | Cumulative | Per-round corr vs on-chain | Same sign |
|---|---|---|---|---|
| **Actual executed prices** (E7a) | **−$44,358** | **0.852** | 0.961 | 0.95 |
| Simulator quote, per-address s, κ = 0 | +$76,159 | 1.145 | 0.912 | 0.99 |
| Simulator quote, per-address s, κ = 0.15, B = $20k | +$153,877 | 1.422 | 0.886 | 0.95 |
| Simulator quote, per-address s, κ = 0.15, B = $5k | +$337,811 | 2.422 | 0.792 | 0.86 |
| Simulator quote, uniform s = 3%, κ = 0.15, B = $5k (EA §4.4 as run) | +$515,275 | 4.079 | 0.752 | 0.79 |

**Price fidelity.** Executed unit price minus (Thales base ± nominal spread), on the LP-received basis: median −0.61 pp, IQR [−1.99, +0.34] pp, volume-weighted **−0.86 pp**. The simulator quote has no inventory *discount* and no capacity-relative impact. It therefore overcharges the flow by about 1¢ per token, which on ~20M tokens is worth ≈ $120k.

**Verdict:** the sign flips, so E7b fails. The EA §6.6/§6.7 statement "Thales-style beats the hook at 7 d" is an artifact of this quote.

---

## 4. Attribution of the realized loss (b)

Scripts: `attrib.py`, `driftcal.py`, `replay.decompose`, `smile_thales.py`. All figures are on the E7a rebuild.

### 4.1 Model edge vs execution margin

On the covered trades (50,835), the LP P&L of −$22.4k splits as follows:

- **Model edge at the Thales mid** (as if every trade executed at `N(d0)`, with no spread): **−$342,382**.
  - Per round: mean −$4,280, **t = −4.31** over 80 rounds.
  - At BS `N(d2)` with the same σ: −$348,240.
- **Execution margin: +$319,976.**
  - Whitelisted contracts: +$63k on $4.87M, i.e. 0.83¢/token effective against 0.5¢ nominal.
  - All others: +$257k on $5.81M, i.e. 2.09¢/token against 3¢ nominal.

So the real flow was **significantly informed relative to the model**, at about 3.2% of volume. The net loss is small only because the spreads recovered about 94% of that edge. The simulator's modeled agents on a Thales-style 7 d book extract only −0.0008 B (tail), −0.0014 B (iv) and −0.0008 B (jump) per market over the same era (`thales7d_sim.py`). That is the E7c gap.

### 4.2 What the informed flow knew: direction, not tails or speed

| Cut | Actual LP P&L | Model edge at mid |
|---|---|---|
| Trader long UP-equivalent | **−$307,986** (−5.4% of vol) | **−$492,927** |
| Trader long DOWN-equivalent | +$263,628 | +$150,545 |
| Tokens priced < 0.1 by Thales (lottery tokens) | −$25,799 | −$115,361 (−57% of their volume) |
| Traded < 2 d before maturity | −$39,171 | −$87,769 |
| 4–7 d before maturity | +$37,828 | −$31,958 |

- **Token-weighted calibration:** UP resolved **+3.23 pp** more often than Thales' odds (ETH +7.74 pp, BTC +4.96 pp). The flow was net **+790k UP-equivalent tokens** out of 19.9M gross. ETH rose +44% (log) and BTC about 3.7× over the era.
- **Markouts** (model value change in the trader's direction, σ fixed, token-weighted):

  | Horizon | Markout (pp/token) | SE |
  |---|---|---|
  | 60 s | +0.005 | 0.003 |
  | 5 min | −0.000 | 0.007 |
  | 1 h | −0.012 | 0.020 |
  | **24 h** | **+0.672** | 0.084 |

  The share of trades in the direction of the prior 5-minute CEX move is **0.519** (n = 49,477). **There is no latency signature.** Chainlink staleness was not the channel.
- **Driftless bias:** Σ q_up·(N(d0) − N(d2)) = **+$5.9k for the LP**. The flow was net long UP, which the driftless odds over-price. The missing −σ²τ/2 term (04 §1.3) was not the cause.
- **Walk-forward drift agents** (`exp_drift.py`), each LP P&L per market positive (the agent loses):

  | Agent / book (Thales era 2023-05-09 → 2025-02-04) | 1 d v1 | 7 d Thales-style |
  |---|---|---|
  | 365 d lookback | +0.009 | +0.001 |
  | 90 d lookback | +0.052 | +0.017 |
  | 30 d lookback | +0.062 | +0.022 |

  The directional edge therefore was **realized bull-market drift captured by net-long flow**, not a forecastable rule.
- **1 d simulator markets, `mean(1{UP} − mid)`:** +1.31 pp (IS), +0.55 pp (OOS), +0.98 pp (Thales era), −1.14 pp (2022), all with day-clustered SE 0.8–1.5 pp. At 1 d the drift effect is below a 3% spread. At 7 d it is 3–8 pp, which **explains why 7 d is fragile** (EA §6.3) and why Thales' weekly book lost.

### 4.3 Who took it

- **RangedMarketsAMM (Thales' own product) accounts for −$100,631** of LP P&L (−2.56% of its $3.93M), with a model edge of −$177,898. It is the single largest source, bigger than the net loss. It reached the LP through a whitelisted 0.5% spread and 0.5% fee.
- Several EOAs lost the LP 15–30% of their volume, e.g. `0xf9c7…` −$20.3k on $95k and `0xdb6b…` −$12.5k on $83k.
- TeaVaultV2 (+$10.6k) and two EOAs (+$15.9k, +$27.6k) *paid* the LP.

**Lesson for us:** protocol-internal composability paths (routers and vaults with fee exemptions) must not bypass the spread that prices model risk.

### 4.4 Jumps, caps and concentration

- **Jump rounds.** The top 20% of rounds by max |daily move| of ETH/BTC over the two weeks to round end (threshold 8.3%) are 17 rounds. They hold **−$7.5k of −$44.4k** rebuilt (on-chain −$11.3k of −$39.7k) and −$104k of the −$342k model edge. Jumps are over-represented but not dominant.
- **Worst rounds.** Round 66 (2024-08-06, the Aug-5 crash, 24.9% daily move) rebuilt −$16.4k (on-chain −$16.6k). Rounds 19 and 13 were −$18.6k and −$15.4k with max daily moves of only 2.0%.
- **Concentration and cap-hitting.**
  - The top 10% of markets by |net token exposure| (664 of 6,640) carry **−$67.0k**, i.e. more than the whole loss. The top 1% carry −$96.8k, and the worst 10 markets −$45.3k.
  - Per-market P&L has SD $655 and 47% of markets lose.
  - Losses therefore sit where one side accumulated inventory up to the caps.
  - I could not tie these to `capPerMarket`/`getCapPerAsset` history, because `SetCapPerAsset` logs were not fetched (**UNVERIFIED**).

### 4.5 Skew and smile (Deribit) on Thales ETH/BTC trades

Method (`fetch_deribit_thales.py`, `smile_thales.py`):

- For each ETH/BTC trade, I took all Deribit option trades on the **same expiry** as the Thales maturity. Thales maturities are at 08:00 UTC, the same time as Deribit expiries. The trades come from the full clock hour *before* the trade hour (10,513 windows).
- I fitted σ(k) as in §5.1 (6,629 fits). Where the expiry was not yet listed or the fit failed, the trade is skipped. **Coverage: 17,960 of 33,900 ETH/BTC trades.**
- I computed the smile digital and the trader's edge per token versus the smile: `D_smile(token) − unit price paid` for buys, reversed for sells.

**Calibration** (token-weighted, covered trades):

| | mean(1{UP} − p) | Brier |
|---|---|---|
| Deribit smile | +5.16 pp | 0.1600 |
| Thales odds | +4.65 pp | 0.1621 |

- Mean |smile − Thales| = 2.97 pp.
- The median σ of the smile at the strike is **1.20×** Thales' on-chain IV.
- Both are biased the same way, by the bull-market drift of §4.2. The smile is only slightly better calibrated.

**Realized LP P&L by trader edge versus the smile:**

| Trader edge vs smile (per token) | Trades | Volume | LP P&L | LP P&L / volume |
|---|---|---|---|---|
| < −5¢ | 4,097 | $570k | +$65.6k | +11.5% |
| −5 … −2¢ | 5,069 | $949k | +$99.6k | +10.5% |
| −2 … 0¢ | 3,615 | $731k | −$21.3k | −2.9% |
| 0 … +2¢ | 2,670 | $545k | −$28.2k | −5.2% |
| +2 … +5¢ | 1,863 | $389k | −$49.4k | −12.7% |
| > +5¢ | 646 | $157k | −$27.3k | −17.3% |

The ordering is **monotone**. The trades a smile desk would have chosen (edge > +1¢; 3,709 trades) cost the LP **−$98.4k**. The rest of the covered flow gave the LP +$137.5k (all covered: +$39.1k).

So a smile-informed agent would have extracted about $100k from 53% of Thales' ETH/BTC flow. That is the same order as the whole realized loss. It is the adversary the simulator was missing at 7 d.

Most of its edge comes from the IV **level**: Thales' IV was about 17% below the same-expiry smile (median σ ratio smile/Thales = 1.20). The same holds for dailies (§5.2). Thales' daily-set IV from "nearest Friday ask" (04 §1.3) evidently lagged the options market.

---

## 5. New adversaries and D\* for the 1-day v1 configuration (c)

### 5.1 Definitions

These are in `engine_x.py`. Each agent is run in isolation plus noise, with the same conservative accounting as EA §4.3.

| Agent | Belief | Data |
|---|---|---|
| **jump** | Tail-ECDF belief (EA agent "tail") with its variance inflated by **Σ J²ₑ** over scheduled events e remaining in the market's life. Partial windows are pro-rated. | Events: 80 CPI releases (08:30 ET; BLS schedule pages), 53 FOMC statements (14:00 ET; federalreserve.gov calendar), 4 ETF decision/launch dates, 4 ETH upgrades (`events.py`). J²ₑ = walk-forward mean over prior same-class events of (realized 1-minute variance over [tₑ − 5, tₑ + 90) min minus the hook's own EWMA forecast for that window). |
| **jump\_ev** | The jump agent, restricted to markets whose life contains a CPI or FOMC release. A realistic event trader only trades event days. | same |
| **smile** | Deribit digital `D(K) = N(d2(σ(k))) − φ(d2)·√τ·σ′(k)`, with k = ln(K/S_t), σ(k) = a + bk + ck² fitted to OTM mark IVs of the **same daily expiry** (Deribit dailies expire at 08:00 UTC, the same time as the simulator's 1 d markets), using the latest 3-hourly fit (≤ 6 h old, built only from trades before the snapshot). Fits need ≥ 5 strikes with ≥ 2 per wing and RMSE ≤ 10 vol points. | 16,736 one-hour windows of `history.deribit.com get_last_trades_by_currency_and_time` (2021-01 → 2026-09) → **11,629 fits** (OOS fits: median 10 strikes, median RMSE 1.4 vol points). Median fitted slope b = −0.53 (IQR −1.29 … +0.18). |
| **drift** | The hook's own model at the fresh price, shifted by μτ, with μ = trailing log-drift over 30/90/365 days (walk-forward) | Binance 1-minute |

**Event verification.** On the release minute, |1-minute return| relative to the median of the same minute on the 20 prior days is 3.2× for CPI (65% of releases > 2×), 4.3× for FOMC (77%), 3.3× for ETF and 5.4× for upgrades.

CPI releases in 2020–2021 are mostly *not* spikes; crypto was not macro-sensitive then. Every 2022–2026 release spikes except 2024-12-11, 2025-03-12, 2025-06-11, 2025-10-24, 2026-02-13 and 2026-04-10. Two CPI dates reported by the BLS-page summarizer were wrong and were corrected to 2024-01-11 and 2025-01-15.

**Size of the event variance.** Mean excess variance per event window is 4.3e-4 (CPI) and 5.5e-4 (FOMC), about 45% of a normal day's variance at σ = 0.6. The medians are 1.4e-4 and 2.3e-4.

### 5.2 Results at v1

Config: t-kernel ν = 5, EWMA 1 d, s = 2%, λB = 0.1, cutoff 144 min, p_min 0.02. The L1 latency charge is −0.029 B/market (EA §6.5). IS = 2021–2023, OOS = 2024-01 → 2026-09.

LP P&L per market (negative = extraction), with volume in B per market in brackets:

| Agent | IS | OOS | On event markets (IS / OOS) |
|---|---|---|---|
| tail | +0.023 [3.0] | +0.004 [3.0] | −0.029 / **−0.109** |
| jump | +0.020 [3.0] | +0.005 [3.1] | **−0.084 / −0.099** |
| jump\_ev (averaged over all markets) | −0.0046 | −0.0052 | — |
| smile | −0.004 [3.0] | **−0.028 [4.2]**, 95% CI [−0.066, +0.017] | −0.015 / −0.081 |
| smile, level only (flat at Deribit ATM) | +0.007 | **−0.037** | |
| smile, shape only (hook σ level + Deribit b, c) | +0.031 | +0.010 | |
| smile, slope only | +0.032 | +0.012 | |
| drift (365/90/30 d) | +0.025 / +0.043 / +0.062 | +0.014 / +0.069 / +0.070 | |
| orv (clairvoyant, stress only) | −0.218 | −0.219 | |

**Break-even D\* and risk at v1** (1% NAV per market):

| Adversary set | D\* IS | D\* OOS | E3 lower bound at D = 2, OOS | E4 at D = 2, OOS (CVaR95 / CVaR99 / max DD) |
|---|---|---|---|---|
| Old {lat, tail, iv, dir} | 1.50 | 1.45 | — | — |
| + jump + smile | 2.45 | 4.35 | −123%/yr | 18.2% / 22.4% / 230% |
| + jump + smile + jump\_ev | **2.70** | **4.50** | **−135%/yr** | **18.4% / 23.2% / 252%** |
| + clairvoyant vol (stress) | — | 15.0 | — | — |

**Reading.**

- (i) The *skew* of the Deribit smile carries no exploitable information about 1-day outcomes. The options market's **ATM level for the next daily expiry** does (OOS only; IS it loses). That is event and regime information that the EWMA lacks.
- (ii) The jump agent loses to the LP overall only because it also over-trades non-event days. Restricted to event days it extracts.
- (iii) Under v1's per-block-reset impact, one persistent-belief agent can accumulate the full budget per strike. That is why single markets hit −1.0 B and weekly CVaR reaches 18%. This is the simulated analogue of Thales' cap-hitting concentration (§4.4).

---

## 6. What makes E3/E4 hold against the extended set (d)

### 6.1 Sweep

Every row is v1 plus the change shown, with the full extended set (lat, tail, iv, dir, jump, smile, jump\_ev) and the latency charge −0.029. "Neg yrs" counts calendar years with a negative mean at D = 2.

| Change | D\* IS | D\* OOS | E3 lower bound at D = 2, IS / OOS | E4 OOS at D = 2 (CVaR95 / CVaR99 / max DD, % NAV) | Neg yrs | Smile agent OOS, B/market [95% CI] |
|---|---|---|---|---|---|---|
| v1 | 2.70 | 4.50 | −37% / −135% | 18.4 / 23.2 / 252 | 3 | −0.028 [−0.066, +0.017] |
| s = 3% | 1.25 | 2.75 | +57% / −59% | 15.5 / 20.6 / 131 | 2 | −0.023 [−0.054, +0.014] |
| s = 4% | 0.95 | 1.80 | +98% / +22% | 12.1 / 17.3 / 62 | 1 | −0.012 [−0.039, +0.020] |
| λB = 0.2 | 1.60 | 6.00 | +24% / −244% | 32.4 / 41.3 / 426 | 4 | −0.033 [−0.063, +0.003] |
| cutoff 25% | 2.35 | 6.00 | −21% / −236% | 27.5 / 32.8 / 519 | 4 | −0.032 [−0.066, +0.009] |
| event-aware σ (`ev_on`) | 2.75 | 4.20 | −40% / −117% | 18.2 / 22.6 / 210 | 3 | −0.020 [−0.060, +0.025] |
| halt ±30 min | 2.60 | 4.95 | −35% / −144% | 18.4 / 23.1 / 270 | 4 | −0.028 |
| halt −60/+90 min | 2.60 | 4.55 | −32% / −135% | 18.6 / 23.1 / 254 | 3 | −0.029 |
| `ev_on` + halt ±30 | 2.50 | 4.00 | −29% / −112% | 18.0 / 22.9 / 209 | 3 | −0.021 |
| static skew add-on (0.5·φ√τ, IS median slope) | 2.55 | 4.70 | −30% / −150% | 19.8 / 26.3 / 305 | 4 | −0.035 |
| `ev_on` + skew + s = 3% | 1.10 | 2.55 | +66% / −44% | 16.2 / 21.4 / 132 | 2 | −0.015 |
| p_min 0.05 | 3.15 | 4.95 | −52% / −140% | 17.7 / 21.7 / 264 | 4 | −0.027 |
| p_min 0.10 | 3.65 | 6.50 | −62% / −147% | 15.6 / 19.2 / 278 | 6 | −0.027 |
| **κ = 0.05** | 1.60 | 2.05 | +23% / −1% | 3.4 / 3.9 / 20 | 2 | −0.008 [−0.014, −0.002] |
| **κ = 0.10** | 1.55 | 1.75 | +25% / +15% | 2.3 / 3.1 / 6 | 0 | −0.004 [−0.007, −0.001] |
| κ = 0.15 | 1.50 | 1.65 | +26% / +20% | 1.9 / 2.6 / 5 | 0 | −0.003 [−0.005, −0.001] |
| κ = 0.10 + p_min 0.05 | 1.80 | 1.95 | +10% / +3% | 2.8 / 3.2 / 12 | 2 | −0.004 |
| κ = 0.10, s = 3% | 1.10 | 1.20 | +65% / +61% | 1.4 / 2.1 / 3 | 0 | −0.002 [−0.005, +0.002] |
| κ = 0.10, s = 3%, p_min 0.05 | 1.30 | 1.35 | +41% / +40% | 2.0 / 2.4 / 4 | 0 | −0.001 |
| **κ = 0.10, s = 3%, `ev_on` (recommended)** | **1.10** | **1.10** | **+62% / +65%** | **1.4 / 2.0 / 2.5** | **0** | −0.000 [−0.003, +0.003] |
| κ = 0.10, s = 3%, p_min 0.05, `ev_on` | 1.30 | 1.35 | +40% / +36% | 1.0 / 1.6 / 1.7 | 0 | +0.000 [−0.003, +0.003] |
| κ = 0.10, p_min 0.05, `ev_on`, halt ±30, skew | 1.95 | 1.95 | +2% / +4% | 2.5 / 3.1 / 15 | 1 | −0.002 |

Sources: `out/jev.txt` for D\*, E3 and E4 (all including jump\_ev), and `out/summary_1d.txt` for negative years and the smile CI (day-clustered bootstrap; negative years are counted without jump\_ev).

**Recommended configuration, full detail:**

- Per-year vault return at D = 2 (extended set, latency charged): 2021 +54%, 2022 +59%, 2023 +90%, 2024 +82%, 2025 +61%, 2026 +76%.
- With the clairvoyant-vol agent added: OOS lower bound +33%/yr, max DD 7.6%, **D\*\_stress 1.55** (v1: 15.0).
- Per-market extraction by jump\_ev is 0.0000 IS and OOS.

**Why κ works.** With per-block-reset impact, an agent whose belief exceeds ask by g re-trades every block until the budget is exhausted. With persistent inventory skew it stops at inventory ≈ B·(g − s)/κ. For g = 5¢, s = 3¢ and κ = 0.10 that is 0.2 B instead of 1 B. Halts, bands and cutoffs do not bound accumulation, which is why they fail.

This is **not** the "decaying impact" rejected in EA §6.4:

- κ is keyed to *vault inventory* and reverts only through opposite flow.
- Decaying impact is keyed to recent *flow* and reverts with time.

### 6.2 Latency with κ and around events (1-second data; `lat_x.py`, `lat_k.py`)

116 days, 2026-06-01 → 09-24, 1 d markets at 08:00 UTC, t-kernel, λB = 0.1, cutoff 10%, p_min 0.05. SEs are day-clustered. The sample has 7 event days (4 CPI, 3 FOMC).

| Block | κ | s | No halt: all / event days / other | Halt ±5 min: all / event days |
|---|---|---|---|---|
| 12 s | 0 | 2% | +0.012 ± 0.018 / **−0.045 ± 0.088** / +0.016 | +0.016 / +0.011 |
| 12 s | 0 | 3% | +0.021 ± 0.015 / −0.036 / +0.024 | +0.024 / +0.025 |
| 12 s | 0.10 | 2% | −0.019 ± 0.003 / −0.019 / −0.019 | −0.018 / −0.003 |
| 12 s | 0.10 | 3% | **−0.0105 ± 0.0027** / −0.010 / −0.011 | −0.0096 / +0.005 |
| 2 s | 0.10 | 3% | −0.0033 ± 0.0019 / −0.006 / −0.003 | −0.0028 / +0.002 |

- A ±5-minute halt around scheduled releases removes the event-day latency loss in every configuration, and costs < 0.001 in noise revenue. It is worth keeping for latency, even though it does nothing for D\* in the 1-minute simulation.
- κ creates a small but steady latency cost, −0.0105 B at L1 and s = 3%. It is well below the −0.029 charge used in §6.1.
- In this rerun, κ = 0 latency is *positive* (+0.012 ± 0.018), whereas EA §6.4 reported −0.020 to −0.029 (λB = 0.05, normal kernel). The difference is within about 2 SE. It is kept as a note, and the EA charge is retained as conservative.

### 6.3 Is the κ result an artifact of noise not moving inventory?

In `engine.run_hook` the noise ledger does not move the skew. `exp_ninv*.py` adds an option in which noise, at its actual intensity (η = D per market, no linear scaling), moves the inventory. Informed agents can then harvest skew created by noise.

All figures are OOS, with the L1 latency charge and the extended set. "Sum" is EA's conservative aggregation (every net-extracting class is added). "Max" counts only the single most-extracting class.

| Config | D | Per-agent LP P&L (B/market): lat / tail / iv / jump / smile | Noise P&L | Sum: lower bound, CVaR95 / CVaR99 / max DD | Max: lower bound, CVaR95 / CVaR99 / max DD |
|---|---|---|---|---|---|
| κ 0.10, s 3%, `ev_on` | 2 | −0.002 / +0.001 / +0.008 / −0.000 / −0.002 | +0.063 | +63%, 1.87 / 3.19 / 4.2% | +73%, 0.37 / 0.66 / 0.7% |
| κ 0.10, s 3%, `ev_on` | 5 | −0.010 / −0.011 / −0.004 / −0.012 / −0.012 | +0.185 | +207%, **15.2 / 23.8 / 43.6%** | +355%, <0 / <0 / 0.0% |
| κ 0.10, s 3% | 2 | −0.000 / +0.001 / +0.007 / +0.001 / −0.003 | +0.063 | +70%, 0.64 / 1.05 / 1.6% | +71%, 0.42 / 0.90 / 1.1% |
| κ 0.10, s 3% | 5 | −0.007 / −0.010 / −0.003 / −0.010 / −0.012 | +0.185 | +221%, **11.3 / 16.1 / 30.9%** | +354%, <0 / <0 / 0.0% |
| κ 0.15, s 3%, `ev_on` | 2 | −0.002 / −0.002 / +0.003 / −0.002 / −0.003 | +0.062 | +43%, 4.2 / 7.0 / 12.0% | — |
| κ 0.15, s 3%, `ev_on` | 5 | −0.017 / −0.020 / −0.015 / −0.020 / −0.019 | +0.184 | +87%, 18.7 / 27.9 / 55.5% | — |
| v1 (κ = 0) | 2 | 0 / +0.002 / +0.086 / +0.003 / −0.032 | +0.047 | −127%, 19.1 / 23.7 / 241% | — |

Sources: `out/exp_ninv_{a,b,c,d}.txt`.

**Reading.**

- When noise moves the skew, several agents profit by trading the noise-created skew back to the model. This is a *skew-harvester* class. They are effectively paid the impact that noise pays. Noise revenue also rises (+0.185 B/market vs 5 × 0.029 = 0.147 under linear scaling), so the mean LP P&L stays strongly positive.
- At **D = 2**, κ = 0.10 passes E3 and E4 under either aggregation.
- At **D = 5**, the mean is strongly positive (E3 passes). E4 **fails under the sum and passes under max-single**. The sum counts the same skew five times, because tail, jump, smile, lat and iv all harvest the same opportunity. The truth needs a joint simulation in which the agents compete within a block. That has not been run.
- κ = 0.15 is too strong: it creates more harvestable skew.
- **Claim E4 for the recommended configuration only for D ≤ 2 until a joint-agent run exists.**

### 6.4 Recommendation for the v1 quote function

| Parameter | EA v1 | **v1.1 (this report)** | Condition |
|---|---|---|---|
| Base half-spread s | 2% | **3%** | — |
| Per-block impact λB | 0.1 | 0.1 (reset per block) | unchanged |
| **Persistent inventory skew κ** | 0 | **0.10 per budget of net vault inventory**, shared across YES/NO | re-validate E4 with noise-driven inventory at the declared D (§6.3) |
| σ | EWMA 1 d, t-kernel ν = 5 | same **+ scheduled event variance** Σ J²ₑ, set by governance/keeper per event class (CPI 4.3e-4, FOMC 5.5e-4 as of 2026-09) | the calendar must be published ahead of time |
| Event halt | none | **±5 min around CPI/FOMC** (latency only) | — |
| Cutoff | 10% | 10% | a 25% cutoff is harmful |
| p_min | 0.02 | 0.02 (0.05 costs noise revenue with little gain) | — |
| Fee exemptions | — | **none on the spread**: routers/vaults may get fee rebates, never a narrower model-risk spread | §4.3 |
| Tenor | 1 d | 1 d; **7 d stays out of scope** | directional drift of 3–8 pp at 7 d exceeds any sane spread (§4.2) |

Under v1.1, with D ≤ 2 and L1, E2 (D\* ≤ D_decl), E3 and E4 hold against {lat, tail, iv, dir, jump, jump\_ev, smile} out of sample. E5 publishes D\*\_stress = 1.55.

---

## 7. Revised gate E7 and consequences for the proof plan

1. **E7a (accounting): tape rebuild.** For every venue used as evidence, the simulator's ledger fed with executed trades must reproduce the realized per-round LP P&L. Criteria: correlation ≥ 0.95, same sign in ≥ 90% of rounds, cumulative within 1% of volume.
   - Thales: 0.961, 0.95, and $4.7k on $11.3M = 0.04%. **PASS** (cumulative 0.852 vs 0.8615).
   - This is the Python analogue of the Foundry tape replay (EA §9.3).
2. **E7b (quote): the venue quote must reproduce executed prices within ±0.25 pp, volume-weighted.** The old Thales-style config is at −0.86 pp: **FAIL.** Before any "vs Thales" statement (EA §6.6, E6), either model Thales' discount branch (`ThalesAMM.sol` `_buyPriceImpact`, `calculateDiscount`, `ThalesAMMUtils.sol:130-143`) and per-address spreads, or drop Thales from E6.
3. **E7c (flow): path-conditional envelope.** The realized model edge at mid (−$342k, t = −4.3) must be matched by modeled adversaries *or* by a declared **directional-flow stress**.
   - The smile-informed selection on the real tape (−$98k on 53% of ETH/BTC flow, §4.5) shows the smile agent has the right magnitude at 7 d.
   - The 7 d simulator still needs weekly-expiry Deribit fits before E7c can be re-run inside the simulator. This is a TODO; only dailies were fitted here.
   - The directional-flow stress is the flow net-long the realized trend: at 1 d, +0.55 to +1.31 pp per token (§4.2), and at 7 d, 3–8 pp.
   - E-claims must carry the sentence: "*The LP is short the directional risk premium of net-long flow. Over 2023-05 → 2025-01 this cost 3.2% of notional at 7 d. It is not forecastable by walk-forward trend rules, and at 1 d it is below the 3% spread.*"
4. **Adversary set for E2–E4 from now on:** {lat, tail, iv, dir, jump, jump\_ev, smile} plus the orv stress.
   - Add a **skew-harvester** check whenever κ > 0 (§6.3).
   - Deribit smile fits: 11,629 windows covering 2021–2026.
5. **Carry forward to Foundry:**
   - add κ-inventory state and the event-variance add-on to `quote_vectors.json`;
   - the tape replay must include the halt window and inventory-skew path;
   - add an invariant: *no address-based spread discount*.

---

## 8. Verification

**Verified by running code or reading primary sources:**

- **Tape.**
  - Event topics are recomputed with keccak from the signatures in the Sourcify-verified `ThalesAMM.sol:1083-1101`.
  - All 58,246 trades are decoded; the log count is 60,357.
  - Every LP-era market has maturity, strike and result; 105 of them came from archive reads because the contracts self-destructed (`eth_getCode` = `0x`).
- **Fee logic.** Read at `ThalesAMM.sol:430-452` and `:696-721`. Overrides were read live by `eth_call`.
- **Round assignment.** Read at `ThalesAMMLiquidityPool.sol:570-578`, and checked against `profitAndLossPerRound` (corr 0.961).
- **Simulator consistency.** `engine_x` reproduces EA's v1 tail-agent P&L exactly (IS +0.0228, OOS +0.0036) and D\*\_old ≈ EA's value (1.45 vs EA's 1.35). The difference probably comes from applying the latency charge inside the bootstrap here, **UNVERIFIED**.
- **Event calendar.** FOMC dates were cross-checked on federalreserve.gov. CPI 2021–2025 come from the BLS release archive page and 2026 from the BLS schedule page; two dates were corrected (§5.1). Release-minute spikes were checked in the data (§5.1), and both corrected dates show a spike (ratio ≥ 1.5).
- **Deribit.**
  - Fits use mark prices inverted with Black on F = index. The fits reproduce known features: 2024-08-05 ATM 1.5–2.0, slope −1 to −2.
  - Fits use only trades before the snapshot. There is no look-ahead: the snapshot time is the window end, and the agent uses only snapshots with t_snap ≤ t.
- **Statistics.** All D\*, E3 and E4 figures use the same moving-block bootstrap as EA (`bt.mbb_mean_ci`, 4-week blocks). The smile-agent CIs are day-clustered bootstraps.

**Not verified / limitations:**

- (a) The **historical** values of the per-address overrides, `referrerFee`, `capPerMarket` and `getCapPerAsset` (only the 2026 values were read). The rebuild residuals of rounds 43 and 50 (about −$10k each) are unexplained. **UNVERIFIED**.
- (b) The identity of the proxies `0x6c7f…`, `0x4331…` and `0xb484…` beyond their shared deployer. **UNVERIFIED**.
- (c) Spot for Thales uses Binance 1-minute, not the Chainlink round Thales used. 5.5% of volume (XAU, XAG, WLD, BCH, …) has no spot and is carried at executed prices.
- (d) ETF event times are approximate to the hour. The 2020 CPI/FOMC dates (warm-up only) are from memory. **UNVERIFIED** to the minute.
- (e) Deribit index is used as the forward for dailies; the basis is ignored. Dailies only: there is no smile agent at 7 d in the simulator. The 7 d smile analysis is only the §4.5 cross-section.
- (f) Agents are still run in isolation. Summing correlated agents (tail/jump/smile harvest overlapping mispricings) overstates the loss. Max-single-agent aggregation is reported only in §6.3.
- (g) **Selection bias.** The defence sweep was read against OOS.
  - A purely IS-driven choice (minimum IS D\* subject to E4 on IS) would have picked **s = 4%**: IS D\* 0.95, IS CVaR95 1.0%. That fails E4 OOS (CVaR95 12.1%).
  - The κ rows pass E4 in IS as well (recommended: IS CVaR95 0.71%, CVaR99 1.60%, max DD 2.3%), and κ has a structural rationale (§6.1, the accumulation bound).
  - Still, the recommendation is not a clean hold-out. A forward test from 2026-09-26 is the clean check.
- (h) κ's latency cost was measured on 116 days of 1-second data only (7 event days).
- (i) The Thales gate's ±50% criterion is replaced (§7), not "passed". The E7c directional-flow stress is a disclosure, not a mitigation.

---

## Appendix: reproduction

Run from `…/scratchpad/e7` (copies are in `$X`). Simulator runs use `uv run --with numpy --with scipy --with numba python <script>`.

| Step | Script | Output |
|---|---|---|
| Tape | `fetch_rpc.py 84000000 132000000 logs_all.json 2`, `blockts.py`, `tape.py` | `logs_all.json`, `tape_raw.pkl` |
| Markets | `fetch_markets3.py <rpc> <shard> <n> <batch> <threads>`, `fetch_destroyed.py` | `markets_all.json`, `markets_destroyed.json` |
| Overrides | `overrides.py` | `overrides.json` |
| Spot | `px/*.zip` (data.binance.vision), `pxbuild.py` | `px1m.npz` |
| E7a/E7b | `recon.py`, `replay.py` | `out/recon.txt`, `out/replay.txt` |
| Attribution | `attrib.py`, `driftcal.py`, `smile_thales.py` (after `fetch_deribit_thales.py`) | `out/attrib.txt`, `out/driftcal.txt`, `out/smile_thales.txt` |
| Events | `events.py` (run from `econ/`) | `events.npz`, `out/events.txt` |
| Deribit dailies | `fetch_deribit.py deribit/{oos,is}.json deribit/{oos,is}_ends.txt 1.05 6`, `smile.py` | `deribit/{oos,is}_fit.json` |
| New agents, D\* sweep | `engine_x.py`, `btx.py`, `exp_1d.py <configs> 0.5 <tag>`, `summarize_1d.py`, `jev.py`, `exp_smile.py`, `exp_drift.py`, `thales7d_sim.py`, `evsplit.py` | `out/exp1d_*.txt`, `out/summary_1d.txt`, `out/jev.txt`, `out/exp_smile.txt`, `out/exp_drift.txt`, `out/thales7d_sim.txt`, `out/evsplit.txt` |
| Latency | `lat_x.py` (first pass, κ = 0, halts ±5/15/30 min), `lat_k.py` | `out/lat_k.txt` |
| Noise-inventory robustness | `exp_ninv.py`, `exp_ninv2.py` | `out/exp_ninv_*.txt` |
