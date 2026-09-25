# 00 — Research summary: a Uniswap v4 prediction-market hook priced by Black–Scholes binary math

**Date:** 2026-09-26. **Audience:** the engineer who will write the "prove it works" plan (Foundry project plus Python reference).
**Inputs:** all 20 reports in `docs/research/` (6 topic reports, 14 gap reports). Where reports disagree, §7 says which one wins and why.
The gap reports are newer than the topic reports and supersede them where they overlap.

**Citation keys** (every claim below is tagged with its source):

| key | report | key | report |
|---|---|---|---|
| [01] | `01-v4-core-custom-accounting.md` | [G-SWAP] | `gaps/swap-path-accounting-complete-sets.md` |
| [02] | `02-oracles-volatility.md` | [G-QUOTE] | `gaps/quote-function-spot-input-and-size-impact.md` |
| [03] | `03-fixedpoint-bs-math.md` | [G-SETTLE] | `gaps/settlement-rule-and-in-band-manipulation.md` |
| [04] | `04-prior-art-economics.md` | [G-ORACLE] | `gaps/underlying-oracle-source-and-sigma-estimator.md` |
| [05] | `05-math-theory-proofs.md` | [G-VAULT] | `gaps/lp-vault-structure-and-exposure-caps.md` |
| [06] | `06-hook-security.md` | [G-ECON] | `gaps/economic-acceptance-criteria-and-backtest.md` |
| [G-KERNEL] | `gaps/bs-normal-kernel-sufficiency-vs-student-t.md` | [G-FV] | `gaps/formal-verification-integer-proofs.md` |
| [G-ROUTE] | `gaps/routing-composability-proof-surface.md` | [G-L2] | `gaps/target-chain-l2-parameters-timestamps.md` |
| [G-SPEC] | `gaps/integrated-spec-rerun-backtest.md` | [G-REAL] | `gaps/simulator-realism-thales-replay-jump-adversaries.md` |

**Artifacts.** Anything under `scratchpad/` that the topic reports cite (for example `v4sim.py`, `bsbench/`, `gasbench/`) is
**ephemeral**. The persisted, reusable code is in `docs/research/`:
- `05-math-scripts/` (mpmath references, Solidity Hart port `evm/T.sol`);
- `gaps/swap-path-accounting-proto/` (multi-market VCS hook, 16/16 tests);
- `gaps/quote-function-scripts/` (integer reference `quote_ref.py`, `QuoteMath.sol`);
- `gaps/settlement-scripts/`;
- `gaps/underlying-oracle-prototype/` (`VolOracleV2`, `VolOracleHookV2`, `V3ObserveAdapter`, `SigmaPolicy`, `IUnderlyingOracle`; 13 tests);
- `gaps/lp-vault-scripts/` (`SeriesHook.sol`, 21/21 tests);
- `gaps/economic-backtest/`, `gaps/integrated-spec-scripts/`, `gaps/simulator-realism/` (Python engines, `quote_vectors.json`);
- `gaps/kernel-sufficiency-scripts/solidity/` (`StudentTCdf.sol`);
- `gaps/formal-verification-scripts/` (HartX36, certificates, z3 lemmas, Halmos harnesses);
- `gaps/routing-composability-proof/forkproof/` (UR 2.1.2 fork tests, 12/12 on mainnet and on Unichain);
- `gaps/l2-chain-scripts/`.

---

## 0. Executive summary: what research says the thing to build and prove is

The user's architecture works mechanically. Research changes five of its details. The plan must reflect all five, or the proof will be
either false or trivially exploitable.

1. **v4 execution works exactly as intended.** A `beforeSwap` + `beforeSwapReturnsDelta` hook fully NoOps the CL curve. Standard
   PoolSwapTest, V4Router, deployed UniversalRouter 2.1.2 and deployed V4Quoter all route USDC→YES and YES→USDC. Multi-hop
   ETH→USDC→YES also works in one UR transaction. [01][G-SWAP][G-ROUTE]
2. **"S and σ from the same Uniswap v4 ETH/USDC market" cannot be met by any existing pool.** Every deep v4 ETH/USDC pool is
   hookless, so it has no oracle, and hooks cannot be added to an existing pool. The honest Uniswap-native sources are:
   - (i) our own oracle-only hook on a new v4 ETH/USDC pool, which is v4-native, exact and fuzzable, but thin;
   - (ii) the v3 WETH/USDC 5 bp `observe` oracle, which is deep.

   Both sit behind one interface, `IUnderlyingOracle`. [G-ORACLE][02]
3. **The YES price is not literally `e^(−rT)N(d2)` at spot. Four corrections are required:**
   - r = 0 (collateral is idle USDC, and complete sets must be at par) [05];
   - S is the **start-of-block (SoB)** price, never live `slot0` and never a TWAP [G-QUOTE];
   - settlement is a **w-window geometric TWAP**, so the fair price is the **discrete geometric-Asian digital**, not N(d2)
     [G-SETTLE];
   - quotes carry a spread, per-block linear impact, caps, a price band (halt, not clamp) and a trading cutoff. A flat,
     reserve-free price with no depth limit loses without bound [05 §4.5][G-QUOTE].
4. **Solvency is structural and independent of pricing.** Solvency comes from complete-set accounting (1 USDC ≡ 1 YES + 1 NO,
   6-decimal outcome tokens), not from the Black–Scholes model. It is provable exactly. **Profitability is only conditionally provable**:
   given a declared noise flow, a declared adversary set, a chain and a tenor. [05 §3][G-ECON][G-SPEC][G-REAL]
5. **Scope the v1 claim to 1-day ETH markets.**
   - 7-day markets are fragile: realised drift is 3–8 pp [G-REAL].
   - Sub-day markets are research only: they need fat tails, L2 latency and event handling [G-KERNEL][G-ECON].
   - Use a settlement window of w = 4 h: the manipulation-safe open interest scales as w² [G-SETTLE][G-SPEC].
   - Proof fork chain: Base. Product chain: Arbitrum One. [G-L2]

**The baseline the plan should build (converged spec).** The per-row sources are in §2–§5.

| Component | Choice |
|---|---|
| Hook | One singleton `PredictionHook is OZ BaseHook` (no other OZ base). Flags `0x2AA8`. Self-initialises its pools; `beforeInitialize` always reverts. Static fee 0. Never partial-fills. |
| Markets and series | A series is (source pool, T, w) with a ladder of ≤ 30 strikes. Each market has two pools, {YES, USDC} and {NO, USDC}. Outcome tokens are plain ERC-20s with 6 decimals, mintable only by the hook. |
| Accounting | Virtual complete sets (VCS): per market `B_m` (USDC bucket as ERC-6909 claims), `outY`, `outN`, `invY`, `invN`. Post-check `B_m ≥ max(outY, outN)` plus the series ladder cap. Outputs are paid from inventory claims first; any shortfall is minted on demand with `sync/mint/settle`. |
| Oracle | `IUnderlyingOracle`. Local: `VolOracleHookV2` on our ETH/USDC v4 pool (flags `0x1080`). Forks: `V3ObserveAdapter` over v3 5 bp. |
| S | SoB `sqrtPriceX96` under the virtual-write rule, converted to a log price without tick flooring. Epoch key is `block.timestamp`. |
| σ | TWAP-return realised variance, H = 300 s grid, ×3/2, per-second variance at 1e36, winsorised, plus a band correction β, clamped to [0.20, 2.50]. Live EWMA with a 1-day half-life, read epoch-constant. No volatility multiplier. |
| Price | P = Φ̂(d) on the discrete-Asian (μ, v). The CDF is HartX36, a proven-monotone WAD Hart/West port. NO = 1e18 − YES. A Student-t kernel is an optional module. |
| Quote | ask = max_i g⁺ + h₀, bid = min_i g⁻ − h₀, with g± = P ± k·φ(d) in factored integer form. Linear impact λ on one signed I per market, reset each epoch. Per-epoch cap Q_epoch. Band p_min = 0.02 halts. Cutoff at T − w − 5 min. Amounts come from the exact-integer quadratic solvers. |
| Settlement | Strict integer rule on D = cum(T) − cum(T − w) with a half-tick threshold. Tie → NO. Checkpoints are stored at `settle`. Fallback chain: secondary source, then the mark at cutoff, then INVALID 50/50 after GRACE. |
| LP | Series tranche: subscribe 1:1, locked until finalisation. Budget B per market and B_s per series (exact O(n) ladder). Gross-OI cap Q_safe. |

---

## 1. Verified Uniswap v4 facts the design relies on

Versions: v4-core `46c6834` (2026-04-02). Its only `src/` change since tag `v4.0.0` (`e50237c`) is `a7cf038`, which moved
`SwapParams` and `ModifyLiquidityParams` into `src/types/PoolOperation.sol`; ABI and behaviour are identical. [01]

### 1.1 Swap flow and sign conventions [01 §1][06 §1.2]

- `PoolManager.swap` (`PoolManager.sol:187-227`) runs these steps:
  1. revert on `amountSpecified == 0` (`:193`) and on an uninitialised pool (`:196`);
  2. `beforeSwap` (`:202`);
  3. `Pool.swap` with `amountToSwap`, not the user's amount;
  4. `afterSwap` mapping (`:221`), even when the AFTER_SWAP flag is absent;
  5. book `hookDelta` to the hook (`:224`), then `swapDelta − hookDelta` to the caller (`:226`).
- **`amountSpecified < 0` means exact-in; `> 0` means exact-out.** `zeroForOne = true` means currency0 is the input.
- **The specified currency is currency0 iff `zeroForOne == (amountSpecified < 0)`** (`Hooks.sol:307`).
- **`BeforeSwapDelta` packing.** The upper 128 bits are `deltaSpecified` and the lower 128 bits are `deltaUnspecified`, both `int128`.
  Both are expressed from the **hook's perspective**: positive means the hook is owed or took currency; negative means the hook owes or
  paid (`BeforeSwapDelta.sol:4-37`, `IHooks.sol:101`).
- **`amountToSwap = amountSpecified + deltaSpecified`** (`Hooks.sol:266-279`). Core checks **only** a sign flip:
  - exact-in reverts only if `deltaSpecified > A`;
  - exact-out reverts only if `deltaSpecified < −A`.

  A wrong-signed specified delta is accepted and *enlarges* the CL swap. **The hook must assert `deltaSpecified == −amountSpecified`
  itself.** [01 §1.3 corrected][06 §2.4]
- **Mapping to currency0/1** (`Hooks.sol:305-313`): if `(amountSpecified < 0) == zeroForOne` the hook delta is `(spec, unspec)`,
  otherwise `(unspec, spec)`. The caller's delta is `clDelta − hookDelta`, which is **`−hookDelta`** on a full NoOp. The subtraction
  uses `SafeCast` and reverts on int128 overflow.
