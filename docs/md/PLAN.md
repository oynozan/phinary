# Phinary plan: proving a Black–Scholes-priced prediction market on Uniswap v4

**Status: awaiting your approval.** Revised 2026-09-26 after your answers: about 3-day deadline and product first, Unichain Sepolia, live demo in a fork of the Uniswap web app, 1-minute demo markets, Black–Scholes with a Student-t comparison, commits authored by you only.

This plan rests on the research in [docs/md/research/](research/). The starting point is the synthesis [00-SUMMARY.md](research/00-SUMMARY.md). Behind it are:
- 6 topic reports (`01`–`06`), each adversarially fact-checked;
- 12 gap reports in [gaps/](research/gaps/), with working prototypes, backtests and machine proofs.

In total, 27 research agents ran with 0 errors.

---

## 0. What "prove it works" means

"It works" is really seven separate claims, and they need different kinds of proof.

- **C1–C6** can be proven outright, both mathematically and in code.
- **C7 (LPs make money)** cannot be proven outright by anyone. It can only be shown under a declared set of conditions, and the plan treats it that way.

| # | Claim | Proof method |
|---|---|---|
| **C1 Execution** | YES/NO trades are ordinary v4 swaps through `PoolManager`, `V4Router`, `UniversalRouter` and `V4Quoter`: all 4 swap types, both token orderings, and multi-hop ETH→USDC→YES. The concentrated-liquidity curve is never touched. The hook's price is the execution price. | Foundry tests on a real `PoolManager`; fork tests against the deployed UR 2.1.2 and V4Quoter |
| **C2 Pricing** | The execution price equals the Black–Scholes binary model evaluated on Uniswap-derived inputs: S from the ETH/USDC pool, σ from that pool's own history, τ from `block.timestamp`. Numerical error is ≤ 1e-12 per $1 of payout. The price moves with S, σ and τ exactly as the model predicts, and **does not** move with YES/NO reserves. | Derivations; differential tests against mpmath at 50 digits; machine-checked monotonicity; property fuzzing |
| **C3 Solvency** | Every winning token redeems for exactly 1 USDC, whatever the prices, oracle errors or trader behaviour. An LP's loss per market is ≤ its declared budget. | Inductive proof; Halmos symbolic proof; Foundry stateful invariants through the real `PoolManager` |
| **C4 Settlement** | The outcome is decided by the underlying pool's price history over the settlement window, using an exact integer rule. A tie resolves NO. The outcome cannot be changed within a block. Redemption is never locked. | Proof; boundary tests; griefing tests |
| **C5 Manipulation resistance** | Swaps on the underlying pool within a block change the quote by exactly 0. Across blocks, attacker profit is ≤ the spread paid, under the open-interest caps. | Theorem; attack PoCs with **negative controls** (defence removed → attack profits) |
| **C6 Model validity** | Quotes are calibrated probabilities under the model. The on-chain σ estimator is unbiased, and its confidence intervals have the stated coverage. | Monte Carlo; σ̂ coverage on GBM paths driven through the real pool |
| **C7 Economics** *(conditional, not re-run in this build)* | Whether LPs make money depends on who trades. The research already backtested this (see §5), and we **cite** those results rather than re-running them, per your M0–M6 scope. | Cited from `docs/md/research/gaps/` |

---

## 1. What the research changed in your design

Your core architecture works as intended. Black–Scholes pricing, a full "NoOp" v4 hook (the concentrated-liquidity curve is bypassed entirely), standard routers, and LPs as underwriters are all verified with prototypes. **The following details must change**; otherwise the proof would be false or the system trivially exploitable.

1. **S is the start-of-block price, not live `slot0`.** Flash accounting makes intra-transaction manipulation of the underlying pool almost free. Near expiry, the break-even attack is about $400 of YES notional. An oracle hook records the price *before the first swap of each block*, so nothing inside the current block can move the quote.
2. **"S and σ from the same v4 ETH/USDC market" needs an oracle hook.** Every deep v4 ETH/USDC pool is hookless (verified on 4 chains), and a hook cannot be added to an existing pool. We build:
   - an oracle-only hook on our own v4 ETH/USDC pool: fully v4-native and provable, but thin;
   - a v3 `observe()` adapter for real depth;
   - one interface `IUnderlyingOracle` in front of both.
