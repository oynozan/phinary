# Gap report: where the "Uniswap-native" S and σ come from, and one σ estimator spec

Status: research + working prototype, 2026-09-25/26. Scope:
- (a) Resolve the UNVERIFIED items in 02 §2.5/§6.1 and 06 §5.1: does any hooked ETH/USDC v4 pool carry a deep,
  manipulation-resistant observation?
- (b) Choose the architecture for the proof environment and specify the interface the PredictionHook calls.
- (c) Unify the σ estimator spec across reports 02, 03, 04, 05 and 06.
- (d) Build and run the VolOracle tests that 02 §3.9 asked for.

Conventions: the same as report 02. "SoB" is the start-of-block price, which equals the end-of-previous-block price.
`γ` is the no-arbitrage fee band of the source pool. `H` is the grid length and `W` the estimation window. σ is
annualised over 365 days. On-chain variance is per second and scaled by 1e36 (03 §5.2).

Provenance:
- Prototype code, tests, scripts and raw outputs are copied to `docs/research/gaps/underlying-oracle-prototype/`:
  `src/`, `test/`, `py/`, `out_forge.txt`, `out_logs.txt` and `out_gas_writes_isolate.txt`.
- The working copy is in `scratchpad/gapS/`.
- Toolchain: Foundry 1.8.3 (`cae51ad`), solc 0.8.26, via-IR, Cancun, and the same `v4-core` checkout as report 02.
- Live reads were taken on 2026-09-25/26 at Ethereum block 26,055,289, Base block 51,779,327 and Arbitrum block
  508,796,295.
- Anything not verified is marked **UNVERIFIED**.

---

## 0. Answers in brief

1. **(a) No.** None of the hooked ETH/USDC v4 pools on Ethereum, Base, Arbitrum or Unichain combines depth with a
   manipulation-resistant accumulator.
   - The deep v4 ETH/USDC pools are all **hookless**: mainnet 30 bp $44.6M, Arbitrum 5 bp $9.3M, Unichain 5 bp $20.1M,
     Base 30 bp $6.1M TVL.
   - The only hooked pool with real size is **Angstrom** (mainnet USDC/WETH, $3.45M TVL, $9.3M/day). It has no
     observation storage. Its `beforeSwap` only enforces the node unlock and sets the fee.
   - The only v3-style oracle hook on an ETH/USDC pair is **BackGeoOracle**, deployed on all four chains with
     **$0.6k–1.8k TVL** each.
   - Bunni v2 had a truncated oracle, but it shut down in October 2025 after its $8.4M exploit. EulerSwap has no
     oracle, and its NoOp curve never moves v4 `slot0`. Flaunch's oracle serves only its own memecoin pools
     (TWAP 600 s, 300 slots).
   - The deep manipulation-resistant Uniswap sources of ETH/USDC that exist today are the **v3 WETH/USDC 5 bp pools**:
     - mainnet: y_v $155M, 723 observations, about 7.4 h of history;
     - Base: y_v $67M, 5,000 observations, 28.2 h;
     - Arbitrum: y_v $167M, 9,000 observations, 46.9 h.
2. **(b) Use both, behind one interface.**
   - `VolOracleHookV2` is a separate oracle-only hook (flags `afterInitialize|beforeSwap`, address bits `0x1080`) on
     a local ETH/USDC v4 pool. It is the v4-native path and supports exact, fuzzable proofs.
   - `V3ObserveAdapter` wraps a v3 pool's `observe` on a mainnet fork. It provides the realistic depth.
   - Both implement `IUnderlyingOracle`: SoB tick, SoB `sqrtPriceX96`, cumulative now, cumulative at a grid time,
     and variance over N windows. Every read is O(1) and never binary-searches. Measured cold-read gas is
     **5.8k–14k**.
   - Oracle overhead on the underlying pool's swaps: **+27.6k gas on the first swap in a block**, +11.3k on later
     swaps, and +53.7k when a grid boundary is crossed and a fresh checkpoint slot is written.
3. **(c) One estimator.**
   - The estimator is TWAP-return realised variance on an H = 300 s unix-aligned grid, read over W = 864 windows
     (3 days), times 3/2, per second, at 1e36 scale.
   - Add an additive fee-band correction `β = 0.5·γ²/H` (0 for the exact-follower test pool).
   - Winsorise each window difference at 400 ticks, clamp σ to [20%, 250%], and use no EWMA and no σ multiplier.
   - v1 fixes σ per market at creation ("mode A", 06 §9.6). Live σ ("mode B") is rate-limited.
   - The bias figures in reports 02 and 05 all describe **5-minute point sampling** at different σ, and they agree
     once σ is matched. Our TWAP-return estimator's band bias is 3–10× smaller. It is well approximated by an
     additive deficit `≈ 0.5·γ²/H`. That deficit matched real data within about 1 variance point on two independent
     windows.
4. **(d) 13 distinct tests, all passing.** They cover:
   - a fuzzed brute-force reference, 256 runs;
   - cap binding, multi-window gap branches, ring wrap-around, and a differential test against the OZ Oracle
     `tickCumulative`;
   - 6 mutants of the library, all killed;
   - χ² calibration on replayed GBM and band-follower paths, bit-exact against Python;
   - a 1-day GBM path driven through the real `PoolManager`, including same-block manipulation probes;
   - mainnet-fork tests of the v3 adapter.
   - A 2,000-path Python run (bit-exact equivalent) gives **95% CI coverage of 95.2–96.0%** and SD equal to theory
     (5.1%) for the χ²(ν = n/1.125) interval.

---

## 1. (a) Hooked ETH/USDC v4 pools: is there a deep oracle?

### 1.1 Method

- **Enumeration.**
  - Uniswap's public GraphQL (`interface.gateway.uniswap.org/v1/graphql`, `topV4Pools(chain, tokenFilter: USDC)`)
    was paginated by TVL cursor for ETHEREUM, BASE, ARBITRUM and UNICHAIN (`py/gql_pairs.py` → `py/gql_ethusdc.json`).
  - Pools whose other token is native ETH or WETH were kept.
  - Coverage:
    - Arbitrum (2,451 USDC pools) and Unichain (684) are complete.
    - Ethereum and Base hit the 6,000-row cap. Every ETH/USDC pool with TVL ≥ ~$150 (Ethereum) or ≥ ~$185 (Base)
      is included, because the smallest ETH/USDC pool found on each chain had that TVL.
- **Cross-check from logs (Arbitrum).**
  - `PoolManager.Initialize` events were scanned with `currency0/currency1` topic filters (`py/scan_init.py` →
    `py/init_arbitrum.json`). The scan found 538 ETH/USDC pools, 459 of them hooked, from block 298,076,243 onwards.
  - All 138 hooked pools with TVL appear in GraphQL. The 321 missing from GraphQL have no TVL.
  - The same scan on mainnet, Base and Unichain failed: public RPCs cap `eth_getLogs` at 2k–100k blocks or require
    archive tokens (**not done**, see Verification).
