# Permissionless markets: design

**Date:** 2026-09-26. **Status:** phase 1 (scheduler) and phase 2 (SealedPoolOracle with proofs) approved in chat.

> **Superseded in part (2026-09-27).** The single `MarketScheduler` that owns the hook, its 120 s tenor with overlapping
> markets and its deploy flow are replaced by a `MarketGatekeeper` that owns the hook and runs four tracks (ETH, ETH15M,
> SOL, SOL15M), each with `tenor == period` and a `TooLate` deadline. See
> [2026-09-27-market-tracks-design.md](2026-09-27-market-tracks-design.md). Everything else here, including phase 2,
> still applies. The superseded passages are marked below.

## Goal

After this change, no key can create markets, change pricing or touch the oracle. Anyone can open, settle, sweep and redeem.
Settlement, redeem, sweep, deposit and withdraw are already permissionless. Two privileged powers remain today:

1. `PredictionHook.createMarket` accepts only `owner` or `keeper` (`src/PredictionHook.sol:137-138`). Both are our keys.
2. `UnderlyingOracleHook.setVarianceBounds` is `onlyOwner` (`src/oracle/UnderlyingOracleHook.sol:160`).

## Decisions

- **A new `MarketScheduler` contract owns a freshly deployed `PredictionHook`.** *(Superseded: a `MarketGatekeeper` owns
  the hook and forwards `createMarket` from its per-track schedulers only. The no-keeper property is unchanged.)*
  - The hook's code does not change. It has 144 bytes of room under the size limit and its tests stay valid.
  - The scheduler has no owner, no setters and no call to `setKeeper`, so `keeper` stays `address(0)` forever.
- **Base half-spread `h0 = 0.02` (2¢)**, the research minimum. It is fixed for this deployment.
- **The live oracle's ownership is renounced** after the new hook is deployed. That step is irreversible, and it keeps the price
  history.
- **Messaging:** "no external oracle", never "no oracles". The Uniswap pool is the price source.

## MarketScheduler

`src/MarketScheduler.sol`. All configuration is `immutable` and set in the constructor.

| Field | Demo value (Unichain Sepolia) | Meaning |
|---|---|---|
| `hook`, `oracle` | new hook, live oracle | fixed targets |
| `period` | 60 s | one market per period slot |
| `tenor` | 120 s | expiry = slot start + tenor, so expiries land on whole minutes |
| `window`, `cutoffBuffer`, `nSamples` | 10 s, 2 s, 10 | as today |
| `h0`, `gammaS`, `lambda`, `qEpochMax`, `pMin` | 0.02, 0.00002, 0.001, 100 tokens, 0.02 | only `h0` changes from today (0.01) |
| `maxBudget`, `minBudget` | 10 USDC, 1 USDC | budget rule below |
| `ticker` | "ETH" | names and symbols |

**`open() returns (uint256 marketId)`**, callable by anyone:
- `slot = block.timestamp / period`. It reverts `AlreadyOpened` when `slot <= lastSlot`, so there is one market per slot.
- `openTime = block.timestamp`, `expiry = slot * period + tenor`.
  - The constructor requires `tenor >= period + window + cutoffBuffer`.
  - That keeps the hook's `openTime + window + cutoffBuffer < expiry` check true even when `open()` is called in the slot's last
    second.
  - *(Superseded: the constructor now requires only `tenor > window + cutoffBuffer`, so `tenor == period` runs markets back to
    back, and `open()` reverts `TooLate(slot)` once `block.timestamp + window + cutoffBuffer >= expiry`.)*
- **Strike:**
  - `cents = round(expWad(oracle.lnSpotSoBWad()) / 1e16)` and `lnStrikeWad = lnWad(cents * 1e16)`. This is the same rounding as
    `script/CreateMarket.s.sol`.
  - The strike gives no edge: quotes use the live start-of-block price from the same oracle. Pushing the strike costs as much as
    pushing the oracle.
- **Budget:**
  - `min(maxBudget, hook.vaultIdle() / 2)`.
  - It reverts `InsufficientIdle` below `minBudget`.
  - Halving the free USDC lets two overlapping markets open even when the vault is short. Today the keeper skips those.