3. **Settlement uses a 4-hour geometric TWAP.** Spot-at-T is 60–300× cheaper to manipulate. The safe open interest grows with the square of the window, so a 30-minute window is too cheap to manipulate to be financeable. A TWAP-settled binary is a **discrete geometric-Asian binary**. It is still lognormal Black–Scholes, with a closed form, so the mid price uses that formula (plain N(d2) is off by up to ~10¢ near the cutoff).
4. **r = 0 is required.** Collateral is idle USDC. With r > 0, `YES + NO = 1` breaks against mint/merge of complete sets.
5. **σ must be live and robustly estimated.**
   - Naive per-block realised variance is biased 25–60% low, because the pool price sticks inside its fee band.
   - We use **TWAP-return realised variance** on a 5-minute grid, ×3/2, with a 1-day-half-life EWMA, a robust clamp and bounds of [20%, 250%].
   - Freezing σ at market creation was backtested and fails: stale intraday σ gets picked off.
6. **A flat Black–Scholes price is exploitable without limit.** The quote needs all of the following, and each piece is backed by a theorem or a backtest:
   - a spread: base ≥ 2¢ plus a gamma-scaled term for input error;
   - linear price impact that **resets every block** and is shared by the YES and NO pools;
   - per-block and open-interest caps;
   - a price band that **halts** trading rather than clamping the price;
   - a cutoff at T − 4 h − 5 min.
7. **The pricing distribution is pluggable.**
   - The default is **Gaussian, i.e. true Black–Scholes**. Every theorem is proven for it.
   - An optional **variance-matched Student-t (ν = 5)** kernel, with a closed-form CDF, was more robust in the strictest backtest.
   - The economics suite reports both. Only the Gaussian kernel can honestly be called "Black–Scholes-priced".
8. **Inventory skew is optional.** A small persistent skew (κ = 0.10: the mid moves 10¢ per budget of vault inventory) defends against traders who keep the same belief across blocks. It reintroduces a *minor* reserve dependence. It is a parameter, default 0; all proofs hold for κ = 0, and within a block for κ > 0.
9. **Solvency is structural.** It comes from complete-set accounting, 1 USDC ≡ 1 YES + 1 NO, and does not depend on pricing. **Profitability is conditional.** The closest precedent, Thales, lost its LPs 13.9%. Our replay of its 54,297 on-chain trades attributes the loss to a missing risk class: traders using options-market smile information, and directional bull-market flow. That class is now in our adversary set.

---

## 2. Architecture

```
          Uniswap v4 PoolManager (singleton, flash accounting, ERC-6909 claims)
   ┌────────────────────────────┬─────────────────────────────────────────────┐
   │ ETH/USDC pool              │ YES_i/USDC and NO_i/USDC pools (per market) │
   │ hooks = UnderlyingOracle   │ hooks = PredictionHook, fee 0, no liquidity │
   └────────────┬───────────────┴──────────────────────┬──────────────────────┘
                │ beforeSwap: record start-of-block    │ beforeSwap: full NoOp
                │ price, tickCumulative, TWAP-return   │ (specified delta = −amountSpecified)
                │ variance grid, checkpoints           │
                v                                      v
      ┌────────────────────┐  S_sob, σ̂², cum(t)  ┌──────────────────────────────┐
      │ IUnderlyingOracle  │ ───────────────────> │ PredictionHook (singleton)   │
      │  v4 oracle hook,   │                      │  quote: BS geometric-Asian   │
      │  or v3 observe()   │                      │  binary + spread + impact    │
      │  adapter (forks)   │                      │  ledger: bucket, outY, outN  │
      └────────────────────┘                      │  caps, band, cutoff          │
                                                  │  settle / redeem / split /   │
                                                  │  merge / LP series tranches  │
                                                  └──────────────────────────────┘
```

### Contracts (`src/`)