- **Code.** For every hook with non-trivial TVL, or with an oracle-like name, the verified source was read:
  - local clones for Angstrom `3690f91`, Bunni v2 `2b303b8`, EulerSwap `dd936d2` and Flaunch `77d7d23`;
  - Blockscout verified source for MyNewHook, AdaptivePoolPolicyHookV1 and BackGeoOracle.
  - Names come from the Uniswap hooklist `1d2f09b` (2026-09-21).

### 1.2 Results: top ETH/USDC v4 pools by TVL (GraphQL, 2026-09-25)

"fee" is the total swap fee in pips as GraphQL reports it: LP fee plus protocol fee (625 = 5 bp + 1.25 bp protocol).

| chain | pool (fee, tick spacing) | hook | TVL | 24 h volume | on-chain observation? |
|---|---|---|---|---|---|
| Ethereum | ETH/USDC 3499, 60 | none | $44.6M | $9.44M | no |
| Ethereum | ETH/USDC 625, 10 | none | $10.3M | $2.54M | no |
| Ethereum | USDC/WETH 250, 10 | **Angstrom** `0x0000000aa232…fad4` | **$3.45M** | **$9.29M** | **no** (see 1.3) |
| Ethereum | ETH/USDC 125, 1 | none | $1.17M | $1.69M | no |
| Ethereum | ETH/USDC 828, 60 | MyNewHook `0x47F1…1080` | $451k | $4.7k | EWMA of tick moves for a dynamic fee. No cumulative and no `observe` |
| Ethereum | ETH/USDC 0, 10 | `0x74A7…4880` (unverified source) | $47k | $0 | unknown |
| Ethereum | ETH/USDC 4000, 10 | AdaptivePoolPolicyHookV1 `0xFDE6…48c4` | $36k | $5.4k | no (owner fee/bounds policy) |
| Ethereum | ETH/USDC 0, 32767 | **BackGeoOracle** `0xB132…BaC4` | **$1.8k** | $20 | **yes** (v3-style ring) |
| Base | ETH/USDC 3499, 60 | none | $6.06M | $636k | no |
| Base | ETH/USDC 625, 10 | none | $987k | $346k | no |
| Base | ETH/USDC 90, 2 | UniswapV4KEMHook `0x4440…c0c4` | $410k | $178k | no |
| Base | ETH/USDC | BackGeoOracle `0x59f3…BAC4` | $671 | $12 | yes |
| Base | ETH/USDC 160 | AngstromL2 `0xCD25…e5Cf` | $312 | $0 | no |
| Arbitrum | ETH/USDC 625, 10 | none | $9.31M | $22.97M | no |
| Arbitrum | ETH/USDC 3499, 60 | none | $3.63M | $3.13M | no |
| Arbitrum | ETH/USDC 1000, 10 | Limit Order Hook | $112k | $25k | no |
| Arbitrum | ETH/USDC | BackGeoOracle `0x3043…baC4` | $702 | $32 | yes |
| Arbitrum | 10 pools on BunniHook `0x0000fe59…1888`, `0x0000eb22…1888` and `0x00005242…1888` (log scan) | Bunni v2 | none listed | none listed | truncated oracle, but the protocol has shut down |
| Unichain | ETH/USDC 500, 10 | none | **$20.1M** | $2.56M | no |
| Unichain | ETH/USDC 3000, 60 | none | $845k | $401k | no |
| Unichain | ETH/USDC 670, 10 | Limit Order Hook | $81k | $247 | no |
| Unichain | ETH/USDC 0, 32767 | BackGeoOracle `0x54bd…3aC4` | $620 | $68 | yes |
| Unichain | ETH/USDC 490, 10 | VolatilityFeeHook `0x3002…50C4` | $15 | $15 | fee only |

Total TVL of *all* hooked ETH/USDC v4 pools:
- Ethereum $4.04M, of which Angstrom is $3.45M;
- Base $0.78M;
- Arbitrum $0.17M;
- Unichain $0.08M.

### 1.3 The protocols named in 02 §2.5 / §6.1

- **Angstrom (Sorella).** No oracle.
  - `grep -riE "oracle|twap|observ"` over `angstrom/contracts/src` finds only `GrowthOutsideUpdater.sol`, which
    tracks LP reward growth.
  - `UnlockHook.beforeSwap` (`contracts/src/modules/UnlockHook.sol:38-67`) reverts `CannotSwapWhileLocked` unless
    a registered node has unlocked the pool for this block (`TopLevelAuth.sol:193-213`,
    `_lastBlockUpdated == block.number`). It stores `currentTickBeforeSwap` in transient storage only and returns a
    zero delta plus an override fee.
  - So the per-block uniform clearing price is **not accumulated anywhere readable**.
  - Its v4 pool's `slot0` could be sampled, but once a node has unlocked the block, anyone can swap after the bundle.
    That makes it the same same-block-manipulable read as any hookless pool.
  - It also has a **permissioned-node** trust model.
- **Bunni v2.** It has a real oracle.
  - `src/lib/Oracle.sol:28` has `MAX_ABS_TICK_MOVE = 9116`, the truncated oracle. The `minInterval` "intermediate
    observation" logic is at `:101-140`.
  - The oracle is written in `beforeSwap` from Bunni's own pre-swap `slot0` (`src/lib/BunniHookLogic.sol:203-206`)
    and read with `BunniHook.observe(key, secondsAgos)` (`src/BunniHook.sol:470-476`).
  - The protocol **shut down on 2025-10-22/23** after the 2025-09-02 $8.4M exploit of its LDF on Ethereum and Unichain
    pools (The Block, CoinDesk; secondary sources).
  - The Arbitrum ETH/USDC Bunni pools found by the log scan carry no TVL in GraphQL. **Unusable.**
- **EulerSwap.** No oracle (`grep` over `euler-swap/src` returns nothing).
  - Permissions include `beforeSwap` + `beforeSwapReturnDelta` (`src/UniswapHook.sol:141-152`). Every swap is a
    NoOp that returns the full delta (`:105-107`). The v4 pool's `slot0` therefore never moves, and even sampling it
    would be meaningless.
  - No EulerSwap ETH/USDC pool appears in the TVL lists.
- **Flaunch.** It has a v3-style oracle contract (`src/contracts/Oracle.sol:29-33`: `TWAP_WINDOW = 600`,
  `MAX_OBSERVATION_CARDINALITY = 300`).
  - Only an authorised `InternalSwapPool` (`ORACLE_CONSUMER` role, `:59-62`) can record into it.
  - It serves Flaunch memecoin/flETH pools on Base, not ETH/USDC.
- **BackGeoOracle.** A GeomeanOracle-style v3 ring (verified source `BackGeoOracle.sol`, `Oracle.Observation[65535]`),
  with backrun logic. It is deployed on all four chains, and each ETH/USDC deployment holds **< $2k TVL**. Moving
  such a pool 1% across a block costs cents.
