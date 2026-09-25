# 04 — Prior art and LP (underwriter) economics for a Black–Scholes-priced binary market on Uniswap v4

Status: **fact-checked final**, 2026-09-25 (adversarial verification pass; corrections are marked *[FC]* inline and listed in the Verification log at the end). Topic owner: prior art, v4 hook projects, and the economics of LP underwriting.

**Conventions**

- `$R` = `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/repos` (shallow clones). `$S` = the parent scratchpad directory.
- Code citations use the form `repo/path/File.sol:line`. Commits: lyra-v1 `ea9e36a`, rmm-core `8d3ef9b`, premia v2 `0ed54a9`, premia v3 `fe3b821`, Buffer-Protocol-v2.5 `e049261`, panoptic-v2-core `e3b9d12` (2026-09-09), gnosis CTF `eeefca6`, gnosis market makers `6814c02`, Polymarket ctf-exchange `ed5c770`, neg-risk adapter `f78b35b`, Uniswap/hooklist `1d2f09b` (2026-09-21), oz-uniswap-hooks `80bd724`.
- Thales, OrketHook, Hyperhook, and PolymarketHook source code was fetched from **Sourcify**, where it is verified (exact match), and saved to `$S/thales/` and `$S/hooksrc/`. Live Thales parameters and LP history were read over Optimism RPC (`eth_call`/`eth_getStorageAt`) on 2026-09-25.
- Quantitative results I computed are marked **[computed]**. The scripts are in `$S/prior_art/` (see Appendix). Anything I could not verify is marked **UNVERIFIED**, and statements taken from search snippets or secondary sources are marked **(secondary)**.
- Unless noted, `r = 0`, `τ = T − t` is in years, and the digital is cash-or-nothing, paying $1 if `S_T > K`. `V = N(d2)`, where `d2 = [ln(S/K) − σ²τ/2]/(σ√τ)`.

---

## 0. Executive summary

1. **Model-priced binaries have been live in DeFi before, and LPs lost money.** The closest precedent to our design is Thales' Positional-Markets AMM on Optimism: UP/DOWN tokens, Black–Scholes-style odds, Chainlink settlement, a single LP vault, a 3% base spread, up to 15% inventory skew, a 24 h cutoff, and per-market caps. Its LP vault ended at a cumulative return of **0.8615 (−13.9%)** after 80 active weekly rounds (May 2023 to Jan 2025). Peak allocation was about $735k. The worst weeks were −7.4% and −6.8%, and the maximum drawdown was 22.8% **[computed from on-chain `profitAndLossPerRound`]**. Lyra v1 (a vanilla-options AMM) lost in 6 of its first 8 rounds. Its round 8 lost $1.58M, mostly through *unhedged delta*. Buffer's BLP fell from 1.11 to 0.85 within days, and Buffer switched to protocol-owned liquidity.
2. **Thales' odds function is not risk-neutral Black–Scholes.** On-chain it computes `N(ln(S/K)/(σ√τ))`, which omits the `−σ²τ/2` drift term. It evaluates this with an Abramowitz–Stegun CDF that has a mistyped coefficient (max CDF error 1.0e-5). With `σ = 0.8`, the drift omission overprices UP by +2.2 pp at 7 days and +4.6 pp at 30 days **[computed]**. Both are useful negative test vectors for us.
3. **Latency and oracle manipulation are the main dangers for short-dated binaries.** Polymarket's 15-minute crypto markets attracted latency-arbitrage bots. One reportedly turned $313 into $414k in a month (secondary). Polymarket responded with taker fees ∝ `p(1−p)` (Jan and Mar 2026). Separately, a study reportedly tied 821 accounts to roughly $8.2M captured in manipulation-flagged cycles of the **5-minute BTC** contract by pushing the reference price in the final seconds (secondary; FinanceFeeds, CryptoDaily, Genfinity). From 2026-08-07, Polymarket settles those markets on a 30–60 s Chainlink TWAP instead of a snapshot.
4. **Price error from a stale S grows sharply near expiry.** With σ = 60%, a 5 bp error in S moves an ATM digital by 0.24¢ at 7 d, 0.64¢ at 1 d, 3.1¢ at 1 h and 6.2¢ at 15 min **[computed]**. The hedge notional per $1 of payout is 4.8× at 7 d, 12.7× at 1 d and 62× at 1 h. For a 7-day ATM binary, 34.4% of its lifetime price variance `V₀(1−V₀)` occurs in the last 24 h **[computed; closed form `1 − (2/π)·arcsin((T−w)/T)`, independent of σ]** *[FC: draft said 34.5%, a rounding of the numerical estimate]*. These numbers are the quantitative basis for a trading cutoff and for spreads scaled by delta.
5. **Black–Scholes with realized vol is badly miscalibrated for short ETH horizons.** On Binance ETHUSDT hourly data (2020–2026), with σ taken from trailing 30-day realized vol, the model misprices 1 h and 4 h digitals by up to **±7–9 pp** at strikes ±0.5σ away. Hourly standardized returns have excess kurtosis of 24.5, and P(|z|>3) is 1.9% versus 0.27% for a normal distribution. At 1 d the error is about ±3–7 pp. ETH implied vol (Deribit DVOL) exceeded subsequent 30-day realized vol by **+5.3 vol points** on average, on 66% of days **[computed]**. The model therefore needs a vol premium, fat-tail and seasonality handling, and trade-flow feedback, or a restriction to horizons of at least about 1 day.
6. **An oracle-free alternative exists.** RMM-01's stable reserve per unit of liquidity equals `K·N(d2)`, which is K times the Black–Scholes digital. The paper "Replicating Monotonic Payoffs Without Oracles" (Angeris, Evans, Chitra 2021, §2.3) shows that the numéraire leg of a CFMM share with trading function `ψ(R1,R2) = R1 − Φ(Φ⁻¹(1 − K·R2) − σ√τ)` *is* a Black–Scholes cash-or-nothing call, settled by arbitrage rather than by an oracle. Paradigm's pm-AMM (2024) is the reserve-based AMM derived for exactly our price process (Gaussian score dynamics equal the BS digital with `r = 0`). Its LVR is `V/(2(T−t))`: the static version loses 100% and the dynamic version 50% of LP wealth in expectation. These make good baselines for proving our design better.
7. **Among the v4 hooks I found, none prices binaries by Black–Scholes through v4 swaps with LP underwriting.** v4 prediction-market hooks in the Uniswap hooklist (PolymarketHook, Hyperhook, OrketHook, and others) and hackathon repos are reserve- or curve-priced, or charge fees only. I found no hook that prices binaries by BS *through v4 swaps* with LP underwriting, so our design appears novel (search-coverage caveat applies). Production custom-curve hooks (EulerSwap, OZ `BaseCustomCurve`) and Panoptic v2 on v4 (manipulation-resistant internal oracle) supply reusable patterns.

---

## 1. Thales Positional Markets AMM (Optimism): the closest precedent

### 1.1 Addresses and sources

| Item | Value | How verified |
|---|---|---|
| ThalesAMM proxy (Optimism) | `0x278B5A44397c9D8E52743fEdec263c4760dc1A1A` | Thales integration docs |
| ThalesAMM implementation | `0xf3b63b29a2813959a4273e920c6c5df06bfc369a` | EIP-1967 slot read via RPC |
| ThalesAMMUtils (odds and skew math) | `0x4986e171a7d66d5acfbf4299df7893a97636b02c` | storage slot 28 of the proxy; source on Sourcify |
| ThalesAMMLiquidityPool (proxy) | `0xc10a0a6ff6496e0bd896f9f6da5a7b640b85ea40` | `liquidityPool()` getter |
| Source | `$S/thales/src/contracts/AMM/ThalesAMM.sol`, `$S/thales/utils_src/contracts/AMM/ThalesAMMUtils.sol` | Sourcify v2 API (chain 10) |

The GitHub repository `thales-markets/contracts` is now private (clone fails; the API returns 404). Verified bytecode sources are the authoritative reference.

### 1.2 Market structure

- Each positional market is "asset > strike at maturity". It has two ERC-20 position tokens, UP and DOWN. `mint(amount)` locks `amount` sUSD and creates `amount` UP plus `amount` DOWN, i.e. a complete set, as in CTF (§6.1). After maturity the market resolves from a Chainlink price (`oraclePrice()`), and winning tokens are exercised for 1 sUSD each.
- The AMM is the counterparty. On a buy it mints the complete sets it needs, collecting `toMint` sUSD from the LP round pool via `commitTrade` (`ThalesAMMLiquidityPool.sol:174`). It sells the requested side to the trader and keeps the opposite side in the LP round pool. On a sell it buys the tokens back, and matched UP+DOWN pairs are burned for sUSD. The LP's capital at risk per sold token is therefore `(1 − price)`, and the book is always fully collateralized.

### 1.3 Exact odds formula (on-chain)

`ThalesAMM.price()` (`ThalesAMM.sol:259-282`) calls `ammUtils.calculateOdds(oraclePrice, strike, timeLeftInDays·1e18, impliedVolatilityPerAsset[key]) / 1e2`, then sets `DOWN = 1 − UP`. `ThalesAMMUtils.calculateOdds` (`ThalesAMMUtils.sol:46-77`):

```solidity
uint vt = ((volatility / (100)) * (sqrt(timeLeftInDays / (365)))) / (1e9);   // σ√τ, 1e18
bool direction = strike >= _price;
uint lnBase = strike >= _price ? (strike * (ONE)) / (_price) : (_price * (ONE)) / (strike);
uint d1 = (PRBMathUD60x18.ln(lnBase) * (ONE)) / (vt);          // |ln(S/K)| / (σ√τ)   <-- NO −σ²τ/2 term
uint y = (ONE * (ONE)) / (ONE + ((d1 * (2316419)) / (1e7)));  // A&S 26.2.17, p = 0.2316419
uint d2 = (d1 * (d1)) / (2) / (ONE);                           // d²/2 (misnamed)
if (d2 < 130 * ONE) {
    uint z = (_expneg(d2) * (3989423)) / (1e7);                // φ(d) via pow(2.71828, x)
    uint y5 = (powerInt(y, 5) * (1330274)) / (1e6);
    uint y4 = (powerInt(y, 4) * (1821256)) / (1e6);
    uint y3 = (powerInt(y, 3) * (1781478)) / (1e6);
    uint y2 = (powerInt(y, 2) * (356538)) / (1e6);             // should be 0.356563782
    uint y1 = (y * (3193815)) / (1e7);
    uint x1 = y5 + (y3) + (y1) - (y4) - (y2);
    uint x = ONE - ((z * (x1)) / (ONE));                       // N(|d|)
    result = ONE * (1e2) - (x * (1e2));                        // 100·N(−|d|)
    if (direction) { return result; } else { return ONE * (1e2) - result; }
```

It computes `UP = N(ln(S/K)/(σ√τ))`. This is the probability for a driftless log-price, not the risk-neutral `N(d2)`. Issues relevant to our proof work, all **[computed]** with `$S/prior_art/cdf_errs.py` and `thales_drift.py`:

