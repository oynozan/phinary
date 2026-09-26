# Gap: making "Uniswap is the routing and composability layer" provable

Status: research plus a working fork prototype, 2026-09-26.

Scope. This report resolves the open composability items: 01 Q7/§7.2 (router struct version), 01 Q8/§4.4 (event standard), 02 §6.1 (router policy for return-delta hooks), 06 Q11/§1.6 (aggregator acceptance), and swap-path §7/§11.3/§11.5 (in-unlock split/merge, pre-sync aggregators).

Provenance. Everything is in `docs/md/research/gaps/routing-composability-proof/`:
- `ur_probe.py`, `ur_probe2.py` and their `*_output.txt`: raw `eth_call`s against the deployed contracts on 4 chains.
- `forkproof/`: a Foundry project with `src/SoBOracleHook.sol`, `src/MiniPredictionHook.sol` and `test/RoutingFork.t.sol`. Its libraries are symlinked from the scratchpad.
- `forge_test_output.txt`: the output of both fork runs.
- `support_article.txt`: the Uniswap support article, fetched through the Zendesk API.

Toolchain: Foundry 1.8.3 (`cae51ad`), solc 0.8.26, via-IR, Cancun.

Forks and live reads:
- Fork tests ran against Ethereum block 26,055,400 and Unichain block 59,602,400.
- Live probes ran on 2026-09-26 at Ethereum 26,055,414, Base 51,780,707, Arbitrum 508,807,065 and Unichain 59,602,420.

Source pins:
- universal-router, full history, at `a9c574f`;
- v4-periphery, full history, at `9969eec`;
- Uniswap/uniroute-public at `435a706` (2026-09-25);
- Uniswap/smart-order-router at `04c7c0b`;
- Uniswap/v4-subgraph at `0c13ab2`;
- Uniswap/hooklist at `1d2f09b`;
- 0xProject/0x-settler at `cdf29a0`;
- KyberNetwork/kyberswap-dex-lib at `22729b8` (sparse checkout).

Anything not verified is marked **UNVERIFIED**.

---

## 0. Answers in brief

1. **(a) Struct layout per deployed UR.** Checked by fork `eth_call` on Ethereum, Base, Arbitrum and Unichain.
   - **UR "v2.0"** uses the **5-field** `ExactInputSingleParams` (no `minHopPriceX36`) and the **4-field** `ExactInputParams`.
   - **UR 2.1.1 and 2.1.2** use the **6-field** single struct and the **5-field** multi-hop struct (`uint256[] minHopPriceX36` after `path`). This holds on all four chains.
   - A mismatched encoding does **not** always revert. On an ETH-`currency0` pool with empty `hookData`, both directions of mismatch decode "successfully" and execute normally.
   - On our pools, `currency0` is never 0 (it is USDC or an outcome token), so a mismatch **fails closed**: the call reverts with no data.
   - **Decision:** tests and scripts target **UR 2.1.2** and encode the **6-field** single and **5-field** multi-hop structs. They must never rely on "it didn't revert" to validate an encoding.
2. **(b) Multi-hop ETH → USDC → YES works end to end** in one UR `V4_SWAP` through the deployed UR 2.1.2 on mainnet and Unichain forks.
   - The intermediate USDC never leaves the PoolManager.
   - The YES leg is priced at the **start-of-block (SoB)** spot, not at the spot left behind by hop 1.
   - In the test, hop 1 moved S from $2,684 to $2,204 (−17.9%). Pricing at the live spot would have given the trader **10.8% more YES** (533,257 vs 481,394).
   - The deployed V4Quoter's multi-hop quote equals execution exactly, because the quoter runs the oracle hook in the same simulated unlock.
3. **(c) What a halt looks like to routers.**
   - A halt in `beforeSwap` reaches the **deployed V4Quoter** as `UnexpectedRevertBytes(WrappedError(hook, 0x575e24b4, MarketHalted(code), 0xa9e35b2f))`.
   - It reaches **UR 2.1.2 `V4_SWAP`** as the raw `WrappedError(...)`, bubbled with no `ExecutionFailed` wrapper.
   - Both are byte-exactly asserted for band, cutoff and cap.
   - Uniswap's routers treat any quoter revert as "no quote for this route and amount" and drop it (SOR `success=false` → failed quote). Because the router probes a ladder of split percentages, a per-trade cap makes it split the order or skip the pool; the whole quote does not fail.
   - A UR caller can make a halted leg *soft* by wrapping it in `EXECUTE_SUB_PLAN | 0x80` (tested).
   - The deployed V4Quoters on all 4 chains **lack `msgSender()`**: the call reverts, so they predate periphery `1ae55a6`. A hook that calls `IMsgSender(sender).msgSender()` unguarded is therefore **unquotable**.
4. **(d) Split and merge can be composed inside UR today, with no new UR command.** Express them as hook-priced swaps at par, selected by optional `hookData`:
   - **split**: `USDC → YES` exact-in with `hookData = (1, recipient)`. The hook delivers YES through the swap delta and mints NO as ERC-20 directly to `recipient`.
   - **merge**: `PERMIT2_TRANSFER_FROM(NO → hook)`, then `YES → USDC` exact-in with `hookData = (2)`. The hook burns the pre-transferred NO.

   Both are tested through UR 2.1.2. The quoter returns par for them. Empty `hookData` is still the normal priced swap. A separate entry point (own `unlock`) stays for non-UR use.

   What is **not** possible: an action-level split/merge in V4Router or UR. V4Router supports only swap, settle and take actions. `MINT_6909`/`BURN_6909` exist only in `PermissionedPositionManager`.
