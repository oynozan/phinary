# Implementation spec (hackathon build)

This is the normative spec for the code. The plan lives in [PLAN.md](PLAN.md). The research is in [research/00-SUMMARY.md](research/00-SUMMARY.md) and [research/gaps/](research/gaps/).

## 0. Conventions

- **Solidity and EVM:** solc `0.8.26`, EVM `cancun`, via-IR. Libraries are v4-core, v4-periphery, OZ uniswap-hooks (`BaseHook` only) and Solady.
- **Token units:**
  - USDC (collateral) has 6 decimals.
  - Outcome tokens (YES/NO) also have **6 decimals**. 1 YES pays 1e6 USDC units if it wins.
- **Prices** are **WAD** (1e18 = $1.00 per outcome token).
- **Log prices** are signed WAD natural logs. `x = ln(S/K)`.
- **Variance** is **per second at 1e36 scale** (`varE36`). Example: σ = 60%/yr gives 0.36 / 31,557,600 × 1e36 ≈ 1.1408e28. Never store per-second variance in WAD; it loses precision.
- **Time** is `block.timestamp` in seconds. The **epoch key is `block.timestamp`**, not `block.number`.
- **Rounding always favours the vault.** The trader pays `ceil` and receives `floor`.
- **Fill rule:** always fill fully, or revert. Never partial-fill.

## 1. Contracts

| File | Owner track | Purpose |
|---|---|---|
| `src/math/NormalCdf.sol` | math | Φ and φ in WAD. HartX36 (Hart/West with 36-decimal Horner accumulators, from `research/gaps/formal-verification-scripts/halmos/src/HartTail36.sol`). Exact symmetry; saturates at \|x\| ≥ 37. |
| `src/math/StudentTCdf.sol` | math (optional, day 3) | Variance-matched Student-t, ν = 5 (atan form), from `research/gaps/kernel-sufficiency-scripts/solidity/src/StudentTCdf.sol`. |
| `src/math/BinaryPricer.sol` | math | Discrete geometric-Asian binary: `μ`, `v`, mid, pdf; the spread-adjusted ask/bid. |
| `src/math/QuoteMath.sol` | math | Exact-integer amount solvers for linear impact (port of `research/gaps/quote-function-scripts/solidity/src/QuoteMath.sol`, plus the band precondition from the formal-verification report). |
| `src/interfaces/IUnderlyingOracle.sol` | scaffold (frozen) | What the hook reads about ETH/USD. |
| `src/oracle/UnderlyingOracleHook.sol` | oracle | v4 hook on the ETH/USDC demo pool (flags `AFTER_INITIALIZE \| BEFORE_SWAP`). Implements `IUnderlyingOracle`. |
| `src/OutcomeToken.sol` | hook | Solady ERC20: 6 decimals, hook-only `mint`/`burn`. Permit2 infinite allowance (Solady default, kept on). |
| `src/PredictionHook.sol` | hook | Singleton hook: markets, LP vault, swap path, settlement, redemption. |
| `src/interfaces/IPredictionHook.sol` | scaffold (frozen) | External API used by scripts, the bot and the front end. |

## 2. Underlying oracle (`UnderlyingOracleHook`)

- Serves one ETH/USDC v4 pool. On testnet this is **mintable demo WETH (18 dec) and demo USDC (6 dec)**. Either token ordering must work.
- Ticks are **normalised** so that "ETH up" means "tick up": `normTick = sign × rawTick`. `sign = -1` when USDC is currency0.
- The human USD/ETH price is `1.0001^normTick × 10^decimalsShift`.
- Writes follow v3 `Oracle.sol` semantics. On the **first swap of each `block.timestamp`**, `beforeSwap` records the pre-swap state:
  - the SoB `sqrtPriceX96` and tick;
  - a new observation `{timestamp, tickCumulative}` into a ring buffer (configurable cardinality, e.g. 4096). The cumulative uses the tick that prevailed since the last write.
- **Virtual-write rule** for reads in a block with no write yet: `SoB = slot0` of the pool. That is exact, because no swap has happened in this block yet.
- Reads:
  - **`lnSpotSoBWad()`**: WAD `ln(USD per ETH)` at the start of the current block, computed from `sqrtPriceX96` (`lnWad`, no tick flooring) with sign and decimals applied.
  - **`cumulativeAt(uint32 t)`**: normalised `Σ tick·dt` at any past time `t` within the ring span (binary search plus linear interpolation, v3 `observe` semantics), and at `t ≤ now` (extrapolated with the SoB tick). Used for settlement.
  - **`varianceE36()`**: per-second variance from the **TWAP-return realised variance** estimator. It averages the normalised tick over an H-second grid, takes squared differences of consecutive grid means ×3/2, converts with `ln(1.0001)²`, winsorises each difference, and clamps to `[varMinE36, varMaxE36]`. If fewer than `minWindows` complete windows exist, it returns `fallbackVarE36` (warm-up). Parameters `H`, `nWindows`, `minWindows`, clamps and fallback are set at construction; the owner may update the clamps and fallback.
  - `sobTick()`, `feedInfo()` are auxiliary.