- **MyNewHook** (mainnet, $451k). Its docstring and `VolatilityData` struct (`src_0x47F1C7C7.sol:17-128`) keep an
  EWMA (α = 0.4, updated at most once per 60 s) of tick moves over fixed 5, 15, 30 and 60-minute look-backs, to set a
  dynamic fee.
  - It has no cumulative, no `observe`, and no statistical calibration.
  - Its volume is $4.7k/day.
  - Not an oracle source.

### 1.4 v3 observe sources (read live)

| pool | token0 | L | y_v (virtual USDC) | cardinality | span of ring | notes |
|---|---|---|---|---|---|---|
| Ethereum v3 5 bp `0x88e6…5640` | USDC | 2.998e18 | **$155M** | 723 | **7.4 h** (26,628 s) | feeProtocol 68 |
| Base v3 5 bp `0xd0b5…F224` | WETH | 1.294e18 | **$67M** | 5,000 | **28.2 h** | not flipped |
| Arbitrum v3 5 bp `0xC696…E8D0` | WETH | 3.224e18 | **$167M** | 9,000 | **46.9 h** | not flipped |
| Unichain v3 5 bp `0x6508…BcF1` | USDC | 7.09e14 | $37k | 2,000 | n/a | too thin |
| Unichain v3 30 bp `0x8927…9E49` | USDC | 1.01e17 | $5.2M | 601 | n/a | 30 bp band is a poor σ source (02 §3.4) |

Spans were read at a pinned block: `slot0` (index, cardinality), then the newest observation and the oldest one,
`observations((index+1)%card)`.

### 1.5 Conclusion for (a)

"S and σ from the same Uniswap v4 market" **cannot be satisfied by any existing pool.**
- Every deep v4 ETH/USDC pool is hookless. v4 has no core oracle (02 §2.1), and hooks cannot be added to an existing
  pool.
- The honest Uniswap-native options are:
  - **(i)** a new, dedicated ETH/USDC v4 pool with an oracle-only hook (thin at launch; its depth is the security
    budget);
  - **(ii)** the v3 5 bp `observe` oracle, which is deep and battle-tested but is v3.
- The user's premise holds in the proof environment through (i), and in a realistic fork through (ii). Production
  would use (ii), or (i) once it is deep enough, on the chain where the product runs.

---

## 2. (b) Proof-environment architecture and the interface

### 2.1 Decision

**Both, behind one interface** (`src/IUnderlyingOracle.sol`):

```
PredictionHook ──reads (O(1), view)──► IUnderlyingOracle
                                         ├─ VolOracleHookV2   (oracle-only hook on a local ETH/USDC v4 pool; also deployable)
                                         └─ V3ObserveAdapter  (mainnet-fork wrapper of the v3 USDC/WETH 5 bp pool)
```

- **VolOracleHookV2** is the v4-native path. We control H, caps and checkpoints, and the tests are exact.
  - It serves many pools (feed id = `PoolId`).
  - Permissions: `afterInitialize | beforeSwap` only, with no return-delta flags and a zero fee override, so
    routers can treat it like a vanilla pool.
  - It is a **separate contract** from the PredictionHook (02 §6.2a).
- **V3ObserveAdapter** gives the realistic depth ($155M) and real history. It reproduces the same statistic from v3
  `tickCumulative`s through a permissionless `poke()`.
- **We do not deploy OZ `BaseOracleHook` itself**, for three reasons:
  - It is unaudited (02 §2.2 [FC]).
  - It has no RV accumulator and no O(1) grid checkpoints.
  - Its truncated accumulator must not be used for RV or TWAP settlement (05 §5.3 item 3).
- Its **write semantics are adopted exactly**: first swap per block, pre-swap tick. A differential test checks that
  our untruncated `tickCumulative` equals the OZ `Oracle` library's `tickCumulative` on fuzzed paths (§4).

### 2.2 The interface (what the PredictionHook calls)

```solidity
interface IUnderlyingOracle {
    struct FeedInfo { uint32 H; int8 sign; int16 decimalsShift; uint24 feeBandPips; uint16 ringSize; }
    function feedInfo(bytes32 feed) external view returns (FeedInfo memory);
    function sobTick(bytes32 feed) external view returns (int24 normTick, uint32 lastWriteTime);
    function sobSqrtPriceX96(bytes32 feed) external view returns (uint160 sqrtPriceX96, bool exact); // raw orientation
    function cumulativeNow(bytes32 feed) external view returns (int56 normCum);
    function cumulativeAtGrid(bytes32 feed, uint32 grid) external view returns (int56 normCum);      // reverts if not retained
    function varianceE36(bytes32 feed, uint32 nWindows)
        external view returns (uint256 varPerSecE36, uint32 gStart, uint32 gEnd, uint32 dN);
}
```

- **Normalisation.** `normTick = sign·rawTick`, so "ETH up" is always "tick up".
  - `sign = +1` for native ETH/USDC v4 (ETH is currency0, 02 §7).
  - `sign = −1` for mainnet v3 USDC/WETH.
  - In the flipped orientation `−floor` is a ceiling. Settlement must use the orientation-aware integer thresholds
    of the settlement gap report (`YES ⇔ D < ceil(w·(κ−½))` flipped).
  - `sobSqrtPriceX96` is returned raw. The quote converts it to a log price with `s_o` as in
    `quote-function-spot-input-and-size-impact.md` §1.2.
- **SoB rule (both implementations).** Return the observation's value if it was written in this block, otherwise the
  live value.
  - v4: only `Pool.swap` moves the price, and every swap first runs the oracle hook's `beforeSwap`, which writes the
    pre-swap state. The only exception is `noSelfCall` (`Hooks.sol:253`), and the oracle hook never swaps.
  - v3: the pool writes the pre-change tick whenever the tick changes, once per block
    (`v3-core/contracts/UniswapV3Pool.sol:733-741`; `Oracle.sol:90`). If the newest observation is from this block,
    the SoB tick is `(cum_new − cum_prev)/(t_new − t_prev)`. That division is exact because `cum_new − cum_prev` is
    `tick·Δt`.
  - In v3 the exact SoB `sqrtPriceX96` is lost once the tick has changed in the block. The adapter then returns the
    half-tick midpoint with `exact = false` (error ≤ 0.5 bp, the same γ₀ allowance as the quote report's fork
    fallback).
- **Window reads.**
  - Grid g covers `((g−1)H, gH]` in unix time.
  - A TWAP between grid g and now is `(cumulativeNow − cumulativeAtGrid(g))/(now − gH)`.
  - The settlement statistic `D = cum(T) − cum(T−w)` is two `cumulativeAtGrid` reads with T and T−w grid-aligned.
    The PredictionHook should copy both into market storage at `settle()`, which makes settlement independent of
    ring retention.