5. **(e) Routing eligibility is explicit and code-verifiable.**
   - Uniswap's support article says hooks with `beforeSwapReturnsDelta` **require manual allowlisting**.
   - The open-source UniRoute code confirms this. `hasCustomAccountingPermissions` pools are excluded from both automatic gates (`v4HooksPoolsFiltering.ts:54-58, 125-153, 241-251`).
   - Pools with **zero CL liquidity** are also dropped by the subgraph query floor (`liquidity > 0 && totalValueLockedETH > 0.001`). They need an entry in **`ZLCA_HOOKS_PER_CHAIN`** ("Zero-Liquidity Custom-Accounting hooks"), which is exactly our class. That entry comes with a `gasOverheadPerHop` and, for us, `sqrtPriceFromQuoter: true`.
   - **Events:** the Uniswap v4-subgraph indexes `Swap` from the PoolManager, which is all-zero for a NoOp. It indexes the aggregator `HookSwap(bytes32,address,int256,int256,uint24)` **only** for hook addresses configured as data sources, filtered to a stable-stable allowlist. The OZ `IHookEvents.HookSwap` is consumed by nothing we could find. **Emit the aggregator signature.**
   - **PermissionedV4Router** matters only for pools holding a *verified permissions-adapter* token. For USDC and our outcome tokens it is a no-op (one extra view call per pay).
6. **(f) Pre-sync aggregators.**
   - The open-source settlement paths all run `sync → pay → settle` atomically, so the on-demand-mint path is live for them: periphery `DeltaResolver` (UR, V4Router, PositionManager), **0x Settler** (`UniswapV4.sol:255-273`, used both before swaps in fee-on-transfer mode and after swaps), and v4-core/OZ `CurrencySettler`.
   - **KyberSwap** will not route to us without a bespoke off-chain Go simulator: an unknown hook with swap flags gives `ErrUnsupportedHook` (`pool_simulator.go:46-48`).
   - 1inch, Odos, Velora, OKX and CoW solvers were not reviewed (closed or not found): **UNVERIFIED**.
   - A pre-sync router still works via the inventory path. The mint path fails closed (swap-path §7).

---

## 1. (a) Deployed UniversalRouter versions and struct layouts

### 1.1 Source history (git, full clones)

| UR tag | tag commit / date | pinned v4-periphery | single-hop struct | multi-hop struct | contains `545a5d2` (exact-out unfilled revert) |
|---|---|---|---|---|---|
| 2.0.0 | `3663f6d` 2025-04-29 | `444c526` | 5 fields `{poolKey, zeroForOne, amountIn, amountOutMinimum, hookData}` | 4 fields `{currencyIn, path, amountIn, amountOutMinimum}` | no |
| 2.1.1 | `999d561` 2026-05-22 | `3231810` (2026-03-17) | 6 fields (+`uint256 minHopPriceX36` before `hookData`) | 5 fields (+`uint256[] minHopPriceX36` after `path`) | no |
| 2.1.2 | `802fe4c` 2026-09-17 | `545a5d2` (2026-08-03) | 6 fields | 5 fields | yes |
| 2.2.0 (tag on `64027f3`, the commit that *records* 2.1.2 addresses) | 2026-09-18 | `a7af5b3` | 6 fields | 5 fields | yes, plus `_validatePoolKey` (§5.6) |

Checks:
- `03b2d09` ("per-hop slippage to single swaps", 2026-03-17) and `3779387` ("per hop slippage checks", 2025-11-05) are ancestors of `3231810`, but not of `444c526` (`git merge-base --is-ancestor`).
- Deploy records: `deploy-addresses/*.json` `UniversalRouterV2_1_1` was added by `cb222d3` (2026-06-25) and `UniversalRouterV2_1_2` by `64027f3` (2026-09-18).
- Deployed code sizes: v2.0 = 19,499 B, 2.1.1 = 24,546 B and 2.1.2 = 24,380 B. They are the same on every chain.

### 1.2 Fork `eth_call` evidence (`ur_probe.py`)

Method:
- Swap 0.01 native ETH → USDC on each chain's hookless 500/10 v4 pool, paid via `msg.value` (no Permit2).
- UR command: `V4_SWAP` with `[SWAP_EXACT_IN_SINGLE | SETTLE_ALL | TAKE_ALL]`.
- `TAKE_ALL.minAmount = 2^127` forces `V4TooLittleReceived(min, actual)`. The actual amount shows whether decoding and execution succeeded.

| encoding sent | UR v2.0 (all 4 chains) | UR 2.1.1 and 2.1.2 (all 4 chains) |
|---|---|---|
| single, 5-field, `hookData=""` | executes (26,779,515 USDC-units on mainnet) | **executes silently** (minHop decoded as 0x120 = 288, which passes) |
| single, 5-field, `hookData=32B` | executes | reverts, no data |
| single, 6-field, minHop 0, `hookData=""` | **executes silently** (hookData offset decoded from minHop=0, so length = `currency0` = 0) | executes |
| single, 6-field, minHop 2^200 | reverts, no data | `V4TooLittleReceivedPerHopSingle` ✔ |
| multi, 4-field | executes | reverts, no data |
| multi, 5-field | decodes to an empty path: `V4TooLittleReceived(min=1e16, actual=0)`, i.e. fails closed only because `amountIn` lands in the `amountOutMinimum` slot | executes; with minHop `[2^200]` → `V4TooLittleReceivedPerHop` ✔ |

`ur_probe2.py` repeats the test on a pool key with a **non-zero `currency0`** (USDC), like ours. The pool does not exist, so a *correct* decode reaches the PM and reverts `PoolNotInitialized()`:
- v2.0: 5-field → `PoolNotInitialized` ✔, 6-field → reverts with no data;
- 2.1.1 and 2.1.2: 6-field → `PoolNotInitialized` ✔, 5-field → reverts with no data.