| Contract / library | Responsibility |
|---|---|
| `math/NormalCdf.sol` | Φ and φ in WAD. A Hart/West rational approximation with Solady `expWad`. The Horner accumulators carry 18 extra decimals ("HartX36"), and that is what makes monotonicity **provable**. Exact symmetry; saturates at \|d\| ≥ 9. Error ≈ 4e-17; ≈ 1.3k gas. |
| `math/StudentTCdf.sol` | Optional kernels, ν = 4 (algebraic) and ν = 5 (atan). Closed forms; error ≤ 1e-18; ≈ 0.8–1.4k gas. |
| `math/BinaryPricer.sol` | `x = ln(S/K)` from `sqrtPriceX96`, orientation-aware; variance per second at 1e36 scale. Computes the discrete geometric-Asian (μ, v) and `YES = F(μ/√v)`. European N(d2) is the w → 0 special case. |
| `math/QuoteMath.sol` | Exact-integer quadratic solvers for the linear-impact curve: `isqrt` form, Lemma S, all 8 swap types, rounding always in the vault's favour. `g± = P ± kφ` is computed in factored form with one final rounding. |
| `oracle/UnderlyingOracleHook.sol` | Oracle-only v4 hook on the ETH/USDC pool, flags `afterInitialize \| beforeSwap`. Records: the SoB price keyed by `block.timestamp`, v3-style `tickCumulative`, TWAP-return squared differences on a 300 s grid, and settlement checkpoints. Every read is O(1). |
| `oracle/V3ObserveAdapter.sol` | The same interface over a v3 pool's `observe()`, for depth in fork tests. |
| `PredictionHook.sol` | Singleton hook built on OZ `BaseHook`, permission mask `0x2AA8`: `beforeInitialize`, `beforeAddLiquidity`, `beforeRemoveLiquidity` and `beforeDonate` revert; `beforeSwap` + `beforeSwapReturnDelta` are live. It creates its own pools, prices every swap and always fills fully or reverts. It also holds the ledger with solvency checks, settlement, redemption, price-free split/merge (also reachable through UniversalRouter via `hookData`), LP series tranches, and emits the aggregator `HookSwap` event. |
| `OutcomeToken.sol` | ERC-20 with 6 decimals, the same unit as USDC. Only the hook can mint or burn; no transfer callbacks. Deployed with CREATE2 so both orderings relative to USDC can be tested. |

### The price a trader gets

```
S     = start-of-block ETH/USDC price (oracle hook)         x = ln(S/K) from sqrtPriceX96 (no tick flooring)
σ²    = per-second variance: EWMA(TWAP-return RV × 3/2 + band correction), robust clamp, σ ∈ [20%, 250%]
τ     = T − now; settlement statistic = geometric TWAP of the pool tick over [T−w, T], w = 4 h
μ     = x − ½σ²·(τ − w + (n−1)Δ/2)          v = σ²·[(τ − w) + Δ(n−1)(2n−1)/(6n)]
mid   = Φ(μ/√v)                              (Gaussian = Black–Scholes; → N(d2) as w → 0; r = 0)
ask   = max over {SoB, optional anchor} of (F + k·f) + h₀ [+ κ-skew from epoch-start inventory]
bid   = min over {SoB, optional anchor} of (F − k·f) − h₀ [− κ-skew]        k = c_Δ·γ_S/√v
exec  : marginal price = ask/bid + Λ·I   (I = signed per-block flow, shared by YES and NO pools, reset each block)
NO    : ask_NO = 1 − bid_YES,  bid_NO = 1 − ask_YES
halt  : τ < T−w−5min cutoff, price outside [0.02, 0.98], |I| > Q_epoch, open-interest/ladder cap, oracle deviation breaker
```

### Accounting: "virtual complete sets"

- **Per-market ledger:** `bucket B` (USDC held as hook ERC-6909 claims), `outYes`, `outNo`, and inventory claims `invYes`/`invNo`.
- **Solvency check** after every mutation: `B ≥ max(outYes, outNo)`, plus the series ladder cap.
- **Swap settlement:**
  - inputs arrive as ERC-6909 claims;
  - outputs are paid from inventory claims first;
  - any shortfall is minted on demand (`sync → mint → settle`).
- **Optional mode:** an immutable `InventoryOnly` mode for routers that call `sync` early.

### LP layer: series tranches