- **Names:**
  - UTC and built on-chain: `ETH > $2690.13 26 Sep 14:07` for UP and `ETH < $2690.13 26 Sep 14:07` for DOWN.
  - Symbols are `ETHUP` and `ETHDOWN`, the same format `script/CreateMarket.s.sol` produces today.
  - The formatting moves into a library, `src/lib/MarketNames.sol`, which both the scheduler and the script use.
- The function emits `MarketOpened(marketId, slot, caller, budget, strikeCents)`.
- Views: `lastSlot`, `nextOpenTime()`, and `canOpen()` (whether `open()` would succeed now).

## Deployment

*(Superseded: the gatekeeper takes the scheduler's place in this flow and deploys the schedulers itself, see
`script/base/TrackSet.sol` and `script/DeployTracks.s.sol`. `script/DeployScheduler.s.sol` is gone.)*

The two addresses depend on each other: the hook's constructor needs the scheduler address as `owner`, and the scheduler needs the
hook address.
- Predict the scheduler address from the deployer nonce with `vm.computeCreateAddress(deployer, nonce)`.
- Mine the hook salt with that owner.
- Deploy the scheduler (CREATE at `nonce`), then the hook through the CREATE2 factory.
- The script then asserts `hook.owner() == scheduler`, `scheduler.hook() == hook`, `hook.keeper() == address(0)` and the hook's
  permission bits.
- No other transaction from the deployer key may land in between, so the keeper is stopped first. If one does, the assertions fail
  and nothing is recorded.

**Scripts:**
- `script/DeployScheduler.s.sol` deploys the scheduler and a new hook against the existing oracle and pool, reading
  `deployments/unichain-sepolia.json`.
- `script/Deploy.s.sol`, the fresh full stack used by the local env and rehearsal, deploys the same pair. Local and live then stay
  identical.
- `script/RenounceOracle.s.sol` checks that the oracle's pool is bound, then calls `renounceOwnership()`. It runs through
  `script/sepolia.sh` behind `CONFIRM`.

**Live sequence on Unichain Sepolia.** I will ask before each irreversible step.

1. Stop the keeper. The mirror keeps running.
2. Deploy the scheduler and the new hook.
3. Settle and sweep the old hook's open markets. Withdraw the deployer's 35e12 shares and deposit the proceeds into the new vault.
4. Renounce the oracle's ownership.
5. Update `deployments/unichain-sepolia.json`:
   - new `predictionHook`, new `marketScheduler`, new `deployBlock`;
   - `legacyPredictionHooks: ["0x62bB…eaa8"]`.
6. Regenerate the fork's `deployment.generated.ts` with `packages/swap-sdk/scripts/vendor-interface.mjs`, restart the bots and dev
   servers, and check everything live.

## Off-chain changes

- **Bot:**
  - The keeper's create step calls `scheduler.open()`, simulating first and skipping on `AlreadyOpened`.
  - It needs no role. `hookOperator` and the market-template code used for creation go.
  - Settle and sweep are unchanged.
- **swap-sdk and indexer:**
  - Parse `marketScheduler` and `legacyPredictionHooks`.
  - The indexer indexes the new hook from the new `deployBlock`.
  - Old markets stay redeemable on the legacy hook through direct calls. The UI does not list them.
- **Copy:**
  - `web/src/app/page.tsx:14` changes from "No oracles." to "No external oracles.". README and RUNBOOK get the same change.
  - README and RUNBOOK also document the scheduler, the absence of admin roles and the testnet mirror as a stand-in for mainnet
    arbitrage.

## Testing

- **`test/scheduler/MarketScheduler.t.sol`:**
  - any address can open;
  - a second open in the same slot reverts;
  - the next slot opens;
  - expiry and names are right;
  - the strike matches `CreateMarket.s.sol` rounding;
  - the budget follows `min(max, idle/2)` and reverts below the minimum;
  - the hook's `owner` is the scheduler and `keeper` is `address(0)`;
  - direct `createMarket` from an EOA reverts `Unauthorized`.
- **Fuzz:** `open()` in any second of a slot yields params the hook accepts.
- **Existing suite:** passes unchanged, including `CreateMarketNames.t.sol` against the shared library.
- **Deploy script:** dry run on an Anvil fork of Unichain Sepolia.
- **Rehearsal:** open, buy UP through UniversalRouter, settle, redeem.
- **Bot:** unit tests for the new create step.