This matches on all four chains. The no-data revert is Solidity's calldata-bounds check: `hookData` length is decoded from `currency0`, a 160-bit address. In the fork prototype, `test_UR212_fiveFieldEncoding_revertsWithoutData` asserts `ret.length == 0` for the legacy struct against our YES pool.

The decoder explains why the empty-`hookData` ETH case silently succeeds:
- `CalldataDecoder.decodeSwapExactInSingleParams` checks only `params.length ≥ 0x160` and then trusts the struct offset (`v4-periphery/src/libraries/CalldataDecoder.sol:195-210`).
- A 5-field encoding with empty `hookData` is exactly 0x160 bytes, so it passes the 6-field check.

### 1.3 Decision for tests and scripts

- **Primary router: UR 2.1.2** on every target chain. Mainnet `0x23617e59…De85`, Base `0xd6145b2D…9c40`, Arbitrum `0x2d014117…Fe65`, Unichain `0xD1b797D9…4343` (Uniswap v4 deployments page, `scratchpad/v4deployments.md`).
- **Encoding:** import `IV4Router` from periphery ≥ `3231810`, so the structs are 6-field single and 5-field multi. The prototype's `LegacyExactInputSingleParams` exists **only** as a negative test.
- A script must **not** infer encoding correctness from a non-revert (§1.2 rows marked "silently").
  - Prefer an explicit acceptance check: send `minHopPriceX36 = 2^200` and expect `V4TooLittleReceivedPerHopSingle`.
  - Also assert exact output amounts.
- **UR 2.1.1 behaves identically for our pools**, except that 2.1.1 lacks `545a5d2`, so an exact-output under-delivery would not revert. Our hook never under-delivers, and the prototype rejects exact-out. This is source-inferred; the 2.1.1/2.1.2 exact-out difference was not fork-tested (**UNVERIFIED on-chain**).
- **UR "v2.0"** is still listed as "Universal Router" on the deployments page. Any integrator using the 2025 SDK default encoding (5-field) against our pool gets a data-less revert, not a mispriced trade. This is safe but needs documenting.
- **V4Quoter's `QuoteExactSingleParams`** (`{poolKey, zeroForOne, exactAmount, hookData}`) is unchanged since 2024 (`git log src/interfaces/IV4Quoter.sol`). All 4 deployed quoters answered the same probe (mainnet 26,779,515, gas estimate 41,702).

---

## 2. (b) Multi-hop ETH → USDC (oracle-hooked underlying) → YES in one UR transaction

### 2.1 Mechanics (source)

- UR `V4_SWAP` → `_executeActions` → **one** `PM.unlock` (`universal-router/contracts/base/Dispatcher.sol:282-284`; `v4-periphery/src/base/BaseActionsRouter.sol:25-27`).
- `SWAP_EXACT_IN` loops over `path` and calls `PM.swap` once per hop inside that unlock. Each hop's output becomes the next hop's `amountIn` (`V4Router.sol:98-128`).
- **Hop 1 (ETH → USDC, `SoBOracleHook` pool).**
  - Before the CL swap, the oracle hook's `beforeSwap` stores `(sqrtPriceX96, ts)` if this is the pool's first swap in the block (`SoBOracleHook.sol:38-53`).
  - The router's delta becomes `ETH −x, USDC +y`.
- **Hop 2 (USDC → YES, PredictionHook pool).**
  - The hook prices from `oracle.sobSqrtPriceX96(id)`. That returns the stored value when `sobTs == block.timestamp`, and live `slot0` otherwise (`SoBOracleHook.sol:55-60`, the same rule as quote-function §1).
  - It takes the `y` USDC as ERC-6909 claims via `PM.mint(hook, USDC.id, y)`. It delivers YES via `sync → YES.mint(PM) → settle`.
  - The router's USDC delta nets to 0. **No USDC ever moves as ERC-20.** The hook's collateral is backed by USDC the PM already held from the underlying pool.
- **Payment.** `SETTLE_ALL(ETH)` → `DeltaResolver._settle` → `sync(0); settle{value}` (`DeltaResolver.sol:38-48`). `TAKE_ALL(YES)` transfers YES to `msgSender()`.
- **Why the hook's `sync(YES)`/`settle()` does not disturb the router:** the router syncs only at the end, atomically, and for native ETH. The hook's `settle()` resets the synced-currency slot before that.

### 2.2 Expected SoB behaviour (spec)

| state before the UR tx | what the YES leg is priced at |
|---|---|
| no swap on the underlying yet in this block | hop 1's oracle `beforeSwap` records the **pre-hop-1** price as SoB; hop 2 reads it |
| an earlier swap in this block already moved the underlying | SoB was recorded before that earlier swap; hop 1 and hop 2 do not change it |
| hop 1 routes through a *different* ETH/USDC pool (hookless canonical, v3) | the oracle pool is untouched; S is unaffected by hop 1 |
| a later block | the new block's SoB = the previous block's closing price. The manipulation is then a multi-block problem (settlement and quote-function gap reports) |