| Issue | Effect |
|---|---|
| Missing `−σ²τ/2` (drift term) | UP − BS(N(d2)) at ATM: +0.6 pp (1 d, σ=0.6), +2.2 pp (7 d, σ=0.8), +4.6 pp (30 d, σ=0.8), +7.9 pp (90 d, σ=0.8). DOWN is underpriced by the same amount. |
| A&S coefficient typo `0.356538` instead of `0.356563782` | Max CDF error **1.01e-5** at x=0 (versus about 2e-7 with correct 7-digit coefficients; the canonical bound is 7.5e-8) |
| `e ≈ 2.71828` truncated in `_expNegPow` | Relative error ≈ 6.7e-7·x in `exp(−x)`; negligible |
| Hard clip: returns 0 or 1 when `d²/2 ≥ 130` | Harmless |
| IV set manually per asset (`setImpliedVolatilityPerAsset`, `ThalesAMM.sol:963`) | Docs: "BTC and ETH IV derived from Deribit's orderbook Ask IV for the nearest Friday expiries"; other assets use ETH IV plus a 15-day historical-vol difference. Updated about daily (secondary: Thales docs). |

Takeaways for our proof: (a) property-test `V(S=K·e^{σ²τ/2}) = 0.5`, i.e. the drift term exists; (b) bound CDF error at ≤ 1e-8 or better; (c) Thales-style driftless pricing is a named anti-pattern.

### 1.4 Spread, skew and price impact (exact)

Live parameters, read by `eth_call` on 2026-09-25:

| Parameter | Value |
|---|---|
| `min_spread` | 0.03 (3% added to the base price on buys, subtracted on sells) |
| `max_spread` | 0.15 (maximum skew impact at full cap utilization) |
| `safeBoxImpact` | 0.02 (2% protocol fee on top; *not* paid to the LP) |
| `minSupportedPrice` / `maxSupportedPrice` | 0.08 / 0.95 (no buys outside this range) |
| `minimalTimeLeftToMaturity` | 86,400 s (**24 h trading cutoff**) |
| `capPerMarket` (default) | 5,000 sUSD |
| `getCapPerAsset` | ETH 1,000; BTC 1,000; SNX 3,000; LINK 5,000; OP 3,000 (final values; the AMM appears wound down) |
| `impliedVolatilityPerAsset` | ETH 62, BTC 45, SNX 87, LINK 66, OP 82 (%; last set values) |

**Buy quote**, `_buyFromAmmQuoteWithBasePrice` (`ThalesAMM.sol:545-578`), with `b = max(price, 0.08)`, `b' = b + min_spread` (or a per-caller override `min_spreadPerAddress[msg.sender]` when set, *[FC: added]*), and `s` = skew impact:

- if `s ≥ 0`: `unitPrice = b' + (1 − b')·s·1.02`
- if `s < 0`: `unitPrice = b'·(1 + s)`. The discount applies when the trader buys the side the AMM already holds; it is capped at `max_spread/2`.
- The trader then pays `quote = amount·unitPrice·(1 + safeBoxImpact)`.

**Skew impact**, `ThalesAMMUtils.buyPriceImpactImbalancedSkew` (`:130-143`). The impact is linear in the post-trade imbalance relative to the capacity, averaged between the pre- and post-trade values (trapezoid rule). *[FC] That is the `else` branch. When the AMM already holds some of the side being bought and `amount > balancePosition`, the code instead returns `(newImpact/2)·(amount − balancePosition)/amount`, so only the newly minted part is charged (`ThalesAMMUtils.sol:134-137`).*

```
maxPossibleSkew = balanceOtherSide + availableToBuy − balancePosition
newImpact       = max_spread · (balanceOtherSideAfter − balancePositionAfter) / maxPossibleSkew
impact          = (newImpact + previousImpact) / 2            // previousImpact uses balanceOtherSide
```

**Capacity**, `_availableToBuyFromAMMWithBasePrice` (`:515-543`). The AMM risks `1 − price` per minted pair:
`availableUntilCap = min(cap, cap + balance·b'(1 − max_spread/2) − spentOnMarket)` and `available = balance + availableUntilCap / (1 − (b' + (1 − b')·max_spread/2))`.

**Sell quote** (`:497-513`, `:580-584`): `unitPrice = (b − min_spread)·(1 − sellImpact)·(1 − safeBoxImpact)`, where `b = min(price, 0.95)` and the maximum sell price is `(b − min_spread)(1 − max_spread/2)`.

`spentOnMarket[market]` is the running net sUSD at risk, capped per asset. Note there is **no aggregate cap across strikes or maturities on the same asset** beyond per-market caps and the LP round balance.

### 1.5 LP vault design

`ThalesAMMLiquidityPool` (`LiquidityPool/ThalesAMMLiquidityPool.sol`):

- **Weekly rounds** (`roundLength = 604,800 s`, live). Each market is assigned to the round containing its maturity (`getMarketRound`, `:570`). The round's sub-pool funds mints for that market (`commitTrade`, `:174`).
- A round closes only when every market traded in it has resolved (`canCloseCurrentRound`, `:509`). P&L is `profitAndLossPerRound[r] = balanceEnd / allocation` (`prepareRoundClosing`, `:306`). Deposits and withdrawals take effect only at round boundaries, which removes NAV-gaming.
- Deposits were gated by THALES staking (`stakedThalesMultiplier`), with `maxAllowedDeposit = 1,000,000` and `maxAllowedUsers`.

### 1.6 Results: on-chain LP performance

**[computed]** I read `profitAndLossPerRound`, `cumulativeProfitAndLoss` and `allocationPerRound` for rounds 1–144 (`$S/prior_art/thales_lp_rounds.txt`). *[FC] Rounds 143–144 are not closed yet: their `profitAndLossPerRound` is 0, meaning unset, so every statistic below uses rounds 1–142. If those rounds are included naively, the cumulative return appears to go to 0. On 2026-09-25 I re-queried rounds 14, 39, 56, 66, 99 and 142, plus the AMM parameters and the implementation slot, and they match.*

| Quarter | Rounds | Average allocation | Quarterly return | Cumulative |
|---|---|---|---|---|
| 2023Q2 | 1–8 | $310k | +6.73% | 1.0673 |
| 2023Q3 | 9–21 | $645k | −0.79% | 1.0589 |
| 2023Q4 | 22–34 | $448k | +1.69% | 1.0768 |
| 2024Q1 | 35–47 | $334k | +0.80% | 1.0855 |
| 2024Q2 | 48–60 | $241k | −1.34% | 1.0709 |
| 2024Q3 | 61–73 | $193k | **−13.95%** | 0.9215 |
| 2024Q4 | 74–87 | $56k | −0.88% | 0.9134 |
| 2025Q1 | 88–99 | $30k | −5.69% | 0.8615 |
| 2025Q2–2026Q1 | 100–142 | $6–11k | 0 (no trading) | 0.8615 |

- Across the 80 active rounds: mean weekly return −0.16%, weekly SD 2.20%, 33 losing rounds, peak cumulative 1.1165 (round 39), **maximum drawdown 22.8%**, and final cumulative **0.8615**. The sum of `allocation × (pnl − 1)` is about **−$39.7k**. Peak allocation was $735k (round 14).
- Worst rounds (round start date; the markets in each round *mature* during that week): #66 (2024-08-06) −7.44%, #56 (2024-05-28) −6.84%, #91 (2025-01-28) −5.69%, #63 (2024-07-16) −4.62%, #84 (2024-12-10) −3.84%. The first two cluster around large ETH jumps: the spot-ETF approval rally of 20–23 May 2024 and the 5 Aug 2024 crash. That attribution is my interpretation, **UNVERIFIED** per market.
- Interpretation: a 3% base spread, 15% maximum skew, 2% protocol fee, 24 h cutoff, $1–5k per-market caps and daily IV from Deribit were **not enough** to keep the LP profitable. Losses concentrate in jump weeks, consistent with (i) stale daily IV, (ii) fat tails, and (iii) the driftless-odds bias.

**Audit** (iosiro, "Thales AMM Smart Contract Audit"): one High, *oracle manipulation when paying with alternative collateral* (a Curve swap price), fixed by bounding the swap result around the expected sUSD value; one Medium, *inconsistent `minSpread` use between buy and sell*; plus informational missing validation and events (secondary: iosiro page).

### 1.7 Thales Speed Markets (brief)

1 h–24 h up/down on ETH and BTC settled with Pyth benchmark prices. Odds are fixed at **50:50**, so no vol model is needed; the payout is **2×** minus a 2% safebox fee and a time-dependent LP fee. Buy-in is $5–$200, with an initial AMM risk cap of $5,000 per asset per day (secondary: Thales docs). Buffer's ATM-only design (§2) makes the same choice: avoid σ by only offering strike = spot.

---

## 2. Buffer Finance (Arbitrum)

Source: `$R/Buffer-Protocol-v2.5` (commit `e049261`, Aug 2023) and `$R/Buffer-Protocol-v2`.

- **Pricing: fixed probability 0.5 (ATM only).** `BufferBinaryOptions._fees` (`core/BufferBinaryOptions.sol:356-371`):
  ```solidity
  // Probability for ATM options will always be 0.5 due to which we can skip using BSM
  premium = amount / 2;
  total = (premium * 1e4) / (1e4 - settlementFeePercentage);
  settlementFee = total - premium;
  ```
  The strike must be within the user's slippage of the current price (`isStrikeValid`). The payout is `lockedAmount = amount`, i.e. 2× the premium. With a settlement fee of 20%, a winner receives 1.6× the total paid. `settlementFeePercentage` comes from a signed *sfPublisher* message per trade; it is a dynamic house edge.
- **Black–Scholes is used only for early close.** `_exercise` (`:373-414`) pays `lockedAmount·BS_binary(config.iv(), strike, closingPrice, expiration − closingTime)` if the option is closed before expiry. `OptionMath._N` (`core/OptionMath.sol:23-34`) is **Choudhury's approximation**, with max CDF error **1.4e-4** **[computed]**. `config.iv()` is a single owner-set IV (`OptionsConfig.setIV`).
- **Prices come from off-chain signatures, not an on-chain oracle.** `BufferRouter` verifies publisher-signed `(price, timestamp)` pairs and rejects stale ones (`block.timestamp − publisherSignInfo.timestamp > maxDelay`). A keeper opens queued trades and executes them. The design is a two-step queue-then-price flow at the next signed price, which blunts latency arbitrage.
- **Risk caps:** `getMaxTradeSize() = min(poolOIConfig.getMaxPoolOI(), marketOIConfig.getMaxMarketOI(totalMarketOI))`, plus open-interest caps per pool and per market (`:259-280`). Minimum and maximum periods are enforced (`evaluateParams`, `:282`).
- **LP outcome (secondary: Buffer Medium post "Protocol Owned Liquidity and the way forward", fetched via search snippet only):** after the Arbitrum v2 beta launch, the BLP exchange rate went **1.11 → 0.91** after a few large winning trades, then **→ 0.85** within the next 24 h. It remained volatile even though the protocol earned about $90k revenue on about $600k volume. Buffer blamed a **high max trade size and pool utilization limit**, discontinued BLP, compensated holders with esBFR, and restarted on **protocol-owned liquidity** seeded with 75.5k USDC. I found no exploit post-mortem for Buffer (**UNVERIFIED** that none exists).
- Lessons: (i) fixed-odds ATM binaries avoid vol estimation but not variance; small pools with large maximum trade sizes produce LP-token drawdowns that cause panic. (ii) Signed-price keepers are an off-chain dependency that our Uniswap-native design wants to avoid, but the "queue, then price at a later price" idea maps to v4 as *price at the start-of-block oracle value*.