## Phase 2: SealedPoolOracle (mainnet price source on Unichain)

### Why

Mainnet has to stay on Unichain with no external oracle. Research on 2026-09-26 covered live Unichain data, prior art, and
state proofs from L1 and from L2:
- The only deep ETH/USDC pool on Unichain is the **hookless** v4 5 bp pool `0x3258…39d9`.
  - Its TVL is $20M. Its in-range virtual depth is $8.09M: L = 1.56e17, read on-chain.
  - A hook cannot be added to an existing pool.
- **Our own oracle-hooked pool:** safe only when small. It would need seed liquidity and a routing allowlist.
- **Reading the deep pool's `slot0` directly:** a same-transaction push, read and unwind costs about $38 per 1%. Unusable.
- **Unichain's v3 30 bp pool:** can be moved up to 0.3% for almost nothing, because of its fee band.
- **Proving L1 state:** always about 60 s stale.

`SealedPoolOracle` gives the deep hookless pool the same guarantee as `UnderlyingOracleHook`: no value can be moved by swaps
earlier in the same block. It also keeps a complete history with no gaps.

### Two facts it rests on

1. **Seal.**
   - In a pool with `L > 0` and `lpFee > 0`, every price-moving swap step charges at least 1 wei of LP fee and raises
     `feeGrowthGlobal0/1`. See `lib/v4-core/src/libraries/SwapMath.sol` (fee rounded up) and `Pool.sol:401-406`.
   - With `L == 0` a swap step is free: `Pool.sol` skips the fee-growth update. The seal therefore rests on a
     **precondition**: the pool's in-range liquidity never reaches zero between two pokes and is not controlled by one party.
     - A sole in-range LP can remove its liquidity, move the price for free, then restore the price and re-add the
       liquidity.
     - Liquidity added and removed around a poke inside one unlock fakes the snapshot's `L`.
     - No pool state reveals either. So the oracle is only for a deep pool with many independent LPs, like the 5 bp pool
       above.
   - A snapshot whose `sqrtPriceX96` is exactly a tick price never seals.
     - From a tick boundary, the first swap step can cross that tick at zero cost. If the far side has no liquidity, the
       rest of the move is free too, and a limit swap back re-crosses the tick and restores every word.
     - The reviewer's probes confirmed this at both the lower and upper edge, where the pool's tick is `T` or `T − 1` at
       `P(T)`. So checking `sqrtPriceX96 == P(tick)` alone misses the upper edge.
     - Strictly inside a tick, the first step of any price-moving swap has the snapshot's `L > 0`.
   - Suppose the tuple `(sqrtPriceX96, tick, feeGrowthGlobal0X128, feeGrowthGlobal1X128)` read in block `b` equals a
     snapshot taken in an earlier block `a`, the snapshot had `L > 0` and a price strictly inside a tick, and the
     precondition holds. Then no swap happened in between, so the pool's end state for every block from `a` to `b − 1` is
     that snapshot.
   - `sqrtPriceX96` alone is not enough: an attacker can restore it exactly with a price limit.
2. **Proof.**
   - A block header whose `keccak256` equals Unichain's own hash for block `k` gives that block's `stateRoot`.
   - The hash comes from `BLOCKHASH` for the last 256 blocks, then the EIP-2935 contract
     `0x0000F90827F1C53a10cb7A02335B175320002935` for 8,191 blocks. Both were verified live on Unichain mainnet and Sepolia on
     2026-09-26.
   - Older blocks use a header chain walked back from a known hash.
   - A Merkle-Patricia account proof of the PoolManager, plus a storage proof of `pools[poolId].slot0` (StateLibrary: slot
     `keccak256(poolId, 6)`), gives the pool's exact state at the end of block `k`.

### Contract

`src/oracle/SealedPoolOracle.sol` implements `IUnderlyingOracle`. The `PredictionHook` does not change. The contract has no owner
and no setters; everything is immutable.

**Configuration:**
- PoolManager, pool key or id, orientation sign and `decimalsShift`.
- Estimator parameters, with the same meaning as `UnderlyingOracleHook`: `gridSeconds`, `nWindows`, `minWindows`, `winsorTicks`
  and the variance bounds.
- `blockTime` (1 s on both chains).
- `maxStaleBlocks`.
- Observation cardinality.
- The constructor rejects a pool with a hook, a dynamic fee or `lpFee == 0`.

