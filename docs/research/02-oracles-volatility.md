# 02: Spot S, volatility σ and settlement price S_T from Uniswap

Status: fact-checked final, 2026-09-25 (draft verified adversarially; corrections are marked **[FC]** inline, and the
verification log is at the end). Scope: how a Uniswap v4 binary-option ("prediction") hook can get
(1) the spot price S used to price trades, (2) the volatility σ, and (3) the settlement price S_T, in a way
that is Uniswap-native and hard to manipulate.

Conventions: `ln` is the natural log. A tick `t` means raw price `1.0001^t` (currency1 per currency0, in base
units). A *log-return in ticks* `Δt` equals `Δt · ln(1.0001)` in natural-log units, with
`ln(1.0001) = 9.99950003e-5` (about 1 bp). "SoB" means start-of-block price, which is the same as the
end-of-previous-block price. `y_v` means the virtual USDC reserve `L·√P` of the active range (USD). σ is
annualized over 365 days (crypto trades 24/7) unless a per-second unit is given.

Provenance: code citations are `repo/path:line`, taken from the clones in
`scratchpad/repos` (commit hashes are in Appendix A). Live on-chain numbers were read on 2026-09-25 through public
RPCs: Ethereum block ≈ 26,054,869 and Unichain block ≈ 59,596,666. Numerical scripts and a Foundry prototype are
listed in Appendix B. Anything I could not verify is marked **UNVERIFIED**.

---

## 0. TL;DR

1. **Uniswap v4 has no oracle.** `grep -ri "observ|oracle" v4-core/src` returns nothing. Every v4 oracle is a hook,
   and **all of the canonical ETH/USDC v4 pools (mainnet 1/5/30 bp, Unichain 5/30 bp) are hookless.** I checked this
   by recomputing their PoolIds from a PoolKey with `hooks = address(0)` (§6.1). You cannot get a
   manipulation-resistant S or σ out of them. Every read of their `slot0` can be manipulated within the same
   transaction for the cost of fees alone.
2. The proven pattern is Uniswap v3's `Oracle.sol`. It writes **once per block, at the first interaction, using the
   tick from before that interaction**. As a result the cumulative `Σ tick·dt` never contains a price that was moved
   in the same block. v4 ports of it include OpenZeppelin's `BaseOracleHook` (Panoptic-derived, with a truncated
   accumulator), the historical `GeomeanOracle`, and the `TruncatedOracle` branch.
3. **Pricing the binary from `slot0` is catastrophic.** A 1% round trip in the mainnet v4 5 bp ETH/USDC pool costs
   about $55 in fees. A 1-day at-the-money binary moves about 14.3¢ per 1% move in S. The attack breaks even at
   about 390 binaries per transaction and can be repeated (§4.2).
4. Pricing from the **SoB price or a short n-block TWAP** makes the attacker hold the manipulation across block
   boundaries, where it is exposed to arbitrage. That costs roughly `y_v·δ²/4` per block. It raises the break-even
   attack size by about 5× (SoB) to about 25× (5-block TWAP) (§4.3). A builder that also controls the next block pays
   fees only, which cancels the SoB gain, so short TWAPs plus per-block caps are needed. The price is then stale by at least one block, so informed flow picks off LPs at
   about `0.8·n(d2)·√(Δt_lag/τ)` per $1 of binary: 0.38¢ for a 1-day at-the-money binary with a 12 s lag, and 1.8¢
   for 1 hour (§4.4). Fees and spread must scale with this. Trading must stop well before expiry.
5. **σ from ticks works, but naive per-block RV is biased low by about 25%.** Over 7 days of real data from the
   mainnet v3 5 bp pool, per-block RV was 40.4%, while Binance 1-minute RV was 52.5% and Deribit DVOL was about
   51. Cause: the fee band and partial arbitrage make the pool price sticky. 72% of block returns are zero, and the
   lag-1 autocorrelation is +0.10. **Sampling at ≥5 minutes fixes most of this.** Five-minute point returns give
   about 50–51% (depends on grid phase and the block→timestamp mapping) and five-minute TWAP returns (×3/2) give
   51.1–51.2%, against 52.4–54.3% on Binance. A band-follower simulation reproduces the zero-return share, the
   per-block bias and the signature plot, but it overstates the lag-1 autocorrelation (model +0.33 vs real +0.10)
   **[FC]** (§3.4).
6. The recommended σ accumulator is **"TWAP-return" RV**: squared differences of consecutive H-second mean ticks,
   times 3/2. It costs O(1) per write, fits into a single 256-bit observation slot together with the v3-style
   `tickCumulative`, and makes vol manipulation about `(2/3)·(H/Δblock)` times more expensive than point sampling.
   That is about 17× on L1 and about 200× on Unichain for H = 5 min. A Foundry prototype passes an exact
   brute-force equivalence test. It costs **+22.5k gas on the first swap in a block (OZ oracle hook: +20.0k) and
   +10.9k on later swaps** (§3.9).
7. **A TWAP-settled binary is a geometric-Asian binary**, and it has a closed form. If trading stops at `T − w`, the
   only change is `d2_G = [ln(S/K) + (r − σ²/2)(τ − w/2)] / (σ√(τ − 2w/3))`. The gap to the European price is
   ≤0.35¢ for a 1-day market with w = 1 h, and up to 13¢ for a 1-hour market with w = 1 h (§5.1). Use the exact
   formula.