---

## 3. Lyra v1 (Avalon/Newport): a Black–Scholes AMM with a dynamic vol surface

Source: `$R/lyra-v1/contracts` (commit `ea9e36a`). Deployed parameters are in `$R/lyra-v1/deployments/mainnet-ovm/params.realSNX.json` (Optimism) and `mainnet-arbi/params.realGMX.json` (Arbitrum). *[FC] Caveat: these are Newport-era (2023) parameter files. The loss rounds quoted in §3.7 (Nov 2021 to May 2022) ran on the earlier Avalon-era deployment, whose parameters are not in this repo, so do not read the numbers below as the settings that produced those results. The Arbitrum wETH market also differs from Optimism ETH: `standardSize 50`, `skewAdjustmentFactor 0.75`, `spotPriceFeeCoefficient 0.01`, `vegaFeeCoefficient 300`, `acceptableSpotPricePercentMove 5%`, `staleUpdateDuration 3 h`.*

### 3.1 Architecture

`OptionMarket` handles trades and boards (one expiry with many strikes). `OptionMarketPricer` computes IV impact, fees and limits. `OptionGreekCache` caches Black–Scholes greeks per strike, per board and globally, and holds the GWAV oracles. `LiquidityPool` holds LP funds, the queued deposit/withdraw system and circuit breakers. `ShortCollateral` holds user shorts. `PoolHedger` / `GMXFuturesPoolHedger` / `SNXPerpsV2PoolHedger` handle delta hedging. `libraries/BlackScholes.sol` works at 27-decimal internal precision and uses the Hart/West CDF (coefficients `N0..N6`, `M0..M7`). Its max abs error in double is **2.2e-16** **[computed]**.

### 3.2 Vol surface and how trades move it

Volatility = `boardBaseIv × strikeSkew` (`OptionGreekCache.sol:484` *[FC: draft said :481]*, `volatilityDecimal: boardCache.iv.multiplyDecimal(strikeCache.skew)`). Each trade bumps both (`OptionMarketPricer.sol:362-375`):

```solidity
uint orderSize = trade.amount.divideDecimal(pricingParams.standardSize);
uint orderMoveBaseIv = orderSize / 100;                                   // standardSize contracts ⇒ 1 vol point
uint orderMoveSkew = orderMoveBaseIv.multiplyDecimal(pricingParams.skewAdjustmentFactor);
if (trade.isBuy) return (boardBaseIv + orderMoveBaseIv, strikeSkew + orderMoveSkew);
else             return (boardBaseIv - orderMoveBaseIv, strikeSkew - orderMoveSkew);
```

Optimism ETH parameters: `standardSize = 30` and `skewAdjustmentFactor = 1.25`. Buying 30 ETH options raises the board's base IV by 1.00 vol point and that strike's skew by 0.0125. This is **order-flow feedback into σ**: a persistent price impact that decays only when opposite flow arrives or governance resets it.

### 3.3 Fees (all additive to the Black–Scholes premium)

From `OptionMarketPricer.getTradeResult` (`:387-449`):

| Fee | Formula | Optimism ETH value |
|---|---|---|
| Option-price fee | `c_opt(t) × premium` | `c_opt = 1%` (1× until 6 weeks to expiry, rising linearly to 2× at 12 weeks; `getTimeWeightedFee`, `:468-480`) |
| Spot-price fee | `c_spot(t) × spot × amount` | `c_spot = 0.1%` of **spot** per contract, time-weighted the same way. This is effectively a *delta/hedging-cost proxy*. |
| Vega-utilization fee | `vegaFeeCoefficient × (volTraded·|postTradeAmmNetStdVega| / NAV) × amount`, charged only if the trade *increases* the AMM's |net std vega| (`:489-522`) | `vegaFeeCoefficient = 35,000` |
| Variance fee | `0.65 × (minStaticVega + vega·1) × (minStaticSkew + |skew − refSkew|·1) × (minStaticIvVar + ivVariance·1) × amount` (`:530-577`), where `ivVariance = |baseIv − GWAV(baseIv)|` | Zero when IV equals its GWAV. It penalizes trading right after IV has moved, which is anti-manipulation. |

Premium plus fees made up about **7.5% of option prices on average**, "with spot and variance fees being the most painful" (secondary: Lyra blog via search snippet).

### 3.4 Trade limits, cutoff, force close

- `tradingCutoff = 43,200 s` (**12 h**): normal trades revert after `block.timestamp + tradingCutoff > expiry` (`:252`, `:272-274`).
- `minDelta = 0.1`: no trades when the call delta is below 0.1 or above 0.9 (`:339-349`). This is the analog of Thales' [0.08, 0.95] price band.
- Vol bounds: `minBaseIV 0.35`, `maxBaseIV 2`, `minSkew 0.5`, `maxSkew 1.5`, `minVol 0.25`, `maxVol 3`. Buys that push above the maximum revert, as do sells that push below the minimum (`:278-306`).
- **Force close and liquidations** are priced off a *GWAV* vol with shocks (`OptionGreekCache.getPriceForForceClose`, `:547-611`). For example, `shortVolShock 1.2` (1.4 post-cutoff) and `longVolShock 0.8` (0.5 post-cutoff), so the trader pays a penalty for exiting when the delta limits would otherwise block them.

### 3.5 Worst-case spot per direction and oracle circuit breakers

`OptionMarket.sol:737-748` selects `PriceType.MAX_PRICE` for opening long calls and short puts, and `MIN_PRICE` for the opposite, so each side gets the worse of the available prices. `GMXAdapter.getSpotPriceForMarket` (`GMXAdapter.sol:123-`) compares GMX min/max prices with Chainlink:

- It reverts opens and closes if either deviates from Chainlink by more than `priceVarianceCBPercent = 1.5%`.
- It uses the **worst-case** of Chainlink and GMX above `gmxUsageThreshold = 0.4%`.

This pattern maps directly onto our design: pricing YES buys at `max(spot, oracle)` and YES sells at `min(spot, oracle)`, and reverting if they diverge.

### 3.6 Circuit breakers and GWAV

`LiquidityPool._updateCBs` (`LiquidityPool.sol:538-590`) blocks deposits and withdrawals, not trades, when any of these hold:

- free liquidity is below 1% of NAV (48 h timeout on Optimism);
- `maxIvVariance > 0.15` or `maxSkewVariance > 0.15` (12 h timeout);
- after board settlement (6 h).

`GreekCacheParams`: `acceptableSpotPricePercentMove = 0.5%` and `staleUpdateDuration = 30 min`. If spot moved more than that since the greeks were cached, or the cache is stale, deposits and withdrawals are blocked. The NAV uses GWAV vols (`optionValueIvGWAVPeriod = 36 h`), so an attacker cannot move NAV by pushing IV. `GWAV` (`libraries/GWAV.sol`) is a geometric time-weighted average: an accumulator of `ln(value)·dt`, analogous to v3's tick-cumulative oracle.

LP deposits and withdrawals are **queued**. On Arbitrum: `depositDelay = withdrawalDelay = 7 days` and `withdrawalFee = 1%`. Shock-vol minimum collateral (`shockVolA/B = 2.5`) and spot shocks of ×1.2/×0.8 applied to user shorts.

### 3.7 Delta hedging and results

- `PoolHedger` params on Arbitrum: `interactionDelay = 86,400 s`, `hedgeCap = 100`. GMX futures hedger: `deltaThreshold = 100`, `targetLeverage = 1.1`, `maxLeverage = 10`, `acceptableSpotSlippage = 1.05`. Hedging is a separate, rate-limited keeper action, not part of each trade.
- **Results** (Derive/Lyra "AMM Performance Update", ETH pool, rounds 1–8, Nov 5 2021 to May 27 2022): −2.07%, 0.00%, −0.63%, −0.70%, +0.36%, +2.55%, −1.89%, **−7.74%**. Round 8 held up to 4,000 sETH as call collateral (~$8M). It lost **$1.58M**, of which $1.8M came from the decline in collateral value (ETH went from $4,550 to $1,800 over the period). For round 8, simulated delta hedging would have produced between **+$100k (+0.5%) and −$170k (−0.82%)**, depending on the assumed hedging frequency *[FC: draft said "per round"; the post gives this range for the loss round]*: "If delta hedging had been live for the first 8 rounds, the AMM would have delivered positive returns." Later: "flagship ETH pools averaging 6–8% in real yield over 1.5 years" (Lyra v2 announcement). Lyra v2 moved to an off-chain orderbook with on-chain settlement, citing capital inefficiency ("the AMM chews up a lot of collateral per option sold").
- Lessons for us: (i) *Spread and vol-surface feedback can make a model-priced AMM profitable before directional risk; directional or delta exposure is what kills it.* (ii) Circuit breakers should protect **LP entry and exit** (NAV integrity) separately from trading. (iii) Use the worst-of oracle per direction.

---

## 4. Primitive RMM-01, replicating market makers, and pm-AMM

### 4.1 RMM-01 trading function (code)

`$R/rmm-core/contracts/libraries/ReplicationMath.sol:41-70` (`getStableGivenRisky`):

```solidity
int128 phi = oneMinusRiskyX64.getInverseCDF();          // Φ⁻¹(1 − x)
int128 input = phi.sub(volX64);                          // − σ√τ
int128 stableX64 = strikeX64.mul(input.getCDF()).add(invariantLastX64);   // y = K·Φ(Φ⁻¹(1−x) − σ√τ) + k
// τ == 0:  y = K·(1 − x) + k     (linear market maker at price K)
```

`PrimitiveEngine.swap` requires `invariantAfter ≥ invariantBefore` (`PrimitiveEngine.sol:359`). It allows swaps until `maturity + BUFFER` (`BUFFER = 120 s`, `:51`, `:327`) and requires `gamma ≥ 9000` (fee ≤ 10%, `:170`). The trading function is re-evaluated with the *current* τ at every swap, so the curve shifts over time and arbitrage keeps it in line.

**The key identity.** With reserves per unit of liquidity `x` (risky) and `y` (stable), and a market price S kept in line by arbitrage, the RMM-01 pool sits at `x = 1 − N(d1)` and `y = K·N(d2)`. The LP share is therefore worth `S·N(−d1) + K·N(d2)`, a BS covered call. That value splits exactly into:

- **K cash-or-nothing calls** (the stable leg: `K·N(d2)`), plus
- **one asset-or-nothing put** (the risky leg: `S·N(−d1)`).

### 4.2 Can a CFMM replicate a *digital*? Yes, via monotone replication (not as a whole LP share)