- A series is `(source, T, w)` with a ladder of up to 30 strikes.
- LPs subscribe 1:1 before trading opens. Capital stays locked until finalisation, so NAV is pure cash at both entry and exit. NAV manipulation and just-in-time LP attacks are therefore impossible by construction.
- Each market has a budget `B` and each series a budget `B_s`, enforced by an exact O(n) ladder check. Open interest is capped by `Q_safe`, which is derived from the measured cost of manipulating the settlement TWAP.
- `settle` is permissionless and records one S_T for the whole series.
- `redeem` and `claim` need no oracle and no unpause. If settlement fails, the fallback is: secondary source → mark at cutoff → **INVALID 50/50** after a grace period.

---

## 3. Mathematical proof program (`docs/md/proofs/`)

Each theorem gets:
- a written proof;
- a numeric check in Python, using mpmath at 50 digits or Monte Carlo;
- a Foundry property test on the Solidity implementation.

Integer lemmas are also machine-checked.

| Theorem | Statement | Verification |
|---|---|---|
| **T1 Model** | Binary under GBM and the risk-neutral measure: `YES = N(d2)`. Parity `YES + NO = 1` at r = 0. Closed-form Greeks and their limits. `r > 0` ⇒ a mint/merge arbitrage exists. | Derivation; Greeks vs finite differences (≤ 1e-19 relative) |
| **T2 Settlement-matched price** | The fair price of a binary on the oracle's actual settlement statistic (discrete geometric TWAP of the tick) is the closed form in §2. The half-tick integer threshold removes floor bias. | Derivation; Monte Carlo using the oracle's own sampling agrees within 1 standard error |
| **T3 Numerical accuracy** | `\|P_chain − P_mpmath\| ≤ 1e-12` on the domain. Φ̂ is exactly symmetric and **monotone on all of ℝ**. | Differential vectors. A monotonicity certificate built from exact-rational interval arithmetic, Sturm root counting and an exhaustive check of the `expWad` segments (under 2 minutes). |
| **T4 Quote safety** | (a) `bid ≤ mid ≤ ask`. (b) `bid_Y + bid_N ≤ 1 ≤ ask_Y + ask_N`, exactly, including rounding. (c) A same-block round trip loses ≥ `2h₀q`. (d) Splitting a trade across the 8 swap types gains nothing. (e) The quote is monotone in S (Lemma M: log-concavity + the band halt). (f) The integer solver is exact (Lemma S; the sell side needs the band precondition). (g) Per-block extraction is ≤ `((\|F−P\|−h₀)⁺)²/(2λ)`. | Proofs; **z3 over unbounded integers** (0.03–2 s per lemma); integer-exact Python fuzz; Foundry fuzz |
| **T5 Solvency and conservation** | The virtual-complete-set invariants hold: `B ≥ max(outY, outN)`; USDC is conserved; mark-to-market is zero-sum at any common mark; LP loss ≤ budget; the ladder cap equals the brute-force minimum. **Solvency does not depend on pricing.** | Inductive proof. **Halmos**: a symbolic inductive step over all 8 swap cases plus split, merge, fund, redeem and resolve, and a bounded end-to-end run through the real `PoolManager`. Ladder cap for n ≤ 4, plus an induction for general n. |
| **T6 Calibration and LVR** | Fair quotes are a martingale, so fair trading has zero expected P&L. Total expected arbitrage loss against block-refreshed depth ℓ is `ℓ·P₀(1−P₀)/2 ≤ ℓ/8`. | Proof. Monte Carlo reliability diagram, Brier score and Hosmer–Lemeshow test with a power check. |
| **T7 σ estimator** | Unbiased under GBM with irregular sampling. `Var(σ̂²) = 2σ⁴ΣΔᵢ²/W²`. The 3/2 factor is exact for Brownian averages. The fee-band bias is quantified. | Proof; Monte Carlo; σ̂ coverage through the real pool |
| **T8 Manipulation** | SoB inputs are invariant to all same-block swaps. Per-block safe size is `q_safe`. The settlement cap `Q_safe = 8π·h₀·k_w·v_cut`. Attacker profit ≤ spread paid (M1), plus a statistical bound (M2). | Proof; attack PoCs; fork tests against real liquidity |

---

## 4. Code proof program (Foundry)