- **Full NoOp.** When `amountToSwap == 0`, `Pool.swap` returns `ZERO_DELTA` at `Pool.sol:320`:
  - before any price-limit check, so **`sqrtPriceLimitX96` is never validated**;
  - with no state write and no liquidity touched;
  - with `amountToProtocol = 0`, so no protocol fee is charged on NoOp volume.

  The pool must be initialised but needs **no liquidity**. The PM still emits `Swap(id, sender, 0, 0, …)`, so indexers see zero
  volume. [01 §1.4][06 §1.4]
- **The hook must net its own delta inside `beforeSwap`.** Without `AFTER_SWAP`, it gets no later callback before `unlock` checks
  `NonzeroDeltaCount == 0` (`PoolManager.sol:112`), and the router owns the `unlock`. [01 TL;DR 2]
- **Always fill fully or revert.** A partial fill sends the remainder through the CL loop on an empty pool. That walks tick words up
  to the router's MIN/MAX price limit, moves the cosmetic `slot0`, and makes `V4Quoter` revert `NotEnoughLiquidity`
  (`BaseV4Quoter.sol:53-57`). [01 §1.9][G-ROUTE §3.1]
- **Hook reverts arrive wrapped** as ERC-7751
  `WrappedError(address hook, bytes4 0x575e24b4 /*beforeSwap*/, bytes reason, bytes 0xa9e35b2f /*HookCallFailed*/)`, selector
  `0x90bfb865` (`Hooks.sol:137`, `CustomRevert.sol:11,83-110`).
  - The deployed V4Quoter wraps that again in `UnexpectedRevertBytes` (`0x6190b2b0`).
  - UR `V4_SWAP` bubbles it raw.
  - Tests must match these bytes exactly. [G-ROUTE §3.1][06 §2.2 corrected]

### 1.2 BeforeSwapDelta recipe, all 4 swap cases (both token orderings) [01 §1.7–1.8][G-SWAP §2, §9]

Notation: `A = |amountSpecified|`, OUT = the outcome token of the pool, ask/bid in WAD. Rounding always favours the vault: outputs
use `mulDiv` (floor) and inputs use `mulDivRoundingUp` (ceil); **revert if either amount is 0**.

The general rule is: exact-in returns `(+amountIn, −amountOut)`; exact-out returns `(−amountOut, +amountIn)`. In both cases
`spec = −amountSpecified`.

| # | Trade | zeroForOne if OUT = currency0 | zeroForOne if OUT = currency1 | Specified currency | Amounts (flat price; see §3.4 for impact) | `BeforeSwapDelta(spec, unspec)` | Hook's PM calls inside `beforeSwap` (effects first) |
|---|---|---|---|---|---|---|---|
| 1 | buy OUT, exact-in `A` USDC | false | true | USDC | `q = ⌊A·1e18/ask⌋` | `(+A, −q)` | `PM.mint(hook, USDC.id, A)`; `PM.burn(hook, OUT.id, f)` with `f = min(inv, q)`; if `q − f > 0`: `PM.sync(OUT); OUT.mint(PM, q−f); require(PM.settle() == q−f)` |
| 2 | buy OUT, exact-out `A` OUT | false | true | OUT | `cash = ⌈A·ask/1e18⌉` | `(−A, +cash)` | same as 1 with `q = A` |
| 3 | sell OUT, exact-in `A` OUT | true | false | OUT | `cash = ⌊A·bid/1e18⌋` | `(+A, −cash)` | `PM.mint(hook, OUT.id, A)`; `PM.burn(hook, USDC.id, cash)` |
| 4 | sell OUT, exact-out `A` USDC | true | false | USDC | `q = ⌈A·1e18/bid⌉` | `(−A, +q)` | same as 3 |

- **The (spec, unspec) words do not depend on token ordering.** Ordering changes only `zeroForOne` and the currency0/1 mapping of
  `hookDelta`. This is the most likely place for an ordering bug (06 T21), so test all 8 cases (4 swap types × YES/NO) in both
  orderings. [G-SWAP §9]
- **Byte-exact worked words** (P = 0.40, s = 0.01, so ask 0.41 and bid 0.39):
  - A, buy exact-in 100 USDC → 243,902,439 YES: `0x00000000000000000000000005f5e100fffffffffffffffffffffffff1765819`
  - B, buy exact-out 250 YES → 102,500,000 USDC: `0xfffffffffffffffffffffffff1194d80000000000000000000000000061c06a0`
  - C, sell exact-in 250 YES → 97,500,000 USDC: `0x0000000000000000000000000ee6b280fffffffffffffffffffffffffa3044a0`
  - D, sell exact-out 100 USDC → 256,410,257 YES: `0xfffffffffffffffffffffffffa0a1f000000000000000000000000000f488291`

  The G-SWAP prototype reproduces B, C and D byte for byte, and a Python recomputation matches every row. [01][G-SWAP]
- **Recommended post-condition asserts:**
  - `int256(spec) == −amountSpecified`;
  - `amountIn > 0 && amountOut > 0`;
  - exact-in: `spec > 0 && unspec == −amountOut`;
  - exact-out: `spec < 0 && unspec == +amountIn`.

  Use `SafeCast.toInt128` everywhere. `−amountSpecified` must not be `int256.min`. [06 §2.4][01 §8.6]

### 1.3 Settlement primitives and the pattern to use [01 §3][G-SWAP][G-VAULT][06 §1.3]

| call | effect on caller's delta | token movement | note |
|---|---|---|---|
| `sync(c)` | none | none | Snapshots `balanceOf(PM)` into **one** transient slot pair (`CurrencyReserves`). |
| `settle()` | `+paid` | measures the balance diff | Resets the synced slot (`:361`). With no synced currency it credits `msg.value`. |
| `take(c,to,a)` | `−a` | ERC-20 out now | Needs a **physical** PM balance. A fresh PM has zero balances, and the swapper has not paid yet in `beforeSwap`, so **never `take` inputs in `beforeSwap`**. |
| `mint(to,id,a)` | `−a` | ERC-6909 only | `id = uint160(currency)`. **Claim ids are per currency, not per pool**, so USDC claims are shared across all markets and need per-market ledgers. |
| `burn(from,id,a)` | `+a` | ERC-6909 only | |
| ERC-6909 `transfer` | none | claims only | Callable **while locked** (`ERC6909.sol:25-48`), so redemptions and LP claims can pay in claims with no `unlock`. [G-VAULT] |

- **Inputs** are taken as claims with `PM.mint(hook, in.id, amtIn)`.
- **USDC outputs** are paid with `PM.burn(hook, USDC.id, out)`.
- **Outcome outputs** come from inventory claims first (`PM.burn`). Any shortfall is minted on demand with
  `sync(OUT) → OUT.mint(PM) → settle()`.
  - This `sync` is the only way to create a positive delta for a token the PM does not hold.
  - It is safe for the hook: nothing untrusted runs between `sync` and `settle`, and the outcome token has no hooks.
  - Its only side effect is on the **caller's liveness**. A router that pre-syncs before `swap` fails closed with
    `CurrencyNotSettled`, and value can never be mis-credited (5 tests).
  - All standard routers settle atomically: periphery `DeltaResolver`, 0x Settler, v4-core and OZ `CurrencySettler`. Uniswap's own
    audited `WETHHook` and aggregator hooks use the same in-`beforeSwap` `sync/send/settle`. [G-SWAP §3, §7][G-ROUTE §6]
- **Checks-effects-interactions.** Update ledgers **before** any PM or token call. Make no calls to untrusted code in `beforeSwap`.
  [06 §2.7]

### 1.4 Permission flags and deployment [01 §2][06 §1.1]

- Flags live in the low 14 address bits (`Hooks.sol:27-47`). `validateHookPermissions` requires an **exact** 14-bit match, and OZ
  `BaseHook`'s constructor calls it. Each `*_RETURNS_DELTA` flag requires its base flag.
- **Recommended mask `0x2AA8`**: `BEFORE_INITIALIZE` 0x2000, `BEFORE_ADD_LIQUIDITY` 0x0800, `BEFORE_REMOVE_LIQUIDITY` 0x0200,
  `BEFORE_SWAP` 0x0080, `BEFORE_DONATE` 0x0020, `BEFORE_SWAP_RETURNS_DELTA` 0x0008. All callbacks except `beforeSwap` always revert.
  - The minimal working set is `0x2888` (used by the G-SWAP prototype); OZ `BaseCustomCurve` uses `0x2A88`.
  - A missing `BEFORE_SWAP_RETURNS_DELTA` is **silently ignored** (`Hooks.sol:266`), and the transaction then reverts
    `CurrencyNotSettled`.
- **The oracle-only hook on the underlying pool** uses `AFTER_INITIALIZE | BEFORE_SWAP` = `0x1080`, with no return-delta flags.
  [G-ORACLE §2.1]
- **Self-initialise pattern.** `createMarket` calls `PM.initialize` itself. `Hooks.noSelfCall` (`Hooks.sol:171-182`) skips our
  `beforeInitialize`, which reverts for everyone else. Euler Swap, Flaunch, Doppler and Uniswap's `SpreadQuoterBase` all do this.
  - Initialise at `SQRT_PRICE_1_1 = 2⁹⁶`. Both tokens have 6 decimals, and the price is cosmetic.
  - Use static fee 0 and a large `tickSpacing`, which bounds any accidental CL walk.
  - `PM.initialize` also requires: `tickSpacing` ∈ [1, 32767], `currency0 < currency1`, and a static fee ≤ 1e6.
  [01 §8.1][06 §1.5]
- **The hook's own swaps on its own pools skip its callbacks** (`Hooks.sol:253`). PredictionHook must never swap its own pools.
  [06 §1.5]
- **Mining.** About 16,384 CREATE2 tries on average. `HookMiner` was removed from `v4-periphery/src/utils` on 2026-02-06 (`5da22e6`);
  current copies are `v4-periphery/test/shared/HookMiner.sol` and `v4-hooks-public/src/utils/HookMiner.sol`. Vendor it.
  - In tests, use forge-std `deployCodeTo`. For Halmos, deploy normally and then `vm.etch` onto the flagged address.
  - **Avoid the address prefix `0x91…`** (Uniswap routing rule). [01 §2.3][G-FV §5.3][G-ROUTE §5.1]
- **Base contract.** Inherit OZ `BaseHook` only (`onlyPoolManager` on every entry point). Do **not** also inherit periphery
  `SafeCallback`: the identifiers collide.
  - `BaseCustomAccounting` and `BaseCustomCurve` are **single-pool**: they bind `_poolKey` on the first initialise and assume
    two-sided LP deposits.
  - Copy their claims pattern instead (`BaseCustomCurve.sol:112-128`). [01 §4.6][06 §2.1]

### 1.5 Router, quoter, identity, events [01 §7][G-ROUTE]