- It cannot be moved by swaps in the current block. **This is a tested property.**

## 3. Markets (`PredictionHook`)

### 3.1 Creation (`createMarket`, owner/keeper only)

The parameters are in `IPredictionHook.MarketParams`:
- `oracle`;
- `lnStrikeWad` (ln of the USD strike);
- `openTime`, `expiry`, `window` (settlement averaging seconds), `cutoffBuffer` (seconds before `expiry − window` when trading stops), `nSamples` (samples in the window for the discrete Asian formula; use `window / blockTime`, or 0 for continuous);
- `budget` (USDC allocated from the vault);
- quote parameters: `h0Wad` (base half-spread), `gammaSWad` (input log-price uncertainty for the gamma term), `lambdaWad` (impact: marginal price change per whole token of net flow in one epoch), `qEpochMax` (max \|I\| per epoch in token units), `pMinWad` (band);
- `sigmaMode` (0 = oracle, 1 = fixed) with `fixedVarE36`;
- `kernel` (0 = Gaussian; 1 = Student-t ν = 5, optional);
- names and symbols for YES/NO.

Creation deploys YES and NO `OutcomeToken`s (CREATE2 with a salt), then calls `poolManager.initialize` for `{YES, USDC}` and `{NO, USDC}`:
- fee 0, `tickSpacing = 60`, `hooks = this`;
- sqrtPrice is cosmetic: `2^96`.

`beforeInitialize` **always reverts**. Self-initialisation skips it through `noSelfCall`. Creation moves `budget` from vault idle into the market bucket.

### 3.2 Ledger per market

```
bucket   : USDC (6 dec) owned by this market, held as hook ERC-6909 USDC claims
outYes   : YES held by anyone except the hook  (= YES.totalSupply() - invYes)
outNo    : NO held by anyone except the hook
invYes   : YES ERC-6909 claims held by the hook (from users selling)
invNo    : NO ERC-6909 claims held by the hook
epochTs, epochFlow (int, YES-equivalent tokens: YES buy +q, YES sell -q, NO buy -q, NO sell +q)
status   : Trading | Settled | Invalid ; yesWon
```

**Solvency is a hard post-condition of every mutation:** `bucket ≥ max(outYes, outNo)`. After settlement: `bucket ≥ outWinner`; if Invalid, `bucket ≥ (outYes + outNo)/2` rounded up.

**Global identity:** `Σ bucket + vaultIdle == poolManager.balanceOf(hook, USDC.id)`. It is `≤` only when someone donates claims.

### 3.3 Quote (the mid and spread are constant within an epoch)

```
τ   = expiry − now                                  (trading requires openTime ≤ now < expiry − window − cutoffBuffer)
x   = oracle.lnSpotSoBWad() − lnStrikeWad
σ²  = sigmaMode==0 ? oracle.varianceE36() : fixedVarE36        (per second, 1e36)
Asian discrete (n = nSamples ≥ 1, Δ = window/n; n == 0 → continuous):
  μ = x − ½σ²·(τ − w + (n−1)Δ/2)                   continuous: x − ½σ²(τ − w/2)
  v = σ²·[(τ − w) + Δ(n−1)(2n−1)/(6n)]              continuous: σ²(τ − 2w/3)
  d = μ/√v ; mid = Φ(d) ; pdf = φ(d)
k   = gammaSWad / √v
ask = ceil( Φ(d) + k·φ(d) ) + h0Wad    bid = floor( Φ(d) − k·φ(d) ) − h0Wad    (clamp bid at ≥ 0 before the band check)
NO: askNo = 1e18 − bid ; bidNo = 1e18 − ask
```

**Amounts** come from `QuoteMath`, with `lam = lambdaWad` and `i0` = the epoch flow in the pool's mirrored coordinate:

| Pool / direction | Price arg | State arg | Flow update |
|---|---|---|---|
| YES buy | `ask` | `+I` | `I += q` |
| YES sell | `bid` | `+I` | `I −= q` |
| NO buy | `1e18 − bid` | `−I` | `I −= q` |
| NO sell | `1e18 − ask` | `−I` | `I += q` |

`I` resets to 0 when `epochTs != block.timestamp`.

**Checks.** Any failure reverts with a custom error. The hook wraps it as `WrappedError`, and V4Quoter shows "no quote".
- Every executed marginal price is inside `[pMinWad, 1e18 − pMinWad]`. Check both endpoints of the linear segment.
- `|I_after| ≤ qEpochMax`.
- Solvency.
- Amounts > 0.

### 3.4 Swap path (`beforeSwap`)

1. Resolve the market from `PoolId`; revert `UnknownPool` otherwise. `hookData` is ignored.
2. `exactIn = amountSpecified < 0`. The input currency is `zeroForOne ? currency0 : currency1`. `isBuy = (input == USDC)`.
3. By status:
   - **Trading**: quote and amounts as in §3.3.
   - **Settled**: only **sells of the winning token at exactly 1.0**, with no spread and no impact. That is redemption via swap. Everything else reverts `MarketClosed`.
   - **Invalid**: sells of either token at 0.5.