- **Freshness.**
  - VolOracleHookV2 computes the checkpoint of any grid completed since the last write *virtually*: the tick is
    constant since that write and equals the SoB tick. `varianceE36` is therefore always current.
  - The v3 adapter requires `poke()` to have run for `gEnd`. It returns `gEnd`, and the caller checks
    `gEnd ≥ now/H − 1`.

### 2.3 VolOracleHookV2 storage and write (`src/VolOracleV2.sol`)

- `Observation` (1 slot, 256 bits): `blockTimestamp`, `tick` (prevailing over (prev, ts]), `tickCumulative`
  (untruncated), `blockSqCumulative` (diagnostic), `windowSqCumulative`, `initialized`. This is unchanged from
  02 §3.9.
- `State` (1 slot, 216 bits): ring `index/cardinality/cardinalityNext`, plus `lastGrid`, `nWin`, `cumAtLastGrid`
  and `lastWindowSum`.
- **Checkpoint ring** (new; `Checkpoint {uint32 grid; uint32 nWin; int56 cum; uint72 wsq}`, 192 bits, 1 slot),
  `ckpt[g % ringSize]`.
  - Each write that crosses boundaries stores the checkpoints of the newly completed grids. Their values are closed
    form, because the tick is constant since the last write:
    - `cum(g'H) = last.cum + k·(g'H − last.ts)`;
    - `wsq(g') = wsq_before + sq1 + [g' > g1]·sq2`;
    - `nWin(g') = nWin_before + (g' − lastGrid)`.
  - The loop is bounded by `maxCatchUp` (12 = 1 h at H = 300). Older skipped grids stay unavailable, with a
    `CheckpointUnavailable` revert.
  - A reader checks `ckpt[g % ring].grid == g`. That single SLOAD needs no search.
  - With `ringSize = 4096` at H = 300, the ring retains 14.2 days.
- **Window statistic.** It is the same lazy O(1) two-difference update as 02 §3.9.
- **`poke(PoolId)`** is permissionless.
  - It writes an observation with the live tick and `sqrtPriceX96` if nothing was written in this block. This is safe
    by the SoB rule: no swap has happened in this block, so the live values are the SoB values.
  - Keepers use it to guarantee settlement checkpoints and to keep gaps under `maxCatchUp`.
- **SoB `sqrtPriceX96` slot.**
  - `Sob {uint160 sqrtPriceX96; uint32 ts}` is written on the first swap of the block, after `getSlot0`. It removes
    the ≤ 1-tick flooring of the S input that 05 §2.5 and the quote gap report require.
  - This hook does not add the quote report's fixed-point `lnCum`. The TWAP anchor can use `tickCumulative` with
    the half-tick correction, as the quote report does for v3.

### 2.4 V3ObserveAdapter (`src/V3ObserveAdapter.sol`)

- `poke()` computes the grids completed since its last run. On the first run it backfills up to `maxCatchUp`
  windows, bounded by the oldest v3 observation.
- It makes **one** `observe(secondsAgos[])` call for all of them and applies the same window update. It stores
  checkpoints `(g, nWin, cum, wsq)` in its own 4096-slot ring.
- If the gap exceeds `maxCatchUp`, or reaches older than the v3 ring, the chain **breaks**:
  - Windows across the break are not counted. `nWin` counts only the differences actually measured.
  - `Δwsq/ΔnWin` therefore stays an unbiased estimator across breaks.
  - A consumer should require `dN ≥ 0.9·nWindows`.
- Reads (`cumulativeAtGrid`, `varianceE36`) are one or two SLOADs. `sobTick`/`sobSqrtPriceX96` make 2–3 external
  calls to the v3 pool.

### 2.5 Gas (measured)

Writes on the underlying pool. `forge test --isolate`, so each swap is its own transaction. PoolSwapTest,
fee 500, exact-in 0.1 token, no initialized tick crossed. The ring is pre-grown to 64 observations and warmed with
200 blocks. Output is in `out_gas_writes_isolate.txt`.

| case | hookless | VolOracleHookV2 | Δ |
|---|---|---|---|
| first swap in block, no grid boundary crossed | 122,024 | 149,660 | **+27,636** |
| later swap in the same block | 116,482 | 127,789 | **+11,307** |
| first swap in block, crosses 1 boundary (fresh checkpoint slot, zero→nonzero) | 122,024 | 175,694 | **+53,670** |
| first swap after a 1 h quiet gap (12 fresh checkpoints) | 116,482 | 431,370 | +314,888 |

- In steady state, once the 4096-slot ring has wrapped after 14 days, checkpoint writes become nonzero→nonzero. That
  should cut the boundary case to about +32k and the 1 h case to about +80k (**UNVERIFIED**, estimated from SSTORE
  pricing and not measured).
- Compared with 02 §3.9 (v1 +22.5k), the extra +5.1k on the first swap comes from the SoB `sqrtPriceX96` slot.

Reads. These are the costs a PredictionHook pays for one external call, measured through a `Reader` contract with
`vm.cool(oracle)` and `vm.cool(PoolManager)` before each call, so accounts and slots start cold. They include the
2,600 cold-account CALL.

| read | VolOracleHookV2: no write yet in block | VolOracleHookV2: written this block | V3ObserveAdapter (fork) |
|---|---|---|---|
| `sobTick` | 13,827 | 8,272 | 12,886–16,710 |
| `sobSqrtPriceX96` | 11,412 | 5,846 | about the same as `sobTick` (**UNVERIFIED**, not separately measured) |
| `cumulativeNow` | 13,926 | 8,063 | 16,304–16,807 (`observe([0])`) |
| `cumulativeAtGrid` (retained) | 9,137 | 9,137 | 5,654 |
| `varianceE36` (two checkpoints) | 13,977 | 13,977 | 11,281 |
| `poke()`, 1 new window (keeper) | n/a (the swap writes) | n/a | **119,321** (v3 `observe` binary search plus a fresh checkpoint SSTORE) |

A PredictionHook trade that reads SoB price + variance (mode B) costs about 20–28k gas. With fixed σ (mode A) it is
6–11k.

On L1 an adapter keeper poking every 5 minutes would cost about 34M gas/day (about 0.034 ETH/day at 1 gwei).
- Poke hourly instead. One `observe` call covers 12 targets and the per-target cost amortises (**UNVERIFIED** exact
  gas).
- Or poke lazily from PredictionHook trades.
- On L2 the cost is negligible.

### 2.6 What the PredictionHook calls, and when

| moment | call | why |
|---|---|---|
| market creation (mode A) | `varianceE36(feed, 864)` → SigmaPolicy → store `varMarketE36` | σ fixed for the market's life (06 §9.6) |
| every quote/swap | `sobSqrtPriceX96(feed)` (and `sobTick` for the circuit breaker) | epoch-constant S (quote gap report §1.2) |
| optional TWAP anchor/breaker | `cumulativeNow` − `cumulativeAtGrid(g)` | worst-of overlay / deviation halt |
| every block (mode B only) | `varianceE36(feed, 864)`, rate-limited | live σ |
| settle | `cumulativeAtGrid(T/H − w/H)`, `cumulativeAtGrid(T/H)` → store both | exact integer settlement (settlement gap report §4.1) |
| keeper around T | `poke` | guarantees the T checkpoint within `maxCatchUp` |