| Suite | What it proves | Claim |
|---|---|---|
| `test/math/` | Differential tests against committed mpmath vectors: ABI `.bin` files, `assertLe(err, 1e-12)`, no FFI needed in CI. Symmetry, monotonicity, range and parity fuzzing. Adjacent-wei seam scans. Bit-exactness against the Python integer spec. | C2 |
| `test/oracle/` | The accumulator equals a brute-force reference over fuzzed paths and gaps. **Same-block manipulation invariance.** Ring buffer wrap-around, robust clamp, checkpoints. σ̂ coverage on GBM paths through the real `PoolManager`. | C2, C5, C6 |
| `test/swap/` | 8 swap cases × 2 token orderings × {`PoolSwapTest`, `V4Router`, locally deployed `UniversalRouter`}. `BeforeSwapDelta` checked byte for byte against the research vectors. `V4Quoter` quote equals execution. `slot0` never moves. Adding liquidity and foreign `initialize` both revert. | C1 |
| `test/pricing/` | Step by step, the price follows the mpmath model as S, σ and τ change. It does **not** respond to reserves, cross-block trade history or pool liquidity (with κ = 0). | C2 |
| `test/invariant/` | Stateful handler over buy and sell (exact-in and exact-out), split, merge, warp, underlying swaps, subscribe, settle, redeem and claim. Checks solvency, conservation, ledger == ERC-6909 balances, supply identities, no round-trip profit, no split advantage and budgets. At least 10⁶ calls. | C3 |
| `test/security/` | One or more tests for each threat T1–T32 in the research threat model. These include `onlyPoolManager`, foreign pools, `hookData` fuzzing, delta sign and ordering, rounding micro-operations, `sync` interleaving on a fresh `PoolManager`, donations, time boundaries, settlement griefing, market spam and reentrancy. | C3–C5 |
| `test/attacks/` | Attack PoCs: an atomic sandwich through ETH/USDC in one `unlock`, multi-block TWAP pushes, σ inflation by oscillation, settlement pushes, and cross-outcome arbitrage. **Negative controls:** variant hooks that price from live `slot0`, lack a cap, or clamp instead of halting **are** profitably attacked. This shows each defence carries weight. | C5 |
| `test/e2e/` | The full "ETH > K at T" lifecycle: a GBM path through the real ETH/USDC v4 pool over days, σ from the oracle, LP subscription, traders via UniversalRouter, repricing checked against mpmath at each step, TWAP settlement, redemption and LP claims. Exact USDC accounting across all actors at the end. | C1–C4 |
| `test/fork/` | **Base** (primary) and **mainnet**: the v3 oracle adapter on real data; deployed UR 2.1.2 and V4Quoter, including multi-hop ETH→USDC→YES and halt semantics; manipulation cost against real liquidity. | C1, C5 |
| Mutation testing | Injected bugs must each be caught: a sign flip, trader-favourable rounding, missing `onlyPoolManager`, `slot0` pricing, a missing cap, and clamp instead of halt. | Meta |
| Gas snapshots | Swap (buy/sell, exact-in/exact-out), quote, oracle write, settlement, ladder check. | — |

---

## 5. Statistics, the model comparison, and what economics we cite (`sim/`, Python via `uv`)

The heavy economics (M7) is dropped, per your choice. What stays is cheap and supports the mechanism claims:

1. **Reference engine.** An integer-exact Python port of the quote function and ledger, reusing the research prototypes. It is the single source of all test vectors.
2. **Calibration under the model (C6).** About 200k quotes along simulated ETH price paths. The check is: of all the times YES was priced at 30¢, did YES actually win about 30% of the time? Reported as a reliability diagram and Brier score.
3. **Black–Scholes vs Student-t comparison.**
   - The same market is priced side by side by both kernels, as a table and a chart.
   - A light historical check on real ETH hourly data (2020–2026) asks which kernel's probabilities matched reality better.
   - This is a few minutes of compute, not the full LP backtest.
4. **Economics, cited not re-run.**
   - The research backtest (1-day markets, real ETH data 2024–2026, out of sample) found the LP profitable in every year, but only under stated assumptions: enough ordinary traders, and no one predicting volatility better than the market.
   - It also found that a trader with perfect foresight of volatility beats the LP.
   - We quote these results with their caveats and link the research reports.

---

## 6. Hackathon demo: live swaps in a fork of the Uniswap web app (Unichain Sepolia)

Research: [interface-fork/RECOMMENDATION.md](research/interface-fork/RECOMMENDATION.md).