- **Why a plain share cannot.** A CFMM LP share's portfolio value `V(p)` must be concave, nondecreasing and 1-homogeneous (Angeris–Evans–Chitra, "Replicating Market Makers", 2021). A digital's value `N(d2(S))` is convex for `S < K·e^{−σ²τ/2}` (where `d1 < 0`), so no single long LP share *is* a digital.
- **Monotone replication.** Angeris, Evans and Chitra, "Replicating Monotonic Payoffs Without Oracles" (arXiv:2111.13740, Nov 2021): "any monotonic payoff can be replicated using only liquidity provider shares in CFMMs, without the need for additional collateral or oracles." The trick is to sell the right to withdraw one *component* of the share. For a monotone payoff `f(p)`, the share holds `f(p)` of numéraire and `g(p) = ∫_p^∞ f′(q)/q dq` of risky, and the holder of the numéraire rights receives exactly `f(p)`.
  - **§2.1, terminal digital.** For `f = 1{p > p₀}`, `g(p) = (1 − f(p))/p₀`, and the trading function is the linear market maker `ψ = R1 + p₀·R2 − 1`.
  - **§2.3, Black–Scholes digital.** For `f(p) = Φ(d(p))` with `d = (log(p/K) − τσ²/2)/(σ√τ)`: `g(p) = (1 − Φ(d(p) + σ√τ))/K`, and
    **`ψ(R1, R2) = R1 − Φ(Φ⁻¹(1 − K·R2) − σ√τ)`**.
    This is RMM-01 with the stable reserve scaled by 1/K.
- **Consequence for us.** A v4 custom-curve hook *on the ETH/USDC pool itself* could implement RMM-01 with fixed `(K, σ, T)` and tokenize the two reserve rights. **YES = the USDC-reserve right / K**; the ETH-reserve right is an asset-or-nothing put held by the "underwriter". The YES price would be read from reserves (`y/K = N(d2(p_pool))`) with no oracle. At expiry the curve degenerates to a linear market maker at K, so the pool is all-USDC (YES = $1) if the market price is above K and all-ETH (YES = 0) otherwise. Settlement is **by arbitrage**, and flipping it costs roughly `reserves × |S/K − 1|`.
- **Caveats.** (i) The pool must be arbitraged continuously. Within the fee band γ, YES tracking error is ≈ `φ(d2)/(σ√τ)·γ`, the same pin-risk blow-up as §8.3. (ii) σ is fixed per pool; there is no vol feedback. (iii) The LP pays the curve's theta through arbitrage: RMM-01 LVR equals the covered call's time decay, which fees must cover. (iv) Creating YES requires someone to hold the put leg, so it is a two-sided underwriting market. (v) It needs `Φ⁻¹` on-chain. (vi) The paper itself warns (§2.3): "replicating in this manner requires additional capital as the portfolio value function is pointwise strictly decreasing in the time to maturity, τ", i.e. a static-reserve BS-digital replica must be topped up (or fee-funded) as τ ↓ 0 *[FC: added]*. This route is **genuinely Uniswap-native and oracle-free**. It is worth keeping as a benchmark and fallback, not the primary design, because the user specification wants trading in YES/USDC with S read from an existing ETH/USDC pool.

### 4.3 pm-AMM (Paradigm, Moallemi & Robinson, Nov 2024): the reserve-based optimum for our price process