---

## 3. (c) One σ estimator spec

### 3.1 The spec

```
Source:      SoB tick path of the underlying (VolOracleHookV2 pool, or v3 5 bp via V3ObserveAdapter).
Grid:        H = 300 s, unix-aligned; window g = ((g−1)H, gH].
Sample:      D_g = cum(gH) − cum((g−1)H)      (tick·seconds, exact integer).
Return:      r_g = clamp(D_g − D_{g−1}, ±400·H)          (winsorised at 400 ticks of mean-to-mean move).
Accumulate:  Q(g) = Σ r_g²,  n(g) = #differences measured.   (O(1) per write; checkpoints every grid)
Raw var:     v_raw = (3/2)·ln²(1.0001)·ΔQ / (H³·Δn)        per second, 1e36 scale, W = 864 windows (3 days)
             = 3·LN_TICK_SQ_E36·ΔQ / (2·H³·Δn),  LN_TICK_SQ_E36 = 9999000091658334094374450926
Bias:        v = v_raw + β,  β = 0.5·γ²/H   (γ = source fee band: 5 bp v3 → 4.1667e26 E36 = 0.01314/yr;
                                               6.25 bp v4-5bp → 6.5104e26; 0 for an exact-follower test pool)
Clamp:       v ∈ [0.20², 2.50²]/31,536,000  → [1.2684e27, 1.9819e29] in E36
Mode A (v1): varMarket = policy(v) at creation, fixed until expiry.
Mode B:      published v moves toward target at most +20%/h up and −10%/h down (SigmaPolicy.rateLimit).
Guard:       creation/quotes halt if v_1d/v_3d ∉ [0.25, 4] (regime flag), or if dN < 0.9·nWindows.
Pricing:     w = v·τ_sec (no annualisation, 03 §5.2); spread term h_σ = |∂P/∂σ|·z·SE(σ̂) with SE = σ̂·√(1.125/(2n)).
```

Discreteness factor: with m = H/Δb blocks per window, `Var(ΔĀ) = (2/3)σ²H·(1 + 1/(2m²))`. That is +0.08% at m = 25
(L1) and negligible on L2. It is ignored and documented. The derivation: the difference of two adjacent m-block
means gives increment weights 1/m, 2/m, …, 1, …, 1/m, and `Σc² = (2m²+1)/(3m)`.

### 3.2 Reconciling the bias figures

All the headline numbers in reports 02 and 05 are **5-minute point sampling** on a band-follower (5 bp band, 12 s
arbitrage). They differ only because σ differs.

Re-simulation (`py/bias.py`, 400 paths × 1 day per cell; relative bias of E[σ̂²]/σ² − 1):

| σ | 5 bp, point 5 min | 5 bp, **TWAP-ret 5 min** | 5 bp, point 15 min | 5 bp, TWAP-ret 15 min | 6.25 bp, TWAP-ret 5 min | 30 bp, TWAP-ret 1 h |
|---|---|---|---|---|---|---|
| 0.3 | −27.2% | −15.4% | −9.1% | −3.4% | −23.7% | −36.5% |
| 0.5 | **−13.0%** (05: −12.9%) | **−4.8%** | −5.6% | −1.3% | −7.9% | −12.1% |
| 0.8 | **−7.3%** (05: −6.7%) | **−2.4%** | −3.3% | −1.4% | −3.0% | −4.7% |
| 1.2 | −4.1% | −0.9% | −2.5% | −1.1% | −0.4% | −1.1% |

- **02's "−11% at 5 min, σ 52%"** is its own point-sample row (0.491 vs 0.52 → −10.9%). It sits between our −13.0%
  (σ 0.5) and −7.3% (σ 0.8).
- **05's −6.7% at σ 0.8 and −12.9% at σ 0.5** are reproduced within MC error (−7.3%, −13.0%).
- **The three reports agree**, and none of them used the TWAP-return estimator we adopt.
- **The TWAP-return bias is an additive variance deficit.**
  - Writing it as `−c·γ²/H` gives `c = 0.53 / 0.47 / 0.31` at σ = 0.3 / 0.5 / 0.8 (500 paths × 3 days;
    `py/calib_2000_3.0.json` "band" rows: ratio 0.844 / 0.950 / 0.987).
  - Equivalently the relative bias is `≈ −0.5·z²` with `z = γ/(σ√H)`.
  - The point-sampling bias does *not* scale like this: its c grows with σ (0.93 → 2.25).
- **Real data.**
  - Report 02 found 5-min TWAP-return pool RV 51.2% vs Binance 52.4% over 7 days: variance ratio 0.955, **−4.5%**.
    The model predicts −4.9% at σ = 0.52.
  - This report's fork check covered the last 84 windows (7 h) before block 26,055,289. Pool raw
    σ̂² = 0.5378 (σ̂ = 73.3%) against Binance ETHUSDT 5-min TWAP-return 74.5% over the same window: **−3.1%**.
    The model predicts −2.4%. Adding β gives 74.2%.
- **Sensitivity.** Adding noise trades inside the band (`bias.py`, noise = 0.5γ random walk) shrinks the deficit or
  flips its sign: +2.1% at σ = 0.3 with 6.25 bp; hugely positive with a 30 bp band. The model's sign is therefore not
  guaranteed on other pools.
  - That is why the correction is (i) additive and small, (ii) a per-source constant set from the fee band, and
    (iii) validated on the actual source (fork test + Binance) before use.

### 3.3 Decisions on every open knob