- **UniversalRouter.** `V4_SWAP = 0x10`. Actions `SWAP_EXACT_IN_SINGLE 0x06`, `SETTLE_ALL 0x0c`, `TAKE_ALL 0x0f`.
  - **UR 2.1.1 and 2.1.2 use the 6-field `ExactInputSingleParams`** `{poolKey, zeroForOne, amountIn, amountOutMinimum,
    uint256 minHopPriceX36, hookData}` and the 5-field multi-hop struct. UR v2.0 uses 5 and 4 fields.
  - On our pools (currency0 ≠ 0) a mismatched encoding reverts with **no data**. On ETH-currency0 pools it can execute silently.
    Never validate an encoding by "it didn't revert". **Target UR 2.1.2.**
- **Slippage** is amount-based only (`amountOutMinimum`, `amountInMaximum`, `V4ExactOutputUnfilled`). Price limits are ignored on a
  NoOp.
- **V4Quoter** simulates the full hook path and reverts. **Quote equals execution exactly within the same epoch with the same
  pre-trade state**, and it requires an exact fill.
- **The deployed V4Quoters lack `msgSender()`.** A hook that calls `IMsgSender(sender).msgSender()` unguarded is unquotable. The
  `sender` passed to the hook is the router; never use `tx.origin`. [G-ROUTE §3.2][06 §1.6]
- **Split and merge compose inside UR** as par-priced swaps selected by optional `hookData`. Split is `(1, recipient)`: the hook mints
  the other leg to `recipient`. Merge is `PERMIT2_TRANSFER_FROM(other→hook)` followed by a swap with `hookData = (2)`. Empty `hookData`
  must remain the normal priced swap. [G-ROUTE §4]
- **Events.** Emit the **aggregator** signature `HookSwap(bytes32 indexed poolId, address indexed sender, int256 amount0,
  int256 amount1, uint24 fee)` with the hook-perspective sign (input +, output −). Nothing consumes OZ `IHookEvents.HookSwap`; the
  Uniswap v4-subgraph indexes the aggregator form only for configured data sources. [G-ROUTE §5.3]
- **Routing admission.** Hooks with `beforeSwapReturnsDelta` need **manual allowlisting**: `HOOKS_ADDRESSES_ALLOWLIST` plus
  `ZLCA_HOOKS_PER_CHAIN` with `sqrtPriceFromQuoter: true`, because our L is 0 forever and `slot0` stays at 2⁹⁶. Eligibility can be
  proven; admission cannot. [G-ROUTE §5.2]

### 1.6 Reading other pools, and deployed addresses [01 §5, §10][G-L2 §4][G-ORACLE §1.4]

- `StateLibrary.getSlot0` is one `extsload` (2,375 gas in the v4-core snapshot) and can be called inside our callback. It returns
  **in-transaction state, which is manipulable**. `POOLS_SLOT = 6`.
- Price conversions:
  - native ETH (currency0) / USDC: `$/ETH = 1.0001^tick·1e12`, and ETH up means tick up;
  - mainnet v3 USDC(token0)/WETH is **flipped**;
  - Base and Arbitrum WETH/USDC have WETH as token0 and are not flipped.

  Always derive the orientation sign from the PoolKey at creation. [02 §7][05 §6.4]
- **`slot0.tick` can be `floor − 1`** after a zeroForOne swap that ends exactly on an initialised boundary (`Pool.sol:409-431`). It
  happened in 8 of 7,200 E2E blocks. Use `sqrtPriceX96` for S, and use the recorded tick for settlement. [03 §5.1][G-ORACLE §4.3]

| Contract | Ethereum | Base | Arbitrum One |
|---|---|---|---|
| PoolManager | `0x000000000004444c5dc75cB358380D2e3dE08A90` | `0x498581ff718922c3f8e6a244956af099b2652b2b` | `0x360e68faccca8ca495c1b759fd9eee466db9fb32` |
| UR 2.1.2 | `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85` | `0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40` | `0x2d01411773c8C24805306E89A41F7855C3c4Fe65` |
| V4Quoter | `0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203` | `0x0d5e0f971ed27fbff6c2837bf31316121532048d` | `0x3972c00f7ed4885e145823eb7c655375d275a1c5` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same | same |
| v3 5 bp oracle pool | `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` (token0 USDC, 723 obs, ≈ 7 h) | `0xd0b53D9277642d899DF5C87A3966A349A798F224` (token0 WETH, 5,000 obs, ≈ 26 h) | `0xC6962004f452bE9203591991D15f6b388e09E8D0` (token0 WETH, 9,000 obs, ≈ 47 h) |

**Protocol fee.** The July 2026 fee switch (Proposal 100) covers static no-hook pools, CCA pools and aggregator-hook pools. NoOp volume
never pays PM protocol fees. Whether routing reviewers expect a hook to honour `slot0.protocolFee` (as Uniswap's aggregator
`ProtocolFees.sol` does) is **UNVERIFIED**. [01 §6][G-ROUTE §5.1]

---

## 2. Oracle: S, σ and settlement

### 2.1 The landscape (verified live, 2026-09-25/26) [G-ORACLE §1][02 §6][G-L2 §1]

- **v4-core has no oracle.** The canonical ETH/USDC v4 pools are all hookless: mainnet 30 bp $44.6M, 5 bp $10.3M; Unichain 5 bp
  $20.1M; Arbitrum 5 bp $9.3M.
- **No hooked v4 ETH/USDC pool combines depth with a manipulation-resistant accumulator:**
  - Angstrom ($3.45M) has no observation storage;
  - BackGeoOracle has a v3-style ring but under $2k of TVL;
  - Bunni v2 shut down in October 2025.
- **Deep manipulation-resistant sources today are the v3 5 bp pools:**

  | pool | virtual USDC reserve y_v | ring span |
  |---|---|---|
  | mainnet | $155M | 7 h |
  | Base | $55–67M | 26 h |
  | Arbitrum | $163–169M | 47 h |

  Unichain v3 is too thin ($37k), so Unichain is excluded.

### 2.2 Options and verdicts

| Source for S | Verdict | Why |
|---|---|---|
| Live `slot0` of any pool (incl. inside the multi-hop) | **Never** | Push, trade and restore happen in one `unlock` for fees only, with zero capital (flash accounting). Break-even is about 390 binaries on v4 5 bp at 1-day ATM, and about $400 of notional at 1 h to expiry on a $100M, 5 bp pool. [02 §4.2][06 §5.2][05 §4.7] |
| First-touch snapshot in our hook, or a ring fed by our own trades or `poke` | **Rejected for S** | The attacker moves the underlying before touching us in the same unlock. Acceptable only as a fallback σ sampler (winsorised, rate-limited). [05 §4.7b][G-QUOTE C4/C5] |
| TWAP as the mid | **Rejected** | LP arbitrage loss relative to SoB is ×1.35 (2-block), ×2.8 (5), ×14 (25) and ×93 (150). A 30-min TWAP behaves like a 10-min lag. [G-QUOTE §1.1][05 §4.5] |
| **SoB price from an oracle hook on the underlying pool** (the hook writes the pre-swap price once per timestamp in `beforeSwap`) | **Adopted** | Epoch-constant and atomic-safe. Moving it requires holding the price across a block. [G-QUOTE §1.2][02 §1.4] |
| Short TWAP anchor as a worst-of overlay | Optional (`W_a = 0` default) | Never increases LVR. Multiplies manipulation-safe size by `W_a/Δt` only against attackers who control a single block close. **On both L2s m_a = 1** (sequencer, Timeboost, flashblocks), so the anchor adds nothing there. [G-QUOTE §1.3][G-L2 §3.3] |
| External (Chainlink, Pyth) | Bound check or fallback only | Not Uniswap-native. [02 §6.2] |

**Recommended architecture** [G-ORACLE §2]. One interface serves both proof paths:

```solidity
interface IUnderlyingOracle {
  struct FeedInfo { uint32 H; int8 sign; int16 decimalsShift; uint24 feeBandPips; uint16 ringSize; }
  function feedInfo(bytes32) external view returns (FeedInfo memory);
  function sobTick(bytes32) external view returns (int24 normTick, uint32 lastWriteTime);
  function sobSqrtPriceX96(bytes32) external view returns (uint160 sqrtPriceX96, bool exact); // raw orientation
  function cumulativeNow(bytes32) external view returns (int56 normCum);
  function cumulativeAtGrid(bytes32, uint32 grid) external view returns (int56 normCum);  // reverts if not retained
  function varianceE36(bytes32, uint32 nWindows) external view returns (uint256 varPerSecE36, uint32 gStart, uint32 gEnd, uint32 dN);
}
```

- **`VolOracleHookV2`** (local, v4-native, deployable):
  - one-slot observation: `ts`, `tick`, untruncated `tickCumulative`, `blockSq`, `windowSq`;
  - an SoB `sqrtPriceX96` slot;
  - an O(1) checkpoint ring `ckpt[g % 4096]` (14.2 days at H = 300);
  - a permissionless `poke`, and catch-up bounded by `maxCatchUp` = 12.

  Measured overhead on the underlying pool: **+27.6k gas** on the first swap in a block, +11.3k on later swaps, and +53.7k when a new
  checkpoint slot is written. Reads cost 5.8k–14k.
- **`V3ObserveAdapter`** (forks): the same statistics from v3 `tickCumulative` via `poke()`. Its SoB `sqrtPriceX96` is the half-tick
  midpoint (`exact = false`, ≤ 0.5 bp) once the tick has changed in the block.
- **The virtual-write SoB rule**: `sob = (oracle.sobTs == block.timestamp) ? oracle.sobSqrtP : slot0.sqrtPriceX96`. This is safe
  because in v4 only `Pool.swap` moves the price, and every swap runs the oracle's `beforeSwap` first. [G-QUOTE §1.2]
- **Epoch key = `block.timestamp`, never `block.number`.**
  - On Arbitrum, `block.number` is the L1 number (every ≈ 15.5 s), and about 4 L2 blocks share each timestamp.
  - A key finer than the oracle's costs ×1.92 extraction; a coarser one ×1.76.

  [G-QUOTE §6.2][G-L2 §3.2]

### 2.3 σ estimator (one spec) [G-ORACLE §3][G-SPEC §1 row 8][G-L2 §2.5]

```
Grid:      H = 300 s, unix-aligned; D_g = cum(gH) − cum((g−1)H)      (exact integer, tick·s)
Return:    r_g = clamp(D_g − D_{g−1}, ±cap·H)                       (TWAP-return; winsorised)
Accum:     Q += r_g², n += 1   (O(1) per write; checkpointed per grid)
Raw var:   v_raw = 3·LN_TICK_SQ_E36·ΔQ / (2·H³·Δn)   per second, 1e36 scale
           LN_TICK_SQ_E36 = 9999000091658334094374450926   (ln(1.0001)²·1e36, rounded; floor …925)
Bias:      v = v_raw + β,  β = c·γ²/H   (γ = source fee band)
Clamp:     σ ∈ [0.20, 2.50]  →  v ∈ [1.2684e27, 1.9819e29] (E36)
Live read: EWMA with a 1-day half-life of the per-window squared differences; read with the virtual-write rule (epoch-constant)
Guard:     halt creation and quotes if v_1d/v_3d ∉ [0.25, 4]  or  dN < 0.9·nWindows
```