4. Update the ledger (effects), then interact:
   - **Input:** `poolManager.mint(address(this), inputId, amtIn)` to take ERC-6909 claims.
   - **USDC output:** `poolManager.burn(address(this), usdcId, amtOut)`.
   - **Outcome-token output:** burn inventory claims first (`poolManager.burn(hook, tokId, fromInv)`). Any shortfall uses `poolManager.sync(tok); OutcomeToken.mint(poolManager, short); poolManager.settle()`.
5. Return `BeforeSwapDelta`:
   - exact-in: `(+amtIn, −amtOut)`;
   - exact-out: `(−amtOut, +amtIn)`.

   So `specified = −amountSpecified` always.
6. Emit the aggregator-style event `HookSwap(bytes32 id, address sender, int128 amount0, int128 amount1, uint128 hookLPfeeAmount0, uint128 hookLPfeeAmount1)` or the IHookEvents equivalent, plus our own `Trade(marketId, trader=sender, isYes, isBuy, qty, usdc, priceWad)`.

Flags: `BEFORE_INITIALIZE | BEFORE_ADD_LIQUIDITY | BEFORE_REMOVE_LIQUIDITY | BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA | BEFORE_DONATE`. All callbacks except `beforeSwap` revert.

### 3.5 Settlement and redemption

- **`settle(marketId)`** is permissionless when `now ≥ expiry`:
  - `D = cumulativeAt(expiry) − cumulativeAt(expiry − window)`, normalised ticks × seconds.
  - Strike threshold in ticks: `κ = lnStrikeRawTick`. Compute `strikeTickWad = (lnStrikeWad − decimalsShift·ln10) / ln(1.0001)` (WAD).
  - **YES iff `D·1e18 > window·(strikeTickWad − 0.5e18)`.** The half-tick removes floor bias. A tie resolves NO.
  - `status = Settled`.
  - If the oracle cannot answer (not retained) and `now > expiry + GRACE`, anyone may call `settleInvalid` (50/50).
- **`redeem(marketId, amount)`**: direct path. Burns the caller's winning tokens (`OutcomeToken.burn`, hook-only) and pays USDC inside a hook-initiated `unlock` (burn claims, then `take`).
- **Redemption via swap**: §3.4, Settled.
- **`sweep(marketId)`** is permissionless after settlement. It moves `bucket − outWinner` (Invalid: `bucket − ceil((outYes+outNo)/2)`) back to vault idle. It can be called again as redemptions proceed.

### 3.6 LP vault (inside the hook)

- **`deposit(assets)`**: USDC `transferFrom` user → hook. Inside `unlock`: `sync(USDC)`, transfer to PM, `settle`, `mint` claims. Shares are priced at **NAV⁺** with a virtual offset: `shares = assets·(totalShares + 1e6)/(NAVplus + 1)`.
- **`withdraw(shares)`**: pays `assets = shares·(NAVminus + 1)/(totalShares + 1e6)` from **idle only**. It reverts if idle is short. Inside `unlock`: `burn` claims, then `take` USDC to the user.
- `NAVplus  = idle + Σ_active (bucket − min(outYes,outNo))`
- `NAVminus = idle + Σ_active (bucket − max(outYes,outNo))`
- Both are maintained as O(1) aggregates, updated on every trade, settle and sweep. They are model-free, so an oracle cannot manipulate them.
- Shares are internal and non-transferable (hackathon).

### 3.7 Access control

- `owner` (the deployer) sets `keeper`. `createMarket` is callable by owner or keeper.
- Global parameters are only the keeper and owner addresses.
- Per-market parameters are immutable.
- There is **no admin override of settlement**.

## 4. Front-end integration contract

| What | Contract call |
|---|---|
| Quote | `V4Quoter.quoteExactInputSingle` / `quoteExactOutputSingle` with `PoolKey{currency0, currency1, fee 0, tickSpacing 60, hooks}` |
| Swap | UniversalRouter 2.0 on chain 1301 (`0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d`, **5-field** `ExactInputSingleParams`): commands `0x10` (V4_SWAP) or `0x0a10` (PERMIT2_PERMIT + V4_SWAP), actions `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL` |
| Market list | `hook.marketCount()`, `hook.marketInfo(id)` (tokens, pool keys, strike, expiry, window, status), `hook.quote(id)` (mid/ask/bid for YES and NO, τ, σ) |
| Events | `MarketCreated`, `Trade`, `Settled` |

Chain 1301 addresses (verified in [research/interface-fork/unichain-sepolia.md](research/interface-fork/unichain-sepolia.md)):

| Contract | Address |
|---|---|
| PoolManager | `0x00b036b58a818b1bc34d502d3fe730db729e62ac` |
| V4Quoter | `0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Circle USDC | `0x31d0220469e10c4E71834a79b1f276d740d3768F` |