| knob | proposals in reports 02–06 | decision | reason |
|---|---|---|---|
| estimator | 02: TWAP-return ×3/2; 04 §9.4: EWMA of log returns; 05 §8.9: our hook self-samples | **TWAP-return RV from the oracle's checkpoints** | Unbiased under GBM, including random activity and irregular gaps (§4.3). Calibrated χ² CI. 3–10× smaller band bias than point sampling. About 17× (L1) to 200× (Unichain) costlier to inflate than point RV (02 §3.8). Window chosen at read time. |
| EWMA | 04 §9.4 | **Rejected** for the oracle | Window fixed at deploy. Weights the newest (manipulable) samples most. No χ² CI (n_eff only). Extra state and `expWad` per write. Reactivity comes instead from the `v_1d/v_3d` guard and mode-B rate limit. |
| self-sampling from the PredictionHook | 05 §8.9 (acceptable for σ), quote report C5 | **Fallback only**, for a chain with no oracle source | Samples are taken whenever *we* are touched, after possible in-block pushes. Winsorising and rate-limiting bound, but do not remove, that manipulation. Not needed once `IUnderlyingOracle` exists. |
| fixed σ per market | 06 §9.6 | **Mode A = v1** | Removes the mid-life σ-manipulation surface and makes proofs deterministic. σ is still *computed from Uniswap* at creation. |
| per-second 1e36 | 03 §5.2 | **Adopted** (`varianceE36`) | WAD per-second variance has only ~10 significant digits (03). |
| H | 02: 5–15 min | **300 s** | With β, the residual bias is ≤ 1–2 points at σ ≥ 0.3. SE 2.55% vs 4.4% at 15 min (W = 3 d). |
| W | 02: 3–7 d | **3 d (864 windows)** | SE(σ̂) = 2.55%, 95% CI ×[0.950, 1.050]. Shorter than 7 d for regime tracking. The 1-day read is the guard. |
| bias correction | 02: "or an explicit correction"; 05: "multiplicative correction by simulation" | **Additive β = 0.5·γ²/H** | Deficit is ~constant in variance units, and a multiplicative factor would be wrong across σ. β is independent of σ̂, so manipulation cannot amplify it. Validated on 2 real windows. |
| winsorisation | 02: 1000 ticks; 05: k·σ̂√Δ | **400 ticks per window-mean difference** | 6.3 SD at the 250% cap, 30 SD at 52%. Never binds on 7 days of real data (max per-block move 74 ticks). A fixed cap is O(1) and state-free. An adaptive k·σ̂ cap needs σ̂ at write time (circular). The cap does *not* bound manipulation much, because holding a push for a whole window costs n_b·y_v·δ²/4. Depth does that. |
| floor/cap | 02: [25%, 250%]; 04: Lyra [0.25, 3] | **[20%, 250%]** | Prevents σ → 0 degeneracy (prices saturate at 0/1). Covers the 2021–2026 ETH RV range (04 §8.4). |
| rate limit | 02 (Aloe ≈ 19 vol-pts/day); 05 | **Mode B only: +20%/h, −10%/h in variance** | Asymmetric: react faster to rising vol. In mode A, not applicable. |
| vol premium | 04 §9.4 (multiplier toward IV, VRP ≈ +5.3 pts) | **None in v1 (m = 1)**; spread term `h_σ = |∂P/∂σ|·z·SE` instead | For a binary, vega `= −n(d2)·d1/σ` changes sign at d1 = 0. A σ markup raises OTM prices but *lowers* ITM prices, so it is not conservative. It only picks which counterparty to favour. It protects against IV-arbitrage desks on OTM tails but hands edge to physical-measure traders on ITM. Keep calibrated probabilities for the proof. Offer an audited `m ∈ [1, 1.15]` parameter later (open question). |

### 3.4 Precision and manipulation cost under the spec

- **Precision.** SE(σ̂)/σ = √(1.125/(2n)): 4.42% (1 d), **2.55% (3 d)**, 1.67% (7 d).
  - The 95% χ²(ν = n/1.125) intervals for σ̂/σ are [0.913, 1.087], **[0.950, 1.050]** and [0.967, 1.033].
  - Pricing impact, from 05 §5.4 scaled from its 4.17% SE: about 0.57¢ for a 5% OTM 1-day binary.
- **Cost to push the 3-day σ̂ from 52% to 62%.** The added quadratic variation is 9.37e-4, and the cost is
  `≈ n_b·y_v·ΔQV/12` (02 §3.8):

  | source | n_b = H/Δb | cost |
  |---|---|---|
  | v3 5 bp L1 ($155M) | 25 | **$303k** |
  | v4 5 bp L1 hookless ($8.9M; reference only) | 25 | $17k |
  | our new oracle pool, $1M TVL full range (y_v $0.5M) | 25 | **$976** |
  | v3 5 bp Base ($67M) | 150 | $785k |
  | v3 5 bp Arbitrum ($167M) | 1200 | $15.6M (**UNVERIFIED**: assumes arbitrage every 0.25 s block) |

- What the attacker gains is about 3.9¢ per $1 notional per 10 vol points (7-day, 10% OTM, 02 §3.8).
- Mode A exposes only the creation instant. The creator can also refuse a σ outside a sanity band.
- A thin new pool is **not** a safe live-σ source. In the proof environment that is fine, because the pool is ours.
  In production, use the v3 source or enforce vega caps against the pool's cost.

---

## 4. (d) Tests built and results

All files are in `underlying-oracle-prototype/`. `forge test`: **13 distinct tests pass.** The runner reports 18
because two suites inherit tests. Output is in `out_forge.txt`.

### 4.1 Library, deterministic and fuzzed (`test/VolOracleV2.t.sol`)

- **Reference model** (`RefModel`). It integrates the piecewise-constant tick path segment by segment:
  - pretended tick before initialisation;
  - live tick after the last write for virtual reads;
  - every `D_g`, winsorised difference, `wsq`, `nWin`, cumulative and `blockSq` recomputed from scratch;
  - no lazy two-difference logic and no incremental state.
- **`testFuzz_pathMatchesReference`**, 256 runs, 30–60 writes each. Gap mixture:
  - 40%: 1–30 s;
  - 30%: 150–1,050 s (the `g == g1` and `g > g1` branches);
  - 20%: 2,000–6,000 s (multi-window gaps beyond `maxCatchUp = 6`);
  - 10%: land exactly on a boundary.
- The tick process has ±10 steps, ±100 jumps that bind **both** caps (`blockCap = 15`, `windowCap = 25`) and
  repeats. Half the runs also grow the observation ring to 8 so it wraps. The checkpoint ring is 16, so it wraps
  too. The test asserts:
  - newest observation, `tickCumulative` (**also equal to the OZ `Oracle` library's `tickCumulative`, fed the same
    writes with truncation disabled**), `blockSq`, `windowSq`, `lastGrid`, `cumAtLastGrid`, `lastWindowSum` and `nWin`;
  - every retained checkpoint's `cum`, `wsq` and `nWin`;
  - checkpoint **availability** follows the catch-up rule exactly;
  - the observation ring holds the last `card` writes in order;
  - the virtual checkpoint for a grid completed after the last write (live tick) is exact;
  - `varianceE36` is exact.
- **`test_capBinding`.** A 1,000-tick jump binds the block cap once (`50²`) and saturates two consecutive window
  differences (`2·(30·300)²`), while `tickCumulative` stays untruncated.
- **`test_multiWindowGapBranches`.** Deterministic cases:
  - no crossing;
  - exactly one boundary;
  - two boundaries;
  - a write exactly at `gH`;
  - a 10-window gap with `maxCatchUp = 4`, where grids g0+5 … g0+10 revert `CheckpointUnavailable` and g0+11 … g0+14
    are exact, with `nWin` counting the zero-return windows inside the gap.
- **`test_ringWrapAround`.** 50 writes with ring 8 and cardinality 4: old grids revert and the last 8 are exact.
- **`test_sameBlockWriteIsNoop`.** Later writes in the same block with ±5,000-tick "manipulated" ticks change
  nothing, and `sobTick` ignores the live tick.