- **Why TWAP-return RV.**
  - Per-block RV is biased about −25% (72% of block returns are 0).
  - Point sampling at 5 min is biased −13% (σ = 0.5) or −7% (σ = 0.8) on a 5 bp pool.
  - TWAP-return sampling reduces the bias 3–10×, and it is about `(2/3)·H/Δb` times costlier to inflate: 17× on L1.
  - Precision: SE(σ̂)/σ = √(1.125/(2n)), i.e. 2.55% over 3 days, with a calibrated χ²(ν = n/1.125) interval (95.2–96.0% coverage).

  [02 §3][G-ORACLE §3–4]
- **Live σ, not fixed at creation.** Fixing σ at creation ("mode A") gives D\*_OOS = ∞: a trader using the live 1-day EWMA extracts
  0.25–0.33 B per series. Freshness matters, not the estimator. Keep mode A only for deterministic unit tests. [G-SPEC §4.1]
- **No volatility multiplier and no DVOL-as-σ.** A binary's vega changes sign at d1 = 0, so a markup mis-prices one side. Backtest:
  D\* rises from 67 to 180–336 per day at 1 h. Charge model risk through the spread. [G-ECON §6.2][G-ORACLE §3.3]
- **Scheduled event variance** (v1.1). A governance or keeper constant is added for scheduled releases: CPI 4.3e-4, FOMC 5.5e-4, set
  per event class. Pair it with a ±5-min quote halt around each release, which removes event-day latency loss. [G-REAL §5–6]

### 2.4 Settlement (one rule) [G-SETTLE][G-SPEC][G-VAULT §6]

- **Statistic.** The time average of the source pool's integer tick over `[T−w, T]`: `D = cum(T) − cum(T−w)`. This is a discrete
  geometric TWAP with left-endpoint samples.
  - Spot at T is 60–300× cheaper to move than a 30-min TWAP.
  - Precedents: Deribit (30-min TWAP) and CF BRR (1 h). Polymarket moved to TWAP settlement after a reported $8.2M manipulation episode
    (secondary source).
- **Strict integer rule with a half-tick threshold.** κ is the real log-tick of the strike in the pool's own orientation:
  - up orientation: **YES ⇔ `D > floor(w·(κ − ½))`**;
  - flipped orientation: **YES ⇔ `D < ceil(w·(κ − ½))`**;
  - a tie is possible only when `w(κ − ½)` is an integer, and it resolves **NO**.
  - For K = $5,000 and w = 1800 s the thresholds are −344,067,005 (up) and +344,065,205 (v3).
  - The half-tick term makes the effective strike equal K on average. Without it the ATM price is biased −0.73¢; with 02's
    `ceil(κ)·w` rule, −1.95¢.
  - Store `sqrtPriceX96_K`, compute and store the threshold at creation, and emit it.
- **Window and cutoff.** For 1-day markets use **w = 4 h** (n = 1,200 samples on L1 at 12 s). Trading stops at **T − w − b**, with
  b ≥ 5 min (245 min before T).
  - No trading inside the window: with ≤ 10 samples left, the attacker controls the outcome.
  - Mint, merge and redeem stay open after the cutoff.