8. **The source pool's depth is the security budget.** A new hooked pool with $1M TVL (full range) can be moved 1%
   across a block for about $20. The v3 5 bp pool costs about $4.2k and the v4 30 bp pool about $6.7k (incl. its
   0.05% protocol fee **[FC]**). **[FC]** The hookless v4 30 bp pool is as deep at the current price as the v3 5 bp
   pool (virtual reserve ≈ $158M vs $155M), but it has no oracle. A
   Uniswap-native design therefore has to use the depth that already exists (read the v3 pool's `observe`) or
   bootstrap a deep oracle pool, and it has to cap exposure per block and per market in proportion to that depth
   (§6, §8).

---

## 1. Uniswap v3 `Oracle.sol`: the reference design

### 1.1 Observation struct

`v3-core/contracts/libraries/Oracle.sol:12-21`

```solidity
struct Observation {
    uint32 blockTimestamp;                       // the block timestamp of the observation
    int56 tickCumulative;                        // tick * time elapsed since the pool was first initialized
    uint160 secondsPerLiquidityCumulativeX128;   // seconds elapsed / max(1, liquidity)
    bool initialized;
}
```

It packs into one 256-bit slot (32+56+160+8). The ring buffer is `Observation[65535]`. `cardinality` is the
number of populated slots. `cardinalityNext` can be raised by anyone through `increaseObservationCardinalityNext`,
which pre-writes `blockTimestamp = 1` so that later swaps pay a nonzero→nonzero SSTORE
(`Oracle.sol:108-120`, `UniswapV3Pool.sol:255-267`).

### 1.2 Write semantics: once per block, with the pre-interaction tick

`Oracle.sol:30-45` (transform) and `:78-101` (write):

```solidity
function transform(Observation memory last, uint32 blockTimestamp, int24 tick, uint128 liquidity)
    private pure returns (Observation memory) {
    uint32 delta = blockTimestamp - last.blockTimestamp;
    return Observation({
        blockTimestamp: blockTimestamp,
        tickCumulative: last.tickCumulative + int56(tick) * delta,
        secondsPerLiquidityCumulativeX128: last.secondsPerLiquidityCumulativeX128 +
            ((uint160(delta) << 128) / (liquidity > 0 ? liquidity : 1)),
        initialized: true
    });
}
function write(...) internal returns (uint16 indexUpdated, uint16 cardinalityUpdated) {
    Observation memory last = self[index];
    // early return if we've already written an observation this block
    if (last.blockTimestamp == blockTimestamp) return (index, cardinality);
    ...
    indexUpdated = (index + 1) % cardinalityUpdated;
    self[indexUpdated] = transform(last, blockTimestamp, tick, liquidity);
}
```

The pool calls it from `swap` **with `slot0Start.tick`, the tick before the swap**. It only does so if the swap
changed the tick (`UniswapV3Pool.sol:732-748`):

```solidity
// update tick and write an oracle entry if the tick change
if (state.tick != slot0Start.tick) {
    (uint16 observationIndex, uint16 observationCardinality) =
        observations.write(slot0Start.observationIndex, cache.blockTimestamp,
                           slot0Start.tick, cache.liquidityStart, ...);
```

It is also called from `_modifyPosition` for in-range mints and burns (`:340-348`, with the current tick, which
liquidity changes cannot move).

The resulting invariant: **the tick accumulated over `(t_prev, t_now]` is the tick that held at the end of the last
block that traded.** Swaps inside block `t_now` change `slot0` but add nothing to the cumulative until the next
block. At that point they are weighted by the time the price actually held.

### 1.3 observe / interpolation / cardinality

`Oracle.sol:245-287` (`observeSingle`):

- `secondsAgo == 0`: returns `last`, extrapolated with `transform(last, now, currentTick, liquidity)` when
  `last.blockTimestamp != now`.
- A target inside the buffer is found by binary search (`:153-184`), then linearly interpolated (`:273-285`):
  `before.tickCumulative + ((after.tickCumulative - before.tickCumulative) / Δt_obs) * Δt_target`. Between two
  consecutive observations the tick was constant, so the integer division is **exact**: the difference equals
  `tick × Δt_obs`. For a fixed tick the interpolation is exact, not approximate.
- A target older than the oldest observation reverts with `'OLD'` (`:226`).

`OracleLibrary.consult` (v3-periphery `contracts/libraries/OracleLibrary.sol:34-36`; **[FC]** v3-periphery is not
cloned here, the logic was checked in the vendored copy `Premian-Labs_premia-contracts/contracts/vendor/uniswap/OracleLibrary.sol:39-46`)
floors the arithmetic mean tick toward −∞:

```solidity
arithmeticMeanTick = int24(tickCumulativesDelta / secondsAgo);
// Always round to negative infinity
if (tickCumulativesDelta < 0 && (tickCumulativesDelta % secondsAgo != 0)) arithmeticMeanTick--;
```

`1.0001^meanTick` is the **time-weighted geometric mean price**.

### 1.4 Why this resists same-block manipulation, and what it does not stop

- **Same transaction or same block:** an attacker who pushes the price and pushes it back inside one block leaves
  the cumulative unchanged. The write happened before their first swap, with the old tick, and nothing more is
  written in that block. Corollary: `observe([0])` is clean at any moment. If a write already happened in this block
  then `last.blockTimestamp == now` and no extrapolation occurs. If not, the current tick is still the
  end-of-previous-block tick.
- **Across blocks:** to move the cumulative, the manipulated price has to be the *last* price of block N. It is
  then exposed to every arbitrageur at the top of block N+1. For a concentrated-liquidity range with active
  liquidity L, pushing price from `P` to `P(1+x)` and having it arbitraged back costs the attacker
  (derivation in §4.2):

  `loss ≈ L·√P·(√(1+x) − 1)² / √(1+x) ≈ y_v·x²/4` per block held, plus the LP fee on the push.

- **Multi-block MEV under PoS:** a proposer or builder that controls consecutive blocks can hold the price
  without arbitrage and pays fees only. Uniswap Labs' PoS analysis (Adams, Wan, Zinsmeister, 2022-10-27,
  <https://blog.uniswap.org/uniswap-v3-oracles>) estimates that a validator with 1% stake gets three consecutive
  blocks about 0.19 times per month, and 10% stake about 181 times per month. It also estimates that moving the
  USDC/WETH 5 bp 30-minute TWAP by 20% costs about $710B with 2 blocks and about $978M with 3 blocks. The
  recommendations are wide-range liquidity and, as alternatives, truncated TWAPs (max 9,116 ticks per block, which
  forces "at least a 30 block oracle manipulation in order to move 30 minute TWAP by 20%") and time-weighted
  *median* price oracles **[FC: median added]**.
  Euler's derivation (M. Bentley, `euler-xyz/uni-v3-twap-manipulation/cost-of-attack.tex`) models the cost per block
  as the arbitrage value created. That is the model used in this report. The Omniscia audit of Euler's
  `UniswapV3Oracle` recommends a ≥30-minute window instead of the 5-minute minimum.

### 1.5 The live mainnet v3 USDC/WETH 5 bp pool (`0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640`)

Read on 2026-09-25:

| field | value |
|---|---|
| `slot0.tick` | 197348 (token0 = USDC, token1 = WETH, so ETH = 10¹²/1.0001^197348 ≈ $2,690 **[FC: draft said $2,697]**; re-read at block ≈26,055,028: tick 197353, $2,688) |
| `liquidity` | 2.99e18 (virtual USDC reserve `L/√P` ≈ $155M) |
| `observationCardinality` / `Next` | **723 / 723** |
| `feeProtocol` | 68 = 0x44, so the protocol takes 1/4 of fees on both tokens |
| 723 observations span | **8.55 h** (mean write interval 42.6 s: writes happen only on the first tick-changing swap, or in-range mint/burn, per block). **[FC]** Re-read a few minutes later: 7.89 h (39.3 s mean interval). The span varies with activity. |

Consequence: `observe` on this pool only reaches back about 8.5 h. Anyone can extend it. Each extra slot is one
zero→nonzero SSTORE (about 22.1k gas), so 10,000 extra slots cost about 221M gas. That is **UNVERIFIED** as a cost
in USD, and depends on the gas price. **[FC]** Since Fusaka (Dec 2025), EIP-7825 caps a transaction at 2²⁴ ≈ 16.78M
gas, so one `increaseObservationCardinalityNext` call can add at most ≈750 slots. Growing by 10,000 therefore takes
≥14 transactions. A consumer that needs days of history must either grow the buffer or keep its
own checkpoints (§6).

---

## 2. Uniswap v4: no built-in oracle. Survey of oracle and volatility hooks

### 2.1 v4-core facts that matter for oracles

- No oracle anywhere in `v4-core/src`.
- `StateLibrary.getSlot0` (`v4-core/src/libraries/StateLibrary.sol:40-60`) reads `(sqrtPriceX96, tick, protocolFee,
  lpFee)` with a single `extsload` of `keccak256(poolId, 6)`. Liquidity is at `+3` (`LIQUIDITY_OFFSET`, `:19`).
- In v4 **the tick only moves through swaps**, and a swap with a hook always calls `beforeSwap` first
  (`PoolManager.sol:187-227`), with **one exception: a hook's own swaps skip its callbacks**
  (`Hooks.sol:171-175`, `noSelfCall`, and `:253` `if (msg.sender == address(self)) return (amountToSwap, ZERO_DELTA,
  lpFeeOverride);`). An oracle hook that also trades in its own pool must write its observation manually before
  that trade. OZ documents this in `BaseOracleHook.sol:107-108`.
- `Pool.swap` sets `tick = tickNext − 1` when it crosses downward onto a boundary (`v4-core/src/libraries/Pool.sol:431`).
  `slot0.tick` can therefore be one lower than `getTickAtSqrtPrice(sqrtPrice)` exactly at a boundary. Otherwise
  `getTickAtSqrtPrice` returns "the greatest tick such that getSqrtPriceAtTick(tick) <= sqrtPriceX96"
  (`TickMath.sol:116-121`), in other words floor(log₁.₀₀₀₁ P).
- Swap fee with the protocol fee enabled: `protocolFee + lpFee − protocolFee·lpFee/1e6`
  (`ProtocolFeeLibrary.sol:38-46`). The protocol fee is packed per direction in 12 bits (`self & 0xfff`).

### 2.2 OpenZeppelin `uniswap-hooks` `src/oracles/panoptic` (v1.2.2, read in full)

Files: `BaseOracleHook.sol`, `OracleHookWithV3Adapters.sol`, `adapters/V3OracleAdapter.sol`,
`adapters/V3TruncatedOracleAdapter.sol`, `libraries/Oracle.sol`. The folder name says it derives from Panoptic.
**[FC] The three audits in `oz-uniswap-hooks/audits/` (v1.0.0 RC1 @1db9646, v1.1.0 RC1/RC2) do NOT cover the oracle
files.** Their scope lists contain only `base/`, `fee/`, `general/`, `interfaces/` and `utils/`/`lib/`, and the word
"oracle" does not appear in them. `src/oracles/panoptic/BaseOracleHook.sol` first appears in commit `bd5287c`
(2025-11-27), after v1.1.0, and the first tag that contains it is v1.1.1. Whether a later audit covers it is
**UNVERIFIED**. Treat it as unaudited. The package.json version is 1.2.2, but `git describe` gives
`v1.1.1-80-g80bd724` (the latest tag in the clone is v1.2.1).

Observation (`libraries/Oracle.sol:23-29`). It fits one slot: 32+24+56+56+8 = 176 bits.

```solidity
struct Observation {
    uint32 blockTimestamp;
    int24 prevTruncatedTick;
    int56 tickCumulative;
    int56 tickCumulativeTruncated;
    bool initialized;
}
```

Truncation (`Oracle.sol:38-62`): a per-observation clamp of the truncated tick relative to the previous truncated tick:

```solidity
int24 tickDelta = tick - last.prevTruncatedTick;
if (tickDelta > maxAbsTickDelta || tickDelta < -maxAbsTickDelta) {
    truncatedTick = last.prevTruncatedTick + (tickDelta > 0 ? maxAbsTickDelta : -maxAbsTickDelta);
}
... tickCumulative: last.tickCumulative + int56(tick) * int56(uint56(timeDelta)),
    tickCumulativeTruncated: last.tickCumulativeTruncated + int56(truncatedTick) * int56(uint56(timeDelta)),
```

Hook (`BaseOracleHook.sol`):
- Permissions: `afterInitialize` and `beforeSwap` only (`:65-82`). No return-delta flags.
- `_afterInitialize` initializes the buffer with the initial tick (`:88-101`).
- `_beforeSwap` (`:114-137`) reads `poolManager.getSlot0(poolId)`, meaning the **pre-swap** tick, then calls
  `observationsById[poolId].write(index, uint32(block.timestamp), tick, cardinality, cardinalityNext, MAX_ABS_TICK_DELTA)`.
  It returns `ZERO_DELTA` and fee 0. Note: unlike v3 it writes on the first swap of a block even when the tick does
  not change. It also SSTOREs `stateById` on every swap, which is a warm no-op after the first.
- `observe(uint32[] secondsAgos, PoolId)` returns `(tickCumulatives, tickCumulativesTruncated)` (`:152-169`).
- `increaseObservationCardinalityNext(uint16, PoolId)` (`:175-189`).
- `OracleHookWithV3Adapters` deploys per-pool adapters that expose the v3 `slot0()/observations()/observe()` ABI
  (`secondsPerLiquidity` is always 0), so existing v3 consumers can read a v4 pool.
- Recent commit `01a87ba` (2026-08-07) adds index-range checks to the adapters.

### 2.3 Historical v4-periphery examples

- **GeomeanOracle** (last present at `Uniswap/v4-periphery@1ca56ab7`, `contracts/hooks/examples/GeomeanOracle.sol`,
  removed in #159, 2024-07-18). It is the v3 oracle plus hard anti-fragmentation rules: `fee == 0` and
  `tickSpacing == MAX_TICK_SPACING` (`:95`, "only one oracle pool per pair"), full-range positions only (`:128-132`),
  and **liquidity can never be removed** (`beforeRemoveLiquidity` reverts `OraclePoolMustLockLiquidity`, `:137-144`).
  It writes in `beforeSwap` and `beforeAddLiquidity` with the pre-action tick (`:111-120`).
- **TruncatedOracle** (`v4-periphery` branch `trunc-oracle`, `contracts/libraries/TruncatedOracle.sol`).
  `int24 constant MAX_ABS_TICK_MOVE = 9116;` (`:21`). `transform` clamps `tick` to `last.prevTick ± 9116` before
  accumulating (`:43-66`), so only the truncated cumulative exists. 9116 ticks is ×2.488 in price, or
  ln-return 0.9116, per observation. Uniswap blog of 2023-09-20
  (<https://blog.uniswap.org/uniswap-v4-truncated-oracle-hook>): an attacker "would have to wait 15 blocks for the
  oracle to catch up", which exposes the manipulation to arbitrage for longer.
- **VolatilityOracle** (`@1ca56ab7`, `contracts/hooks/examples/VolatilityOracle.sol`). Despite the name, it is a toy
  dynamic-fee example: `fee = 3000 + lapsed·100/60` (`:55-60`). It does **not** estimate volatility.

### 2.4 Aloe II `VolatilityOracle`, which reads implied vol from Uniswap v3 fee growth

Source: `aloelabs/aloe-ii`, `core/src/libraries/Volatility.sol:44-87`, `core/src/VolatilityOracle.sol`,
`core/src/libraries/constants/Constants.sol:130-171`.

The formula is Lambert's (<https://lambert-guillaume.medium.com/on-chain-volatility-and-uniswap-v3-d031b98143d1>):
a narrow LP position behaves like a perpetual straddle, and setting fee income equal to theta gives

`IV = 2γ·√(volume / tickTVL)` (daily; multiply by √365 for annual), where γ is the fee tier.

In code (`Volatility.sol:55-63`):

```
//  γ = √(γ₀γ₁)
//  volume ≈ ((P · fgg0 / γ₀) + (fgg1 / γ₁)) · liquidity
//  valueOfLiquidity = (tickSpacing · liquidity · √P) / 20000
//  IV = 2 √( 20000 · (fgg0 · γ₁ · √P  +  fgg1 · γ₀ / √P)  / tickSpacing )
```

It uses `feeGrowthGlobal{0,1}X128` deltas over about 72 h (`FEE_GROWTH_AVG_WINDOW = 72 hours`), samples every 4 h,
applies an asymmetric EMA (gain 1/20 up, 1/100 down), and clamps IV changes to 1 percentage point of *daily* IV per day **[FC: that is ≈19 annualized vol-points per day (×√365), not 1]**
(`IV_CHANGE_PER_SECOND = 115740` in 1e12 units at a 24 h scale). Cold start is 12.79% daily. `Oracle.consult` also
returns a **manipulation metric**: `dist(meanTick[0,2w], meanTick[w,2w])` **[FC: the mean over the whole 2w window vs the older half, which is equivalent up to a factor of 2 to comparing the two halves]** (`libraries/Oracle.sol:110-117`).

Relevance: this is a Uniswap-native *implied*-vol proxy, but it is contested. Khaldoun (arXiv:2608.13340, revised
2026-09-23) argues that σ_fee = 2·fee·√(Vol/L_tick) is "a fee implied activity index, not a Black-Scholes consistent
implied volatility". Volume includes uninformed flow, and hedging costs cannot be seen. It can also be inflated by
wash volume, since only the fee is paid, and an attacker who is also the LP gets part of that back. It does not
apply directly to v4: v4 has `feeGrowthGlobal` per pool through `StateLibrary.getFeeGrowthGlobals`, but dynamic fees
break the fixed-γ assumption. I treat it as a sanity signal only.

### 2.5 Other v4 volatility work found

- **Brevis / SP1 "VolatilityHook-UniV4"** (`0xekkila/VolatilityHook-UniV4@4fa158f`, 2024-09-26). RV of ETH/USDC across
  DEXes is computed off-chain from tick data and verified on-chain with a SNARK
  (`src/SnarkBasedVolatilityOracle.sol:21-44`). It converts from tick units to ln units with
  `ln_1_0001 = 109945666` in 40 fractional bits (`:12, :41`). **It has an owner backdoor, `setVolatility(uint256)
  onlyOwner` (`:78`).** It shows that the ZK-coprocessor path (Brevis, Axiom, SP1) exists for arbitrary estimators.
- **StoikovHook** (`tonycai/StoikovHook`). The contract is a skeleton with a placeholder fee. Its spec
  (`specs/01-design.md`) describes a time-aware EWMA of squared per-block tick changes,
  `V ← (τ_σ V + Δ²)/(τ_σ + Δt)`, with Δt floored at 1 s and a cap C bounding V. It is a useful reference for an
  EWMA variant.
- **Angstrom (Sorella)** is a v4 hook with per-block batch clearing, live since about August 2025 per the Uniswap
  Foundation builder update. Its price is a uniform clearing price per block, which would be a clean oracle input.
  Whether it has deep ETH/USDC liquidity and exposes an oracle is **UNVERIFIED**.
- **Euler price oracle** `UniswapV3Oracle` adapter: minimum 5-minute TWAP, with an audit recommendation of ≥30 min.
  It needs pools with "some full-range liquidity" and a large enough cardinality.

I found no production v4 hook that exposes an on-chain *realized-variance accumulator*. §3.9 proposes one.

---

## 3. Realized variance from tick data

### 3.1 Identity

`P = 1.0001^tick`, so `ln P = tick·ln(1.0001)`, and a log-return equals `Δtick · 9.9995e-5`. For any sequence of
sampling times `s_0 < … < s_n` spanning `T_w = s_n − s_0` seconds:

`σ̂²_per-second = ln(1.0001)² · Σ (tick(s_i) − tick(s_{i−1}))² / T_w`, and `σ̂_annual = √(σ̂²_per-second · 31,536,000)`.

Because Σ is additive, **store a cumulative `Q(t) = Σ_{s_i ≤ t} Δ²` next to each observation**. The variance over
any window is then `(Q(b) − Q(a))/(t_b − t_a)`, the same trick as `tickCumulative`. The sign of the tick orientation
(ETH as currency0 vs currency1) does not matter for squared returns.

**Work in per-second total variance on-chain, and avoid annualizing.** Black-Scholes needs only `v = σ²τ`:
`d2 = (ln(S/K) − v/2)/√v` with `v = σ̂²_per-second · τ_seconds` (r = 0).

### 3.2 Estimators and unbiasedness

Model: `ln S_t = ln S_0 + μt + σW_t` (GBM, which is the Black-Scholes assumption).

- **Irregular sampling is fine.** `E[Σ(Δ ln S)²] = σ²·T_w + μ²·Σ Δs_i²`. The drift term is negligible: with μ = 100%
  per year and 5-minute returns, `μ²h/σ² ≈ 3.5e-5` (h in years). This still holds when the sampling times are **stopping times**,
  for example "the first swap after the price moved". For a continuous martingale `M`, `E[(M_τ − M_σ)²] = E[⟨M⟩_τ −
  ⟨M⟩_σ]` (Wald / optional stopping). Endogenous, trade-triggered sampling therefore does not bias RV in the model.
  Gaps with no swaps do not bias it either: the whole move is counted as one larger return.
- **Point (grid) sampling.** Take `tick` at fixed grid times `jH`. Then `E[Δ²] = σ²H/ln²`. On-chain this is exact
  and O(1). Between two writes the pool tick is constant, so every grid point skipped during a quiet period has the
  value of the pre-swap tick at the next write, and at most one of those grid returns is nonzero.
- **TWAP-return sampling (Brownian-averaging correction).** Use `Ā_j = (1/H)∫_{(j−1)H}^{jH} ln S_t dt` (a window mean
  tick). For adjacent windows of lengths `h1, h2`: `Var(Ā_{j+1} − Ā_j) = σ²(h1 + h2)/3`, which is `(2/3)σ²H` for
  equal windows, with lag-1 autocorrelation `+1/4`. The estimator is `σ̂² = (3/2)·Σ(ΔĀ)²/T_w`. Its variance is only
  about 6% worse than point sampling: `Var ∝ 2v²n(1 + 2ρ²) = 2v²n·1.125`, so the standard error is about 1.06× that
  of point sampling. With irregular window lengths, divide `Σ(ΔĀ_j)²` by `Σ(h_j + h_{j+1})/3`.
- **Per-block sampling** (`Δ` between consecutive observations) gives the most samples, but it is the most
  exposed to microstructure effects (§3.4) and manipulation (§3.8).

### 3.3 Estimator precision

Under GBM with n returns, `n·σ̂²/σ² ~ χ²_n`, so the relative SE of σ̂ is about `1/√(2n)`:

| window \ sampling | 12 s (per block) | 1 min | 5 min | 15 min | 1 h |
|---|---|---|---|---|---|
| 1 day | 0.83% | 1.86% | 4.17% | 7.22% | 14.4% |
| 3 days | 0.48% | 1.08% | 2.41% | 4.17% | 8.3% |
| 7 days | 0.31% | 0.70% | 1.57% | 2.73% | 5.5% |
| 30 days | 0.15% | 0.34% | 0.76% | 1.32% | 2.6% |

A 95% CI is about ±2 SE. Example: 5-minute sampling over 7 days gives σ̂ = 52% ± 1.6 vol-points. In practice the
error is dominated by **non-stationarity** (vol clustering and regime shifts), not by sampling noise. That argues
for windows of a few days, blended or floored (§3.7).

### 3.4 Microstructure: real data and a mechanistic model

**Real data.** 50,568 `Swap` events of the v3 USDC/WETH 5 bp pool over blocks 26,004,478 to 26,054,878
(2026-09-18 to 2026-09-25; 50,399 blocks; 12.076 s per block, so L1 slots are still 12 s). I built the end-of-block
tick path (the last swap tick in each block, carried forward) and compared it with Binance ETHUSDT 1-minute klines
and Deribit DVOL over the same week.

| estimator (7 days) | pool (v3 5 bp) | Binance ETHUSDT |
|---|---|---|
| per-block (12 s) point RV | **40.4%** | n/a |
| 1-min point RV | 46.3% | 52.5% |
| 5-min point RV | **51.2%** (FC re-run: 50.2%) | 54.3% |
| 15-min point RV | 52.7% (FC: 51.4%) | 52.9% |
| 30-min point RV | 52.1% (FC: 49.8%) | 49.5% |
| 60-min point RV | 47.1% (FC: 48.1%) | 49.3% |
| 5-min **TWAP-return** RV ×3/2 | **51.2%** | 52.4% |
| 15-min TWAP-return RV ×3/2 | 50.9% | 52.0% |
| Deribit ETH DVOL (30-day implied), hourly | mean 51.4 (range of hourly closes 49.3–54.1; the draft's 49.1–54.3 probably used highs/lows) | |

**[FC]** An independent re-implementation (`scratchpad/fc02/rv.py`, same Swap-log dump, one log spot-checked against
the live RPC) reproduced per-block RV 40.4%, the zero share 71.9%, the autocorrelations and all Binance numbers
exactly, and the TWAP-return RV (51.1% / 51.0%). Grid-point RV at 5–60 min came out 1–2 points different
(50.2 / 51.4 / 49.8 / 48.1%). The re-run maps blocks to time linearly, and point RV at coarse H is sensitive to grid
phase (the 7-day SE at 15 min is ≈1.4 vol-points, §3.3). The conclusions do not change. The TWAP-return estimator is
the *more stable* of the two, which is one more argument for it.

Pool block statistics: swaps in 57.6% of blocks. **71.9% of block-to-block tick changes are zero.** Per-block
|Δtick|: p50 0, p90 3, p99 10, p99.9 23 (FC re-run: 22), **max 74**. Autocorrelation of block returns: lag 1 +0.098, lag 2 +0.086,
lag 3 +0.045, lag 5 +0.024.

Daily 5-minute RV, pool vs Binance: 0.590/0.585, 0.346/0.375, 0.565/0.612, 0.560/0.559, 0.394/0.432, 0.542/0.561,
0.524/0.575. The pool reading is lower on 5 of 7 days, by 2–5 points, and higher on the other 2 by at most 0.5. Per-block RV on the same days was 0.27–0.48.

An 8.5 h check using only the pool's 723 v3 observations gave the same pattern: 38.8% per observation vs 58–67%
at 5–15 min. The pool price deviated from Binance by a mean of −0.7 bp with an SD of 3.8 bp, measured on 1-minute
closes; the USDC/USDT basis was ignored.

**Model.** Positive autocorrelation and many zero returns are what a **band-follower** produces. **[FC]** The pure
band-follower overstates lag-1 AC (+0.33 vs the observed +0.10). Real flow includes noise trades and overshooting
arbitrage, so treat the model as qualitative for the AC. An independent re-simulation (`scratchpad/fc02/band.py`)
reproduced the γ = 0 / 5 bp / 30 bp rows to within sampling noise, e.g. 5 bp: per-block 0.275, 1 min 0.390, 5 min 0.494,
TWAP-ret 0.518, zero share 0.718, AC 0.33. The
arbitrageur only moves the pool price when the reference price leaves the no-arbitrage band ±γ, and then only to
the edge of the band (Milionis–Moallemi–Roughgarden-style arbitrage with fees). Simulation: σ = 52%, 12 s blocks,
7 days, pool tick = floor.

| model | per-block | 1 min | 5 min | 15 min | TWAP-ret 5 min ×1.5 | zero-return share | lag-1 AC |
|---|---|---|---|---|---|---|---|
| no fee (γ = 0) | 0.523 | 0.524 | 0.536 | 0.533 | 0.538 | 0.12 | −0.01 |
| γ = 5 bp | 0.275 | 0.389 | 0.491 | 0.515 | **0.515** | **0.72** | 0.33 |
| γ = 5 bp + 2 bp gas threshold | 0.295 | 0.387 | 0.492 | 0.524 | 0.515 | 0.82 | 0.22 |
| γ = 5 bp, partial adjustment 0.6 | 0.210 | 0.337 | 0.466 | 0.503 | 0.499 | 0.68 | 0.51 |
| γ = 30 bp | 0.129 | 0.186 | 0.275 | 0.360 | 0.306 | 0.94 | 0.33 |

Takeaways:

- The pool price is the reference price minus a bounded error `e_t ∈ [−γ, γ]`. That error is correlated with
  recent moves. The bias in the variance of each sampled return is about `−c·γ²` with c ≈ 0.6–1.1 in the simulation, roughly independent of
  H. The **relative** bias is therefore about `γ²/(σ²H)`. It is negligible once `σ√H ≫ γ`. For 5 bp pools at 52%
  vol: 1 min gives σ√H = 7 bp (−45% var bias), 5 min gives 16 bp (about −11%), 15 min gives 28 bp (about −2%).
- **TWAP-return sampling is less biased than point sampling at the same H** (0.515 vs 0.491 in the 5 bp model).
  Averaging dampens the band noise.
- **30 bp pools need H ≥ 1 h**, or an explicit correction. They are poor σ sources. Use the 5 bp pool, or 1 bp if it
  is deep enough.
- Per-block RV must not be used directly. It is still useful as a diagnostic: the ratio of per-block to 5-minute
  RV is a stickiness and liquidity-health signal.
- Tick discreteness adds about 2×(1/12) tick² per return. That is about 0.07% of a 5-minute return's variance,
  which is negligible.
- Jumps: RV measures total quadratic variation, including jumps. For Black-Scholes pricing that is an acceptable
  proxy. Bipower variation could separate jumps but is not needed.

### 3.5 Annualization

Annual σ equals `√(σ²_sec · 365·86400)`. Deribit and most crypto desks use 365 days. The hook should keep variance
per second and compute `v = σ²_sec·τ_sec` directly, which makes annualization disappear. If governance supplies σ
in annual units, divide by 31,536,000.

### 3.6 L1 vs L2 sampling

- **Ethereum L1**: 12 s slots (confirmed empirically: 12.076 s per block including missed slots). A ring buffer
  of 65,535 entries with a write every block covers **9.1 days**. Writes are expensive (§3.9), so thin activity is
  fine: quiet periods simply create gaps.
- **Unichain**: 1 s blocks, and **200 ms Flashblocks are sub-block preconfirmations inside the same block, sharing
  its timestamp** (Unichain docs; <https://blog.uniswap.org/flashblocks-are-live>). "Once per block" is effectively
  "once per second". A 65,535-entry buffer then covers only **18.2 h**, so settlement data must be checkpointed
  (§5.3). Per-block RV would be dominated by microstructure effects. Grid or TWAP-return sampling with H ≥ 5 min
  (≥300 blocks per window) is required, and it makes vol manipulation very expensive (§3.8), as long as
  arbitrageurs actually act every block.
- **Chains whose blocks share timestamps** (e.g. Arbitrum): the per-timestamp early return (`last.blockTimestamp ==
  time`) collapses them, which is correct. The StoikovHook spec notes a `Δt = 0` pitfall for EWMAs.
- **Sequencer trust**: on a single-sequencer L2 the sequencer can hold a manipulated price across blocks for fees
  only. That is a trust assumption. Unichain's TEE block building and priority ordering reduce this but do not
  remove it (**UNVERIFIED** strength).

### 3.7 EWMA and other alternatives

- **Time-aware EWMA**: `V ← e^{−Δt/τ}·V + (1 − e^{−Δt/τ})·(Δ²/Δt)`, or the rational approximation in the StoikovHook
  spec. It stores one number, is more reactive, and suits dynamic *fees*. Its weaknesses: the window is fixed when
  the contract is written, the most recent (possibly manipulated) returns get the most weight, and without
  winsorization a single sample can move it a lot.
- **Cumulative accumulators** (recommended): the consumer chooses the window at read time. It can blend, for
  example `σ = max(σ_1d, σ_7d, σ_floor)` or a HAR-style mix, and the same data serves several markets with
  different tenors.
- **Implied vol** (Aloe-style fee IV, a governance or keeper feed of Deribit DVOL, or a SNARK-proven RV) can serve
  as a *bounded* override. RV here tracked DVOL closely (52% vs 51), but historically the ETH variance risk premium
  is positive on average, so IV > RV (**UNVERIFIED** magnitude). Selling binaries at RV-based prices near events is
  risky. Use floors, caps, and a markup.

### 3.8 Manipulating σ: attack cost and mitigations

**Inflation attack.** Push the price by δ (log) so that it is the price recorded at a sampling point, then let
arbitrage push it back. Costs per manipulated sample: arbitrage loss `≈ y_v·δ²/4` plus fee `≈ γ·y_v·δ/2`.

| estimator | QV added per manipulated sample | cost per sample | **cost per unit of added QV** |
|---|---|---|---|
| per-block RV | 2δ² (in and out) | y_v δ²/4 + γ y_v δ/2 | **≈ y_v/8** (+ fee term) |
| grid-point RV (H) | 2δ² | same, but it must straddle a grid boundary | **≈ y_v/8** |
| TWAP-return RV (H), ×3/2 | 3δ² (δ held for a whole window of n_b = H/Δb blocks) | n_b·(y_v δ²/4 + γ y_v δ/2) | **≈ n_b·y_v/12** |

Holding only part (f) of a window gives a cost per unit QV of `n_b·y_v/(12f)`, which is worse for the attacker.
TWAP-return RV is therefore **(2/3)·n_b times** more expensive to inflate than point sampling: about 17× for 5-minute
windows on L1 and about 200× on Unichain.

Example: raise the measured 7-day σ from 52% to 62%. Required added QV = (0.62² − 0.52²)·7/365 = 0.00219.

| underlying source | y_v | grid-point RV | TWAP-return RV (5 min) |
|---|---|---|---|
| v3 USDC/WETH 5 bp (L1) | $155M | $42k | $706k |
| v4 ETH/USDC 5 bp (L1) | $8.9M | $2.4k | $41k |
| v4 ETH/USDC 5 bp (Unichain, 300 blocks/window) | $7.4M | $2.0k | $404k |
| new hooked pool, $1M TVL full range | $0.5M | **$137** | $2.3k |

What the attacker gains: binary vega is `∂B/∂σ = −n(d2)·d1/σ` (r = 0). For a 7-day binary with K = 1.1·S and σ = 52%:
d2 = −1.36, d1 = −1.29, vega = +0.39 per unit σ, so **+3.9¢ per 10 vol-points**. A $100k position gains about
$3.9k. That is safe against the v3 or deep sources and **unsafe against a thin new pool**.

**Deflation** (suppressing measured vol) would mean absorbing all arbitrage flow, which costs about as much as the
LVR of the whole pool. It is impractical. The realistic risk is simply calm periods, which floors address.

**Mitigations**, all cheap and composable:
1. TWAP-return sampling (above).
2. **Winsorize** each sampled return at a cap: `WINDOW_CAP` in mean-tick units. A fixed 1000 ticks (about 10%) per
   5-minute window never binds on normal data (7-day max per-block move: 74 ticks), and it bounds the damage per
   window. A per-block truncation such as OZ/Uniswap's 9116 does nothing for σ at ETH/USDC scale, because it only
   stops ×2.5 spikes.
3. **Rate limits** on the published σ (Aloe: at most 1 point of daily IV per day ≈ 19 annualized points **[FC]**, asymmetric EMA gains).
4. **Floor and cap**, e.g. σ ∈ [25%, 250%] annualized, or `σ = max(σ_RV, σ_floor, IV_feed − band)`.
5. Use **the deepest available pool** as the source, and **size exposure** (per-market OI and vega limits) to the
   manipulation cost (§8).

### 3.9 Prototype: `VolOracle`, an O(1) TWAP + two RV accumulators in one slot

This prototype is written, compiled, and tested with Foundry 1.8.3, solc 0.8.26 (via-IR, optimizer 1e6 runs,
Cancun), against the real `v4-core` `PoolManager`. The files are under
`scratchpad/gasbench/src/{VolOracle.sol,VolOracleHook.sol}` and `test/Gas.t.sol`. The core logic:

```solidity
struct Observation {              // 32+24+56+64+72+8 = 256 bits -> one slot
    uint32 blockTimestamp;
    int24  tick;                  // tick that prevailed over (prev.ts, ts] = end-of-previous-block tick
    int56  tickCumulative;        // Σ tick·dt  (TWAP / settlement)
    uint64 blockSqCumulative;     // Σ min(|Δtick|,cap)^2 per observation (diagnostic per-block RV)
    uint72 windowSqCumulative;    // Σ min(|D_j − D_{j−1}|, cap·H)^2,  D_j = Σ_{window j} tick·dt
    bool   initialized;
}
struct State {                    // 16·3+32+56+48 = 184 bits -> one slot
    uint16 index; uint16 cardinality; uint16 cardinalityNext;
    uint32 lastGrid;              // floor(lastWrite / H)
    int56  cumAtLastGrid;         // tickCumulative at lastGrid·H (exact: tick constant between writes)
    int48  lastWindowSum;         // D of the window that ended at lastGrid·H
}
function write(Observation[65535] storage self, State memory st, uint32 time, int24 tick,
               uint32 H, int24 blockCap, int24 windowCapTicks) internal returns (State memory, bool) {
    Observation memory last = self[st.index];
    if (last.blockTimestamp == time) return (st, false);          // once per block (v3 semantics)
    int56 k = int56(tick);                                         // pre-swap tick
    int56 cum = last.tickCumulative + k * int56(uint56(time - last.blockTimestamp));
    uint64 bsq = last.blockSqCumulative + uint64(_sqClamp(int256(k) - int256(last.tick), blockCap));
    uint72 wsq = last.windowSqCumulative;
    uint32 g = time / H;
    if (g > st.lastGrid) {                                         // ≤ 2 non-zero window diffs, O(1)
        int256 capD = int256(windowCapTicks) * int256(uint256(H));
        uint32 g1 = st.lastGrid + 1;
        int56 d1 = last.tickCumulative + k * int56(uint56(g1 * H - last.blockTimestamp)) - st.cumAtLastGrid;
        wsq += uint72(_sqClamp(int256(d1) - int256(st.lastWindowSum), capD));
        int56 dLast = d1;
        if (g > g1) { int56 d2 = k * int56(uint56(H)); wsq += uint72(_sqClamp(int256(d2) - int256(d1), capD)); dLast = d2; }
        st.lastGrid = g;
        st.cumAtLastGrid = last.tickCumulative + k * int56(uint56(g * H - last.blockTimestamp));
        st.lastWindowSum = int48(dLast);
    }
    ... // ring-buffer index/cardinality bump exactly as v3
}
```

Reading σ: pick observations `a` (older) and `b` (newest, or extrapolated to now with the current tick, which is
safe for the same reasons as v3). Then:

`σ̂²_sec = (3/2) · ln(1.0001)² · (b.windowSq − a.windowSq) / (H³ · (⌊b.ts/H⌋ − ⌊a.ts/H⌋))`

Here `(ΔD)² = H²(Δmean)²`, and there are Δg windows of length H.

Test results (`forge test --isolate`):
- `test_accumulators` **PASS**. On a scripted 25-block path with gaps of 12–700 s spanning 5 windows,
  `tickCumulative`, `blockSqCumulative`, and `windowSqCumulative` **match a brute-force per-second reference
  exactly**. The reference integrates the tick path second by second in the test. **[FC] Re-run 2026-09-25 with
  forge 1.8.3 (`cae51ad`): PASS, "windows checked: 5".** Caveats: (i) for the first window, the reference reuses the
  oracle's own `s0.cumAtLastGrid` and `s0.lastWindowSum`, so the check is not fully independent there; (ii) none of the
  caps (`BLOCK_CAP` 9116, `WINDOW_CAP` 1000) bind on this path, so the winsorization branch is untested; (iii) the path
  is deterministic, not fuzzed. The proof program must add fuzzed paths, cap-binding cases, `g > g1` multi-window
  gaps with both branches, and ring wrap-around.
- `test_gas` (PoolSwapTest router, fee 3000, tickSpacing 60, exact-in 0.1 token without crossing initialized ticks,
  ring pre-grown to 64, each call its own transaction):

| pool | 1st swap in block | Δ vs hookless | later swap in same block | Δ |
|---|---|---|---|---|
| hookless | 116,847 | n/a | 122,347 | n/a |
| OZ-style truncated oracle hook (`BaseOracleHook` logic) | 136,885 | **+20,038** | 133,593 | +11,246 |
| VolOracle hook (TWAP + per-block RV + TWAP-return RV) | 139,329 | **+22,482** | 133,205 | +10,858 |

**[FC]** Re-run: the numbers reproduce exactly. The "OZ-style" row is `scratchpad/gasbench/src/BaselineOracleHook.sol`: a copy of
the OZ `Oracle` library driven by a minimal `HookBase`, not OZ's `BaseHook`. Real OZ `BaseOracleHook` overhead may
differ slightly. Gas comes from `vm.lastCallGas()` (deprecated in forge 1.8.3 in favour of `lastFrameGas`) with `--isolate`,
so every swap is its own transaction and pays cold access. That is realistic, because a second swap in the same block is
normally a different transaction.

Recording therefore costs about 20–22k gas on the first swap per block: a cold hook call, 2 cold SLOADs, an SSTORE
to the pre-grown ring slot, and a state SSTORE. Later swaps cost about 11k, mostly for the cold hook call and
SLOADs. The extra RV accumulators add only about 2.4k. At 1 gwei, 22.5k gas is about 0.0000225 ETH, or about $0.06.
On L2 it is negligible.

Read-side cost: a binary search over a 65,535 buffer is up to 16 cold SLOADs, about 34k gas. **Recommendation:** add
a small O(1) checkpoint ring keyed by `gridIndex mod N`, storing `(cumAtGrid, windowSqAtGrid)` once per window. Then
"σ over the last N windows" and "TWAP between grid times" each cost 2 SLOADs. It also makes settlement independent
of the main ring's coverage (§5.3).

---

## 4. Spot S for pricing trades

### 4.1 How sensitive a binary is to S

With r = 0, `B = N(d2)` and `∂B/∂ln S = n(d2)/(σ√τ)`. The maximum is at d2 = 0: `0.3989/(σ√τ)`. With σ = 52%, at
the money:

| τ | σ√τ | ΔB per +1% S | ΔB per +0.1% S |
|---|---|---|---|
| 1 h | 0.0056 | **0.463** | 0.071 |
| 4 h | 0.0111 | 0.315 | 0.036 |
| 1 d | 0.0272 | **0.143** | 0.0146 |
| 7 d | 0.0720 | 0.055 | 0.0055 |
| 30 d | 0.149 | 0.027 | 0.0027 |

**[FC]** The table gives exact finite differences `B(S) − B(0.99·S)` (checked with scipy), not the linearised
`0.3989·0.01/(σ√τ)`. The two agree for τ ≥ 1 d. At 1 h the linear value would be 0.718, while the true 1% move is
0.463 because N(·) saturates.

### 4.2 Using the current `slot0`: the same-transaction sandwich

**Cost to move a concentrated-liquidity pool.** In one initialized range with liquidity L, moving `√P → √P'`
requires `Δy = L(√P' − √P)` of token1 and returns `Δx = L(1/√P − 1/√P')` of token0 (standard v3 math; tick crossings
make L piecewise-constant). For a move of x:

- notional `≈ y_v·(√(1+x) − 1) ≈ y_v·x/2`, where `y_v = L√P`
- **round trip in the same transaction**: the curve is path-independent, so pushing and pushing back returns every
  token except **fees**. Cost ≈ `2γ·y_v·x/2` plus gas. Flash loans or flash accounting supply the capital.
- **held across a block and then arbitraged back**: loss = `Δy − Δx·P = L√P(√(1+x) − 1)²/√(1+x) ≈ y_v·x²/4`, plus
  the fee on the push.

**The attack**: push ETH down 1%, buy YES from the hook at the depressed `B(S·0.99)`, push back, and sell YES to the
hook at `B(S)`. All of this happens in one transaction. Profit ≈ `Q·ΔB(1%) − fees(1%)`.

Live depths, computed by walking initialized ticks within ±600 ticks of the current price on 2026-09-25:

| pool | tick spacing | L (active) | notional for +1% | round-trip fees for 1% | arbitrage loss if held 1 block, 1% |
|---|---|---|---|---|---|
| v4 ETH/USDC 5 bp mainnet `0x21c67e…` | 10 | 1.76e17 | $44.8k | **$55** (incl. 0.0125% protocol fee) | $221 |
| v4 ETH/USDC 30 bp mainnet `0xdce639…` | 60 | 3.05e18 | $792k | $4.7k → **[FC] ≈$5.5k** (swap fee 3000+500−1.5 = 3498.5 pips incl. the 0.05% protocol fee) | $3.9k |
| v3 USDC/WETH 5 bp mainnet `0x88e6…` | 10 | 2.99e18 | $763k | $763 | $3.8k |
| v4 ETH/USDC 5 bp Unichain `0x3258f4…` | 10 | 1.43e17 | ≈$37k (local L) | ≈$37 | ≈$185 |
| v4 ETH/USDC 30 bp Unichain `0x259399…` | 60 | 8.7e16 | ≈$22k (local L) | ≈$135 | ≈$110 |

(Other ±0.1/0.5/2/5% rows are in `scratchpad/depth.py` output. For example, a 5% move on v3 costs $3.66M notional and
$86k–99k arbitrage loss.)

Break-even for a 1-day at-the-money binary (ΔB = 0.143 per 1%), with the v4 5 bp mainnet pool as S source:
`Q = $55 / 0.143 ≈ 390 binaries`. The attack is atomic, risk-free, and repeatable until LP collateral runs out.
**Never price from the same-block `slot0`.**

### 4.3 Start-of-block price and short TWAPs

**SoB price from a v3-style oracle**: `observe([1, 0])` gives the mean tick over `[now−1, now]`, which is the tick
that held at the end of the previous block. It is clean for the reasons in §1.4. To shift it by δ the attacker must
close block N at the manipulated price and trade the hook in block N+1. The cost is the arbitrage loss plus fees,
or **fees only if the attacker also controls the top of block N+1** (builder or proposer).

**n-block TWAP**: the attacker holds δ over n blocks, paying `n·(arbitrage + fee)`, or shifts one block by nδ,
paying about `n²·y_v δ²/4`. The cost multiplier is at least n.

Cost to shift the hook's S by 1%, and the break-even attack size B_e (binaries) for a 1-day at-the-money binary:

| source pool | slot0 (fees) | SoB (arbitrage + fee) | SoB, attacker builds next block (fees) | TWAP 5 blocks | TWAP 25 blocks | B_e slot0 | B_e SoB | B_e TWAP-5 |
|---|---|---|---|---|---|---|---|---|
| v3 USDC/WETH 5 bp | $773 | $4.2k | $773 | $21k | $106k | 5.4k | 29.6k | 148k |
| v4 ETH/USDC 30 bp **[FC: recomputed with the 0.05% protocol fee]** | $5.5k | $6.7k | $5.5k | $33k | $167k | 39k | 47k | 234k |
| v4 ETH/USDC 5 bp | $55 | $248 | $55 | $1.2k | $6.2k | 389 | 1.7k | 8.7k |
| v4 ETH/USDC 5 bp Unichain | $37 | $202 | $37 | $1.0k | $5.0k | 259 | 1.4k | 7.1k |
| new hooked pool, $1M full range (30 bp) | $15 | $20 | $15 | $99 | $496 | 105 | 139 | 696 |

(**[FC]** The v3 slot0 cell uses the `y_v·x/2` approximation, $773. The tick walk in §4.2 gives $763. The difference does not matter.)
Unichain pools currently have protocol fee 0 (slot0 bits 184–207 are zero).

For a **1-hour** binary divide B_e by 3.2 (ΔB per 1% = 0.463). Any hook spread φ adds `2φ·Q` to the attacker's
cost, and it also sets a floor on the useful manipulation size, `δ > 2φσ√τ/n(d2)`.

### 4.4 Staleness: the binary analogue of LVR

A lagged S lets informed traders, who see the CEX, trade at stale prices. The expected edge per $1 binary is
`E|B(S_true) − B(S_hook)| ≈ √(2/π)·n(d2)·√(Var_lag)/(σ√τ)`. With `Var_lag = σ²Δt` for a pure lag of Δt, and
`σ²(Δt + w/3)` for a w-second TWAP (the average of a Brownian path lags its endpoint by variance w/3):

`edge ≈ 0.80·n(d2)·√((Δt + w/3)/τ)` per $1, per opportunity.

| τ \ S source | SoB (12 s) | TWAP 1 min | TWAP 5 min | TWAP 30 min |
|---|---|---|---|---|
| 1 h | 1.84¢ | 3.00¢ | 5.61¢ | 13.1¢ |
| 1 d | 0.38¢ | 0.61¢ | 1.15¢ | 2.68¢ |
| 7 d | 0.14¢ | 0.23¢ | 0.43¢ | 1.01¢ |

On top of this comes the pool-vs-CEX band (§3.4: SD about 3.8 bp), which adds about `n(d2)·γ/(σ√τ)`. Implications:

- A 30-minute TWAP (the lending-oracle standard) is **far too stale** for pricing short binaries.
- The fee or spread per $1 should be at least `c·n(d2)·√(Δt_eff/τ)`. That is dynamic: highest for at-the-money
  strikes and short τ. Trading must **stop before expiry**. As τ approaches Δt the edge becomes O(1).
- There is a tradeoff between manipulation cost (§4.3, which grows at least linearly in n) and staleness (which
  grows as √(Δt + w/3)). A **2–5 block TWAP** or SoB, combined with per-block exposure caps, is the sweet spot for
  pricing. Long TWAPs are for settlement only.

### 4.5 Extra guard: intra-block deviation as a manipulation signal

Inside `beforeSwap` of the YES/USDC pool, the hook can read both the clean SoB tick and the underlying pool's current
`slot0` tick. A large |current − SoB| (for example > 3σ√Δt plus the band) means someone is moving the underlying
pool in this block. It can also simply mean real volatility. Either way, widening the spread or pausing is prudent.
This is analogous to Aloe's manipulation metric (§2.4).

---

## 5. Settlement price S_T

### 5.1 TWAP settlement is a geometric-Asian binary

Settle on the arithmetic mean tick over `[T−w, T]`, i.e. `G = exp((1/w)∫_{T−w}^T ln S_t dt)`, the geometric-mean
price. Under GBM:

- `E[ln G] = ln S_0 + (r − σ²/2)(T − w/2)`
- `Var[ln G] = σ²·(T − w + w/3) = σ²(T − 2w/3)`

For trading at time t ≤ T − w, with τ = T − t:

**`YES_G = e^{−rτ}·N(d2_G)`, where `d2_G = [ln(S_t/K) + (r − σ²/2)(τ − w/2)] / (σ√(τ − 2w/3))`.**

If trading continues **inside** the window (t > T − w), let `I_t = ∫_{T−w}^t ln S_u du`. It is known from the
oracle: `(cum(t) − cum(T−w))·ln(1.0001)` plus the decimals shift. Then:

`ln G | F_t ~ N( [I_t + (T−t)ln S_t + (r−σ²/2)(T−t)²/2]/w , σ²(T−t)³/(3w²) )`

So `YES_G = N( (m_t − ln K)/√v_t )`. This is also exact.

Difference from the European binary N(d2), σ = 52%, r = 0. Maximum over strikes in ¢ per $1, with the location:

| τ \ w | 1 min | 5 min | 30 min | 1 h |
|---|---|---|---|---|
| 1 h | 0.14¢ | 0.69¢ | **4.9¢** | **13.0¢** |
| 4 h | 0.03¢ | 0.17¢ | 1.06¢ | 2.22¢ |
| 1 d | 0.006¢ | 0.03¢ | 0.17¢ | 0.35¢ (at K/S ≈ 0.973) |
| 7 d | ~0 | 0.004¢ | 0.025¢ | 0.05¢ |
| 30 d | ~0 | 0.001¢ | 0.006¢ | 0.012¢ |

At the money the difference is about 0: ≤0.00004 for τ ≥ 1 d, and **[FC]** 0.00015 for τ = 1 h, w = 1 h. The gap comes mainly from the reduced variance `T − 2w/3` in the
wings. A Monte Carlo check (200k paths, 1 s discrete averaging, τ = 1 d, w = 30 min, K/S = 0.973) gave P = 0.84098
± 0.00082, against the closed form 0.84113 and the European 0.83941. **[FC]** An independent re-run (numpy, seed 1,
same set-up) gave 0.84132 ± 0.00082, and the table above was recomputed independently to the last digit. The mean
and variance of ln G, and the in-window conditional law, were re-derived and are correct. **The closed form is correct, and the hook
should use it.** It costs the same as the European formula: two extra multiply-adds.

### 5.2 Strike, ticks, and an exact comparison

The pool tick is floor(log₁.₀₀₀₁ P), so it quantizes to 1 bp. Define the strike **as a tick**, `K_tick`, stored at
market creation, and decide with an integer comparison. No division, so no rounding:

- orientation where ETH up means tick up (native ETH currency0 / USDC currency1): **YES ⇔ `cum(T) − cum(T−w) ≥
  K_tick · w`**, with `K_tick = ceil(log₁.₀₀₀₁(K·10⁻¹²))`. The effective strike is `1.0001^K_tick·10¹²` ≥ K. Show
  it in the market metadata. For K = $5,000: `K_tick = −191147`, effective strike $5,000.418 (§7).
- flipped orientation (mainnet v3 USDC token0 / WETH token1): the same price gives v3 tick `t3 = −t4 − 1` for a
  non-boundary price. So **YES ⇔ `Δcum_v3 ≤ (−K_tick − 1)·w`**, i.e. 191146·w for $5,000.
- **[FC] Ties: the draft had this backwards.** Under `Δcum ≥ K_tick·w`, a mean tick *exactly equal* to `K_tick`
  resolves **YES**, not NO. With respect to the human strike K = $5,000 this is still consistent with "S > K → YES",
  because the effective strike $5,000.418 is > K and log₁.₀₀₀₁(K·10⁻¹²) is not an integer. If the product rule must
  read "S_T ≤ K_eff → NO" literally, use the strict comparison `Δcum > K_tick·w`, and in the flipped orientation
  `Δcum_v3 < (−K_tick − 1)·w`.
- **[FC] Floor-tick bias (omission).** The pool tick is floor(log P), so the mean of recorded ticks sits about 0.5 tick
  below the mean of log P when the price moves (the fractional part is roughly uniform). The rule `mean tick ≥ K_tick`
  therefore fires when the true geometric mean is ≳ `1.0001^(K_tick+0.5)·10¹²` ≈ $5,000.67 on average. That is
  path-dependent, somewhere in [$5,000.418, $5,000.918]. It is only about 0.5 bp, but the "exact" claim is exact only
  about *floor-tick* TWAPs. An alternative that avoids rounding the threshold to a whole tick is to store
  `C = floor(w·log₁.₀₀₀₁(K·10⁻¹²))` (computed off-chain at high precision, per market and per window length) and
  decide `YES ⇔ Δcum > C`. That decides "mean floor-tick > log₁.₀₀₀₁ K" exactly, up to the same ≈0.5-tick floor bias.

Users should be told the payoff honestly: "the 30-minute geometric-mean price ending at T, measured by the ETH/USDC
pool X, is at least $5,000.42" (**[FC]** more precisely: "the time-average of pool X's integer tick over the window is at
least −191147", which is what the contract computes).

### 5.3 Who triggers settlement, data availability, quiet periods

- `settle(marketId)` should be **permissionless** after T, optionally with a small bounty. The result is
  deterministic and independent of the caller, **as long as the two cumulatives can still be read**.
- **Coverage**: with a v3-style ring, `observe` reverts once the target is older than the oldest entry. Mainnet v3
  5 bp covers about 8.5 h today. Our L1 ring with 65,535 slots covers up to 9.1 days, and on Unichain 18.2 h.
  Therefore either (a) align T and T−w to the oracle's grid and read the O(1) checkpoint ring (§3.9), which keeps
  exact `cum` at every grid time for N days, or (b) have a keeper call `checkpoint(market)` shortly after T. That
  call reads `observe([now−(T−w), now−T])` and stores both values permanently.
- **No trades near expiry**: this is not a problem for correctness. `cum(T)` is exact from `last.cum + tick·(T −
  last.ts)` if no swap has happened since, or from exact interpolation if a later swap exists (§1.3). The TWAP then
  equals the last traded price. The risk is *staleness* in a thin pool. Require a minimum activity level, for
  example ≥ m writes in [T−w, T] and a minimum harmonic liquidity, or else fall back (longer window, secondary
  source). In the deep ETH/USDC pools, 57.6% of L1 blocks have swaps, so this basically always holds.
- **Oracle hook self-swaps**: if the same contract swaps in the underlying pool (for example to hedge), it must call
  its own write first (§2.1).

### 5.4 Cost of manipulating settlement, and open-interest caps

To shift the w-window mean by δ, hold δ for `n_w = w/Δb` blocks. Cost ≈ `n_w·(y_v δ²/4 + γ·y_v·δ/2)`, or fees only
under multi-block builder control. With w = 30 min on L1 (n_w = 150):

| source | δ = 0.3% | δ = 0.5% |
|---|---|---|
| v3 USDC/WETH 5 bp ($155M y_v) | $70k | $174k |
| new $1M full-range pool, 30 bp | $0.5k | $1.0k |

Worked example: trading closes at T−w and the price is 0.2% below the strike. The remaining uncertainty is about
`σ√(w/3)/√yr`, roughly 0.23%, so YES trades at about 0.19. The attacker buys Q YES and then manipulates by about
0.3%. Profit = `0.81Q − $70k` with the v3 source, so it needs Q > $86k. **A market's worst-case one-sided exposure
must therefore be capped at a small fraction of the source's settlement-manipulation cost.** That is tens of
thousands of dollars for a 1-day market on the v3 source, and next to nothing for a thin pool. Longer windows raise
the cost linearly (n_w) but lengthen the Asian adjustment. Using the median of several sources (v3 5 bp, v4 5 bp,
v4 30 bp) forces the attacker to move two of three.

---

## 6. Architecture options for a "Uniswap-native" S, σ and S_T

### 6.1 The current ETH/USDC landscape (all hookless)

PoolIds recomputed as `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks=0))`:

| chain | pool | PoolId | TVL (GeckoTerminal) | 24 h volume | hooks | oracle? |
|---|---|---|---|---|---|---|
| Ethereum | v4 ETH/USDC 0.05% (ts 10) | `0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27` | $10.3M | $2.5M | **none** | no |
| Ethereum | v4 ETH/USDC 0.30% (ts 60) | `0xdce6394339af00981949f5f3baf27e3610c76326a700af57e4b3e3ae4977f78d` | $44.7M | $9.2M | none | no |
| Ethereum | v4 ETH/USDC 0.01% (ts 1) | `0x00b9edc1583bf6ef09ff3a09f6c23ecb57fd7d0bb75625717ec81eed181e22d7` | $1.2M | $1.7M | none | no |
| Ethereum | **v3** USDC/WETH 0.05% | pool `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` | **$99.7M** | **$56.8M** | n/a | **yes (v3 oracle, card. 723)** |
| Unichain | v4 ETH/USDC 0.05% (ts 10) | `0x3258f413c7a88cda2fa8709a589d221a80f6574f63df5a5b6774485d8acc39d9` | n/a (L 1.43e17) | n/a | none | no |
| Unichain | v4 ETH/USDC 0.30% (ts 60) | `0x25939956ef14a098d95051d86c75890cfd623a9eeba055e46d8dd9135980b37c` | n/a (L 8.7e16) | n/a | none | no |

**[FC]** Re-verified at Ethereum block ≈26,055,028 and Unichain block ≈59,597,752 with `cast`. Every PoolId above,
computed with `hooks = 0`, resolves to an initialized pool: mainnet 5 bp tick −197359, L 1.714e17; 30 bp tick −197378,
L 3.055e18 (y_v ≈ $158M); 1 bp tick −197365, L 2.06e16, protocolFee 102425 = 25 pips each way; Unichain 5 bp
L 1.428e17 (y_v ≈ $7.4M); Unichain 30 bp L 8.68e16 (y_v ≈ $4.5M). Both Unichain pools have protocolFee 0. The Unichain
USDC address returns symbol "USDC" and 6 decimals.

On-chain protocol fees: the v4 5 bp pool's packed `protocolFee = 512125` (0x07D07D) is 125 pips in each direction.
The v4 30 bp pool's `2048500` (0x1F41F4) is 500 pips in each direction. GeckoTerminal figures were fetched through its
API on 2026-09-25. The Unichain TVL query was rate-limited (**UNVERIFIED**). Hooked ETH/USDC pools (EulerSwap,
Angstrom, Bunni and others) probably exist. Whether any has both depth and an oracle is **UNVERIFIED**.

Mainnet addresses used: v4 `PoolManager` `0x000000000004444c5dc75cB358380D2e3dE08A90` and `StateView`
`0x7ffe42c4a5deea5b0fec41c94c136cf115597227` (both have code). Unichain `PoolManager`
`0x1f98400000000000000000000000000000000004` (read via `extsload`).

### 6.2 Options

**(a) Our own oracle-hooked ETH/USDC v4 pool.** The oracle logic is the hook of a new ETH/USDC pool (VolOracle, §3.9).
- Pros: fully v4-native. Exact SoB, TWAP, RV and settlement checkpoints. We control grid H, caps, and checkpoints.
  Writes cost about +22k gas on the first swap per block.
- Cons: **liquidity fragmentation**. Existing hookless pools cannot gain a hook. The new pool starts at zero depth,
  and security scales with its depth (§4.3, §5.4). With $1M TVL, manipulation costs are tens to hundreds of dollars.
  It needs a bootstrapping plan: our LPs or underwriters could be required or encouraged to place full-range
  liquidity in it (GeomeanOracle-style locked full-range liquidity), or fees could be redirected. Routers may
  deprioritize hooked pools. Keep the oracle hook **separate from the prediction hook**: flags `afterInitialize |
  beforeSwap` only, with no return-delta permissions, so aggregators treat it like a vanilla pool. Routing policy
  for pools whose hooks have return-delta flags is **UNVERIFIED**.
- Bonus: the underwriters' delta-hedging flow could trade in this pool and deepen it. This is a design idea,
  **UNVERIFIED**.

**(b) Read the Uniswap v3 USDC/WETH 5 bp oracle (`observe`).**
- Pros: the deepest on-chain ETH/USDC price *that has an oracle*, with about $155M virtual depth. (**[FC]** The hookless v4
  30 bp pool has about the same active depth, L = 3.05e18 and y_v ≈ $158M, but it has no oracle.) It already has SoB semantics, it is
  battle-tested, and it is available today. Reading `observe` is a cold external call plus a few SLOADs, about
  10–40k gas depending on binary-search depth.
- Cons: it is v3, not v4 (still "Uniswap-native", but not the v4 story). Cardinality 723 gives about 8.5 h, so
  either grow it (anyone can, for about 22k gas per slot) or checkpoint cumulatives ourselves. There is no RV
  accumulator, so σ requires our own checkpoints of `tickCumulative` every H: TWAP-return RV with the irregular
  `(h1+h2)/3` normalization. A keeper pokes it, or every hook trade lazily does. The token orientation is
  flipped (§7). The pool exists only on mainnet (Unichain v3 depth is **UNVERIFIED**).

**(c) Keeper/poke sampler of a hookless v4 pool.** **Not manipulation resistant.** `slot0` at poke time can be moved,
sampled, and moved back in one transaction for fees only (§4.2). Only a multi-sample median or truncation limits
the damage, and a patient attacker still controls samples. Reject as a primary source. It can serve as an extra
sanity input.

**(d) Hybrid (recommended path).**
- **Prototype and fork tests**: (a) with VolOracle on a local PoolManager, plus (b) read from forked mainnet v3.
- **Production**: S = SoB or a 2–5 block TWAP from the primary source. σ = TWAP-return RV (H = 5–15 min, W = 3–7
  days) from the primary source, then floored, capped, rate-limited, and optionally blended with an IV feed.
  S_T = 5–30 min TWAP settlement using the median of {v3 5 bp, our v4 oracle pool, optionally another oracle-hooked
  v4 pool}, with a deviation circuit-breaker that pauses and extends the window if sources disagree by > X bp.
- A non-Uniswap fallback (Chainlink ETH/USD) works well as a **bound check** only. It is not the source.

---

## 7. Token ordering, decimals, ticks

- In v4, **native ETH is `address(0)`, which always sorts as `currency0`**. For every native ETH/USDC v4 pool:
  currency0 = ETH (18 decimals), currency1 = USDC (6 decimals), raw price = USDC-units per wei.
  **Human $/ETH = 1.0001^tick · 10¹².** ETH up means tick up.
- WETH pools depend on address order. Mainnet: USDC `0xA0b8…eB48` < WETH `0xC02a…6Cc2`, so **USDC is token0**
  (v3 `0x88e6`, where `token0()` returned USDC). Raw price = wei per USDC-unit, **$/ETH = 10¹²/1.0001^tick**, and ETH
  up means tick **down**. Unichain: USDC `0x078D782b760474a361dDA0AF3839290b0EF57AD6` < WETH `0x4200…0006`, also
  flipped. Base: WETH `0x4200…0006` < USDC `0x8335…2913`, so WETH is token0 (not flipped).
- `sqrtPriceX96 = √(raw price) · 2⁹⁶`.

Conversions (mpmath, 60 digits):

| human K | orientation | raw price | exact log-tick | floor tick | sqrtPriceX96(K) |
|---|---|---|---|---|---|
| $5,000 | v4 native ETH/USDC | 5.0e-9 | −191147.836 | −191148 ($4,999.918); next −191147 ($5,000.418) | 5602277097478613991873193 |
| $5,000 | v3 USDC/WETH | 2.0e8 | +191147.836 | 191147 | 1120455419495722798374638764549163 |
| $3,000 | v4 native | 3.0e-9 | −196256.348 | −196257 ($2,999.804) | 4339505179874779489431521 |
| $2,700 | v4 native | 2.7e-9 | −197310.005 | −197311 ($2,699.73) | 4116816085950893928074568 |

A one-tick step is about $0.50 at $5,000 and about $0.27 at $2,700. Live check: the mainnet v4 5 bp tick −197314
gives $2,698.92 (**[FC]**: the draft said $2,699.14), and the v3 tick 197312 gives $2,699.46. The two orientations agree
to within about 2 ticks, and they were read at different moments.

Sign rules: in the flipped orientation, `ln S_ETH = −tick·ln(1.0001) + const`. Squared returns and variance are
unchanged. TWAP comparisons flip direction and pick up the `−t − 1` floor offset (§5.2). Strike ticks do not need to
be tick-spacing aligned. The oracle's tick is the pool's current tick, not a spacing-aligned tick.

---

## 8. Implications for our design

1. **Never read `slot0` of any pool to price a trade.** S must come from an end-of-previous-block oracle: SoB or a
   2–5 block TWAP. The prediction hook reads it in `beforeSwap` of the YES/USDC pool.
2. **The underlying oracle needs a hook.** The canonical v4 ETH/USDC pools are hookless, so the "Uniswap-native"
   options are (a) our own oracle-hooked v4 pool, (b) the v3 5 bp oracle, or both. Plan for **(d) hybrid**:
   build and prove with (a) locally and (b) on a mainnet fork. Treat the depth of the source as the security budget,
   and publish it as a parameter.
3. **Oracle contract design** (VolOracle, prototype passing): a v3-semantics ring with `tickCumulative`, a
   diagnostic per-block squared-tick accumulator, and a **TWAP-return squared accumulator** on an H-second grid, all
   in one slot. Add an O(1) grid checkpoint ring for σ windows and settlement. Keep it as a **separate hook contract**
   from the prediction hook, and make it call its own write before any self-initiated swap. Budget +22.5k gas for the
   first swap in a block and +11k for later ones.
4. **σ policy**: `σ²_sec = 1.5·ln(1.0001)²·ΔQ/(H³·Δg)` with H = 5 min (15 min for 30 bp sources) and W = 3–7 days.
   Winsorize at about 1000 ticks per window. Floor and cap (e.g. 25%–250%). Rate-limit changes. Optionally
   `max(σ_RV, IV_feed − band)`. Keep everything in per-second variance and compute `v = σ²_sec·τ_sec`.
   **Do not use per-block RV** (−25% bias measured).
5. **Pricing formula**: use the **geometric-Asian binary** `d2_G` matched to the settlement window (and the
   in-window formula if trading continues past T−w). Close trading at T − w − buffer.
6. **Spread and fees**: charge at least `c·n(d2)·√((Δt + w_S/3)/τ)` per $1 (binary-LVR). It scales with how at the
   money the strike is and with 1/√τ. Add a manipulation-signal widening when |current tick − SoB tick| is large.
7. **Risk limits derived from oracle depth**: (i) a per-block net YES/NO flow cap `Q_block ≤ C_SoB(δ)/ΔB(δ)`, using
   the costs in §4.3, with the fees-only (builder) column as the conservative bound; (ii) a per-market one-sided
   exposure cap ≪ settlement-manipulation cost (§5.4); (iii) a vega cap vs the σ-manipulation cost (§3.8).
8. **Settlement**: permissionless `settle()`, exact integer comparison `Δcum ≥ K_tick·w` (orientation-aware), grid
   aligned, with a minimum-activity requirement and a multi-source median plus a deviation breaker. The strike is
   stored as a tick and the effective strike is shown to users.
9. **What the proof program should test**:
   (a) exact oracle accumulators vs a brute-force reference, fuzzing paths and gaps (the prototype already has a
   deterministic version);
   (b) **same-block manipulation invariance**: any in-block swaps leave SoB, TWAP, σ, and the cumulatives read in
   that block unchanged;
   (c) statistical calibration: feed simulated GBM and band-follower paths through the real PoolManager and check
   σ̂ against χ² confidence intervals, plus the 3/2 correction;
   (d) a fork test on mainnet v3 `observe` for S and settlement, and orientation-flip tests;
   (e) economic tests: an attacker bot runs slot0 / SoB / TWAP attacks against the hook with the live liquidity
   profile, and the assertion is that its P&L is ≤ 0 under the configured caps and fees;
   (f) Asian vs European Monte Carlo agreement with the on-chain formula.
   (g) **[FC]** settlement boundary tests: an exact tie at `K_tick` (≥ vs >), the orientation flip with boundary prices
   (`t3 = −t4` exactly on a tick boundary), and the floor-tick bias against a high-precision off-chain geometric mean;
   (h) **[FC]** VolOracle cap-binding (winsorization) paths, multi-window gaps, and ring wrap-around, all fuzzed.

## 9. Open questions

1. **Primary source choice.** Can we bootstrap enough depth in our own oracle pool (option a), for example by
   requiring underwriters to post full-range liquidity there? Or do we accept v3 as the primary S/σ/S_T source
   (option b) and label v4 as the execution layer only?
2. **Threat model for multi-block MEV.** Do we assume builders can control consecutive blocks (then the fees-only
   costs apply, and caps drop 5–10×)? On L2: how much do we trust the sequencer?
3. **RV vs IV.** Is RV plus floors acceptable for selling binaries into known events (CPI, FOMC, ETF decisions)?
   Should there be a bounded governance or keeper IV override, or a SNARK-proven external RV?
4. **Settlement window w.** 5, 15 or 30 minutes? This trades manipulation cost (linear in w) against the Asian
   adjustment and user comprehension. Is a geometric-TWAP payoff acceptable product-wise versus a "spot at T" label?
5. **Fee model constants.** c in `c·n(d2)√(Δt/τ)`, the base fee, and how fees split between LPs and the protocol.
   This needs the LP-economics simulation.
6. **Exact routing and aggregator treatment** of pools whose hooks have return-delta flags (for the YES/USDC pools)
   and of oracle-hooked ETH/USDC pools. **UNVERIFIED.**
7. **Checkpoint storage horizon**: how many days of grid checkpoints to keep, and who pays for growing rings on L1.
8. **Trading inside the settlement window**: allowed (with the in-window formula) or hard-closed at T−w?
9. **Jump risk**: should σ include a jump premium, or should the hook pause around large intra-block deviations and
   oracle-source disagreements?
10. **Tick-boundary edge case**: `slot0.tick` can be one lower than `getTickAtSqrtPrice(sqrtPrice)` right after a
    downward crossing (`Pool.sol:431`). This matters only for strike-equality corner cases. Decide whether to
    normalize.

---

## Appendix A: sources and code versions

- `v3-core@d0831dc`: `contracts/libraries/Oracle.sol`, `contracts/UniswapV3Pool.sol`.
- v3-periphery `main`: `contracts/libraries/OracleLibrary.sol:16-41`.
- `v4-core@46c6834`: `src/PoolManager.sol:187-227`, `src/libraries/Hooks.sol:171-175,248-282`,
  `src/libraries/StateLibrary.sol:11-60`, `src/libraries/TickMath.sol:20-33,116-121`, `src/libraries/Pool.sol:431-439`,
  `src/libraries/ProtocolFeeLibrary.sol:38-46`.
- `oz-uniswap-hooks@80bd724` (v1.2.2): `src/oracles/panoptic/**`.
- `Uniswap/v4-periphery@1ca56ab7`: `contracts/hooks/examples/{GeomeanOracle,VolatilityOracle}.sol`,
  `contracts/libraries/Oracle.sol`. Branch `trunc-oracle`: `contracts/libraries/TruncatedOracle.sol`.
- `aloelabs/aloe-ii` (HEAD at clone): `core/src/{VolatilityOracle.sol,libraries/Volatility.sol,libraries/Oracle.sol,libraries/constants/Constants.sol}`.
- `0xekkila/VolatilityHook-UniV4@4fa158f`; `tonycai/StoikovHook` (spec only).
- Uniswap blog: v3 TWAP oracles in PoS (2022-10-27); v4 Truncated Oracle Hook (2023-09-20); Flashblocks live.
- Euler: `uni-v3-twap-manipulation/cost-of-attack.tex` (M. Bentley); Omniscia audit of `UniswapV3Oracle`.
- Lambert, "On-chain Volatility and Uniswap v3" (Medium). Khaldoun, arXiv:2608.13340 (2026).
- Market data: Binance `data-api.binance.vision` ETHUSDT 1-minute klines; Deribit `get_volatility_index_data` ETH
  (DVOL); GeckoTerminal API.

## Appendix B: reproduction (scratchpad, session-local)

All paths are under
`/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/`:
- `fetch_obs.py`, `rv_obs.py`: the 723 v3 observations, then 8.5 h RV.
- `fetch_logs.py`, `fetch_bn.py`, `rv7.py`, `rv7b.py`: 7-day Swap logs vs Binance vs DVOL, and the signature plot.
- `sim_rv.py`: band-follower microstructure simulation.
- `depth.py`: live tick-liquidity walk and manipulation costs. `uni.py`: Unichain pools via `extsload`.
- `binmath.py`, `asian2.py`, `attack.py`: binary Greeks, Asian vs European with Monte Carlo, attack and staleness tables.
- `strike.py`: strike to tick / sqrtPriceX96.
- `gasbench/`: Foundry project (`forge test --isolate -vv`) with `src/VolOracle.sol`, `src/VolOracleHook.sol`,
  `src/BaselineOracleHook.sol`, `test/Gas.t.sol`. Foundry binaries are in `scratchpad/foundry/`.
- **[FC] Fact-check scripts** (`scratchpad/fc02/`): `num.py` (sensitivity, staleness, vega, σ-manipulation costs, SE
  table, Asian vs European table plus an independent Monte Carlo), `rv.py` (independent RV recomputation from the swap
  dump and Binance/DVOL), `band.py` (independent band-follower simulation), `strike.py` (mpmath strike conversions).
  Historical v4-periphery files were re-downloaded independently into `scratchpad/fc02v/` and are byte-identical to
  `scratchpad/hist/`.

---

## Verification log (adversarial fact-check, 2026-09-25)

Verdicts: **confirmed** = independently reproduced from primary source or re-computation; **corrected** = the draft
was wrong or imprecise and is fixed inline (marked [FC]); **unverifiable** = left as UNVERIFIED.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | v4-core has no oracle | confirmed | `grep -rniE "observ\|oracle" v4-core/src` returns nothing (v4-core@46c6834) |
| 2 | v3 `write` is once per block, only on a tick-changing swap, with `slot0Start.tick` (pre-swap). In-range mint/burn also writes | confirmed | `v3-core/contracts/libraries/Oracle.sol:78-101` (early return on same timestamp); `UniswapV3Pool.sol:732-748`, `:340-348` |
| 3 | v3 interpolation is exact for a constant tick; `'OLD'` revert; `grow` pre-writes `blockTimestamp = 1` | confirmed | `Oracle.sol:273-285`, `:226`, `:108-120` |
| 4 | `consult` rounds the mean tick toward −∞ | confirmed | vendored `OracleLibrary.sol:39-46` (premia-contracts), same code as v3-periphery |
| 5 | v4 hook self-swaps skip `beforeSwap` (`noSelfCall`, `msg.sender == address(self)`) | confirmed | `v4-core/src/libraries/Hooks.sol:171-175`, `:253`; OZ note at `BaseOracleHook.sol:107-108` |
| 6 | `Pool.swap` sets `tick = tickNext − 1` on a downward crossing; `getTickAtSqrtPrice` is a floor; protocol-fee formula | confirmed | `Pool.sol:431`, `TickMath.sol:116-121`, `ProtocolFeeLibrary.sol:38-46` |
| 7 | OZ `BaseOracleHook`: permissions afterInitialize+beforeSwap, writes the pre-swap tick from `getSlot0`, SSTOREs state on every swap, 176-bit observation, truncation clamp relative to `prevTruncatedTick` | confirmed | `oz-uniswap-hooks@80bd724` `BaseOracleHook.sol:65-136`, `libraries/Oracle.sol:23-62`; commit `01a87ba` (2026-08-07) adds only uint16 index-range checks to the adapters |
| 8 | Whether the OZ audits cover the oracle files | corrected (was UNVERIFIED) | the 3 audit PDFs' scope lists (`audits_txt/*.txt`) contain no oracle files; the oracle was added in `bd5287c` (2025-11-27), first tag v1.1.1 |
| 9 | GeomeanOracle rules, TruncatedOracle `MAX_ABS_TICK_MOVE = 9116`, toy VolatilityOracle fee | confirmed | files re-downloaded from `raw.githubusercontent.com/Uniswap/v4-periphery/{1ca56ab7,trunc-oracle}`: GeomeanOracle `:95,:132,:143`; TruncatedOracle `:21`, clamp in `transform`; VolatilityOracle `fee = 3000 + lapsed*100/60` |
| 10 | Uniswap PoS blog numbers (0.19 and 181 per month; $710B and $978M; 9116 truncation) | confirmed (+ median oracle recommendation added) | <https://blog.uniswap.org/uniswap-v3-oracles> (Adams, Wan, Zinsmeister, 2022-10-27) |
| 11 | Omniscia recommends a ≥30-min minimum window for Euler `UniswapV3Oracle` | confirmed | Omniscia Euler price-oracles report, UniswapV3Oracle manual review |
| 12 | Aloe fee-IV formula and constants (72 h window, 4 h samples, EMA 1/20 and 1/100, cold start 12.79% daily) | confirmed | `aloe-ii@2452610` `core/src/libraries/Volatility.sol:55-63`, `Constants.sol:130-166` |
| 13 | Aloe clamp "about 1 vol-point per day" | corrected | `IV_CHANGE_PER_SECOND = 115740` means 1 pp of *daily* IV per day, ≈19 annualized points/day |
| 14 | Aloe manipulation metric = 0→w vs w→2w | corrected | `libraries/Oracle.sol:117`: `dist(meanTick0To2W, meanTickWTo2W)` |
| 15 | Khaldoun arXiv:2608.13340 quote | confirmed | arxiv.org/abs/2608.13340: submitted 2026-08-13, revised 2026-09-23, the abstract contains the quoted sentence |
| 16 | Brevis hook `ln_1_0001 = 109945666` (Q40) and owner `setVolatility` | confirmed | `VolatilityHook-UniV4@4fa158f` `SnarkBasedVolatilityOracle.sol:12,41,78`; ln(1.0001)·2⁴⁰ = 109945665.6 |
| 17 | All canonical ETH/USDC v4 pools are hookless (PoolIds with hooks = 0) | confirmed | `cast keccak(abi.encode(0x0, USDC, fee, ts, 0x0))` gives the listed ids for mainnet 5/30/1 bp and Unichain 5/30 bp; all are initialized (StateView / `extsload`) |
| 18 | Live v3 pool state: tick, L = 2.99e18, cardinality 723/723, feeProtocol 68, token0 = USDC | confirmed; price corrected | `cast call` at block ≈26,055,028: tick 197353, L 2.997e18, 723/723, 68. Tick 197348 is ≈$2,690, not $2,697. Span 7.89 h at re-read |
| 19 | Protocol fees 512125 (125/125) and 2048500 (500/500) | confirmed | StateView `getSlot0`; the 12-bit halves decode to 0x07D and 0x1F4 |
| 20 | v4 30 bp round-trip fees $4.7k, SoB $6.3k | corrected | these left out the 0.05% protocol fee: ≈$5.5k and ≈$6.7k. v4 30 bp y_v ≈ $158M |
| 21 | y_v values (v3 $155M, v4 5 bp $8.9M, Unichain 5 bp $7.4M) | confirmed | L·√P from live slot0: $155.4M, $8.89M, $7.41M |
| 22 | Arbitrage-loss formula `L√P(√(1+x)−1)²/√(1+x) ≈ y_v x²/4` | confirmed | re-derived: Δy − Δx·P = L(√P' − √P)²/√P' |
| 23 | Binary sensitivity, staleness edge `√(2/π)n(d2)√((Δt+w/3)/τ)`, vega −n(d2)d1/σ = 0.392 | confirmed | `fc02/num.py`: every table value reproduced. The §4.1 table is a finite difference (note added) |
| 24 | σ-manipulation costs (dQV = 0.002186; $42k / $706k / $2.4k / $41k / $2.0k / $404k / $137 / $2.3k) and the (2/3)n_b factor | confirmed | `fc02/num.py`; the 3δ² vs 2δ² QV-per-sample logic re-derived |
| 25 | SE table 1/√(2n); TWAP-return Var = σ²(h1+h2)/3, ρ₁ = 1/4, SE ×1.06 | confirmed | `fc02/num.py`; analytic re-derivation |
| 26 | Geometric-Asian binary closed form (both regimes) and the table (13.0¢ at 1 h/1 h; 0.35¢ at 1 d/1 h, K/S ≈ 0.973) | confirmed; ATM bound corrected | `fc02/num.py`; independent MC 0.84132 ± 0.00082 vs closed form 0.84113. ATM gap is 0.00015 at 1 h/1 h |
| 27 | Real-data RV: per-block 40.4%, zero share 71.9%, AC +0.098, 5-min TWAP-return 51.2% | confirmed | `fc02/rv.py` on the same dump (one log verified on-chain): 40.41%, 71.92%, 0.098, 51.1% |
| 28 | 5/15/30/60-min point RV 51.2/52.7/52.1/47.1% | corrected (imprecise) | re-run gives 50.2/51.4/49.8/48.1%. Grid-phase and timestamp-mapping sensitivity is within the SE |
| 29 | Band-follower sim "reproduces all facts" | corrected | independent sim matches the draft's rows, but the model's lag-1 AC of 0.33 ≠ the observed 0.10 |
| 30 | VolOracle prototype: accumulator test passes; gas +22,482 / +10,858 (OZ-style +20,038) | confirmed, with caveats | `forge test --isolate` re-run (forge 1.8.3): identical numbers. Test caveats: first window partly self-referential, caps never bind, not fuzzed; the baseline is a re-implementation |
| 31 | VolOracle logic (≤2 non-zero window diffs per write; read formula `1.5·ln²·ΔQ/(H³Δg)`; bit packing 256/184) | confirmed | code review of `gasbench/src/VolOracle.sol`; E[(ΔD)²] = (2/3)σ_t²H³ re-derived; int48/uint72 ranges fine for H ≤ 1 h, cap 1000 |
| 32 | Strike conversions (−191147.836, $5,000.418, sqrtPriceX96 values); v4 tick −197314 = $2,699.14 | confirmed; one value corrected | `fc02/strike.py` (mpmath 60 digits): every row matches; −197314 is $2,698.92 |
| 33 | "Ties resolve to NO under ≥" | corrected | with `Δcum ≥ K_tick·w`, equality resolves YES. Use strict `>` if needed. The floor-tick ≈0.5-tick bias was added |
| 34 | 10,000 extra v3 slots ≈ 221M gas | confirmed; omission added | 20,000 + 2,100 per slot. EIP-7825 (Fusaka) caps a tx at 2²⁴ gas, so ≈750 slots per tx |
| 35 | Unichain 1 s blocks; 200 ms Flashblocks are sub-block partial updates | confirmed (timestamp sharing inferred) | consecutive Unichain block timestamps differ by 1 s; Uniswap blog / docs describe Flashblocks as 200 ms partial block updates streamed out-of-protocol |
| 36 | Angstrom live since about Aug 2025 with an ETH/USDC oracle; hooked ETH/USDC pools with depth; router policy for return-delta hooks; Unichain v3 depth; ETH VRP magnitude; the 8.5 h observation-only RV check (38.8%) | unverifiable | not re-checked; still marked UNVERIFIED |