Consequences:
- **Quote = execution within a block.** V4Quoter runs the same unlock, including the oracle hook's SoB write, which the quoter's revert rolls back. So the multi-hop quote equals execution.
- **Path independence:** a user cannot improve the YES price by chaining an underlying swap in front of it.
- **Do not add** the `NonzeroDeltaCount == 0` guard (06 §5.4 #8). It would reject this route, and 06 already downgraded it.

### 2.3 Fork result (`test_UR212_multiHop_ETH_USDC_YES_pricedAtSoB`, mainnet; the Unichain run matches)

Setup:
- The oracle pool (ETH/USDC 500/10, `SoBOracleHook`) is initialised at the canonical pool's price, with L = 5e16 in ±3000 ticks.
- `MiniPredictionHook` runs an ATM market, K = S₀.
- Hop 1 sells **100 ETH**.

| quantity | mainnet | Unichain |
|---|---|---|
| S at SoB (USD/ETH) | 2,684.156 | 2,677.987 |
| S after hop 1 | 2,203.998 (−17.9%) | 2,199.407 |
| USDC into hook (from the `HookSwap` event) | 243,104.089905 | 242,571.561491 |
| **YES out (executed)** | **481,394.237435** | **480,339.725724** |
| YES if priced at the live post-hop-1 S | 533,256.821992 (+10.8%) | 532,026.345595 |
| deployed V4Quoter `quoteExactInput` | 481,394.237435 (equal) | 480,339.725724 (equal) |

Also asserted:
- the trader receives no USDC (the intermediate is netted);
- the UR ends with 0 ETH;
- `test_UR212_multiHop_afterEarlierSwapInSameBlock_stillSoB`: after another user dumps 50 ETH in the same block, `sobSqrtPriceX96` still equals the pre-dump price, and the hook quote equals the SoB formula.

The reverse route **YES → USDC → NO** in one `V4_SWAP` (`test_UR212_multiHop_YES_USDC_NO_noProfit`) is also tested:
- execution = quoter = `quoteBuyExactIn(NO, quoteSellExactIn(YES, y))`, so it is path-independent;
- the NO received is worth no more at the NO bid than the YES given up at the YES bid.

### 2.4 Caveats

- The prototype's price function `pYES = S/(S+K)` is a monotone stand-in, not Black–Scholes. What this test proves is **routing and SoB plumbing**, not pricing.
- Gas: `UR.execute` for a single-hop YES buy on the mint path is **303.9k** (mainnet fork). That includes Permit2, cold slots and the first-write SSTOREs of `outYes`/`bucket`. It is an upper bound, not a production estimate; measure with `forge snapshot` on warm state.

---

## 3. (c) V4Quoter and router behaviour when the hook halts

### 3.1 Revert-data layering (source and fork)

1. The hook reverts `MarketHalted(code)` in `beforeSwap`.
2. `Hooks.callHook` wraps it: `CustomRevert.bubbleUpAndRevertWith(hook, bytes4(data)=IHooks.beforeSwap.selector, HookCallFailed.selector)` → `WrappedError(address hook, bytes4 0x575e24b4, bytes reason, bytes 0xa9e35b2f)` (selector `0x90bfb865`; the quoter wrapper `UnexpectedRevertBytes` is `0x6190b2b0`) (`v4-core/src/libraries/Hooks.sol:137`, `CustomRevert.sol:11, 83-110`).
3. The two layers then diverge:
   - **V4Quoter.** `_unlockCallback` bubbles the reason (`BaseV4Quoter.sol:29-35`). `parseQuoteAmount` sees a selector other than `QuoteSwap` and reverts `UnexpectedRevertBytes(bytes reason)` (`QuoterRevert.sol:35-41`).
   - **UR `V4_SWAP`** is an internal call (`Dispatcher.sol:282-284`), so the PM's `WrappedError` bubbles **raw**. `ExecutionFailed(commandIndex, message)` is used only for commands dispatched through a low-level call (`UniversalRouter.sol:79-86`).

`test_halts_quoterAndRouterRevertData` asserts the exact bytes for band (1), cutoff (2) and cap (3), against the **deployed** quoter and **deployed** UR 2.1.2 on both chains:

```
Quoter: UnexpectedRevertBytes( WrappedError(hook, 0x575e24b4, MarketHalted(code), HookCallFailed()) )
UR:     WrappedError(hook, 0x575e24b4, MarketHalted(code), HookCallFailed())
```

A different failure produces a different error. If the hook partially fills instead of reverting, the quoter throws `UnexpectedRevertBytes(NotEnoughLiquidity(poolId))` (`BaseV4Quoter.sol:53-57`). That is why halts must revert and never partially fill (01 §1.9).

**Soft halts in UR.** Put the `V4_SWAP` inside `EXECUTE_SUB_PLAN` (0x21) with `FLAG_ALLOW_REVERT` (0x80), i.e. command byte `0xa1`. The sub-plan runs via `address(this).call(execute(...))` (`Dispatcher.sol:312-314`), so the failure is swallowed and the rest of the transaction continues. `test_halt_softFailInsideSubPlan` shows nothing is charged.

### 3.2 How routers treat it

- **Uniswap smart-order-router** (`on-chain-quote-provider.ts`) multicalls the V4Quoter per route × amount-percentage. A reverted call gives `success: false`, and the route/amount is recorded in `debugFailedQuotes` (with a metric for hooked routes, `:1355-1395`) and dropped. The per-amount ladder (for example 5%…100%) means a **cap halt** turns into "route only the fraction under the cap". A **band or cutoff halt** removes the pool from every split of that request.
- **UniRoute** (the current open-source Uniswap routing engine) quotes **ZLCA hook pools through the standard V4Quoter** ("The hook settles the whole swap inside the PoolManager unlock, so the standard V4Quoter prices them fine", `hooksAddressesAllowlist.ts:602-620`). It uses `hook.quote()` only for aggregator hooks (`DeepQuoteStrategy.ts:168-170`). Failed quotes are treated the same way.
- **Deployed quoter and `msgSender()`.** On all four chains, `msgSender()` on the deployed V4Quoter reverts with no data (`ur_probe_output.txt`). UR's `msgSender()` exists and returns 0 outside execution (`ur_probe2_output.txt`). **Requirement:** the hook must not call `IMsgSender(sender).msgSender()` unless `sender` is on an explicit router allowlist, and even then only inside `try`/`catch`. Otherwise quoting through the deployed quoter reverts.
- **Recommendations for the production hook:**
  1. Revert with a typed `MarketHalted(uint8 code)` **as early as possible**, before any `mint`/`sync`, which saves quoter gas.
  2. Expose `view` functions `haltReason(poolId)`, `quote(poolId, zeroForOne, amountSpecified)` and `maxTradeSize(poolId, side)`, so integrators can pre-check without a revert.
  3. Keep halts **deterministic given `(block.timestamp, oracle state, hook storage)`**. Never branch on `tx.origin`, `gasleft` or `hookData`. That keeps quoter = execution (06 §1.6).

---

## 4. (d) In-unlock split/merge that UR and V4Router batches can compose

### 4.1 What the router action set allows

- **V4Router `_handleAction`** supports only `SWAP_EXACT_IN(_SINGLE)`, `SWAP_EXACT_OUT(_SINGLE)`, `SETTLE_ALL`, `TAKE_ALL`, `SETTLE`, `TAKE` and `TAKE_PORTION`. Anything else is `UnsupportedAction` (`V4Router.sol:34-80`).
- `Actions.MINT_6909` and `BURN_6909` (0x17/0x18) are handled only by `PermissionedPositionManager` (`:289-310`).
- **UR commands** cannot call arbitrary contracts. Our hook's `split()` is therefore unreachable from inside a UR transaction as a function call. A `split()` that opens its own `unlock` also reverts with `AlreadyUnlocked` when nested (`PoolManager.sol:105`).
- A swap's return delta is limited to the pool's **two** currencies, so a 3-currency operation (USDC ↔ YES + NO) cannot be expressed purely through deltas.

### 4.2 Design that composes: split and merge as par-priced swaps, selected by optional `hookData`

**Split** (`MiniPredictionHook.sol:224-231`):
- Swap `USDC → X` exact-in `a` on X's pool with `hookData = abi.encode(uint8(1), recipient)`.
- The hook prices at **par** (`out = a`) and delivers X through the normal swap delta.
- It **mints the other outcome token as ERC-20 directly to `recipient`**. The hook is its minter, so this needs no PM delta.
- Ledger: `B += a; outY += a; outN += a`. VCS invariant S3 is preserved.

**Merge** (`:252-258`):
- In one UR transaction, command 1 is `PERMIT2_TRANSFER_FROM(other, hook, a)` (UR command 0x02, `Dispatcher.sol:102-112`).
- Command 2 is `V4_SWAP{ X → USDC exact-in a, hookData = abi.encode(uint8(2)) }`.
- The hook requires `other.balanceOf(hook) ≥ a`, burns `a`, takes X as inventory claims and pays `a` USDC from claims.
- Ledger: `B −= a; outY −= a; outN −= a`.

Fork results (UR 2.1.2, mainnet and Unichain):
- `test_UR212_split_inV4Swap`: 5,000 USDC → 5,000 YES + 5,000 NO. The deployed quoter returns exactly 5,000 for the split `hookData`.
- `test_UR212_merge_permit2TransferThenV4Swap`: 5,000 YES + 5,000 NO → 5,000 USDC. `outYes = outNo = 0` afterwards.
- `test_merge_withoutPrefund_reverts`: a merge without the pre-transfer reverts (`MergeNotFunded`).

Security argument:
1. **Split** delivers exactly `a` YES + `a` NO for `a` USDC, which is worth exactly `a` at settlement whoever the `recipient` is. An attacker-chosen `recipient` can only gift the payer's own tokens.
2. **Merge** pays at most the NO the hook actually holds as ERC-20. In VCS the hook's inventory is ERC-6909 claims, and `sweep` burns immediately, so any ERC-20 balance held by the hook is by construction a pre-transfer. The only risk is a *non-atomic* pre-transfer that a third party merges against. That is a v2-`skim`-style foot-gun that UR's atomic batch avoids; document it.
3. Neither mode reads the oracle, so neither is manipulable. Both keep S3 `B ≥ max(outY, outN)`, checked after every call (`:271`).
4. **Empty `hookData` gives normal pricing**, so the hooklist property `requiresCustomSwapData = false` still holds and aggregators are unaffected (§5.1).

Caveats:
- Indexers see split and merge as a 1:1 swap plus an ERC-20 mint/burn of the other side. Emit `Split`/`Merge` events.
- The NO leg of a split is **not** visible in the router's deltas. A router's `TAKE_ALL` delivers only X; `recipient` gets the other side directly.
- A split exact-*out* variant is not implemented.
- The production hook should still also offer `split()`/`merge()` as a plain entry point with its own unlock (swap-path §4), for non-UR callers.
- An **in-unlock variant for custom routers** is also possible (`PM.isUnlocked()` required, payment via `settleFor(hook)`), but it is not needed, since the swap form already composes.

---

## 5. (e) Routing eligibility, events and PermissionedV4Router

### 5.1 Uniswap's stated criteria (support article "Routing for hooked pools", created 2026-08-20, updated 2026-09-03; text in `support_article.txt`)

Verbatim:
- "Your hook is automatically allowed unless: … deployed to an address that starts with '0x91…'; … uses any of the following flags: beforeSwapReturnsDelta, afterSwapReturnsDelta, or dynamicFees". We use `beforeSwapReturnsDelta`, so **manual review is required**.
- Criteria that "increase the likelihood" of allowlisting:
  - deployed on a supported mainnet;
  - source verified;
  - "should not modify or bypass the AMM protocol fee";
  - "must not be deployed through a proxy contract which permits upgrading";
  - "must not be malicious or extractive towards swappers or LPers";
  - "must not require custom calldata which the Uniswap Labs' router could only produce with modification".
- "Allowlisting decisions are made at Uniswap Labs' sole discretion", and allowlisting is "not an endorsement … or security review". Submission is via the hook allowlisting form.

How our design maps onto these:
- **Custom calldata:** empty `hookData` must work. Split and merge are optional modes.
- **No proxy:** use immutable hook bytecode.
- **Protocol fee.** A full NoOp never pays the PM protocol fee (01 §6).
  - The v4 fee switch (Proposal 100) scopes "static fee pools without hooks, CCA pools and aggregator hook pools", so our pools are out of scope today.
  - Uniswap's own aggregator hooks show both options: `ProtocolFees.sol` honours `slot0.protocolFee` and takes it to the TokenJar, while UniswapX and LitePSM aggregators opt out via `protocolFeeFlags() == 0` (`v4-hooks-public/src/aggregator-hooks/README.md:151`, `UniswapXAggregator.sol:96`, `LitePSMAggregator.sol:91`).
  - **Recommendation:** read `slot0.protocolFee` of our pool (one `extsload`). If it is non-zero, charge it on the USDC leg and `take` it to the TokenJar, as `ProtocolFees.sol:45-100` does. Implement `IFeeClassifiedHook.protocolFeeFlags()`.
  - Whether reviewers require this: **UNVERIFIED**.

### 5.2 What the routing code actually does (UniRoute `435a706`, `src/lib/poolCaching/…`)

1. **Pool discovery.** The subgraph query admits V4 pools only with `liquidity_gt: "0"` and `totalValueLockedETH_gt: 0.001` (`subgraphProvider.ts:139, 398-427`). Our pools have **L = 0 forever** (`beforeAddLiquidity` reverts), so they never pass this on their own.
2. **Automatic gates** (`v4HooksPoolsFiltering.ts`):
   - `isHooksPoolRoutable` (`:125-153`) requires no swap permissions, no custom-accounting permissions and no dynamic fee.
   - `isAutoAllowlistedHook` (`:241-251`) rejects `hasCustomAccountingPermissions` (`:54-58` = `BeforeSwapReturnsDelta ∨ AfterSwapReturnsDelta`).
   - **We fail both.**
3. **Explicit allowlist.** `HOOKS_ADDRESSES_ALLOWLIST[chainId]` is a curated list, vetted by PR (`hooksAddressesAllowlist.ts`). Explicitly allowlisted pools are appended if the fee is within the sanity ceiling (`v4HooksPoolsFiltering.ts:~370`).
4. **TVL bypass for our class.**
   - `ZLCA_HOOKS_PER_CHAIN` (`hooksAddressesAllowlist.ts:602-690`) is for "V4 hooks whose custom accounting means their pools hold no ordinary LP positions, so … `liquidity` … is structurally always 0". Entries are "admitted to routing purely by membership in this registry … every address here must ALSO appear in `HOOKS_ADDRESSES_ALLOWLIST`".
   - Each entry carries `gasOverheadPerHop` (for example LitePSM 500k, DualPool 3M, eToro RFQ 250k, GuideStar 50k). It is used only on the heuristic path; quoter-based estimates already include the hook (`core/gas/zlcaHookGasCalibration.ts`).
   - Optionally, `sqrtPriceFromQuoter: true` derives mid price and price impact from a quoter probe instead of the placeholder `slot0`. **We need it:** our `slot0` stays at 2^96 (1:1 raw, and YES and USDC are both 6 decimals), which would misstate price impact.
   - The warning "Do not add a hook whose pools can involve permissioned … tokens — this list applies no known-token bounding" is satisfied because our hook reverts foreign `initialize`. The pool set is exactly what `createMarket` creates.
5. **The dynamic path** (factory-discovered ZLCA hooks, capped at 50 pools per hook, `v4HooksPoolsFiltering.ts:28-30`) applies to pinned factory bytecode whose pool creation is owner-gated. A shared PredictionHook with many markets should seek a **static** entry.
6. **UniswapX alternative.** Hook builders "can do so by running a UniswapX filler for their hooked pools" (docs, *Integrated Routing with UniswapX*). A filler settles through UR against our pools. It needs no allowlist, but it only reaches UniswapX order flow.

**Eligibility checklist (what "routable by Uniswap" requires of us):**
- immutable, verified hook;
- beforeSwapReturnsDelta pools that **never** partially fill, and halts as clean reverts;
- empty-`hookData` swaps work;
- deterministic quotes with quoter = execution;
- `beforeInitialize` blocks foreign pools;
- a documented `gasOverheadPerHop`, measured through UR (§2.4);
- a protocol-fee policy (§5.1);
- a hooklist entry (`vanillaSwap: false` because of return deltas; `swapAccess: "temporal"` because of cutoff/expiry halts; `requiresCustomSwapData: false`; `upgradeable: false`; `dynamicFee: false` with static fee 0);
- the form submission requesting both `HOOKS_ADDRESSES_ALLOWLIST` and `ZLCA_HOOKS_PER_CHAIN` with `sqrtPriceFromQuoter`.

The fork tests can prove every technical item. The admission itself is a Uniswap Labs decision and **cannot be proven by us**. Report it honestly as "eligible by the published criteria and the open-source admission code, admission pending".

Hooklist data point: of 4,961 registered hooks, 3,134 have `beforeSwapReturnsDelta`, and **none** of those is `vanillaSwap` (`hooklist.json` at `1d2f09b`). The analysis prompt defines `vanillaSwap = false` for any return-delta hook (`.claude/prompts/analyze-hook.md:123-140`).

### 5.3 Events: what indexers consume

- **Uniswap v4-subgraph** (`0c13ab2`) consumes the PoolManager events `Initialize`, `ModifyLiquidity` and `Swap` (`subgraph.yaml:36-45`).
  - For a full NoOp, `PM.swap` still emits `Swap` from `_swap`, but with the **CL delta**, which is 0/0, and before hook deltas are applied (`PoolManager.sol:236-250`). Volume from `Swap` is therefore zero for our pools.
- **`HookSwap(indexed bytes32,indexed address,int256,int256,uint24)`**, the aggregator signature from `IAggregatorHook.sol:15`, is consumed only through the `AggregatorHook` data-source template, which is instantiated for configured addresses. Today that is only `tempo` (`networks.json`, `generate-subgraph.ts:114-135`).
  - Even there, `handleHookSwap` returns early unless the pool's hook is in the USD stable-stable list (`src/mappings/swap.ts:27-44`).
- **OZ `IHookEvents.HookSwap(bytes32,address,int128,int128,uint128,uint128)`** is consumed by nothing in the Uniswap subgraph, SDKs or UniRoute (grep of all four repos).
- **Recommendation:** emit the **aggregator** `HookSwap(PoolId,address,int256,int256,uint24)` with the hook-perspective sign convention (input +, output −), as `BaseAggregatorHook.sol:173-183` does and as the prototype does (`MiniPredictionHook.sol:273-276`). Getting it indexed requires a subgraph data-source PR, which is **UNVERIFIED** whether Uniswap would accept. Third-party indexers (Dune and others) were not checked (**UNVERIFIED**).

### 5.4 PermissionedV4Router

- UR 2.1.x's `V4SwapRouter is PermissionedV4Router, Permit2Payments` (`V4SwapRouter.sol:17`).
- At UR 2.1.2's pin (`545a5d2`) it only overrides `_pay`/`_mapSettleAmount`: if `PERMISSIONS_ADAPTER_FACTORY.verifiedPermissionsAdapterOf(currency) != 0`, it wraps and checks `isAllowed(msgSender(), SWAP_ALLOWED)`; otherwise it pays via Permit2 as usual (`PermissionedV4Router.sol:24-46` at `545a5d2`).
- Periphery `a7af5b3`/`HEAD`, which UR `main` and tag 2.2.0 pin, adds `_validatePoolKey`. It reverts `HookNotAllowed` only when a pool currency is a verified adapter that has not allow-listed the hook (`PermissionedV4Router.sol:28-41`).
- **For USDC/YES/NO pools both are no-ops.** Our pools passed through UR 2.1.2 in every test. It matters only if a future market uses a permissioned (for example tokenised-equity) collateral.
- Whether a 2.2.x UR is deployed is **UNVERIFIED**. It is not on the deployments page as of 2026-09-25.

---

## 6. (f) Third-party aggregators and the on-demand mint path

The hazard (swap-path §7): if a router does `sync(X)` + transfer **before** `PM.swap` and `settle()` after it, then our hook's `sync(OUT)…settle()` inside `beforeSwap` resets the router's pending sync, and the transaction reverts `CurrencyNotSettled`. This is liveness only, and only on the mint path.

| settlement code | pattern | pre-sync across the swap? | evidence |
|---|---|---|---|
| v4-periphery `DeltaResolver._settle` (V4Router, UR v2.0/2.1.x, PositionManager, MockV4Router) | `sync → pay → settle` in one call, after the swaps | no | `DeltaResolver.sol:38-48`; fork: every UR test above uses the mint path |
| **0x Settler** `UniswapV4.sol` | `_pay` = `unsafeSync → transfer/permit2 → unsafeSettle` in one call (`:255-273`). Normal mode pays **after** all swaps (`:380-399`). Fee-on-transfer mode pays **before** the swaps but completes the settle first (`:299-301`). Native: `sync(0); settle(debt)` after the swaps (`:396-398`) | no | source read |
| v4-core `CurrencySettler` / OZ `CurrencySettler` / `PoolSwapTest` | atomic | no | swap-path §7 |
| Uniswap aggregator hooks (`BaseAggregatorHook`) | the hook's own `sync, send, settle` inside `beforeSwap` | n/a (same pattern as ours) | `BaseAggregatorHook.sol:104-105` |
| **KyberSwap** (dex-lib) | off-chain simulator: an unknown hook with swap flags → `ErrUnsupportedHook` | never reaches execution without a Go plugin in `pkg/liquidity-source/uniswap/v4/hooks/` (31 plugins today) | `pool_simulator.go:41-48` |
| 1inch, Odos, Velora/ParaSwap, OKX, CoW solvers | not reviewed (closed source or not found) | **UNVERIFIED** | — |

Conclusions:
- Every open-source v4 integrator we could read settles atomically, so the mint path is live for them.
- For unknown integrators the design stays safe: the mint path **fails closed**, and the inventory path (`restock()`) serves pre-sync routers (swap-path §3).
- A fork test against a closed aggregator's deployed executor would need its calldata format and is out of scope. Record it as a residual risk.
- Most aggregators other than 0x/Uniswap price v4 hook pools **off-chain** with per-hook simulators, so reaching them means contributing a simulator per aggregator. A BS-digital simulator would need our oracle state and σ, which is heavier than the "hooks the quoter can price" model Uniswap uses.

---

## 7. The proof surface for the build plan (fork tests)

Already implemented and passing on **Ethereum and Unichain forks** (12/12 each; `forge_test_output.txt`):

| test | proves |
|---|---|
| `test_UR212_singleHop_buyYes_matchesQuoterAndHookQuote` | deployed UR 2.1.2 + Permit2 buys YES from a hook-priced pool; execution = hook quote = **deployed** V4Quoter; pool `slot0`/L never change |
| `test_UR212_singleHop_sellYes` | the reverse direction through UR |
| `test_UR212_fiveFieldEncoding_revertsWithoutData` | a legacy (v2.0) encoding against our pool fails closed |
| `test_UR212_multiHop_ETH_USDC_YES_pricedAtSoB` | one-transaction route from the underlying market into the prediction market; SoB pricing; quoter = execution for multi-hop |
| `test_UR212_multiHop_afterEarlierSwapInSameBlock_stillSoB` | SoB is fixed by the first swap of the block |
| `test_UR212_multiHop_YES_USDC_NO_noProfit` | cross-outcome route through two hook pools; path independence; no free lunch |
| `test_halts_quoterAndRouterRevertData` | byte-exact halt surfaces for band, cutoff and cap at the quoter and at UR |
| `test_halt_softFailInsideSubPlan` | a UR batch can make a halted leg optional |
| `test_UR212_split_inV4Swap`, `test_UR212_merge_permit2TransferThenV4Swap`, `test_merge_withoutPrefund_reverts` | complete-set split and merge composed inside a UR transaction |
| `test_foreignInitialize_reverts` | pool set bounded (the ZLCA registry precondition) |

To add in the production project (same harness, real BS hook):
1. The same suite parameterised over **Base and Arbitrum** forks, with their UR 2.1.2 and quoter addresses (§1.3).
2. **Exact-output** single and multi-hop through UR 2.1.2 (the `V4ExactOutputUnfilled` semantics).
3. Gas: `forge snapshot` of `UR.execute` warm-path buy, sell, split, merge and the 2-hop route. That yields the `gasOverheadPerHop` figure for the ZLCA application.
4. A **UniswapX-filler-style** execution: a filler contract calls UR against our pool inside a `reactorCallback`. Optional.
5. A property test: for random `(block, amount, hookData ∈ {∅, split, merge})`, `quoter(q) == execution` and the S3 invariant holds.

---

## 8. Remaining open points

1. Admission to `HOOKS_ADDRESSES_ALLOWLIST`/`ZLCA_HOOKS_PER_CHAIN` is a Uniswap Labs decision. Only the eligibility can be proven (§5.2).
2. Protocol-fee policy for our pools: honour `slot0.protocolFee` or opt out (§5.1). This is a reviewer expectation, **UNVERIFIED**.
3. Getting `HookSwap` indexed needs a v4-subgraph data-source PR (§5.3).
4. Closed-source aggregators' settlement patterns and whether they list custom-accounting hooks (§6), **UNVERIFIED**.
5. The meaning of the "0x91…" address rule in the support article is unexplained. Avoid that prefix when mining the hook address.

---

## Verification

Verified in this session (primary sources):
- **UR tag → periphery pin → struct layout**, by `git ls-tree <tag> lib/v4-periphery`, `git show <commit>:src/interfaces/IV4Router.sol` and `git merge-base --is-ancestor`, on full clones (§1.1).
- **Deployed behaviour of UR v2.0, 2.1.1 and 2.1.2 on Ethereum, Base, Arbitrum and Unichain**, via live `eth_call` with balance overrides, 8 encodings × 3 routers × 4 chains plus the non-zero-`currency0` discriminator. Raw output is in `ur_probe_output.txt` and `ur_probe2_output.txt`.
- **Deployed V4Quoter `quoteExactInputSingle` works and `msgSender()` is absent** on all 4 chains (same files).
- **Fork tests** (§7): 12/12 pass on mainnet and 12/12 on Unichain, against the *deployed* PoolManager, UR 2.1.2, V4Quoter and Permit2. Every number in §2.3 and §3.1 comes from those runs.
- **Revert layering:** source (`Hooks.sol:137`, `CustomRevert.sol`, `BaseV4Quoter.sol:29-57`, `QuoterRevert.sol:35-41`, `UniversalRouter.sol:70-86`, `Dispatcher.sol:282-284, 312-314`) plus the byte-exact `vm.expectRevert` assertions.
- **V4Router action set and the absence of 6909 actions:** `V4Router.sol:34-80`, `Actions.sol:57-58`, `PermissionedPositionManager.sol:289-310`.
- **UniRoute admission logic** (`v4HooksPoolsFiltering.ts`, `hooksAddressesAllowlist.ts`, `subgraphProvider.ts`, `zlcaHookGasCalibration.ts`, `DeepQuoteStrategy.ts`) and **SOR failed-quote handling** (`on-chain-quote-provider.ts:540-640, 1355-1395`), by reading the source.
- **Support-article criteria**, verbatim from the Zendesk API (the HTML page returned 403 to WebFetch).
- **Subgraph event consumption:** `subgraph.yaml`, `networks.json`, `generate-subgraph.ts`, `src/mappings/swap.ts:27-44`. The PM `Swap` event emits the CL delta: `PoolManager.sol:230-250`.
- **0x Settler** `UniswapV4.sol:255-273, 299-301, 340, 380-399` and **KyberSwap** `pool_simulator.go:41-48`, `hooks.go:99-104`, by source read.
- **PermissionedV4Router** at `545a5d2` vs `a7af5b3`, by `git show`.
- **Hooklist statistics**, computed from `hooklist.json`.

Not verified, or caveats:
- Which exact source commit the deployed 2.1.x bytecode was built from. The behaviour was verified; the build commit was not. Whether 2.1.1 lacks the exact-out-unfilled revert on-chain was not fork-tested.
- Base and Arbitrum were probed by `eth_call` only. The full fork suite ran on mainnet and Unichain.
- The Uniswap allowlist decision process beyond the published article and the open-source UniRoute; whether the production routing-api differs from `uniroute-public` (**UNVERIFIED**).
- The "0x91…" rule's rationale, the protocol-fee expectation for NoOp hooks, and third-party indexers.
- Closed-source aggregators (1inch, Odos, Velora, OKX, CoW solvers): pre-sync behaviour and hook support are **UNVERIFIED**.
- The prototype's pricing is a stand-in (`S/(S+K)` ± 0.5¢). The gas figures come from cold fork state and are not production estimates.