- **Mutation check** (sed mutants, 64 fuzz runs each). All **6/6 killed**:
  - drop the `gg > g1` guard;
  - remove the upper clamp;
  - off-by-one in d2;
  - off-by-one in catch-up;
  - `nWin += 1`;
  - SoB returns the live tick.

### 4.2 Calibration against χ² (`test/Calibration.t.sol` + `py/calib.py`)

- `calib.py files` generates 3-day, 12 s-block, σ = 50% paths:
  - 6 **exact-follower GBM** paths: the pool tick is `floor(x/ln 1.0001)` every block;
  - 3 **band-follower** paths: 5 bp band, arbitrage at block end, a write only when the tick changes (about 27% of
    blocks).
- For each path, Python also computes the expected `ΔQ` with an **independent vectorised integer implementation**
  (windows summed directly from the block path).
- Solidity replays every write through the library (21,600 or about 5,850 writes per path). It asserts:
  - (1) `ΔQ` and `Δn` are **bit-exact** against Python;
  - (2) per path, σ̂²/σ² lies in the **99.9%** Wilson–Hilferty χ² band with ν = n/1.125 (checked against scipy:
    0.8405 / 1.1766);
  - (3) the ν-weighted pooled ratio lies in the 99% band.
- Results:
  - exact-follower ratios: 1.0036, 0.9979, 1.0440, 1.0352, 1.0151, 1.0087; **pooled 1.0174** (99% band ±5.4%);
  - band-follower raw ratios: 0.924, 0.939, 0.963 (all < 1, as the model predicts);
  - with β: **0.977, 0.992, 1.015**, all inside the per-path band.

**Large-scale Python** (`py/calib.py stats 2000 3`, same estimator; bit-exactness with Solidity is established by the
replay above):

| model | σ | paths | mean σ̂²/σ² | SE | SD (theory 0.0511) | 95% coverage | 99% coverage |
|---|---|---|---|---|---|---|---|
| exact follower | 0.3 | 2000 | 1.0008 | 0.0012 | 0.0515 | 95.7% | 99.0% |
| exact follower | 0.5 | 2000 | 1.0018 | 0.0011 | 0.0497 | 96.0% | 99.1% |
| exact follower | 0.8 | 2000 | 1.0009 | 0.0011 | 0.0511 | 95.2% | 99.3% |
| random activity (57.6% of blocks swap) | 0.5 | 2000 | 1.0002 | 0.0012 | 0.0515 | 94.7% | 98.9% |
| band 5 bp (raw) | 0.3 / 0.5 / 0.8 | 500 each | 0.844 / 0.950 / 0.987 | 0.002 | 0.048–0.051 | n/a (biased) | n/a |

- The χ²(ν = n/1.125) interval is calibrated, which validates the 1.125 variance inflation from the lag-1
  autocorrelation of ¼.
- The estimator is unbiased under GBM, including endogenous, irregular activity (Wald; 02 §3.2).
- With β, the band means become about 0.990, 1.003 and 1.008.

### 4.3 End-to-end through the real PoolManager (`test/E2E.t.sol`)

- **`test_e2e_gbmThroughPoolManager_sameBlockInvariance`.**
  - A local pool uses `VolOracleHookV2` (H 300, cap 400, ring 4096, catch-up 12).
  - For 1 day (7,200 blocks), each block moves the price to the next GBM tick (σ = 50%, Irwin–Hall shocks) with one
    swap and `sqrtPriceLimitX96` set to the target.
  - Every 25th block an attacker first pushes the pool +500 ticks, reads, then pushes −500 ticks and reads, all
    within the block. `sobTick`, `sobSqrtPriceX96`, `cumulativeNow`, `cumulativeAtGrid` and `varianceE36` are
    **unchanged** by the in-block pushes.
  - At the end: `cumulativeNow` equals the reference, `varianceE36` is **bit-exact** against an in-test window
    integration, and σ̂²/σ² = **1.0227**. The test asserts [0.735, 1.307], which is slightly tighter than the scipy
    99.9% χ² band [0.734, 1.317] for n = 287 and ν = n/1.125.
- **Finding.** In **8 of 7,200 blocks** the pool's `slot0.tick` ended at `target − 1` rather than the target. This is
  the zeroForOne word-boundary rule (`v4-core/src/libraries/Pool.sol:431`, 02 §2.1).
  - The oracle correctly follows the pool's tick.
  - Any reference or settlement logic must use `slot0.tick` as recorded, not `getTickAtSqrtPrice`. The first version
    of this test failed on exactly this (Δcum = 96 = 8 ticks × 12 s).
- `test_gas_reads` and `test_gas_writes` produced §2.5.
- **Gotcha:** under via-IR, `vm.warp(block.timestamp + 12)` in a loop does not advance time. Use
  `vm.getBlockTimestamp()`.

### 4.4 Mainnet fork, v3 5 bp adapter (`test/ForkV3.t.sol`, `test/ForkV3Gas.t.sol`)

Fork block 26,055,289; pool tick 197,323, so normalised SoB = −197,323, which is $2,696.

- **SoB invariance.**
  - Dumping 3,000 WETH in the same block moved the raw tick from 197,323 to 198,504 (~12%).
  - `sobTick` and `cumulativeNow` stayed unchanged, and pushing back changed nothing.
  - `sobSqrtPriceX96` switched from exact to the midpoint of the *same* SoB tick (`exact = false`).
- **Realised vol and bit-exactness.**
  - The first `poke()` backfilled 86 checkpoints (84 window differences, 7 h).
  - `varianceE36` was **bit-exact** against a direct recomputation from `pool.observe()`.
  - σ̂²_raw = 0.5378/yr (σ̂ = 73.3%), against Binance ETHUSDT 74.5% for the same window (`py/bn_check.py`).
  - The 30-minute settlement-style mean normalised tick was −197,345.
- **Continuity.** After 7 simulated minutes with swaps, a second poke extended the chain with no break
  (`ΔnWin == ΔlastGrid`).

### 4.5 Still to add in the proof program

- Steady-state gas after the checkpoint ring wraps (nonzero→nonzero), plus a `forge snapshot` baseline.
- Band-follower paths driven **through the PoolManager** (the E2E test uses an exact follower). The library-level
  replay covers the statistics.
- The adapter on Base and Arbitrum forks (not flipped; longer rings), plus a chain-break test using `vm.warp` beyond
  the v3 ring span.
- A statistical test of the `v_1d/v_3d` guard's false-alarm rate under GBM.
- The mode-B rate limit as a stateful invariant: `|Δ ln v| ≤` bound per elapsed hour.
- A manipulation economics test on the thin local pool: an attacker holds a displacement for k windows, and σ̂'s
  change is measured against cost. This checks the `n_b·y_v/12` cost formula.

---

## 5. Implications for the plan