(Source: paradigm.xyz/2024/11/pm-amm; formulas extracted from the page's KaTeX.)

- **Model: Gaussian score dynamics.** `dZ_t = σ dB_t` and `P_t = Φ(Z_t/(σ√(T−t)))`, so `dP_t = φ(Φ⁻¹(P_t))/√(T−t) dB_t`. The post itself names "whether the price of an asset like Bitcoin is above a certain strike price" as an example. With `Z_t = ln(S_t/K) − σ²(T−t)/2`, which is a driftless Brownian motion under Q, this is **exactly the BS digital with r = 0**. The binary's absolute volatility `φ(d2)/√τ` does not depend on σ and blows up as τ → 0.
- **LVR** for an invariant AMM with value `V(P)`: `LVR_t = −½ · φ(Φ⁻¹(P_t))²/(T−t) · V″(P_t)`.
- **Static pm-AMM** (uniform LVR at each t): `(y − x)·Φ((y − x)/L) + L·φ((y − x)/L) − y = 0`, with `V(P) = L·φ(Φ⁻¹(P))` and `LVR = V/(2(T−t))`. Expected value `V̄_t = V₀·√((T−t)/T)`, so **LPs lose 100% of the pool's value in expectation by expiry** (no fees).
- **Dynamic pm-AMM:** `L_t = L₀·√(T−t)` gives the invariant `(y − x)Φ((y − x)/(L√(T−t))) + L√(T−t)·φ((y − x)/(L√(T−t))) − y = 0`. Expected LVR is constant at `V₀/(2T)` and **half of initial wealth is lost by T**. For CPMM (`V = 2L√(P(1−P))`) and LMSR, LVR is non-uniform.
- **Why this matters:** (1) It is the right *reserve-driven baseline* to beat in our simulations. (2) It proves quantitatively that a reserve-priced binary AMM without an oracle bleeds LP value at a rate that grows like `1/(T−t)`. (3) The dynamic version suggests shrinking liquidity like `√(T−t)`. That is the same scaling I derive for per-market capacity in a model-priced design (§8.3).

### 4.4 Reserve-driven versus model-driven, formally

- **Reserve-driven** (CPMM, LMSR, FPMM, pm-AMM). The quote moves only with trades. Every piece of news creates a stale quote that is picked off, so the LP pays LVR as above. In exchange the market *discovers* the probability.
- **Model-driven, perfect oracle** (our design). The hook quotes `V(S_t, σ, τ) ± h`, so the quote moves with S and τ *without trades*. There is **no LVR relative to the model**: the hook "rebalances" its quote for free. The LP's P&L on a trade of q YES sold at time t and held to expiry is `q·(V_t + h − 1{S_T > K})`. Under Q with a correct model, `E = q·h` and `Var = q²·V_t(1 − V_t)`.
- **Model-driven, reality.** Write `ε = V_true − V_model`, where ε comes from oracle lag, σ error, skew and fat tails. Informed traders trade only when `|ε| > h`, so LP expected P&L per trade ≈ `h` for uninformed flow and `−(|ε| − h)` for informed flow. **The LP's enemy is ε, not LVR.** Sections 8.2–8.6 quantify ε for ETH. Price discovery happens only through the vol and skew feedback channel (Lyra, Pods), because S itself is imported from the underlying market.

---

## 5. Other options AMMs (brief, pricing and LP risk)

### 5.1 Premia

- **v2** (`$R/Premian-Labs_premia-contracts`):
  - Price = `BS(σ from VolatilitySurfaceOracle) × C-level × slippage` (`libraries/OptionMath.sol:79-140`, `quotePrice`).
  - The C-level moves exponentially with pool utilization: `c_new = c_old·exp(−steepness·(L_new − L_old)/max(L_old, L_new))` (`calculateCLevel`, `:53-72`), with decay over time (`calculateCLevelDecay`, `:142`).
  - The spot price is pessimistically offset for **price-feed lag**: `spot·(1 ± spotOffset)` (`pool/PoolInternal.sol:154-163`).
  - Floor price = `intrinsic + collateral·minAPY·τ`. Fee premium 3% (deploy script `fixedFromFloat(0.03)`). CDF is Choudhury (1.4e-4 error).
- **v3** (`$R/premia-v3-contracts`, Jul 2024):
  - Order-book-like **concentrated-liquidity AMM in option-price space**, normalized to [0,1], with price linear within a tick (`libraries/Pricing.sol`). This is a reserve and range-order design, the v3 analog of trading YES in a CL pool.
  - Plus an **Underwriter Vault**, model-priced: `premium = BS(spot, K, τ, σ from IV oracle, r)` and `spread = (C − 1)·premium`. The C-level interpolates exponentially from `minCLevel` to `maxCLevel` in utilization `u`: `c(u) = [k·e^{α(1−u)} + α·maxC − k]/(α·e^{α(1−u)})` with `k = α(minC·e^α − maxC)/(e^α − 1)`, minus `hourlyDecayDiscount × hours since last trade`. The geometric mean of the pre- and post-trade C-levels is used (`OptionMath.sol:328-371`, `UnderwriterVault.sol:605-700`).
  - The vault enforces `minDTE/maxDTE` and `minDelta/maxDelta` bounds on buys. Test parameters: α = 3 (or 0.15), minC 1.0–1.05, maxC 1.2, hourly decay 0.005 (production values **UNVERIFIED**). Sells back to the vault are priced at `min(avgPremium, fair)`.
  - CDF is the Shore RMM approximation, max error **6.6e-7** **[computed]**.

### 5.2 Pods Finance Optimized AMM (docs: `$R/pods-docs/options-amm-overview/optionamm/pricing.md`)

The target price is BS with `r = 0` and `WeightedIV = (3·oracleIV + IV_{i−1})/4`, where the spot comes from Chainlink. Trades execute along a **virtual constant product recentered at the BS price**: `poolAmountA = min(TB_A, TB_B/P)` and `poolAmountB = min(TB_B, TB_A·P)`. After the trade, the AMM **solves for the IV** that reproduces the new virtual price, accepting ±0.1 tolerance, and stores it. Trading stops in the expiry window. This is a clean template for "model mid plus bounded price impact plus vol feedback".

### 5.3 Hegic (secondary)

Premium ≈ `√period × IV × strike/price`-type formula with an admin-set `ImpliedVolRate`, changed manually only when market IV moved about ±10%. Sophisticated buyers exploited the stale IV, and a single pooled LP absorbed directional losses with no hedging (secondary: Hindenrank and other analyses; **UNVERIFIED** exact formula version).

### 5.4 Panoptic (options *from* Uniswap LP positions; oracle defenses)

Options are Uniswap v3/v4 LP positions: short = add liquidity, long = remove it. Premium is *streamed* from pool fees ("streamia"), not BS. No oracle is used for pricing; an oracle is needed only for solvency. Panoptic v2 (`$R/panoptic-labs_panoptic-v2-core`, Sep 2026) supports **v4** (`PanopticFactoryV4.sol`, `SemiFungiblePositionManagerV4.sol`) and maintains an internal oracle updated lazily on interactions. Constants in `RiskEngine.sol:70-96`:

| Constant | Value |
|---|---|
| `EMA_PERIODS` | 60 s / 120 s / 240 s / 960 s (spot, fast, slow, eons EMAs) |
| `MAX_CLAMP_DELTA` | 149 ticks (≈1.5%): maximum tick change per internal-median update |
| `MAX_TICKS_DELTA` | 724 ticks (≈7.5%) |
| `MAX_TWAP_DELTA_DISPATCH` | 513 ticks (≈5%) |

It also keeps an 8-slot sorted median of observations. `isSafeMode` (`:989-1024`) triggers when |current − spotEMA| > 724, |spotEMA − fastEMA| > 362, or |median − slowEMA| > 362. It then checks solvency at the most conservative tick. **This is the best available template for a manipulation-resistant S inside a v4 hook that does not own the underlying pool.**

### 5.5 Others (one line each; **UNVERIFIED** beyond general knowledge)

- **Dopex/Stryke SSOVs:** epoch vaults per strike; BS with an IV oracle; LPs sell covered options per epoch.
- **Smilee:** "Impermanent Gain" volatility products replicating Uniswap-LP-like payoffs.
- **Deri:** everlasting options and power perps with funding.
- **Aevo** (and Lyra v2 / Derive): off-chain CLOB with on-chain settlement.

The industry trend (Lyra v2, Aevo, Polymarket) has been *away from on-chain model AMMs toward CLOBs* for short-dated risk. Our design's differentiator must be composability and passive LP UX, with risk controls strong enough to survive adverse selection.

### 5.6 On-chain normal-CDF approximations used in practice [computed]

| Implementation | Used by | Max abs error on [−8, 8] |
|---|---|---|
| Hart/West rational (N0..N6/M0..M7) | Lyra v1 `BlackScholes.sol` | 2.2e-16 (double) |
| Numerical-Recipes erfcc | Primitive `solstat Gaussian.cdf` | 4.2e-8 in double **[computed, FC]**; the source documents "fractional error less than 1.2e-7" on erfc (`solstat/src/Gaussian.sol:84`) |
| Shore RMM | Premia v3 | 6.6e-7 |
| A&S 26.2.17 (7-digit coefficients) | textbook | 2.0e-7 |
| A&S with Thales' typo | Thales | 1.0e-5 |
| Choudhury | Premia v2, Buffer v2.5 | 1.4e-4 |

For context, a digital needs CDF error well below the smallest fee unit. A 1e-4 error on a $1 payout is 1 bp of notional, which matters when spreads are 1–3%.

---

## 6. Prediction-market primitives

### 6.1 Gnosis Conditional Tokens (CTF): exact semantics (`$R/gnosis_conditional-tokens-contracts/contracts/ConditionalTokens.sol`)

- `prepareCondition(oracle, questionId, outcomeSlotCount)` (`:65`) creates `conditionId = keccak(oracle, questionId, n)` with `2 ≤ n ≤ 256`.
- `splitPosition(collateral, parentCollectionId, conditionId, partition[], amount)` (`:105`). The partition entries are **disjoint** index sets (bitmasks). If the partition covers the full set and the parent is 0, it pulls `amount` collateral; if the parent is non-zero, it burns the parent position; for a sub-partition it burns the union position. It then mints `amount` of each partition element as ERC-1155 `positionId = keccak(collateral, collectionId)`.
- `mergePositions` (`:165`) is the exact inverse.
- `reportPayouts(questionId, payouts[])` (`:78`): the oracle is `msg.sender`, which is part of the conditionId hash. It sets `payoutNumerators` and `payoutDenominator = Σ`, once only.
- `redeemPositions(collateral, parent, conditionId, indexSets[])` (`:218`) pays `stake × Σ_{j∈indexSet} numerator_j / denominator` and burns the stake.
- Invariant: **1 collateral ≡ 1 complete set.** YES + NO can always be merged for $1 and split from $1, which pins `p_YES + p_NO = 1` across venues up to fees.
- Design note: CTF positions are **ERC-1155**. A v4 `Currency` must be native or ERC-20, so a v4 YES/USDC pool needs ERC-20 outcome tokens (Thales-style) or an ERC-1155 → ERC-20 wrapper.

### 6.2 Polymarket

- **Settlement layer:** CTF plus the CTF Exchange, a hybrid CLOB with off-chain matching and on-chain settlement (`$R/Polymarket_ctf-exchange`). `OrderStructs.sol:57-64` defines `MatchType { COMPLEMENTARY /*buy vs sell*/, MINT /*both buys*/, MERGE /*both sells*/ }`. A YES bid at p and a NO bid at 1−p are matched by **splitting** collateral, and two asks by **merging**. That is the complete-set identity made operational.
- **Neg-risk adapter** (`$R/Polymarket_neg-risk-ctf-adapter/src/NegRiskAdapter.sol:237-244`): "Convert a set of no positions to the complementary set of yes positions plus collateral proportional to (# of no positions − 1)" for mutually exclusive multi-outcome markets.
- Polymarket began as a Gnosis-FPMM AMM venue and moved to the CLOB (secondary; general knowledge).
- **2026 crypto up/down markets** (secondary):
  - 5-minute, 15-minute, 4-hour, hourly and daily BTC/ETH markets.
  - Latency bots exploited the lag between Polymarket quotes and Binance. One wallet reportedly went from **$313 to $414k in a month**.
  - On **2026-01-07** Polymarket added dynamic taker fees on 15-minute markets, highest at 50/50 (about 3.15% at 50¢, secondary).
  - Fee Structure V2 (effective 2026-03-30) is `fee = C × feeRate × p × (1 − p)`, with crypto `feeRate = 0.07`: 1.75¢ per share at p = 0.5, i.e. 3.5% of the 50¢ price. Makers pay 0 and receive a 20% rebate (Polymarket Help Center "Trading Fees").
  - On **2026-08-07** the 5 m, 15 m and 4 h markets switched from snapshot settlement to a **Chainlink TWAP** (30 s window for 5 m, 60 s for 15 m and 4 h). This followed a study reporting that about **821 accounts captured roughly $8.2M** in manipulation-flagged cycles of the 5-minute BTC contract by pushing the reference price in the final seconds (secondary). Hourly and daily markets settle on Binance candles.
  - Lessons: fees ∝ `p(1−p)` (the binary's variance) and TWAP settlement are the market's own answers to exactly the risks in §8.

### 6.3 LMSR, LS-LMSR, FPMM, Augur, Zeitgeist

- **LMSR** (Hanson): `C(q) = b·ln Σᵢ e^{qᵢ/b}` and `pᵢ = e^{qᵢ/b}/Σⱼ e^{qⱼ/b}`. Worst-case sponsor loss is `b·ln n`. Gnosis `LMSRMarketMaker.calcNetCost` (`:20`) implements it with `b = funding/ln N`, so max loss = `funding`, using base-2 fixed point.
- **LS-LMSR** (Othman, Pennock, Reeves, Sandholm 2013): `b(q) = α·Σᵢ qᵢ` and `C(q) = b(q)·ln Σᵢ e^{qᵢ/b(q)}`. Liquidity grows with volume, the prices sum to more than 1 (a built-in "vig", bounded by `1 + α·n·ln n`), and the loss can be made small.
- **FPMM** (Gnosis `FixedProductMarketMaker.calcBuyAmount`, `:264-282`): investing I (net of fee) splits into I of every outcome added to the pool, then removes the bought outcome so that `Πᵢ nᵢ` is preserved. For a binary, `p_YES = n_NO/(n_YES + n_NO)`.
- **Augur:** order books (v1/v2), an AMM in Augur Turbo, and REP dispute resolution (**UNVERIFIED** details).
- **Zeitgeist:** "Rikiddo" (a dynamic LS-LMSR), then a move to LMSR-as-CFMM "neo-swaps" / LSMR in 2024 (secondary).
- All of these are **reserve-driven**: price reacts to order flow, not to an external state variable. For events whose probability is a known function of an observable price (like ours), reserve-driven AMMs pay LVR to arbitrageurs who read S from elsewhere (§4.3).

---

## 7. Uniswap v4 hook projects: options, prediction markets, custom curves

Sources: Uniswap/hooklist registry (4,924 hook JSONs, commit `1d2f09b`, 2026-09-21), awesome-uniswap-hooks lists, ETHGlobal showcases, and GitHub. Sources marked Sourcify were read by me.

| Project (chain) | What it does | Pricing | v4 mechanics | Maturity |
|---|---|---|---|---|
| **PolymarketHook** (Unichain `0x0fd7…4888`; Sourcify) | YES/USDC and NO/USDC "synthetic" pools. `beforeSwap` takes USDC, mints YES+NO, swaps the unwanted side on a hookless YES/NO v4 pool, and returns the delta. | Reserve-driven (the YES/NO CL pool) | `beforeSwapReturnDelta`; exact-input only; the **sell path is unimplemented** (`// redeem(market, amount);`); `beforeAddLiquidity` reverts | Hackathon-grade; the closest *architecture* to ours (complete-set mint inside `beforeSwap`) |
| **Hyperhook** (Ethereum `0x9aef…c488`; Sourcify) | Hourly BTC UP/DOWN epochs, Chainlink resolution, decay tax on winner sells | Bounded "sentiment curve": `price_side = MIN + (MAX−MIN)·(s_side+v)²/((s_UP+v)²+(s_DOWN+v)²)`, 90/5/5 pot split | `beforeSwapReturnDelta` custom accounting | Production-ish, parimutuel |
| **OrketHook** (Arbitrum; Sourcify) | Binary PM pools with "VALS" fee `e^{λ·Δx/L·σ} − 1` using a **backend-signed σ** per swap (σ is a "toxic velocity" flow parameter, not option volatility; `OrketHook.sol:453-480`; exponent capped at 2) | Reserve-driven price plus dynamic fee | `beforeSwapReturnDelta`; signed hookData required | Deployed |
| **shift0x/uniswap-v4-prediction-market-hook** | Bull/bear units vs "current price" of a host pool | UniswapV2 math between sides; parimutuel payout | Settlement from the host pool's price after a block-delay; 0% fees for PM participants to encourage arbitrage | Hackathon (Nov 2024) |
| TruthMarketHook (Base), PrediXHookProxyV2 (Unichain), HookcastHook (Ethereum), ConvictionHook (X Layer), MarketHook and ChancePool (Robinhood chain) | Router-gated PM pools, range-order settlement, staker-funded betting | Reserve, parimutuel or fixed-odds | Varied | Registry descriptions only |
| **Smile** (ETHGlobal NYC 2026) | Options marketplace: 1inch Aqua JIT plus a v4 hook | Parametric vol surface (per-tenor IV buckets, α/β smile). The hook **vetoes** secondary trades more than 5% from fair value and nudges IV by ±0.5% after each trade | `beforeSwap` veto, `afterSwap` vol update | Hackathon |
| **HOOK Finance** (ETHOnline 2023, Hookathon prize) | Perpetual options via a vAMM on v4 with streamed premium "converging to BS" | Streaming premium | Oracle-free | Hackathon |
| UHI/Atrium cohort: UniMarket, Lumis, Degen Options, auction-managed perpetual options | PM or options hooks | — | — | Listing only (**UNVERIFIED** details) |
| **Panoptic v2 on v4** | Options as LP positions (§5.4) | Streamia | SFPM V4; internal oracle | Production |
| **EulerSwap** (`$R/euler-swap/src/UniswapHook.sol:106-107,152`) | Custom-curve AMM hook | Own curve; vault-backed | `beforeSwapReturnDelta` with `toBeforeSwapDelta(amountIn, −amountOut)` | Production evidence that custom curves over v4 routing work |
| **OZ `BaseCustomCurve`** (`$R/oz-uniswap-hooks/src/base/BaseCustomCurve.sol:44,90,258`) | Library base: override `_getUnspecifiedAmount(params)` and `_getSwapFeeAmount` | — | Implements the NoOp/custom-accounting pattern | In scope of OZ audits v1.0.0-RC1 and v1.1.0-RC1/RC2 (PDFs in `audits/`); repo is now v1.2.2 and its README still labels it "experimental software" *[FC]*; natural base for our hook |

**Conclusion:** among the hooks and repos I surveyed, none (1) prices binaries by Black–Scholes from a Uniswap-derived S and σ, (2) executes via normal v4 swaps with custom deltas, and (3) uses LP underwriting with full collateral. The pieces exist separately: complete-set minting inside `beforeSwap` (PolymarketHook), custom-curve accounting (EulerSwap, OZ), a manipulation-resistant internal oracle on v4 (Panoptic), and IV nudging after swaps (Smile). The search covered the hooklist registry plus web and GitHub search; private or unlisted projects may exist (**UNVERIFIED** absence).

---

## 8. LP / underwriter economics and risks (quantitative)

Setup: the LP vault sells YES (or NO) at `V_model ± h` and holds the complementary side of each complete set. Capital locked per YES sold is `1 − p`. P&L per unit sold and held is `p + h − 1{win}`.

### 8.1 Stale-price adverse selection (CEX lead–lag): the "LVR analog" for digitals

**[computed]** `greeks.py`, ATM, σ = 60%, r = 0:

| τ | ΔV per 1 bp in S | ΔV per 5 bp | Hedge $ per $1 payout (`φ(d2)/(σ√τ)`) | σ(ΔV) per 2 s block | σ(ΔV) per 12 s block | `E[(|ΔV| − 0.5¢)⁺]` per 12 s |
|---|---|---|---|---|---|---|
| 30 d | 0.023¢ | 0.12¢ | 2.3 | 0.035¢ | 0.086¢ | ≈0 |
| 7 d | 0.048¢ | 0.24¢ | 4.8 | 0.072¢ | 0.18¢ | 0.0003¢ |
| 1 d | 0.13¢ | 0.64¢ | 12.7 | 0.19¢ | 0.47¢ | 0.07¢ |
| 4 h | 0.31¢ | 1.6¢ | 31.1 | 0.47¢ | 1.15¢ | 0.50¢ |
| 1 h | 0.62¢ | 3.1¢ | 62.2 | 0.94¢ | 2.3¢ | 1.38¢ |
| 15 m | 1.24¢ | 6.2¢ | 124 | 1.9¢ | 4.6¢ | 3.2¢ |

- Per-block digital volatility is `φ(d2)·√(Δt/τ)`, **independent of σ** (as in pm-AMM, §4.3).
- **Required half-spread to neutralize an S error of γ_S** (for example the ETH/USDC pool's fee band, 5 bp for a 0.05% pool, or oracle lag): `h ≥ (φ(d2)/(σ√τ))·γ_S`. For γ_S = 5 bp that is 0.24¢ at 7 d, 0.64¢ at 1 d, 3.1¢ at 1 h.
- Real-world confirmation: Polymarket's 15-minute markets (§6.2). For CFMMs the analogous result is `ARB ≈ LVR × P_trade` with `P_trade = 1/(1 + √(2λ)·γ/σ)` (Milionis–Moallemi–Roughgarden, arXiv:2305.14604). A model-priced hook avoids accumulated staleness but not the per-block basis.

### 8.2 Oracle manipulation (same-block spot is unsafe)

- In a CL pool with active liquidity L, moving price by a fraction δ needs `Δy ≈ L√P·δ/2` of quote token, and a round trip costs about `2f·Δy = f·L√P·δ` in fees. Price impact is recovered on the way back, and the attack is atomic in one `unlock` with flash accounting, so it needs **zero capital**. With `D₁%` = the USDC needed to move the price 1%, `L√P ≈ 200·D₁%`.
- The attack pays when `Q·φ(d2)/(σ√τ)·δ > f·L√P·δ + Q·h`. The maximum safe trade size is therefore `Q_max ≈ f·200·D₁%·σ√τ/φ(d2)` (ignoring h).
- Example **[computed, illustrative depth]**: f = 5 bp and `D₁% = $5M` give `Q_max ≈ $39k` of payout at τ = 1 d and about $8k at τ = 1 h. A **single-block spot read is exploitable at modest sizes**, even on deep pools.
- Mitigations from prior art: a **start-of-block snapshot** (price all trades in a block at the first observed S, the v4 analog of Buffer's "price at the next signed price"); **EMA/median with a per-update clamp** (Panoptic: 149-tick clamp, 1–16 min EMAs, 8-slot median, safe mode at 724 ticks); **worst-of(spot, oracle) per direction** plus a revert when they diverge (Lyra: 1.5%); caps sized from `Q_max`.
- **Settlement manipulation.** Settle on a TWAP or median over a window, never a snapshot (Polymarket moved to 30–60 s after the $8.2M episode). Uniswap v4 core has **no built-in oracle** (v4-periphery `main` ships no oracle hook), so settlement observations must come from our hook's own recorded observations or from a hook on the underlying pool.

### 8.3 Pin risk, gamma and where the risk lives in time

- Digital delta `φ(d2)/(Sσ√τ)` and gamma `−φ(d2)·d1/(S²σ²τ)` blow up as τ → 0 near K. Gamma changes sign at `d1 = 0`, so delta hedging near expiry is infeasible: the hedge ratio is 62× notional at 1 h (§8.1).
- **Share of lifetime price variance `V₀(1−V₀)` realized in the final window** (ATM at inception; `E[∫dV²] = V₀(1−V₀)` because V is a bounded martingale ending in {0,1}) **[computed]**. *[FC] Closed form, re-derived: at ATM (`V₀ = ½`), `V_s = Φ(X)` with `X ~ N(0, s/(T−s))`, so `E[V_s(1−V_s)] = ¼ − arcsin(s/T)/(2π)`. The share left after time s is therefore `1 − (2/π)·arcsin(s/T)`, which does not depend on σ.*

| Market life | Last 24 h | Last 4 h | Last 1 h | Last 10 min |
|---|---|---|---|---|
| 7 d | 34.4% | 13.9% | 6.9% | 2.8% |
| 1 d | — | 37.3% | 18.4% | 7.5% |

- Capacity budgeting: variance P&L per unit exposure accrues at rate `q²·φ(d2)²/τ`. To keep risk per unit time constant, **per-market capacity should scale like `√τ/φ(d2)`**, which is the same `√(T−t)` scaling as the dynamic pm-AMM.
- Prior art uses hard cutoffs instead: Thales 24 h, Lyra 12 h, Buffer and Speed Markets short fixed-odds, Pods an "expiration window". Recommended rule: stop trading when `(φ(d2)/(σ√τ))·γ_S > h_max`. Then either (a) keep settle-only, or (b) allow exits only at a conservative GWAV/vol-shocked price (Lyra force-close with vol shocks ×1.2–1.6).

### 8.4 Volatility misspecification (vega) and the IV–RV gap

- Digital vega is `∂V/∂σ = −φ(d2)·d1/σ`. It is zero where `d1 = 0`, positive for OTM calls and negative for ITM. Example: 7 d, K/S = 1.10, σ = 0.6 gives 0.36 per unit σ, i.e. **1.8¢ per 5 vol points**.
- **ETH implied versus realized [computed, `vrp.py`]**, 1,972 daily observations (2021-04 → 2026-08):
  - Deribit **DVOL averaged 74.2%**, versus 68.9% **subsequent 30-day RV**: IV − fwdRV = **+5.3 vol points**, and IV > fwdRV on 66% of days.
  - Trailing 30-day RV is almost unbiased for forward RV (+0.4 points) but has **RMSE 22.8 vol points** (IV RMSE 21.6).
  - By year, IV − fwdRV: 2021 +11.5, 2022 +10.6, 2023 +6.0, 2024 +2.5, 2025 −1.3, 2026 +3.2.
  - Implication: σ from the pool's own history is a reasonable *physical* estimate but sits systematically about 5 points below the options market. Options desks will buy our OTM digitals when σ_hook < IV and hedge on Deribit with call spreads. A **vol premium or multiplier**, a floor, and flow feedback (Lyra `standardSize`) are needed.

### 8.5 Skew and fat tails: BS digitals versus reality

- **Skew.** The market digital equals `N(d2(σ(K))) − Vega(K)·∂σ/∂K`. It is *not* N(d2) at ATM vol, and not N(d2) at the strike's own IV either. With a linear smile `σ(K) = 0.60 + s·ln(K/S)` and `s = ±0.3` **[computed, `skew.py`]**, the digital differs from flat-vol BS at ATM by **∓0.6 pp (1 d), ∓1.7 pp (7 d), ∓3.4 pp (30 d)** (sign opposite to s).
- **Fat tails: ETH calibration backtest [computed, `calib.py`]**, Binance ETHUSDT 1 h closes 2020-01-01 → 2026-09-25 (59,008 h, 15 gaps ≤ 6 h). Strike `K = S₀·e^{k·σ√τ}` with σ = trailing 30-day realized. "Realized − model" is the frequency of `S_T > K` minus the BS N(d2). Positive means BS *underprices* YES.

| k (σ√τ units) | 1 h | 4 h | 1 d | 7 d (n_eff ≈ 345) |
|---|---|---|---|---|
| −2.0 | −0.5 pp | −0.6 | −0.9 | −0.8 |
| −1.0 | **+6.2** | +5.7 | +4.0 | +5.1 |
| −0.5 | **+9.0** | +9.0 | +7.0 | +7.2 |
| 0.0 | +0.8 | +1.6 | +2.8 | +5.1 |
| +0.5 | **−7.7** | −6.9 | −3.1 | +1.8 |
| +1.0 | −5.7 | −4.7 | −1.6 | +1.8 |
| +2.0 | +0.3 | +0.5 | +1.0 | +2.8 |

- Standardized-return statistics: 1 h excess kurtosis 24.5, `P(|z| < 0.5) = 0.550` (normal 0.383), `P(|z| > 3) = 1.93%` (normal 0.27%). At 1 d: kurtosis 7.1 and `P(|z| > 3) = 1.75%`. Intraday hourly-vol seasonality has a max/min ratio of 1.55 (peak 14:00 UTC, trough 04:00 UTC).
- **Reading.** For horizons ≤ 4 h, BS with realized σ **overprices near-OTM digitals and underprices near-ITM ones by 7–9 pp**, far above any sensible spread. A trader who simply buys the "likely" side at ±0.5σ strikes earns about 9¢ per $1 in expectation. At 1 d the error shrinks to about 3–7 pp. The 7 d column is noisy and reflects ETH's 2020–26 uptrend (the drift, +5 pp at k = 0).
- The EWMA σ estimator (λ = 0.97 hourly) reduces but does not remove the effect (1 h: +6.9 / −5.4 pp).
- Options: (i) restrict to τ ≥ 1 d at launch; (ii) use a fat-tailed kernel (for example Student-t or normal-mixture with σ scaled to match variance), which is still closed-form and cheap on-chain; (iii) add a skew/kurtosis correction term (Gram–Charlier); (iv) apply intraday seasonality for sub-day markets.

### 8.6 Exposure concentration and correlated strikes

- All markets on ETH with the same expiry settle on one number. The LP's terminal P&L is `Π(S_T) = premiums − Σᵢ nᵢ^{YES}·1{S_T > Kᵢ} − Σⱼ nⱼ^{NO}·1{S_T ≤ Kⱼ}`, a step function of S_T.
- Per-market caps (Thales $1–5k per market, Buffer OI caps) do not bound `min_S Π(S)` across a strike ladder. **Aggregate caps should be computed per (asset, expiry) over the strike grid**, which is O(#strikes). Lyra's per-board and global net-greek caches (`netDelta`, `netStdVega`) are the on-chain pattern.
- Full collateralization (complete sets) guarantees solvency trivially but locks `Σ(1 − pᵢ)`. Cross-strike netting is a capital-efficiency upgrade and a proof obligation.

### 8.7 MEV notes

- Users are protected by slippage bounds (`sqrtPriceLimit` or minimum amount out in the router).
- The hook is exposed to within-block manipulation of the underlying S (§8.2) and to **oracle-update back-running**: trading right after the underlying pool moves, but before any hook-side smoothing catches up. Start-of-block snapshots and EMAs remove the within-block leg.
- On priority-ordered L2s (Base, OP, Unichain with 200 ms flashblocks; **UNVERIFIED** current ordering rules) latency races are about priority fees. Fees ∝ `p(1−p)` or delta-scaled fees (§8.1) are the economic defense.
- OZ `AntiSandwichHook` and Angstrom (batch clearing) show v4-native MEV mitigations.

### 8.8 Mitigation catalogue with real parameter values

| Mitigation | Thales | Lyra v1 (OP ETH) | Premia | Buffer | Polymarket | Panoptic v2 |
|---|---|---|---|---|---|---|
| Base spread / fee | 3% `min_spread` + 2% safebox | 1% of premium + 0.1% of spot | v2 3% fee premium; v3 C-level ≥ minC | settlement fee (signed, per trade) | `0.07·p(1−p)` per share (crypto) | — |
| Inventory / utilization skew | linear to 15% at cap | +1 vol point per 30 contracts; skew ×1.25 | C-level exponential in utilization, hourly decay | — | CLOB | utilization-based long premium (`VEGOID`) |
| Vol premium / feedback | Deribit ask IV, daily | IV bumps + vega-util + variance fee | IV oracle | owner-set IV | market makers | — |
| Price band | [0.08, 0.95] | call delta ∈ [0.1, 0.9] | v3 delta and DTE bounds | ATM only | — | — |
| Caps | per market 5k (ETH 1k) | vol and skew bounds; NAV-based vega fee | vault free liquidity | pool and market OI caps | — | solvency at multiple ticks |
| Cutoff | 24 h | 12 h | min DTE (v3) | fixed short periods | TWAP window | — |
| Oracle defense | Chainlink | worst-of GMX/Chainlink; 1.5% CB | v2 `spotOffset` | signed prices, max delay | Chainlink TWAP 30–60 s | EMA/median/clamp, safe mode |
| LP entry/exit | weekly rounds | OP ETH: no delay, 0.3% fee, CBs (Arbitrum wETH: 7 d queue, 1% fee) *[FC]* | vault | POL | — | — |
| Hedging | none | SNX perps on OP (`interactionDelay 0`); GMX on Arbitrum (1 d interaction delay) *[FC]* | none | none | — | n/a |

---

## 9. Implications for our design

1. **Tokens and collateral.** Use ERC-20 YES and NO with CTF semantics: 1 USDC is minted into 1 YES + 1 NO and merged back. The hook/vault holds the complementary side and locks `1 − p` of LP capital per unit sold. Solvency is then trivial and provable (`USDC_held ≥ outstanding complete sets`). Plan an ERC-1155 wrapper only if CTF interoperability is desired.
2. **Pricing core.** Mid = `e^{−rτ}·N(d2)` with the drift term (property-test against Thales' driftless bug). Use CDF error ≤ 1e-8, which should be achievable by Lyra-class rational approximations or solady/PRB-based erf. Round in favor of the vault on both legs. Treat `r ≈ 0` for τ ≤ 30 d: `e^{−rτ}` at 4% and 7 d is 0.08%, far below spreads.
3. **Robust S (non-negotiable).** Never price off the same-block `slot0` alone. Snapshot S at the first touch in each block. Maintain Panoptic-style EMAs (about 1–16 min) and an 8-slot median with a per-update clamp (start from `MAX_CLAMP_DELTA = 149` ticks). Price buys at `max(snapshot, EMA)` and sells at `min(...)` (Lyra worst-of). Revert, or enter a "safe mode" that pauses opens, when `|spot − EMA| > threshold` (Lyra 1.5%, Panoptic ≈7.5%). Size per-trade caps from `Q_max = f·L√P·σ√τ/φ(d2)` (§8.2).
4. **σ.** Realized vol from the hook's own oracle observations (EWMA of log returns), then:
   - a vol multiplier or premium toward IV (ETH IV − RV ≈ +5 vol points historically), with floor and cap (Lyra `minVol 0.25`, `maxVol 3`);
   - **flow feedback**: net buying raises σ_eff (Lyra `standardSize`) or shifts the probit, e.g. `d2_eff = d2 + κ·netInventory/capacity`, which keeps prices in (0,1) and gives closed-form costs;
   - GWAV smoothing for NAV and settlement-adjacent uses.
   - Start with τ ≥ 1 d markets. For sub-day markets add fat-tail and seasonality handling (§8.5).
5. **Spread, as a sum of interpretable terms:**
   `h = h₀ + h_Δ + h_inv`, where
   - `h₀` ≈ 1–3% (Thales 3%, Polymarket about 3.5% at 50¢);
   - `h_Δ = c_Δ·(φ(d2)/(σ√τ))·γ_S`, which covers oracle and basis error of γ_S;
   - `h_inv` is linear or exponential in utilization (Thales up to 15%, Premia C-level 1.0–1.2).
   - Consider a variance-proportional term `∝ V(1−V)` (Polymarket). Price bands of [0.05–0.08, 0.92–0.95] (Thales) avoid lottery-ticket and near-certainty mispricing.
6. **Time structure.** Per-market capacity ∝ `√τ` (with a floor). Stop trading at `τ_cut`, the smallest τ at which `(φ(d2)/(σ√τ))·γ_S ≤ h_max`: hours for γ_S of 5–10 bp and h_max ≈ 2–3¢; Thales used 24 h and Lyra 12 h. After the cutoff, allow sells only at a conservative vol-shocked price (Lyra force-close ×0.5–0.8 long vol) or none.
7. **Settlement.** Use a TWAP or median of the hook's recorded observations over a window ending at T (Polymarket 30–60 s; on-chain Uniswap needs a longer window, e.g. tens of blocks), not a snapshot. Settlement is permissionless after `T + buffer` (RMM-01 uses 120 s). Tie rule: `S_T ≤ K` → NO. If there are no observations in the window, fall back to the last clamped median with a delay.
8. **LP accounting.** Use epoch/round-based LP entry and exit keyed to expiries (Thales weekly rounds) or queued deposits and withdrawals (Lyra 7 d). Mark NAV with GWAV σ and robust S. Add circuit breakers on oracle deviation, σ jumps (Lyra 0.15 variance threshold) and utilization (Lyra 1%). Aggregate exposure caps per (asset, expiry) over the strike ladder (§8.6).
9. **Hedging.** Do not hedge inside user swaps. An optional keeper-driven delta hedge on the underlying v4 pool, rate-limited (Lyra: 1 day), is worthwhile for τ ≥ several days. It is infeasible near expiry (62× notional at 1 h). Lyra's data says unhedged delta was the dominant loss.
10. **Baselines for the proof.** Simulate the same flow against:
    - (a) our model-priced hook;
    - (b) a CPMM/LMSR YES/USDC pool;
    - (c) dynamic pm-AMM (`L_t = L₀√(T−t)`);
    - (d) an RMM-01 split-share (oracle-free) replication.
    Report LP P&L under uninformed flow, latency-informed flow (CEX-leading S), and vol/tail-informed flow (traders using realized frequencies from §8.5). Replay ETH 2020–2026 hourly data and DVOL. Show that our design beats (b) and (c) under uninformed and latency flow, and quantify the losses to model-informed flow for given h.
11. **Proof checklist items prior art suggests:**
    - drift-term presence;
    - CDF error budget;
    - `YES_bid ≤ mid ≤ YES_ask` and `YES_ask + NO_ask ≥ 1` (no free complete sets, the mint/merge no-arbitrage);
    - monotonicity in S (↑) and K (↓);
    - `V → 1{S > K}` as τ → 0;
    - clamp and snapshot resistance to atomic manipulation (fork test: flash-swap the underlying and attempt a round trip);
    - settlement TWAP resistance;
    - caps enforced across strikes;
    - solvency invariant `USDC ≥ Σ outstanding sets`.

## 10. Open questions

1. **Chain and ordering.** Block time and ordering (L1 12 s versus Unichain/Base 1–2 s with sub-second flashblocks) set the per-block digital volatility (§8.1) and the latency-race dynamics. Which chain, and which ETH/USDC v4 pool (fee tier, depth `D₁%`)?
2. **Does the hook attach to the underlying ETH/USDC pool** (recording observations in `afterSwap`), or only read `slot0` lazily through `StateLibrary.getSlot0` on its own interactions (Panoptic-style)? Lazy reads leave gaps when nobody trades our markets. That matters for settlement TWAPs.
3. **σ source policy.** Pure on-pool realized vol (Uniswap-native, but about 5 points below IV and fat-tail-blind) versus an IV oracle (Deribit via Chainlink or a signed feed, which is not Uniswap-native) versus flow-implied σ. How strong should flow feedback be, and how do we stop σ manipulation (Lyra's variance fee uses GWAV)?
4. **Kernel choice for sub-day markets.** Normal plus seasonality versus Student-t or normal-mixture. Can we prove calibration on held-out ETH data before launch?
5. **Early exit.** Should YES→USDC before expiry be priced at bid = mid − h, or at a conservative GWAV price after the cutoff? How does that interact with the "hold-to-expiry" P&L analysis?
6. **Capital efficiency versus provable solvency.** Is full per-market collateral acceptable for a proof of concept (yes), and is cross-strike netting a later phase?
7. **Secondary liquidity.** If YES/NO also trade in vanilla v4 pools, arbitrage between the hook's quote and those pools is fine, but it leaks value if the hook's quote is stale. Should the hook be the *only* venue initially?
8. **Oracle-free variant.** Is the RMM-01 split-share (§4.2) worth a prototype as a research alternative? It has no oracle and settles by arbitrage, but it needs a two-sided underwriter market and `Φ⁻¹` on-chain.
9. **Legal and regulatory** status of binary options on crypto prices (out of scope for the technical proof, but relevant for any deployment).
10. **Verification gaps.**
    - The Buffer BLP numbers and Lyra's "7.5% fees" are from search snippets because Medium and Mirror blocked fetches.
    - The Polymarket bot and manipulation figures are secondary press.
    - Premia v3 production vault parameters were not found.
    - The UHI cohort project details were not read.

---

## Appendix: reproduction

All paths are under `$S/prior_art/` unless noted. Run with `uv run --with scipy --with numpy --with mpmath python <script>`.

| File | Purpose |
|---|---|
| `cdf_errs.py` | Max error of the on-chain CDF approximations (§5.6, §1.3) |
| `thales_drift.py` | Thales driftless odds versus BS N(d2) (§1.3) |
| `greeks.py` | Digital sensitivities, per-block volatility, variance share near expiry (§8.1, §8.3) |
| `calib.py`, `zstats.py` | ETH digital calibration backtest and tail statistics; data `eth_1h.csv` from Binance `data-api.binance.vision` klines (§8.5) |
| `vrp.py` | DVOL versus realized; data `eth_dvol.json` from Deribit `get_volatility_index_data` (§8.4) |
| `skew.py` | Smile-consistent digital versus flat BS (§8.5) |
| `$S/rpc.py` | Thales LP round history via Optimism RPC; output `thales_lp_rounds.txt` (§1.6) |
| `$S/thales/`, `$S/hooksrc/` | Sourcify-verified sources for ThalesAMM, ThalesAMMUtils, ThalesAMMLiquidityPool, PolymarketHook, Hyperhook, OrketHook |
| `pmamm.html`, `rmp.txt`, `arbfees.txt` | Paradigm pm-AMM page, arXiv:2111.13740 text, arXiv:2305.14604 text |

Key external sources:

- Thales docs (docs.thalesmarket.io: AMM design, integration, speed markets)
- iosiro Thales AMM audit
- Derive insights "AMM Performance Update" and "Announcing Lyra V2"
- Paradigm "pm-AMM" (2024-11)
- Angeris–Evans–Chitra arXiv:2111.13740
- Milionis–Moallemi–Roughgarden arXiv:2305.14604
- Polymarket Help Center "Trading Fees"
- FinanceMagnates (Polymarket dynamic fees, Jan 2026)
- Genfinity (Chainlink TWAP settlement, Aug 2026)
- Uniswap/hooklist
- ETHGlobal showcases (HOOK Finance, Smile)
- pods-finance/documentation


---

## Verification log (adversarial fact-check, 2026-09-25)

Method: I checked every claim against primary sources (the cloned repos under `$R`, Sourcify sources under `$S/thales` and `$S/hooksrc`, live Optimism RPC, and the paper and blog texts), and re-derived or re-ran the numerics independently. My scripts are `$S/fc04/check_math.py` (CDF errors, Thales drift, greeks, variance share, Q_max, vega, skew), `$S/fc04/calib_indep.py` (ETH calibration with time-indexed data and gap handling) and `$S/fc04/rpc_check.py` (Thales on-chain state, with selectors computed by keccak).

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Thales `calculateOdds` = `N(ln(S/K)/(σ√τ))` (no `−σ²τ/2`), A&S with `0.356538` typo, clip at d²/2 ≥ 130 | Confirmed | `$S/thales/utils_src/contracts/AMM/ThalesAMMUtils.sol:46-77` (line 64: `356538`) |
| 2 | Typo gives max CDF error 1.01e-5 at x=0; A&S with 7-digit coefficients 2.1e-7; canonical 7.5e-8 | Confirmed | check_math.py: 1.014e-05 at 0.000; 2.098e-07; 7.452e-08 (9-digit) |
| 3 | Drift bias +0.6/+2.2/+4.6/+7.9 pp (1 d σ.6; 7/30/90 d σ.8) | Confirmed | check_math.py: 0.63, 2.21, 4.56, 7.87 pp |
| 4 | Thales live params 3%/15%/2%/[0.08,0.95]/86400 s/cap 5000; IV ETH 62, BTC 45; implementation `0xf3b6…369a`; LP `0xc10a…ea40` | Confirmed | rpc_check.py via mainnet.optimism.io (EIP-1967 slot, getters) |
| 5 | Thales LP: final cumulative 0.8615, 80 active rounds, mean −0.16%/wk, SD 2.2%, 33 losing, max DD 22.8%, −$39.7k, peak allocation $735k (round 14), worst rounds #66 −7.44% and #56 −6.84% | Confirmed (with caveat: rounds 143–144 unset) | recomputed from data; spot values re-queried on-chain; `prepareRoundClosing` `ThalesAMMLiquidityPool.sol:306-320` |
| 6 | Buffer v2.5 premium = amount/2 (ATM only); BS used only for early close; Choudhury CDF 1.4e-4 | Confirmed | `BufferBinaryOptions.sol:356-371, 373-414`; `OptionMath.sol:13-34`; check_math.py 1.399e-04 |
| 7 | Lyra v1 Hart/West CDF (27-dp constants), 2.2e-16 in double | Confirmed | `lyra-v1/contracts/libraries/BlackScholes.sol:48-69,361-398`; check_math.py 2.22e-16 |
| 8 | Lyra IV bump `orderSize/100`, skew ×`skewAdjustmentFactor`; OP ETH 30 / 1.25; cutoff 12 h; minDelta 0.1; CB/GWAV/force-close values | Confirmed; line ref corrected (484, not 481); Newport-era params caveat added; OP versus Arbitrum mix-up in §8.8 table fixed | `OptionMarketPricer.sol:362-375, 252-273, 340-341`; `params.realSNX.json`, `params.realGMX.json` |
| 9 | Lyra worst-of pricing (`MAX_PRICE` or `MIN_PRICE` by direction), GMX CB 1.5%, worst-case above 0.4% | Confirmed | `OptionMarket.sol:735-748`; `GMXAdapter.sol:140-165`; realGMX `priceVarianceCBPercent 0.015`, `gmxUsageThreshold 0.004` |
| 10 | Lyra rounds 1–8 returns, −$1.58M, $1.8M collateral loss, hedging counterfactual | Confirmed; "per round" corrected to round-8 range by hedging frequency | insights.derive.xyz/amm-performance-update (fetched) |
| 11 | RMM-01 `y = K·Φ(Φ⁻¹(1−x) − σ√τ) + k`; BUFFER 120 s; gamma ≥ 9000; invariant non-decreasing; `x = 1−N(d1)`, `y = K·N(d2)` | Confirmed (identity re-derived: price `−dy/dx = Kφ(d2)/φ(d1) = S`) | `rmm-core/contracts/libraries/ReplicationMath.sol:41-65`; `PrimitiveEngine.sol:51,170,327,359` |
| 12 | Angeris–Evans–Chitra §2.3 `ψ = R1 − Φ(Φ⁻¹(1 − K·R2) − σ√τ)`, `g(p) = (1 − Φ(d+σ√τ))/K`; §2.1 linear MM | Confirmed; paper's "additional capital" caveat added | `$S/prior_art/rmp.txt` lines 334-441 |
| 13 | pm-AMM static/dynamic invariants; `LVR = V/(2(T−t))`; static loses all value, dynamic loses half | Confirmed (LVR re-derived from `V = Lφ(Φ⁻¹P)`, `V″ = −L/φ`) | pmamm.html KaTeX aria-labels; pmamm.txt |
| 14 | Greeks table (1 bp and 5 bp moves, hedge ×, per-block SD, excess over 0.5¢) | Confirmed to all shown digits | check_math.py |
| 15 | Variance share 34.5/13.9/7.0/2.8% (7 d), 37.3/18.4/7.5% (1 d) | Corrected to 34.4/13.9/6.9/2.8 and 37.3/18.4/7.5 (closed form) | check_math.py `1 − (2/π)·asin(s/T)` |
| 16 | `L√P ≈ 200·D₁%`; `Q_max ≈ f·200·D₁%·σ√τ/φ(d2)` → $39k at 1 d, $8k at 1 h (f 5 bp, D₁% $5M, σ 0.6) | Confirmed (re-derived; σ = 0.6 implicit) | check_math.py: 39,366 and 8,035 |
| 17 | Digital vega `−φ(d2)d1/σ`, gamma `−φ(d2)d1/(S²σ²τ)`; example 0.36 per unit σ, 1.8¢ per 5 vol points | Confirmed (derived by hand) | check_math.py: 0.363, 1.81¢ |
| 18 | Skew correction ∓0.6/1.7/3.4 pp | Confirmed | check_math.py: 0.63, 1.66, 3.42 pp |
| 19 | ETH calibration: 1 h and 4 h rows, kurtosis 24.5, P(|z|>3) = 1.93%, P(|z|<0.5) = 0.550 | Confirmed with an independent implementation; 1 d row agrees within ±0.3 pp (differences come from gap handling) | calib_indep.py |
| 20 | DVOL 74.2% vs forward RV 68.9%, +5.3 points, 66% of days, RMSE 22.8/21.6, yearly values | Confirmed (re-ran) | `vrp.py` output |
| 21 | Panoptic v2 constants (EMA 60/120/240/960 s, clamp 149, 724, 513), safe-mode thresholds, 8-slot median, V4 contracts | Confirmed (path is `contracts/`, not `src/`) | `panoptic-v2-core/contracts/RiskEngine.sol:70-96, 989-1024`; `types/OraclePack.sol:400-420` |
| 22 | EulerSwap `toBeforeSwapDelta(amountIn, −amountOut)`; OZ `BaseCustomCurve` sign convention | Confirmed; OZ audit status clarified | `euler-swap/src/UniswapHook.sol:105-107,152`; `oz-uniswap-hooks/src/base/BaseCustomCurve.sol:92-124,258,274` |
| 23 | PolymarketHook: exact-input only, sell path commented out, `beforeAddLiquidity` reverts | Confirmed | `$S/hooksrc/polymarkethook/src/PolymarketHook.sol:139-145,162-163,201-204` |
| 24 | Hyperhook sentiment curve, 5%–95% bounds, 90/5/5; Orket VALS fee with signed σ | Confirmed; Orket σ clarified as "toxic velocity" | `Hyperhook.sol:24-31,248-249`; `OrketHook.sol:43-46,453-480` |
| 25 | v4 core and periphery have no oracle hook | Confirmed at v4-periphery `9969eec` (2026-09-19): no oracle or geomean contract in `src/`; Uniswap `v4-hooks-public` has none either | `find`/`grep` over the repos |
| 26 | Polymarket fee `C·0.07·p(1−p)`, 1.75¢ at 50¢, makers pay 0, 20% rebate | Confirmed (docs do not show the effective date) | docs.polymarket.com trading fees page |
| 27 | Polymarket TWAP switch 2026-08-07 (30 s for 5 m; 60 s for 15 m and 4 h); 821 accounts, $8.2M | Confirmed as secondary press; scope narrowed to the 5-minute BTC contract | FinanceFeeds, Genfinity 2026-08-12, CryptoDaily |
| 28 | Milionis et al. `P_trade = 1/(1 + √(2λ)·γ/σ)`, `ARB ≈ LVR × P_trade` | Confirmed | `$S/prior_art/arbfees.txt:96-160` |
| 29 | Premia v2 C-level `exp(−steepness·ΔL/max(L))`, `spotOffset`; v3 `c(u)` formula (endpoints checked: `c(0) = minC`, `c(1) = maxC`), geometric-mean C-level, Shore CDF 6.6e-7 | Confirmed; the v3 C-level after decay is floored at `minCLevel` | `Premian-Labs_premia-contracts/contracts/libraries/OptionMath.sol:53-72`, `pool/PoolInternal.sol:154-163`; `premia-v3-contracts/contracts/libraries/OptionMath.sol:21-57,328-371` |
| 30 | Gnosis CTF function lines, `2 ≤ n ≤ 256`; FPMM `calcBuyAmount :264`; LMSR `b = funding/ln N` in base 2; Polymarket `MatchType` | Confirmed | `ConditionalTokens.sol:65-68,78,105,165,218`; `LMSRMarketMaker.sol:20-39`; `OrderStructs.sol:57-64` |
| — | Thales docs on IV sourcing, Speed Markets parameters, iosiro audit findings, Buffer BLP 1.11→0.85, Lyra "7.5% fees", Hegic, Smile/HOOK Finance/UHI projects, Thales worst-round attribution to ETH jumps | Unverifiable in this pass (secondary, left marked) | — |