**Notation:**
- `E_k` is the pool state at the end of block `k`.
- The start-of-block (SoB) price of block `k` is `E_{k−1}`.
- The oracle keeps a **frontier** `K`: every `E_j` with `j ≤ K` has been applied, contiguously.
- Applying `E_j` credits its normalised tick to block `j + 1`'s time in the tick cumulative. This is the same "tick prevailing
  since the last write" semantics as `UnderlyingOracleHook`.
- `cumulativeAt(T) − cumulativeAt(T − window)` therefore averages SoB ticks over the window, exactly like today.

**`poke()`**, callable by anyone and at most once per block:
- It reads `slot0`, both fee-growth words and `liquidity` with one `extsload`.
- If the stored snapshot comes from an earlier block `a`, its tuple is unchanged, its `L > 0` and its `sqrtPriceX96` is not
  exactly a tick price, then the run `E_a … E_{b−1}` is proven.
- A proven run is applied if it starts at or before `K + 1`. Otherwise it is appended to a FIFO queue.
- The snapshot is then replaced with the live state at block `b`.

**`prove(...)` / `proveMany(...)`**, callable by anyone:
- Verifies the header, account and storage proofs for block `K + 1` and applies `E_{K+1}`.
- Then drains queued runs that are now contiguous.
- Proofs must be submitted in block order.
- `checkpointHeaders(headers[])` stores verified hashes of older blocks by walking parent hashes back from a known hash. A missed
  window can therefore always be recovered, so the oracle cannot die permanently.

**Views:**

| View | Behaviour |
|---|---|
| `lnSpotSoBWad()` / `sobTick()` | The SoB of the current block comes from the first of: `E_{number−1}` when `K == number − 1`; the queued run at the tail of the queue when it ends at `number − 1` (a poke in this block sealed it behind a gap); the snapshot, when the live tuple still equals it, it was taken in an earlier block and it passes the seal rules (a sealed view that needs no write); or `E_K` when `K ≥ number − 1 − maxStaleBlocks`. Otherwise the call reverts with `StaleSpot`, and trading halts because `quote()` returns zeros. |
| `cumulativeAt(t)` | Answers only for `t ≤ time(K + 1)`, or beyond that when the sealed view proves the live state has held since the frontier. It **never extrapolates across a gap**, so settlement waits for proofs. |
| `varianceE36()` | The same TWAP-return realised-variance estimator and policy as today, over contiguous history. |
| `frontier()`, `snapshot()`, `queueLength()` | Exposed for the bot. |

**Shared code:**
- The observation ring, the grid checkpoints and the estimator move into `src/oracle/TickAccumulator.sol`, an abstract contract.
- `UnderlyingOracleHook.sol` stays byte-for-byte unchanged, because it is live and its build matches the deployed bytecode.
- A differential test checks that both produce the same cumulatives and variance for the same price path.

**Proof libraries:**
- Optimism contracts-bedrock `RLPReader`, `MerkleTrie`, `SecureMerkleTrie` and `Bytes` (MIT), vendored unmodified under
  `src/vendor/optimism/` with the pinned commit.
- `src/oracle/PoolStateProof.sol` holds the header decode (fields 3 `stateRoot`, 8 `number` and 11 `timestamp` of the 21-field
  Isthmus header) and the account and slot0 proofs.
- Measured cost per proven block:
  - about 0.61M gas of execution: header decode ~42k, account and storage proofs ~525k, applying the state ~42k;
  - about 0.72M per transaction once the 21k intrinsic cost and ~108k of proof calldata are added.
  - That is still a fraction of a cent at Unichain gas prices.
- One proof that drains a full queue of 256 one-block runs costs about 8.6M gas of execution. The bot sizes `proveMany`
  batches with this in mind.

### Prover and poker bot

`bot/src/sealed.ts`, run as `script/bots.sh start … sealed`:
- It pokes every block.
- It watches `frontier()` against the head and proves every block the seal could not cover, in order and batched.
- It rebuilds headers from `eth_getBlockByNumber`. The public RPC has no `debug_getRawHeader`. The rebuilt header's `keccak`
  must equal the block hash before anything is sent.