1. **Claim wording.**
   - For the proof: "S, σ and S_T come from a Uniswap v4 ETH/USDC pool's own oracle hook (local), and are shown to
     work unchanged on the deepest Uniswap ETH/USDC oracle (v3 5 bp, mainnet fork)."
   - Do not claim that the existing canonical v4 ETH/USDC pools provide them. They cannot.
2. **Deploy three contracts in the Foundry project:**
   - `VolOracleHookV2` (plus `VolOracleV2`);
   - `V3ObserveAdapter`;
   - the `SigmaPolicy` library.
   The PredictionHook depends only on `IUnderlyingOracle`.
3. **σ in v1 = mode A:** `varMarket = clamp(varianceE36(864) + β, floor, cap)` snapshotted at `createMarket`, with
   the regime guard and the `dN` check. The quote uses `w = varMarket·τ`.
4. **Settlement** reads two grid checkpoints, stores them, and follows the settlement gap report. Keepers `poke` at T.
   T and T−w must be multiples of H.
5. **The quote's S** comes from `sobSqrtPriceX96`: exact on v4, half-tick midpoint on v3 when written this block.
6. **Security budget.** The local oracle pool is thin by construction. Economic caps (OI and vega) must be expressed
   against the *source's* cost functions (settlement report; §3.4). For production, prefer the v3 source, or bootstrap
   depth in the oracle pool.

## 6. Open questions

1. **Production chain.** On Arbitrum and Base the v3 5 bp oracles are deep and hold 28–47 h of history. On L1 the
   history is 7.4 h, which needs checkpoints. Unichain has no deep oracle at all (v3 5 bp $37k). Which chain hosts
   the product?
2. **Is β stable?** Re-estimate `c` on 30+ days of real data per source pool (pool vs Binance TWAP-return). Only two
   windows (7 d and 7 h) have been checked.
3. **Vol premium / IV alignment.** Should there be an audited `m` or a bounded IV band, given the vega-sign argument?
   This is a product decision about which counterparty to favour.
4. **Adaptive winsorisation.** A cap k·σ_ref with a slowly updated stored σ_ref would bound single-window
   manipulation better than the fixed 400 ticks. Is it worth the state?
5. **Keeper economics on L1** for the v3 adapter: hourly pokes, or lazy pokes from trades?

---

## Verification

**Verified (primary sources, code runs, or live chain reads):**
- Pool lists, TVL, volume and hook addresses per chain from Uniswap GraphQL, with pagination completeness as stated
  in §1.1.
- The Arbitrum `Initialize` scan (538 pools, 459 hooked); every hooked pool with TVL cross-matched.
- Hook names from hooklist `1d2f09b`.
- Source reads:
  - Angstrom `UnlockHook.sol:38-67` and `TopLevelAuth.sol:193-225` (no oracle);
  - Bunni `Oracle.sol`, `BunniHookLogic.sol:203-206` and `BunniHook.sol:470-476`;
  - EulerSwap `UniswapHook.sol:125-152` (NoOp, no oracle);
  - Flaunch `Oracle.sol:29-33, 59-74`;
  - BackGeoOracle, MyNewHook and AdaptivePoolPolicyHookV1 from Blockscout verified source.
- v3 pool states (L, cardinality, ring spans) at pinned blocks on Ethereum, Base, Arbitrum and Unichain via `cast`.
- `LN_TICK_SQ_E36` recomputed with mpmath (…925.98, rounded to …926). The half-tick factor 1.0001^¼ =
  1.000024999062554684.
- All Foundry tests listed in §4 pass (13 distinct). 6/6 mutants were killed.
- Calibration: Solidity is bit-exact against Python on 9 replayed paths; 2,000-path coverage figures as tabulated;
  bias tables re-simulated.
- Fork: SoB invariance under a 12% same-block push; adapter variance bit-exact against direct `observe`.
- Gas figures as measured (setup in §2.5).
- Reports 02 and 05's bias figures reproduced within MC error.

**Not verified / UNVERIFIED:**
- `Initialize`-log enumeration on mainnet, Base and Unichain: public RPC range limits (drpc 10k, publicnode archive
  token, Base 2k, flashbots empty responses). Coverage there relies on GraphQL, complete down to about $150–185 TVL.
- Source of the unverified hooks `0x74A7…4880` (mainnet, $47k) and `0x4632…4880` (Base, $149k, zero volume). Their
  address bits (`0x0880`: beforeAddLiquidity + beforeSwap) do not include `afterInitialize`, which a v3-style ring
  needs to seed itself. Low relevance, as neither pool is deep.
- The Bunni shutdown and exploit details come from news sources (The Block, CoinDesk, Decrypt), not a primary
  post-mortem.
- Steady-state (ring-wrapped) checkpoint write gas; the adapter's `sobSqrtPriceX96` gas; hourly batched-poke gas.
- The Arbitrum σ-manipulation cost, which assumes per-block (0.25 s) arbitrage.
- The stability of the fee-band constant `c = 0.5` beyond the two real-data windows. The noise-trade sensitivity
  shows its sign can flip on pools with heavy in-band noise flow.
- The Binance comparison approximates each minute's time-average by (open+close)/2. The 7 h window has SE ≈ 8% in
  σ, so the −3.1% agreement is consistent but weak evidence on its own.

## Sources

- Code (clones in `scratchpad/repos`):
  - `v4-core` (`Pool.sol:431`, `Hooks.sol:253`) and `v3-core@d0831dc` (`UniswapV3Pool.sol:733-741`,
    `libraries/Oracle.sol:90`);
  - `angstrom@3690f91`, `bunni-v2@2b303b8`, `euler-swap@dd936d2`, `flaunchgg-contracts@77d7d23`,
    `Uniswap_hooklist@1d2f09b`;
  - OZ `uniswap-hooks` `src/oracles/panoptic/*` (via the gasbench copy `OZOracle.sol`).
- Verified contracts on Blockscout (eth, base, unichain `/api/v2/smart-contracts/{addr}`).
- Uniswap interface GraphQL `topV4Pools` / `v4Pool`, queried 2026-09-25.
- Binance `data-api.binance.vision` ETHUSDT 1m klines.
- News: [The Block](https://www.theblock.co/news/ecosystems/2025-10-22-bunni-dex-shuts-down-375813),
  [CoinDesk](https://www.coindesk.com/business/2025/10/23/bunni-dex-shuts-down-cites-recovery-costs-after-usd8-4m-exploit),
  [Decrypt](https://decrypt.co/345621/decentralized-exchange-bunni-pulls-the-plug-following-8-4m-flash-loan-exploit).
- Prior reports: 01 §5.4; 02 §§2–3, 3.8–3.9, 6; 03 §5.2; 04 §§8.4, 9.4; 05 §§2.5, 5, 8.9; 06 §§5.1, 9.6. Gap reports:
  `quote-function-spot-input-and-size-impact.md` §1.2 and `settlement-rule-and-in-band-manipulation.md` §§0, 4–5.