**Would forking the Uniswap app work? Yes, with one essential change.**

- The stock app never builds swaps itself. For every quote it asks Uniswap's servers (the Trading API) three things: the price, the approval needed, and the transaction to sign.
- Those servers don't know our pools, so the stock app would just show "No routes found".
- All of those calls go through **one object**, `TradingApiClient`.
- We wrap it. For our YES/NO tokens, the wrapper gets the price from the official **V4Quoter** on-chain and builds the **UniversalRouter** transaction itself. Every other token still uses Uniswap's servers as normal.
- The swap is still executed by Uniswap's real contracts: UniversalRouter → PoolManager → our hook. Judges can see the v4 swap on the block explorer.

**Already verified:**
- the fork runs locally, with a few build patches;
- Unichain Sepolia (1301) is supported in testnet mode;
- the router encoding matches the app's own SDKs;
- the PoolManager, V4Quoter, UniversalRouter 2.0, Permit2 and Circle USDC addresses exist on 1301.

**Not yet verified:** an end-to-end swap in the fork. That needs our contracts deployed first.

**Changes to the fork, about 17–23 h:**

| # | Change | Why |
|---|---|---|
| 1 | Local-run patches (nx, tsconfig, `.env.override`); run on `http://localhost:3000` | The public repo doesn't build as-is; Uniswap's servers only accept the localhost origin |
| 2 | `predictionTradingApi.ts`: overrides quote, indicative quote, approval check, swap, swap status and permissions for our tokens | The core of the integration |
| 3 | Our tokens are resolved **dynamically from the hook's market registry**, polled | 1-minute markets create new YES/NO tokens constantly; avoids spam warnings and manual imports |
| 4 | Quote refresh every 1 s for our tokens | Real-time price changes in the swap box |
| 5 | Chain 1301 RPC → drpc; batching off for 1301; gas estimate before signing | Less dependence on Uniswap servers; no "success then fail" |
| 6 | Optional: a "Prediction markets" section in the token picker, market info (strike, countdown, probability), token logos | Makes the demo readable |

**Contract-side choices that make the demo smooth:**

- **Redemption is a swap.** After settlement, the hook buys winning tokens back at **exactly $1.00**, with no spread. Winners "redeem" by swapping YES → USDC in the same Uniswap swap box. A direct `redeem()` also exists.
- **Outcome tokens pre-approve Permit2.** This is Solady's built-in ERC-20 feature. Selling a brand-new YES token then takes 2 wallet popups (sign, swap) instead of 3.
- **Demo series use 1-minute markets.** 60 s long, strike = ETH's price at creation, 10 s averaging window, trading for about 48 s, a relaxed demo spread of roughly 3–5¢, and settlement by the keeper right after expiry. Every timing value is adjustable.
- **The ETH price source is our own ETH/USDC v4 pool with the oracle hook.** It uses mintable demo WETH and USDC, so there are no faucet limits. A **price-mirror bot** keeps the pool at the real ETH price (from a public price API) about every second, the way arbitrageurs keep mainnet pools in line.
- **Market collateral and trading use Circle's testnet USDC.** The Uniswap app shows it as real "USDC". The LP seed comes from faucet drips, about 20 USDC per 2 h per address, which is enough for demo-sized trades.

**Live-demo risks and mitigations:**

| Risk | Mitigation |
|---|---|
| Uniswap's servers or bot check are flaky on venue Wi-Fi | Own RPC; phone tether as backup |
| Smart-account wallet | Use a fresh, plain MetaMask account |
| Price moves between quote and click | Small trades, 1–2% slippage |
| First app load is slow | Warm up the app before going on stage |
| Anything else | A screen recording of a successful run, as the last fallback |

---

## 7. What cannot be proven

We will state these explicitly in the proof dossier:

- that LPs make money: that depends on who trades (see §5.4);
- that no better adversary exists;
- that L2 sequencers behave honestly (timestamps, censorship);
- that Uniswap Labs will allowlist the hook for its routing;
- anything that relies on unaudited dependencies (Solady `lnWad`/`expWad`, OZ oracle files).

---

## 8. Deliverables