- **Data availability.** At `settle`, copy `cumulativeAtGrid(T−w)` and `cumulativeAtGrid(T)` into storage. Align T and T − w to the
  H grid, and have keepers `poke` at T. Fallbacks:
  1. **depth check:** window harmonic liquidity must be ≥ 0.5 × L at creation (needs a `secondsPerLiquidityCumulative` accumulator,
     which OZ's `Observation` lacks);
  2. **secondary source**, fixed at creation;
  3. **mark at cutoff** `P_cut`, which is solvent under complete sets;
  4. **INVALID** after GRACE (for example 7 days): permissionless 50/50 payout, the CTF `[1,1]` precedent.

  No swaps in the window is **not** a failure, because `cum(T)` extrapolates exactly. [G-SETTLE §5][G-VAULT §6]
- **Chain quirks.**
  - Base timestamps are exactly `1,686,789,347 + 2n`, i.e. odd. A grid-aligned T is interpolated exactly but has half-weight edge
    samples; the effect is negligible.
  - On Arbitrum, compare `Δts` with `12·ΔL1(block.number)` at the checkpoints to detect the sequencer's allowed +768 s timestamp jump.
  - Check the Chainlink L2 sequencer-uptime feed around the window. Arbitrum:
    `0xFdB631F5EE196F0ed6FAa767959853A9F217697D`; Base: `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`. [G-L2 §3.4]
- **Do not settle on a median of pools** that includes the 30 bp pool: it is cheap to move and badly mis-priced (±9–10¢). A
  cost-weighted mean of v3 5 bp and 1 bp gives about 1.5× the cap. [G-SETTLE §3.3]

---

## 3. Math

### 3.1 Libraries and CDF [03][05 §2][G-FV][G-KERNEL]

- **Fixed-point library: Solady `FixedPointMathLib` v0.1.26 (`2afba69`).** Measured gas: `lnWad` 580 (≈ 1e-18 absolute error),
  `expWad` 463 (returns 0 for x ≤ −41.4465e18), `sqrt` (floor, 7 Babylonian steps) 460. MIT, cancun-compatible.
  - PRBMath v4.2 is 5–10× more gas (`ln` 6.4k).
  - ABDK 64.64 is BSD-4 licensed with a narrow range.
  - DeFiMath needs osaka/CLZ and solc ≥ 0.8.31, which clashes with the exact `pragma 0.8.26` in `PoolManager.sol`, and it is unaudited.
  - Solady `expWad` and `lnWad` are **not in any parsed audit scope** (UNVERIFIED as exhaustive). [03 §2]
- **CDF: HartX36.** This is the Hart 1968 #5666 / West 2005 rational with every Horner coefficient scaled by 1e18, so the accumulators
  carry 36 decimals (`gaps/formal-verification-scripts/halmos/src/HartTail36.sol`).
  - Max error 42 wei (**4.2e-17**); 1,309 gas unchecked.
  - `Φ̂(x) = x ≤ 0 ? tail(−x) : 1e18 − tail(x)`, with the tail clamped to ≤ ½, so **`Φ̂(x) + Φ̂(−x) = 1e18` exactly**.
  - Saturate at |x| ≥ 9 (Φ(−9) = 1.13e-19). Guard `x == int256.min`: the unchecked negation currently returns 0.5.
  - **It is proven monotone** by a computer-assisted certificate (exact rational intervals plus Sturm counts): `ratio_cert36.py`,
    `expwad_cert.py`, `expwad_err.py`, `expwad_kcheck.py`.
  - **The plain WAD Hart port in 05 and 03 is not monotone.** It has 61 one-wei up-ticks on z ∈ [5.05, 7.03], 54 of them confirmed on
    the EVM. 2M fuzz runs miss them. [G-FV §2–3]
- **Alternatives and anti-patterns.**
  - Cody (CALERF), 1.7e-18, 1,028 gas: fix the constant `Q1 = 1872952849923460470`; both our copy and Equinox carry a typo.
  - **Never** solstat: it drops 3.0e-8 across d = 0 and has 4.15e-8 error.
  - Never Premia v3 (6.6e-7, 36.6k gas), RMM-core (uses a₃ = √2, error 3.6e-3; its own Echidna reference shares the bug), Choudhury
    (1.4e-4) or Thales (coefficient typo, 1e-5 error, **missing −σ²τ/2**).
  - Lesson: **differential-test against an independent 60-digit mpmath reference**, never against a re-implementation that shares the
    constants. [03 §3–4][04 §1.3][05 §2.3]
- **Optional fat-tailed kernels** (variance-matched Student-t, argument d the same as BS):
  - ν = 4: `F = ½ + d(d²+3)/(2(d²+2)^{3/2})`, `f = 3/(d²+2)^{5/2}`. Algebraic; `cdf4hp` 829 gas, ≤ 1e-18.
  - ν = 5 needs `atan`, which Solady and PRB lack; `cdf5` with a custom `atan36` costs 1,390 gas.
  - ν = 6 is algebraic, 814 gas.
  - The formula for ν = 4 in the original gap statement was missing a factor ½. [G-KERNEL §4]

### 3.2 Formula chain: from ticks to price (r = 0) [03 §5][G-QUOTE §2][G-SETTLE §4.4][G-SPEC §1–2][G-FV §4.3]

```
Constants:  LN_OFFSET      = −25095597659861927392                  (ln(1e18) − 96·ln2, WAD)
            LN_1_0001_E36  =  99995000333308335333166680951131      (ln(1.0001)·1e36, floor)
            YEAR           =  31,536,000 s (365 d)
Spot:       x   = s_o · 2·(lnWad(sobSqrtPriceX96) + LN_OFFSET)          (WAD; ≤2.6e-18; ≈878 gas; no tick flooring)
Strike:     lnK = s_o · 2·(lnWad(sqrtPriceX96_K) + LN_OFFSET)           (the stored sqrtPriceX96_K is the canonical strike)
TWAP (anchor/fork): lnP = Δcum·LN_1_0001_E36/(dt·1e18) (+½ tick if tick-floored); never int24 floor division
Variance:   σ²_s = varE36 (per second, 1e36 scale)                     (NEVER per-second variance in WAD: 8.8e-11 rel. → 1e-11 price error)
Asian (τ ≥ w, n = w/Δ samples, Δ = oracle sample spacing):
            a = ½·σ²_s·(τ − w + (n−1)Δ/2)
            v = σ²_s·[(τ − w) + Δ(n−1)(2n−1)/(6n)]                    (dimensionless; → σ²(τ − 2w/3) as n → ∞)
            d = (x − lnK − a)/√v ;   P = Φ̂(d) ;   NO = 1e18 − P
European fallback (spot settlement only): w = σ²_s·τ, d2 = (x − lnK − w/2)/√w
Guards:     w or v == 0 → step function; |d| ≥ 9 → 0/1; τ < τ_min → halt
```

- **Why the Asian form is mandatory.** The European N(d2) is off by up to **11.5¢ at the cutoff** (τ = 245 min, w = 4 h), 4.9¢ for a
  1 h market with w = 30 min, and 1.45¢ at listing for 1 day. The ATM mid is almost unchanged; the error is a delta/variance effect off
  the money.
- **Validation of the discrete formula.** Monte Carlo through the oracle's own floor-tick sampling matches it to within 1 SE at
  f = 0, and to ≤ 0.5¢ on a 5 bp band-follower pool at the cutoff. Do not use 30 bp pools as sources (error ±9¢). [G-SETTLE §4.4]
- **Spread term.** `g± = P ± k·φ(d)` with `k = c_Δ·γ_S/√v` and `γ_S = γ₀ + c_lag·σ√Δt`.
  - γ₀ = pool fee + 0.5 bp; c_Δ = 1; c_lag = 0.8.
  - Measured SoB error SD: L1 4.9 bp, Base 3.5 bp, Arbitrum 3.0 bp.
  - **In integers, compute it factored with a single final rounding**: for d > 0, `1 − g⁺ = e(d)·(R(d) − κ)` with κ = k/√(2π).
    The naive `Φ̂ + ⌊kφ̂⌋` has 1-wei drops in 0.4–9% of steps. [G-FV §4.3][G-L2 §1.2]

### 3.3 Error budget [03 §6][05 §2.2–2.3]

| Source | Size |
|---|---|
| Numerical, core `(x, w)` | measured 8.2e-16; analytic bound ≲ 3e-13 for √w ≥ 1e-5 |
| Numerical, pool path (`sqrtPriceX96` → price) | measured 2.7e-16 |
| Numerical, full quote on revm | measured 9.3e-17 |
| Numerical, spot/strike inputs with 2 `lnWad`s | measured 1.1e-14 |
| **Target** | **\|P̂ − P_ref\| ≤ 1e-12** absolute per $1, which is 1 USDC unit per $1M; met with about 100× margin |
| **Quote ε** (added to ask, subtracted from bid) | 1e-13 default; 1e-15 is enough on the native paths |
| Input: 1 tick of S | up to 4.8¢ at 1 min to expiry; 1.3e-3 at 1 d (σ = 60%) |
| Input: σ ±10% | up to 2.3–3.1¢ at any tenor |
| Input: one 12 s block of time decay | up to 2.7¢ at 1 min |
| Input: σ̂ sampling error (3 d window) | about 0.6¢ on a 5%-OTM 1-day binary |
| Model: Asian vs European | up to 11.5¢ at the cutoff |
| Model: fat tails at ≤ 4 h | 7–9 pp |
| Model: skew | ∓0.6 pp at 1 d |
| Model: jumps (Merton) | about 1–1.5¢ |

- **Conclusion: numerical error is 10¹⁰–10¹⁴ times smaller than input and model error.** Precision matters only for exact proofs
  (monotonicity, parity, rounding direction). Economic risk is handled by spread, caps, cutoff and σ policy.
- **Theorem A (error propagation).** `|P̂ − P| ≤ ε_Φ + ε_d/√(2π) + 1 ulp`. [05 §2.2]

### 3.4 Amount solvers: exact integers [G-QUOTE §2.3, §3.3][G-FV §4.1]

- **Setup.** One signed impact variable I per market, **shared by the YES and NO pools**. YES buys and NO sells increase it. It
  resets when `epoch.ts ≠ block.timestamp`, stored in one slot as `{uint40 ts; int104 I; int112 E}`.
- **Marginal YES prices.** ask `a + Λx/1e6`, bid `b + Λx/1e6`. NO is the mirror: `ask_N(x) = 1 − bid_Y(x)`, `bid_N(x) = 1 − ask_Y(x)`.
- **Closed forms.** With `D = 2·10²⁴` and `β = 2·10⁶·price + 2Λ·I₀`:
  - buy exact-out: `cost = ⌈(Λq² + βq)/D⌉`;
  - buy exact-in: `q = ⌊(isqrt(β² + 4ΛAD) − β)/(2Λ)⌋`;
  - sell exact-in: `proceeds = ⌊(βq − Λq²)/D⌋`;
  - sell exact-out: `q = ⌈(β − isqrt(β² − 4ΛAD))/(2Λ)⌉`.
- **Lemma S.** Floor `isqrt` on the exact-integer discriminant gives the maximal (buy) or minimal (sell) q with no fix-up loop.
  - z3 proves it over unbounded integers. **The sell side needs the band precondition `2Λq ≤ β`**; without it there is a real
    counterexample (Λ = 55,778, b = 0.01002, A = 9e14 pays 1 unit more than the curve allows).
  - A WAD port that divides before the square root over-delivers in 7 of 60,000 cases.
  - Solver gas: 1.1–1.9k each.

---

## 4. Properties to prove, and how

**The organising principle.** Arithmetic truths go to integer models (z3/NIA) or exact certificates. Bookkeeping truths go to Halmos
inductive steps plus Foundry stateful campaigns through the real PoolManager. Statistical and economic claims stay in Python, and a
trade-tape replay links Python's accounting to the contract's. [G-FV §5.2][G-ECON §9]

### 4.1 Real-number model: paper proofs [05 §1–2][G-FV §7]

| ID | Statement | Method |
|---|---|---|
| T1–T8 | Range; parity `YES + NO = e^{−r_cτ}` (= 1 with r_c = 0); strict monotonicity (∂P/∂S > 0, ∂P/∂K < 0); homogeneity; vega and theta signs flip at d1 = 0; limits; Lipschitz `\|∂P/∂lnS\| ≤ 1/(σ√(2πτ))` | 1-page Greeks; finite-difference checks already at 1e-19 (`05-math-scripts/01`) |
| T9 | The discounted YES price is a Q-martingale; **QV identity `Σ E[ΔP²] = P₀(1−P₀) ≤ ¼`**, model-free | ½ page (orthogonal increments, P_N² = P_N). Optional Lean (1–2 weeks). This is the basis of every LVR bound. |
| Asian | The geometric mean of GBM is Gaussian with variance σ²(τ − 2w/3) (Kemna–Vorst); the discrete left-endpoint form; the in-window form | Paper plus MC (already done: exact at f = 0) |
| RV | `E[σ̂²] = σ² + m²ΣΔ²/W`; unbiased under stopping-time sampling (Wald) with fixed endpoints; ×3/2 for TWAP-return | Paper plus χ² coverage MC |
| Lemma M | The band halt makes the quote monotone for any k. Requires Gordon's inequality `1 − Φ(x) < φ(x)/x`, which must be proved, not just cited. For Student-t the replacement is Lemma M_t: globally monotone if k ≤ 2√(ν−2)/(ν+1) (0.566 for ν = 4); numeric beyond that. | 5-line calculus |
| Theorem L | Per epoch, extraction ≤ `((|F − P_sob| − h₀)⁺)²/(2λ)` and ≤ `Q_epoch·(…)`. Summed, **E[total] ≤ ℓ·P₀(1−P₀)/2**, independent of the number of epochs. Needs reset **at the oracle epoch** and **one shared I**. | Paper; relies on E2 (machine-checked) |
| Theorem D | Any ε-accurate approximation is 2ε-monotone | ½ page |

**The r_c = 0 argument.** Complete sets redeem at par, so `YES + NO` must equal 1. If `YES + NO = e^{−rτ} < 1`, anyone buys both legs and
redeems at a profit. Carry b may enter only through the forward. [05 §1.1]

### 4.2 Numerical kernel: certificates plus differential tests [03 §8][G-FV §3][G-ECON §9]

- **Accuracy.** ≥ 25k mpmath vectors at 60 digits, stored at 1e24 scale in ABI-encoded `.bin` files read with `vm.readFileBinary`
  (no FFI in CI), with **`assertLe(maxErr, ε)`**. The prototypes only logged the error. Inputs: grid [−10, 10], branch seams, Uniswap
  extremes (MIN/MAX sqrt price), and near-expiry ATM.
- **HartX36 monotonicity certificate in CI.** Plus the Solidity-vs-Python bit-exact test on 2,004 points, and the 54 known WAD
  counterexamples as regression tests. The `lnWad` monotonicity certificate is not yet run (TODO).
- **Symmetry and edges.** Exact symmetry; saturation; the `int256.min` case; Cody constants diffed mechanically against netlib.
- **Historical vectors.** `gaps/economic-backtest/out/quote_vectors.json`: 2,400 historical-state vectors at 1e-12 tolerance.
- **Nightly `vm.ffi` fuzz** against mpmath: ≥ 1e5 runs, opt-in.

### 4.3 Quote integer properties [G-QUOTE §5][G-FV §4]

These are machine-proved in z3 NIA in 0.03–2 s each (`gaps/formal-verification-scripts/py/z3_integer_lemmas.py`):

- Lemma A (additivity);
- Lemma S (with the band precondition);
- Theorem N (no split advantage, all 4 kinds, NO pools by mirroring);
- **E1**: `bid_Y + bid_N ≤ 1 ≤ ask_Y + ask_N` at every impact state, after rounding. It holds because the NO quotes are mirrors of the
  YES quotes; separate YES/NO impact states give **+1.30 USDC** free per 100 sets;
- **E2**: a same-epoch round trip loses at least `2h₀q`.

**E4 (monotone in S)** needs three things: HartX36; the factored `g±`; and the gamma term *inside* the max/min (outside it: 398
violations in 11,562 checks). Re-run fuzz F7 against the **integer** Solidity quote, not mpmath.

**Model-to-bytecode refinement.** Use Halmos where the arithmetic is linear. For the rest, use a paper lemma for Solady `sqrt`
floor-correctness plus an exhaustive check for x < 2¹⁶, and fuzzing: Halmos times out on `sqrt`, `mulDiv` and `expWad`.

### 4.4 Accounting and solvency [G-SWAP §5–6][G-VAULT §7][G-FV §5–6][05 §3]

- **VCS invariants** (per market; bijective with 05's complete-set model, so I1–I7 transfer):
  - S1: `outY == YES.totalSupply − invY`;
  - S2: `invY == PM.balanceOf(hook, YES.id)`;
  - **S3: `B_m ≥ max(outY, outN)`** while trading, and `≥ out_winner` after resolution;
  - S4: `Σ B_m + idle == PM.balanceOf(hook, USDC.id)`;
  - S5: the PM's physical ERC-20 ≥ claims;
  - S6: `min(C − outY, C − outN) == 0`;
  - S7: the prediction pool's `slot0` never changes;
  - S8: `NonzeroDeltaCount == 0` after every router call;
  - T (terminal): after resolve, redeem-all and claim-all, the PM holds 0 USDC, supplies are 0, and Σ agent cash equals the initial
    total.

  Use `≤`/`≥` in production, because third parties can donate claims.
- **Series/vault invariants V1–V16**, notably:
  - V5, the exact ladder: `min_j W_j ≥ D − B_s`;
  - V8, share-price monotonicity with sequential pro-rata;
  - V10, conservation (LP P&L = −trader P&L);
  - V11, isolation between series;
  - V16, liveness: `redeem` and `claim` work with the pause on and the oracle dead.
- **Proof status:**
  - Halmos proves S3/S4 inductively over all 8 swap cases plus split, merge, fund, defund, resolve and redeem, including with the real
    `FullMath` (573 paths, 7.6 s);
  - a bounded **end-to-end** Halmos single swap through the real PM and PoolSwapTest passes (791 paths, 176 s);
  - ladder-prefix = brute force is proved by Halmos for n ≤ 4, plus a 3-line induction.
- **Mutation tests.** Removing the solvency post-check (M1) and double-spending inventory (M3) are caught within 100 runs. A
  trader-favourable rounding mutant (M2) is **not** caught by solvency, which is correct because solvency is price-independent (I7).
  Rounding therefore needs the separate round-trip and no-split properties.
- **Solvency is price-independent (I7).** Proofs never need the Black–Scholes math. Fuzz with arbitrary re-pricing.
- **Per-market loss bound.** `U₀ − U ≤ B_m` means LP loss ≤ B_m in every outcome.

### 4.5 v4 integration and routing (Foundry, fresh PM plus forks) [01 §11][G-SWAP][G-ROUTE §7][06 §7]

- The delta table (8 cases × 2 orderings) through PoolSwapTest, periphery `MockV4Router` and **deployed UR 2.1.2 on a fork**.
- V4Quoter equals execution in the same block, for single and multi-hop, and for split and merge `hookData`.
- `slot0` and L never change.
- A fresh PM with zero balances.
- Direct callback calls revert with `NotPoolManager`. Foreign `initialize` reverts with `WrappedError`.
- Halts are byte-exact at the quoter and at UR. `EXECUTE_SUB_PLAN|0x80` makes a halted leg soft.
- ETH → USDC → YES in one `V4_SWAP` is priced at SoB. In the fork run, hop 1 moved S by −17.9%; live-spot pricing would have given
  10.8% more YES.
- YES → USDC → NO gives no profit.
- A 5-field (UR v2.0) encoding against our pool reverts with no data.
- Sync-interleaving (T23) tests: a pre-sync router fails closed on the mint path and works on the inventory path.

### 4.6 Oracle, settlement and manipulation [G-ORACLE §4][G-SETTLE §7][G-SPEC §6]

- **Oracle accumulators vs a brute-force reference.** Fuzzed paths, caps binding, multi-window gaps, ring wrap-around, OZ
  `tickCumulative` differential, and 6/6 mutants killed. Already built: 13 tests.
- **Same-block manipulation invariance** of every read.
- **χ² calibration** of σ̂ on replayed GBM and band-follower paths, bit-exact against Python.
- **Settlement.** Thresholds vs mpmath; tie → NO; both orientations; the `tickNext − 1` quirk; half-tick unbiasedness (MC); every
  fallback (ring overwritten, no swaps, depth drop, INVALID pays exactly ½ per token).
- **Manipulation.**
  - **"Attacker PnL ≤ 0" cannot hold.** In-band cost is quadratic, `C(δ) ≈ k_w·δ²`, so any exposure Δ_G yields a profit of
    `Δ_G²/(4k_w) > 0`.
  - **Provable replacement (M1):** with gross window OI ≤ Q_safe, attacker profit ≤ spread paid.
  - **Plus M2:** a statistical bound on expected extraction.
  - **Atomic attack** (push, trade, restore in one unlock): P&L ≤ 0, provable because the quote is invariant to same-epoch underlying
    swaps.
  - **Block-close attack** with the cap at `m_a·q_safe`: P&L ≤ 0 net of fees in the simulation.

### 4.7 Statistical and economic claims [G-ECON §1][05 §7][G-REAL §7]

- **M-claims (unconditional).**
  - M1 solvency;
  - M2 Python ledger = on-chain ledger, ≤ 1 wei per trade, by tape replay;
  - M3 quote fidelity;
  - **M4 calibration under Q**: ≥ 200k independent quotes; Hosmer–Lemeshow with **df = 10** (not 8), p > 0.01; |Spiegelhalter Z| <
    2.58; |calibration-in-the-large| < 2.58; deciles within 3 SE; and a power check that must reject a mis-specified σ;
  - M5 simulator validation: the latency LVR matches the semi-analytic value to 0.02 SE;
  - M6 manipulation bound.
- **E-claims (conditional).** Every claim states: tenor, chain block time, declared noise turnover D, the adversary set, and
  parameters frozen in-sample.

  | ID | Claim |
  |---|---|
  | E1 | Economic calibration: ECE ≤ s |
  | E2 | D\* ≤ D_decl |
  | E3 | LP profitable at 95% (one-sided moving-block bootstrap, 4-week blocks) |
  | E4 | Weekly CVaR95 ≤ 2% NAV, CVaR99 ≤ 4%, max drawdown ≤ 10%, no negative calendar year |
  | E5 | Disclosure of the clairvoyant-vol stress |
  | E6 | Dominance over CPMM, LMSR and pm-AMM |
  | E7a/b/c | Tape accounting / quote fidelity / flow envelope |

- **Sample sizes.** 1 pp calibration bins need ≈ 19.6k per bin. LP P&L to ±10% needs `(1.96·CV/0.1)²` paths. Use common random
  numbers and paired CIs.
- **History has little power at 1 d:** about 100 quotes per bin, so it certifies only ≈ 12 pp. [05 §7.5][G-ECON §9]

---

## 5. Economics, prior-art lessons and required risk controls

### 5.1 Prior art [04][G-REAL]

- **Thales Positional AMM** is the closest precedent: BS odds, UP/DOWN tokens, one LP vault.
  - Parameters: 3% spread, skew up to 15%, 2% protocol fee, band [0.08, 0.95], **24 h cutoff**, per-market caps of $1–5k.
  - LP result: cumulative **0.8615 (−13.9%)** over 80 rounds, maximum drawdown 22.8%. That is statistically ≈ 0 (t = −0.66).
  - The tape rebuild reproduces it (−14.8%, per-round correlation 0.961).
  - **Attribution:** the model edge at mid was −$342k (t = −4.3), mostly spread-recovered. It came from **directional, net-long flow**
    in a bull market and **IV set about 17% below the same-expiry Deribit smile**. Smile-selected trades cost −$98k.
  - **Fee-exempt internal routers** (RangedMarketsAMM at a 0.5% spread) cost −$100.6k, more than the whole net loss.
  - **No latency signature** was found, and jumps explain only 17% of the loss.
  - Lesson: **never exempt any address from the model-risk spread.**
- **Lyra v1** lost in 6 of its first 8 rounds. Round 8 lost $1.58M, mostly to unhedged delta. Useful templates: 12 h cutoff,
  worst-of spot per direction, 1.5% circuit breaker, GWAV NAV, queued LP.
- **Buffer.** BLP fell 1.11 → 0.85 because of a large maximum trade size relative to the pool; Buffer moved to protocol-owned
  liquidity.
- **Polymarket.** Taker fee `0.07·p(1−p)`; 15-minute markets drew latency bots; TWAP settlement after the $8.2M reported
  manipulation (secondary sources).
- **Reserve AMMs** lose 27–62% of pool value per market to one informed class: LMSR 27–29%, dynamic pm-AMM 39–45% (theory: LVR
  V₀/(2T), losing ½), CPMM 55–62%. The hook's realistic extraction against the same agents is ≈ 0, so **E6 holds by ≥ 10×.**
  [G-ECON §6.6]
- **Oracle-free alternative.** An RMM-01 split share replicates the BS digital (Angeris–Evans–Chitra §2.3). Keep it as a benchmark,
  not the design. [04 §4.2]
- **Novelty.** No surveyed hook prices binaries by BS through v4 swaps with LP underwriting (absence UNVERIFIED). [04 §7]

### 5.2 Required controls, with numbers

| Control | Value | Evidence |
|---|---|---|
| Tenor | **1 day** (v1). 7 d out of scope (drift 3–8 pp exceeds any sane spread; IV-flow extraction 0.13–0.18 B OOS). ≤ 4 h is research (needs t4 plus L2). | [G-ECON §6.3][G-REAL §4.2][G-KERNEL §3] |
| Base half-spread h₀ | **≥ 2¢** (G-SPEC frozen); **3¢** with inventory skew κ (G-REAL v1.1). 0.3–1¢ fails OOS in 19/20 Gaussian cells. | [G-SPEC §4.2][G-REAL §6.4] |
| Gamma term | `k·φ(d)`, k = c_Δ·γ_S/√v, c_Δ = 1. ATM L1 5 bp: 1.21¢ at 24 h, 2.42¢ at 8 h, 4.69¢ at the cutoff. Shaping the spread this way cuts LVR 6.7× vs a flat spread of equal average. | [G-QUOTE §4][G-SPEC §2.1] |
| Per-block impact λ | Linear, **reset each epoch**, one shared I. λB = 0.1 (Gaussian, L1) to 0.5 (t, both chains) per block. Decaying impact is 1.5–3× worse; a per-second reset on L1 is 10× worse. Budget depth **per unit time**, not per transaction. | [G-ECON §6.4][G-SPEC §4.2][G-L2 §2.4] |
| Per-epoch cap | `Q_epoch = m_a·c·√v/P′`, with **m_a = 1** on L2 and against builders. 1-day ATM q_safe per epoch: v4 5 bp mainnet 433 tokens, v3 5 bp mainnet 6,085. Sim E: capped max profit $0 vs uncapped $11–12k. | [G-QUOTE §7.2][G-L2 §2.4] |
| Persistent inventory skew κ | **Contested.** κ = 0.10 (mid moves 10¢ per budget of vault inventory) fixes persistent-belief extraction: D\* 4.5 → 1.1, CVaR95 18% → 1.4%. It costs −0.0105 B/market in latency and invites skew harvesting at D = 5. See §7. | [G-REAL §6] vs [G-QUOTE §3.1] |
| Price band | p_min = 0.02, **halt, never clamp**. A clamp hands buyers +2¢/token every epoch. Every executed marginal price must also be in band. | [G-QUOTE §4] |
| Cutoff | **T − w − b** (245 min with w = 4 h, b = 5 min). "10% of tenor" is illegal when w = 4 h. Extra cutoffs never helped OOS. | [G-SETTLE §6][G-SPEC §4.2] |
| Event handling | ±5 min halt around CPI/FOMC; event variance added to σ. | [G-REAL §6.2] |
| LP budget | B = $20k per market (1% NAV); series B_s = 3B, exact ladder `min_j W_j ≥ D − B_s`, O(n), ≈ 5.44k gas per strike. B = $50k fails robustness. Per-strike flip cap `|invY_j − invN_j| ≤ F_max`. | [G-SPEC §1][G-VAULT §5] |
| Settlement OI cap | Delta-weighted gross OI ≤ **Q_safe = 8π·h₀·k_w·v_cut**, with `k_w = κ_in·n_w·y_v` and y_v from trailing harmonic liquidity. κ_in: L1 0.10 per 12 s slot, Base 0.03 per 2 s, Arbitrum 0.015 per 1 s. Binary w = 4 h at 1¢: L1 $249k, Base $151k, Arbitrum $487k (at 2¢, double). w = 30 min: $4–12k, so **unfinanceable**. | [G-SETTLE §3][G-L2 §2.4][G-SPEC §5] |
| Oracle deviation breaker | Halt if \|x_sob − x_anchor\| > 1–1.5% (Lyra 1.5%). | [G-QUOTE §2.1][04 §3.5] |
| LP structure | Series tranche, 1:1 subscription, **locked until finalize**. NAV is needed only when it is pure cash. At τ = 1 h a 0.5% push moves a mark-to-model NAV by 6.2% for $25–250 of fees. Sequential pro-rata `claim` is exact, dust-free and Bunni-safe. v2 rolling ERC-4626 uses NAV⁺/NAV⁻ (including the σ* interior maximum) and `_decimalsOffset = 6`. | [G-VAULT §2–6] |
| Spread exemptions | **None.** Add an invariant: no address-based spread discount. | [G-REAL §4.3] |
| Hedging | None inside swaps. Near expiry it is infeasible (62× notional at 1 h). | [04 §9.9] |

### 5.3 Economic results to plan around (all conditional; "B" = per-market budget)

- **Frozen v1 spec, strict accounting, M2 manipulation charge, OOS 2024-01 → 2026-09.**
  - L1: **D\* ≈ 0.68/day**; at D = 2 the vault returns +102%/yr (95% lower bound), weekly CVaR95 1.39%, max drawdown 4.8%, every year
    positive.
  - L2 (Base): D\* ≈ 0.76, but it **fails the E4 CVaR bounds**.
  - Latency is LP-positive at 245-min cutoff and w = 4 h.
  - E5 (perfect vol foresight) **fails**; disclose it.

  [G-SPEC §0, §4.5]
- **Extended adversaries** (jump, jump_ev, smile) at the older v1 (s = 2%, λB = 0.1, κ = 0): D\*_OOS rises 1.45 → 4.5/day and E4 fails
  by 10×.
  - With **κ = 0.10, s = 3%, event-aware σ**: D\* = 1.10, the 95% lower bound at D = 2 is +65%/yr, CVaR95 1.4%, max drawdown 2.5%,
    D\*_stress 1.55.
  - This passes only for **D ≤ 2** until a joint-agent simulation exists. [G-REAL §6]
- **Market size.** At w = 4 h the LP budget binds first. It fills about $216k (D = 2) to $487k (D = 5) of payout tokens per 7-strike
  series per day, against Polymarket's median of $366k/day per 11-strike ETH event. [G-SPEC §5]
- **Gas cost per swap** (integrated, 180–300k gas): Arbitrum $0.010–0.017, Base $0.003–0.0045, L1 $0.40–0.66. [G-L2 §5]

---

## 6. Security threat model (summary) [06 §6][G-VAULT §8][G-L2 §3][G-ROUTE]

- **Risk tier.** High on the Uniswap Foundation Hook Security Framework (self-score ≈ 23–24 of 33). That tier requires two audits, one
  by a math and invariants specialist, a bug bounty, invariant fuzzing and monitoring. [06 §8]
- **Precedents.**
  - Cork, about $11M: no `onlyPoolManager` on `beforeSwap`, crafted `hookData`, no pool validation, near-expiry formula blow-up.
  - Bunni v2, $8.4M: wrong rounding direction amplified by flash-loan pushes and 44 micro-withdrawals.

| Class | Threat IDs | Mitigation (proof item) |
|---|---|---|
| Access | T1 direct callback; T4 `unlockCallback` spoof | OZ `BaseHook` `onlyPoolManager`; enum-tagged internal unlock payloads; selector allowlist meta-test |
| Pool set | T2 foreign init; T3 untrusted PoolKey or `hookData` | self-init plus `beforeInitialize` revert; public API takes `marketId`; `_beforeSwap` requires a registered market; `hookData` ignored except the split/merge modes |
| Delta and rounding | T5 sign, scale or partial fill; T6 rounding; T22 CL fall-through | canonical orientation helper; `spec == −amountSpecified` assert; floor out, ceil in, revert on 0; `slot0`-unchanged invariant; round-trip ≤ 0 and no-split fuzz |
| Cross-outcome arbitrage | T7 `ask_Y + ask_N < 1` or `bid_Y + bid_N > 1` | mirrored NO quotes and one shared I (E1, z3-proved); mint/merge loop fuzz |
| Oracle | T8 atomic spot; T9 multi-block/sequencer; T11 σ manipulation; T12 settlement push; T14 oracle unavailable | SoB via pool-attached oracle; per-epoch cap; w = 4 h; Q_safe; σ clamp, rate limit and regime guard; fallback chain; **declared trusted-sequencer assumption on L2** (Arbitrum can re-weight time by up to +768 s: a 43 bp 30-min TWAP shift for about $1.6–4.5k; censorship bounds about 24 h on Arbitrum, about 30 min on Base, UNVERIFIED) |
| Economic | T10 LVR and latency; T13 trading on a known outcome | gamma spread, cutoff, per-epoch reset, event halts |
| Collateral | T17 insolvency; T18 cross-market contamination (singleton); T26 donations | VCS S3/S4, per-market buckets, internal ledgers only (never `balanceOf`), `beforeDonate` revert |
| LP | T15 inflation / first depositor; T16 NAV manipulation / JIT / bank run | series tranche locked, 1:1 shares, no mid-life entry or exit (PoCs P1–P12 in G-VAULT) |
| Liveness | T27 pause, dead oracle, USDC blacklist | `redeem`/`claim` never gated; ERC-6909 payouts need no unlock; pauses block only new risk |
| Integration | T23 sync interleaving; T24 reentrancy; T25 transient storage; T30 quote ≠ execution; T32 identity | claims-first path; no untrusted calls in the swap path; no transient state across callbacks; deterministic quotes given (timestamp, oracle, storage); no `msgSender()` calls on the deployed quoter; never `tx.origin` |
| Governance | T19 market spam or bad parameters; T28 admin/upgrade; T29 flag mismatch | permissioned or bonded creation with bounds; immutable hook and per-market parameters; timelock for globals; flags validated in the constructor |
| Chain | T31 L2 time semantics | epoch = `block.timestamp`; sequencer-uptime feed; Arbitrum Δts vs L1 check; margins on cutoff and expiry |

**Do not rely on the `NonzeroDeltaCount == 0` guard.** Flash loans and sequential `unlock`s bypass it, and it breaks multi-hop
routes. [06 §5.4 #8][G-ROUTE §2.2]

---

## 7. Remaining uncertainties, contradictions and resolutions

### 7.1 Contradictions between reports, and the resolution to use

| # | Topic | Conflict | Resolution |
|---|---|---|---|
| 1 | Delivering outcome tokens | [01] mints YES into the PM in `beforeSwap` (`sync/mint/settle`). [06 §9.4a] and [G-VAULT] pre-mint complete sets and pay only with claims. [G-SWAP] uses inventory first plus on-demand mint. | **Use the VCS ledger** (B, outY, outN, inv) as the single source of truth [G-SWAP]. Pay outputs from inventory claims first and mint only the shortfall. Keep `restock`/`topUp` as an optional value-neutral optimisation, and an immutable `InventoryOnly` mode for pre-sync routers. Why: capacity then equals collateral with no keeper, the sync hazard only affects liveness and fails closed, standard routers settle atomically, and Halmos E2E and the UR fork tests already pass on this path. The physical identity `YES.supply == NO.supply` holds only in `InventoryOnly` mode; state solvency as S3 plus the ladder. |
| 2 | Spot input | [02] SoB or a 2–5 block TWAP; [06] a TWAP ending at the last observation; [04] a Panoptic-style EMA/median; [03] spot `sqrtPriceX96`; [05] SoB only | **SoB `sqrtPriceX96` from a pool-attached oracle hook, with the virtual-write rule** [G-QUOTE]. A TWAP is only an optional worst-of anchor (m_a = 1 on L2). |
| 3 | Settlement | [03] spot at T; [02]/[05] TWAP with `≥`/`ceil(κ)` | **Strict TWAP rule with the half-tick threshold** [G-SETTLE]. [02]'s tie rule was wrong (it resolved ties YES). |
| 4 | Window w | [02] 5–30 min; Polymarket 30–60 s; [G-VAULT] 1 h cutoff placeholder | **w = 4 h for 1-day markets.** Q_safe ∝ w², and 30 min is unfinanceable [G-SETTLE][G-SPEC][G-L2]. |
| 5 | In-band manipulation cost | [05] "almost free"; [02] band-free formula | **Quadratic, `≈ κ_in·n_w·y_v·δ²`.** [05] underestimates 20–30× near δ ≈ f; [02] overestimates 4–15× below f. [05]'s "$250 at D1 = $5M" is really ≈ $7.8k. [G-SETTLE §2] |
| 6 | "Attacker PnL ≤ 0" invariant | [02]/[05]/[06] | Not provable. Replace with M1 (profit ≤ spread paid under Q_safe) plus M2 (statistical). [G-SETTLE §3.1] |
| 7 | Hart monotonicity | [05] "empirically monotone" | **False for the WAD port.** Use HartX36 with its certificate. [G-FV] |
| 8 | Lemma S and E4 | [G-QUOTE] "floor isqrt exact; quote monotone" | Sell-side Lemma S needs the band precondition. Integer `Φ̂ + kφ̂` is not monotone, so use the factored form. [G-FV §4] |
| 9 | Kernel | [G-SPEC] freezes Student-t ν = 5 (Gaussian fails strict accounting at L1, λB = 0.1). [G-KERNEL] finds N(d2) ≡ t5 at 1 d, t4 harmful, and "normal fails ≤ 4 h" was really about the σ policy. | **Build a kernel interface.** The **default is Gaussian (HartX36) on the Asian (μ, v)**: every theorem is proven for it, and it is honestly "Black–Scholes-priced", which a t-kernel market is not (no risk-neutral log-t measure). Ship F4 (algebraic) and F5 (atan) as optional kernels with the Lemma M_t obligations. The economic suite must report **both kernels** under the same frozen configuration and strict accounting. Gaussian with a smaller budget, B = $5k, reaches OOS strict D\* ≈ 0.25–0.33 and passes E4 OOS, but its in-sample D\* is 3.2–3.6 (`integrated-spec-scripts/out/final_strict.txt`). So B, λ and the kernel must be co-tuned. |
| 10 | σ policy | [G-ORACLE] fixed at creation (mode A), rejects EWMA; [G-ECON] EWMA of 5-min point returns | **Live EWMA (1-day half-life) of the TWAP-return estimator**, read epoch-constant [G-SPEC]. Mode A gives D\* = ∞. The live-σ manipulation cost (≈ half of the $303k per 10 vol points for a 3-day window on v3 L1) is **not simulated**: add a fork test. |
| 11 | Band correction β | [G-ORACLE] `0.5·γ²/H` | Per chain, **c ≈ 0.3** (measured Base 0.37, L1 0.40, Arbitrum ≈ 0.13). Refit on 30 days. [G-L2 §0.5] |
| 12 | Winsorisation | [G-ORACLE] 400 ticks per window | The Arbitrum 2026-09-24 event (+3–6% for about 6 min) produced 47.8% of 2-day Σr² without binding the 400-tick clamp. Use a **robust estimator**: a σ-scaled clamp of about 6σ̂√H from a slowly updated σ_ref (an adaptive clamp is circular in [G-ORACLE]), or bipower/median RV, plus the regime halt. **Open.** [G-L2 §2.5] |
| 13 | Persistent inventory skew | [G-QUOTE] and [G-ECON] forbid it (×1.92 extraction under latency; decaying impact 1.5–3× worse). [04] and [G-REAL] require κ = 0.10 against persistent-belief agents. | **Make κ a parameter and prove the theorems for κ = 0.** For κ > 0, compute the skew from **epoch-start** inventory `E_start`, so the quote stays epoch-constant and E1–E3, Lemma S and Theorem N still hold within an epoch. Theorem L then holds relative to the skewed mid and no longer bounds skew harvesting. Report economics for κ ∈ {0, 0.10}. Claim E4 with κ only for D ≤ 2 until a joint-agent run exists. |
| 14 | Spread level | 0.3–1¢ [G-QUOTE]; 2¢ [G-SPEC]; 2% [G-ECON]; 3% [G-REAL] | **h₀ = 2¢ baseline, 3¢ in the κ configuration.** The lower values fail against model error. |
| 15 | λB | 0.1 [G-ECON][G-REAL]; 0.5 [G-SPEC] | Parameter. 0.5 with the t kernel on both chains; 0.1 with Gaussian on L1. Sweep both. |
| 16 | Cutoff | 24 h Thales; 12 h Lyra; 10% of tenor [G-ECON]; τ_cut [05] | **T − w − b.** [05]'s τ_cut is redundant once the c_lag gamma term is in the spread [G-SPEC §0.7]. |
| 17 | Vol premium | [04] +5 vol points toward IV | **Harmful**; none. [G-ECON][G-ORACLE] |
| 18 | Latency charge | [G-ECON] −0.029 B/market at 1 d | Measured at the wrong λ. At λB = 0.1 with a 10% cutoff it is −0.003; under the frozen spec it is LP-positive. [G-KERNEL §1][G-SPEC §4.3] |
| 19 | Thales-style beats the hook at 7 d | [G-ECON §6.6] | Artifact of the simulator's quote (E7b fails: it overcharges by 0.86 pp). Drop Thales from E6 or model its discount branch. [G-REAL §3] |
| 20 | Permission mask | 0x2888 [01][G-SWAP]; 0x2A88 [OZ]; 0x2AA8 [06] | **0x2AA8.** Explicit reverts cost nothing. |
| 21 | Chain | [01]/[03] mainnet/Unichain; [G-SPEC] L1 plus Base | **Proof fork: Base** (deterministic time, free archive RPCs, conservative depth). **Product: Arbitrum** (deepest, 47 h ring, lowest SoB error) under the §2.4/§6 guards. Also run the mainnet fork for the v3 adapter and UR (already passing there). Unichain is excluded. [G-L2 §6] |
| 22 | Median settlement | [02] median of 3 pools | Not a remedy with today's pools. Use a cost-weighted mean of the 5 bp and 1 bp pools, or a single 5 bp pool. [G-SETTLE §3.3] |
| 23 | Event | OZ `HookSwap` [01][06] | Aggregator `HookSwap(bytes32,address,int256,int256,uint24)`. [G-ROUTE] |
| 24 | Hart gas | ≈ 900 [03]; 1.3k [05]; 1,309 [G-FV] | Different harnesses. Use 1,309 unchecked (HartX36) and re-measure with `forge snapshot`. |

### 7.2 Open risks (not resolved by research)

1. **The adversary set is a lower bound.** Every E-claim reads "against {lat, tail, iv, dir, jump, jump_ev, smile}". Still missing:
   - a joint-agent simulation (needed for κ at D > 2);
   - a combined latency + tail agent;
   - 7-day smile fits.

   The vol-foresight stress (E5) fails. The LP is short the directional risk premium of net-long flow: 3.2% of notional at 7 d on
   Thales, 0.55–1.31 pp at 1 d. [G-REAL][G-SPEC]
2. **Short samples.**
   - Latency: 116 days of 1 s data (SE ≈ 0.017 B/market; this dominates D\* uncertainty: 0.2 → 1.5/day).
   - Arbitrum: 2 days, dominated by one tail event (the real cost of a large shift was about 10× below the model).
   - Base: 7 days; β from two windows. [G-KERNEL][G-L2]
3. **Trust in L2 sequencers** (timestamps, censorship) cannot be removed on-chain; declare it. OP-stack drift bounds are UNVERIFIED.
   [G-L2 §3]
4. **Formal gaps.**
   - Solady `sqrt` floor-correctness has no formal proof.
   - The `lnWad` certificate is not run.
   - Fixed-point monotonicity of the t variants is only tested.
   - The d = 0 junction of the factored g± is argued, not checked.
   - Halmos 0.3.3 has been dormant since 2025-08; trial hevm 0.58. [G-FV]
5. **Routing admission** is at Uniswap Labs' discretion (ZLCA plus allowlist). Unverified: reviewers' protocol-fee expectations,
   `HookSwap` indexing (needs a subgraph PR), and closed-source aggregators (1inch, Odos, Velora, OKX, CoW); KyberSwap needs a Go
   simulator. [G-ROUTE §8]
6. **Unmeasured gas.** The warm UR path for buy/sell/split/merge and 2-hop routes (needed for `gasOverheadPerHop`). Oracle writes in
   steady state after the checkpoint ring wraps. The packed ladder. [G-ROUTE §2.4][G-ORACLE §2.5][G-VAULT §5.5]
7. **Unaudited dependencies.** The OZ oracle files are outside their audit scope. Solady `expWad`/`lnWad` are not in any found audit
   scope. DeFiMath has no audit. The deployed PM bytecode has not been byte-matched to v4.0.0. [02 §2.2][03 §2.1][G-L2 §4]
8. **Product and adoption.** Whether noise flow at D ≈ 1–2 will arrive (Polymarket anchors, uninformed share UNVERIFIED). Idle-capital
   drag from series subscription. A geometric-TWAP payoff versus a "spot at T" label. Legal status. [G-ECON §1.2][G-VAULT §10]

---

## 8. Toolchain and dependency versions

| Item | Pin / setting | Notes |
|---|---|---|
| Foundry | **forge 1.8.3 (`cae51ad`)** | Not installed system-wide (`which forge` fails). The binaries in `scratchpad/foundry-bin/` are ephemeral, so install with `foundryup`. |
| solc | **0.8.26** | `PoolManager.sol` pins `pragma solidity 0.8.26` exactly; compiling it from source keeps us on 0.8.26. |
| EVM | `cancun` | Transient storage. Osaka/CLZ is live on every candidate chain but not needed. |
| Profiles | default: `via_ir = true`, `optimizer_runs = 44444444` (v4-core settings; used by the G-SWAP, G-ORACLE and G-ROUTE prototypes). `halmos` profile: lower runs (a 258 s build otherwise) and **`dynamic_test_linking = false`** (Halmos cannot run `vm.deployCode`). `ffi` profile opt-in, nightly. `fs_permissions` read `./vectors`. Fuzz ≥ 10k runs in CI (the math props passed 100k); invariant 256 × 100 minimum. | Gotcha: under via-IR, `vm.warp(block.timestamp + 12)` in a loop does not advance time; use `vm.getBlockTimestamp()`. [G-ORACLE §4.3] |
| v4-core | `46c6834` (package 1.0.2) | Or tag `v4.0.0` = `e50237c`, which has the old `IPoolManager.SwapParams` import path. BUSL-1.1 on PM is fine for tests. |
| v4-periphery | `9969eec` (package 1.0.4) | Has the 6-field `ExactInputSingleParams` (`03b2d09`) and `V4ExactOutputUnfilled` (`545a5d2`). `HookMiner` is in `test/shared/`. `MockV4Router` and `V4Quoter` for local tests. |
| OZ uniswap-hooks | `80bd724` (package 1.2.2; latest tag v1.2.1 = `acbd604`) | `BaseHook` only. Remap `@openzeppelin/uniswap-hooks/=lib/uniswap-hooks/src/`. |
| Solady | `2afba69` (v0.1.26) | `FixedPointMathLib` (`lnWad`, `expWad`, `sqrt`, `fullMulDiv`). |
| universal-router | source `a9c574f` (for `Commands`); **deployed UR 2.1.2** = tag `802fe4c`, which pins periphery `545a5d2` | Fork target. |
| v3-core | `d0831dc` | `observe`/`Oracle` interfaces for `V3ObserveAdapter`. |
| Others | forge-std; permit2; `v4-hooks-public` `e4eabe5` (HookMiner, `SettlementLib`, aggregator `HookSwap` reference); hookmate `ef3e984` (optional precompiled artifacts) | Pin everything in `foundry.lock`. v4-template (`1fbf955`) imports a deleted `HookMiner` path: vendor it. |
| Python | `uv`; mpmath 1.4.1, scipy 1.18.1, numpy 2.5.3, numba, pandas, sympy, z3-solver; optional pyrevm | Run `uv run --with … python`. System Python is 3.9 with no scipy. |
| Formal | halmos 0.3.3 (pin it; dormant) and/or **hevm 0.58.0**; optional Certora 8.19.2 (CVL for S3/S4, 1–2 weeks), Kontrol, Lean 4 + mathlib (QV identity, Lemma S) | Keep harnesses in plain `check_*`/`prove_*` form so they are portable. [G-FV §5.3] |
| Fork RPCs and blocks | **Base** archive RPCs: `mainnet.base.org`, `base.drpc.org`, `base.gateway.tenderly.co`. Arbitrum archive only via tenderly or blastapi; `arb1` logs lack timestamps. Anchors: mainnet 26,055,400; Unichain 59,602,400; Base window 51,478,346–51,780,746 and the June-2026 halt near 47,806,542; the Arbitrum event at 508,540,300–508,541,700. | [G-L2][G-ROUTE] |
| Test deployment | `deployCodeTo` at a flagged address, namespaced with `^ (0x4444 << 144)`. A **fresh PM with zero balances** (`Deployers.deployFreshManagerAndRouters`). Take outcome-token addresses as inputs or mine salts off-chain: a CREATE2 salt loop does not terminate under Halmos. | [01 §2.3][G-FV §5.3] |

**Reusable reference assets to wire into the plan:**
- `05-math-scripts/*.py` (pricing, Greeks, TWAP binary, calibration, LVR MC);
- `gaps/quote-function-scripts/quote_ref.py` (integer-exact quote spec, fuzz F1–F9);
- `gaps/integrated-spec-scripts/spec.py` (frozen constants) and `engine2.py` (series simulator and tape generator);
- `gaps/economic-backtest/export_vectors.py`;
- `gaps/settlement-scripts/08_strike_thresholds.py`;
- `gaps/formal-verification-scripts/py/*` (certificates, z3);
- the prototypes `PredictionHookProto.sol`, `SeriesHook.sol`, `VolOracleHookV2.sol`, `V3ObserveAdapter.sol`, `MiniPredictionHook.sol`,
  `QuoteMath.sol`, `StudentTCdf.sol` and `HartTail36.sol`. These are research quality, not audited.