- It uses `eth_getProof`, which drpc, publicnode and mainnet.unichain.org all serve.
- It needs no role and can only advance the truth.

### Phase 2 testing

- **Seal unit tests** on a local PoolManager with a hookless 5 bp pool:
  - an idle run proves;
  - any swap, donate or same-transaction push-and-restore to the exact `sqrtPriceX96` breaks the seal;
  - a zero-liquidity snapshot never seals;
  - one poke per block.
- **Fuzz** over random swap, poke and proof sequences: the frontier only moves forward, and the cumulative equals a brute-force
  reference built from end-of-block states.
- **Differential test** against `UnderlyingOracleHook` on the same price path: identical `cumulativeAt`, `varianceE36` and SoB
  values.
- **Proof tests** with real Unichain mainnet fixtures (headers plus `eth_getProof`) for the deep pool:
  - valid proofs are accepted;
  - a tampered header, account node or storage node is rejected;
  - a wrong block number or a hash outside the window is rejected;
  - header-chain checkpoints work;
  - gas is recorded.
- **Header encoder test** in the bot: the rebuilt hash equals the RPC hash for recent Unichain mainnet and Sepolia blocks.
- **End-to-end on Anvil** (local chain, real `eth_getProof`):
  - PoolManager, hookless pool, `SealedPoolOracle`, `PredictionHook` and scheduler;
  - the bot pokes and proves while swaps create gaps;
  - a market opens, trades and settles with a complete history.
- **Fork test on Unichain mainnet:** poke the real `0x3258…39d9` pool across rolled blocks. Sealed spot must equal `slot0` and
  track the pool.

Phase 2 does not change the testnet demo. It keeps `UnderlyingOracleHook`, because the mirror bot trades the demo pool almost
every second.

## Out of scope

- An "open market" button in the dashboard.
- Indexing the legacy hook.
- A mainnet deployment of either phase. Phase 2 is proven by tests against real Unichain mainnet state.
- On-chain parameter bounds inside the hook. The scheduler is the only creator, and its immutable settings are the bounds.

## Risks

- **Two-minute markets remain outside the research's backtests.** The 2¢ spread lowers LP risk but does not remove it.
  *(Superseded: the tracks run 1-minute and 15-minute markets; the same caveat applies to both.)*
- **Names are in UTC**, as the keeper's default was. Screens that show local time format it from `expiry`.
- **The deployer nonce could shift between simulation and broadcast.** The post-deploy assertions catch it; the only cost is
  wasted gas.
- **The seal is new.** No prior art was found. Its soundness rests on the two facts above and on the tests.
  - If a protocol fee is ever turned on, a dust swap (below about 2,000 wei of input) can carry zero LP fee. Moving the price 1%
    that way takes about 4e7 swaps.
  - A 1-wei `donate` can break a seal. That only forces a proof, costing about $0.002 per block.
  - The seal needs the liquidity precondition from fact 1: the in-range liquidity never reaches zero and is not controlled
    by one party. A pool where one party holds all in-range liquidity, or can flash it in and out around a poke, can
    have its seals forged. Nothing on-chain detects this, so the pool choice is the defence.
  - A snapshot on an exact tick price is refused, because of a free tick crossing into an empty range. This only costs a
    proof when the price happens to end a block exactly on a tick.
- **A block-time change halts the oracle for good.**
  - `poke` and `prove` both require `block.timestamp == anchorTs + (n − anchorBlock) * blockTime`.
  - If Unichain ever changes its block time, both revert from then on and the frontier stops. The spot goes stale, so
    trading halts, and open markets fall to `settleInvalid` after `GRACE`.
  - The oracle must then be redeployed with a new anchor.
  - Tests and rehearsals must advance the timestamp by `blockTime` with every block: `vm.warp` with every `vm.roll`,
    and one-second Anvil blocks in Tasks 8 and 9.
- **Proof liveness.** If no one proves within the 1 h `GRACE` after expiry, anyone can call `settleInvalid`, which pays 50/50. The
  bot keeps the frontier within a few blocks of the head. `checkpointHeaders` recovers from outages, so proofs are always
  possible.
- **Real money needs windows of at least 30 minutes.** A 10 s window is demo-only at any depth. Research cost to bias
  settlement by 0.3%: about $6.6k over 5 min and about $40k over 30 min on the $8.09M pool.