```
phinary/
  foundry.toml, remappings.txt, foundry.lock, lib/ (v4-core, v4-periphery, universal-router, uniswap-hooks, solady, forge-std, permit2, v3-core)
  src/                 contracts in §2
  test/                suites in §4 (+ vectors/ generated by sim/)
  script/              deploy scripts (Unichain Sepolia), market creation
  bot/                 price-mirror bot + keeper (create 1-minute markets, settle)
  packages/swap-sdk/   shared TS module: V4Quoter quote + UniversalRouter encoding
  interface/           fork of Uniswap/interface with our patches (its own git history; you can push it as your GitHub fork)
  sim/                 Python reference engine, vector generators, calibration, kernel comparison
  formal/              z3 lemmas, monotonicity certificate, Halmos harnesses
  docs/md/proofs/      T1–T8 written proofs
  docs/md/PROOF_DOSSIER.md  claim → theorem → test/script → measured result → pass/fail
```

---

## 9. Schedule: 3 days, product first

The work runs as parallel tracks (agents), each with its own tests. At the end of each day there is an adversarial review and a git commit, **authored by you only, with no Claude attribution**. Coding starts only after you approve this plan.

| Day | Track A: contracts and chain | Track B: Uniswap app fork | Gate at end of day |
|---|---|---|---|
| **1** | Toolchain (Foundry, git, deps). Port the proven research prototypes: math (HartX36 Φ, Asian pricer, integer quote solver), `OutcomeToken`, `UnderlyingOracleHook`, `PredictionHook` (markets, ledger, swap path, quote, settlement, redemption-as-swap, LP deposit and claim). Core tests: math vs mpmath, 8 swap types via `PoolSwapTest`/`V4Router`/`UniversalRouter`, solvency invariants, settlement. **Deploy to Unichain Sepolia.** | Fork builds and runs locally. Shared TypeScript module (V4Quoter quote + UR 2.0 encoding) tested against a local Anvil deployment. | **Go/no-go:** one buy and one sell through UR 2.0 on 1301 |
| **2** | Price-mirror bot, keeper (creates 1-minute markets, settles), deploy scripts, demo parameters. Security tests: `onlyPoolManager`, foreign pools, Mallory's sandwich with a negative control, time boundaries. Gas snapshots. | `TradingApiClient` wrapper (items 2–5), dynamic market tokens, 1 s quote refresh, redemption via swap. End-to-end with MetaMask on 1301. | First-time buy (approve + sign + swap) and sell succeed **in the fork** |
| **3** | Hardening, invariant campaign, short proof dossier (claim → test → result), README. If time: Student-t module + comparison, z3 lemmas and Φ̂ certificate from research. | Market info panel, logos, polish; rehearse the full demo 3+ times; screen-recording fallback | Full rehearsal passes |

The proof program in §3–§4 stays the goal. On this deadline, the **core** proofs come first: math accuracy, real-router swaps, solvency, settlement and the attack PoC with its negative control. The formal extras come after.

---

## 10. Defaults

| Decision | Choice | Reason |
|---|---|---|
| Pricing kernel | **Black–Scholes (Gaussian)** on the settlement-matched average-price form; **Student-t ν = 5** as an optional module with its own tests and a side-by-side comparison | Your choice |
| σ | **Live** from the pool oracle (EWMA of TWAP-return variance), robust clamp, [20%, 250%] | A σ frozen at creation fails the backtest; keeps "volatility changes → price changes" true |
| Settlement | Geometric average over the final **4 h** by default; cutoff T − 4 h − 5 min; tie → NO. **Demo markets: 60 s tenor, 10 s window** (adjustable). | Your choice |
| Spread / skew | h₀ = 2¢ + gamma term; inventory skew κ = 0 (parameter exists) | Research-frozen values |
| r | 0 | Required for parity with complete sets |
| Chains | Local `PoolManager` for tests; **Unichain Sepolia** for the live demo; Base/mainnet fork tests only if time | Your choice; the Uniswap app supports 1301 in testnet mode |
| Front end | **Fork of the Uniswap web app** with our `TradingApiClient` wrapper (§6) | Your choice |
| Git | `git init`; one commit per milestone; **author = you, no Claude attribution** | Your choice |
| Out of scope | Heavy economic backtests (cited instead), audits, production deployment, routing allowlisting, delta hedging, Certora/Lean | Your M0–M6 choice |
