# Permissionless Markets and SealedPoolOracle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** remove every privileged role from Phinary (phase 1), and give it a Unichain mainnet price source with no external oracle
(phase 2).
- **Phase 1:** an ownerless `MarketScheduler` owns a redeployed `PredictionHook`.
- **Phase 2:** `SealedPoolOracle` reads the deep hookless ETH/USDC pool through fee-growth seals and state proofs.

**Architecture:**
- **Phase 1:** a new contract sits in front of the unchanged hook. It computes strike, times, names and budget, and it is the only
  account that can call `createMarket`.
- **Phase 2:** a new `IUnderlyingOracle` implementation keeps a contiguous history of end-of-block states for a pool with no hook.
  - Each state is proven either by an unchanged `(sqrtP, feeGrowth0, feeGrowth1)` tuple between two pokes, or by a
    Merkle-Patricia storage proof checked against Unichain's own block hash.
  - It shares the observation and variance code with `UnderlyingOracleHook` through a new abstract `TickAccumulator`.
- **Bots:** they only call permissionless functions.

**Tech Stack:**
- Solidity 0.8.26 (via-IR, cancun), Foundry 1.8.3, v4-core, solady.
- Vendored Optimism contracts-bedrock trie and RLP libraries.
- TypeScript on Node 24 with viem (bot, swap-sdk, indexer).

**Spec:** `docs/md/superpowers/specs/2026-09-26-permissionless-markets-design.md`

## Global Constraints

**Unchanged and immutable:**
- `src/PredictionHook.sol` and `src/oracle/UnderlyingOracleHook.sol` stay byte-for-byte unchanged. `git diff` on both must be
  empty.
- `MarketScheduler` and `SealedPoolOracle` have no owner, no setters and no upgrade path. All configuration is `immutable`.

**Demo scheduler values (Unichain Sepolia):**

| Parameter | Value |
|---|---|
| `period` | 60 |
| `tenor` | 120 |
| `window` | 10 |
| `cutoffBuffer` | 2 |
| `nSamples` | 10 |
| `h0Wad` | 0.02e18 |
| `gammaSWad` | 0.00002e18 |
| `lambdaWad` | 0.001e18 |
| `qEpochMax` | 100e6 |
| `pMinWad` | 0.02e18 |
| `maxBudget` | 10e6 |
| `minBudget` | 1e6 |
| `ticker` | "ETH" |

- Constructor rule: `tenor >= period + window + cutoffBuffer`.
- Budget: `min(maxBudget, hook.vaultIdle() / 2)`. Revert when it is below `minBudget`.
- Names: `ETH > $2690.13 26 Sep 14:07` and `ETH < $2690.13 26 Sep 14:07`. Symbols: `ETHUP` and `ETHDOWN`. UTC.

**Unichain mainnet (chain 130):**

| Item | Value |
|---|---|
| PoolManager | `0x1F98400000000000000000000000000000000004` |
| USDC | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` |
| Deep pool | id `0x3258f413c7a88cda2fa8709a589d221a80f6574f63df5a5b6774485d8acc39d9`: native ETH / USDC, fee 500, tick spacing 10, no hook |
| Orientation | sign +1, `decimalsShift` 12 |
| EIP-2935 | `0x0000F90827F1C53a10cb7A02335B175320002935` |
| Block time | 1 s (the same on Unichain Sepolia) |
| RPCs | `https://mainnet.unichain.org`, `https://unichain.drpc.org` |

- `cast block <n> --raw` returns the RLP header whose `keccak` equals the block hash. It was checked live.
- Pool state storage slot: `keccak256(abi.encodePacked(poolId, bytes32(uint256(6))))`. Offsets: `+1` fg0, `+2` fg1,
  `+3` liquidity (`lib/v4-core/src/libraries/StateLibrary.sol`).

**Copy:**
- "No external oracles" everywhere; never "No oracles".
- No em dashes in any UI copy or docs.

**Git and secrets:**
- Commits are authored by `oynozan <oynozan@hotmail.com>`.
- No Claude co-author line and no "Day N" wording.
- Everything lands on `main`. Worktree branches are folded into `main` and deleted.
- Never print or commit `.env` values.

**Test fixtures:** live under `test/vectors/` (already readable via `fs_permissions`).

## Review Focus

1. **Oracle reverts during `open()`**, for example a stale spot. `open()` must revert and leave `lastSlot` unchanged, so no market
   is created with a bad strike. Test in Task 2.
2. **A header whose timestamp disagrees with `anchorTs + (n − anchorBlock) * blockTime`**, which would follow an OP Stack
   block-time change. `prove` must revert `BadTimestamp` and leave the cumulative untouched. Test in Task 7.
3. **Bot restart with the frontier more than 256 blocks, and more than 8191 blocks, behind the head.** The bot must catch up
   through EIP-2935 and then through `checkpointHeaders`. Test in Task 8 (256) and Task 9 (8191 with a mocked 2935 window).
4. **Settlement while the frontier is below `expiry`.** `settle` reverts until the proofs land, then settles to the brute-force
   answer. Test in Task 9.
5. **Name formatting at the edges:** strikes of at least $10,000, below $1, and exactly x.x0; expiries at UTC midnight, Dec 31 and
   Feb 29. Test in Task 1.

---

### Task 1: MarketNames library

**Files:**
- Create: `src/lib/MarketNames.sol`
- Modify: `script/CreateMarket.s.sol`. Replace `_strikeCents`, `_date`, `_hhmm`, `_two` and `_formatUnits(cents,2,2)` with library
  calls.
- Test: `test/lib/MarketNames.t.sol`. `test/script/CreateMarketNames.t.sol` must keep passing unchanged.

**Interfaces:**
- Produces, for `library MarketNames` (all `internal pure`):
  - `strikeCents(int256 lnSpotWad) returns (uint256)`, which is `(expWad(lnSpotWad) + 0.5e16) / 1e16`;
  - `lnStrikeWad(uint256 cents) returns (int256)`, which is `lnWad(int256(cents * 1e16))`;
  - `formatCents(uint256 cents) returns (string memory)`, e.g. `"2690.13"` or `"0.05"`, with no thousands separator;
  - `date(uint256 t) returns (string memory)`, e.g. `"26 Sep"` in UTC;
  - `hhmm(uint256 t) returns (string memory)`, e.g. `"14:07"` in UTC;
  - `names(string memory ticker, uint256 cents, uint256 expiry) returns (string memory yesName, string memory noName,
    string memory yesSymbol, string memory noSymbol)`.
- Uses solady `LibString.toString` in place of `vm.toString`.

- [ ] **Step 1:** Write `test/lib/MarketNames.t.sol` through an external harness:
  - Copy every assertion from `test/script/CreateMarketNames.t.sol:23-33`.
  - `formatCents`: `2690_13` → "2690.13", `1_000_000_05` → "1000000.05", `5` → "0.05", `100` → "1.00".
  - `names("ETH", 269013, 1790346660)` returns `("ETH > $2690.13 25 Sep 14:31", "ETH < $2690.13 25 Sep 14:31", "ETHUP",
    "ETHDOWN")`.
  - Fuzz: `strikeCents(lnStrikeWad(c)) == c` for `c` in `[1, 1e12]`.
- [ ] **Step 2:** Run `forge test --match-path test/lib/MarketNames.t.sol`. Expected: compile failure, because `MarketNames` does
  not exist yet.
- [ ] **Step 3:** Implement `src/lib/MarketNames.sol`, then switch `script/CreateMarket.s.sol` to it. Delete its private helpers.
- [ ] **Step 4:** Run `forge test --match-path 'test/{lib,script}/*'`. Expected: all pass.
- [ ] **Step 5:** Commit `feat: MarketNames library shared by the market script and scheduler`.

### Task 2: MarketScheduler

**Files:**
- Create: `src/interfaces/IMarketScheduler.sol` and `src/MarketScheduler.sol`
- Test: `test/scheduler/MarketScheduler.t.sol`. Reuse `test/hook/HookFixture.sol` for the PoolManager, USDC, oracle mock and hook
  deployment. Deploy the hook with `owner = address(scheduler)`, predicted with `vm.computeCreateAddress`.

**Interfaces:**
- Consumes: `MarketNames` from Task 1; `IPredictionHook.createMarket`, `vaultIdle`, `MarketParams` and `QuoteParams`;
  `IUnderlyingOracle.lnSpotSoBWad`.
- Produces:

```solidity
interface IMarketScheduler {
    struct Config {
        uint32 period; uint32 tenor; uint32 window; uint32 cutoffBuffer; uint32 nSamples;
        IPredictionHook.QuoteParams quote; uint256 maxBudget; uint256 minBudget; string ticker; // ticker 1..6 chars
    }
    error AlreadyOpened(uint256 slot);
    error InsufficientIdle(uint256 budget, uint256 minBudget);
    error InvalidConfig();
    event MarketOpened(uint256 indexed marketId, uint256 indexed slot, address indexed caller, uint256 budget, uint256 strikeCents);
    function open() external returns (uint256 marketId);
    function canOpen() external view returns (bool);
    function nextOpenTime() external view returns (uint256);
    function lastSlot() external view returns (uint256);
    function hook() external view returns (IPredictionHook);
    function oracle() external view returns (address);
    function config() external view returns (Config memory);
}
```

- Constructor: `constructor(IPredictionHook hook_, address oracle_, Config memory c)`.
- Every field is an immutable. The ticker is stored with `LibString.toSmallString`.
- `open()` builds `MarketParams` with `openTime = block.timestamp`, `expiry = slot * period + tenor`, `sigmaMode = 0`,
  `fixedVarE36 = 0` and `kernel = 0`.

- [ ] **Step 1:** Write the tests:
  - `test_anyoneOpens`: `vm.prank(address(0xBEEF))`, then check `marketCount` becomes 1 and `lastSlot == block.timestamp / 60`.
  - `test_secondOpenSameSlotReverts`: expect `AlreadyOpened`.
  - `test_nextSlotOpens`.
  - `test_expiryOnMinuteBoundary`: open at `t = 60k + 59`, expect expiry `60k + 120`.
  - `test_namesAndSymbols`: via `IERC20Metadata` of `marketInfo(id).yes` / `.no`.
  - `test_strikeMatchesScriptRounding`: `lnStrikeWad == MarketNames.lnStrikeWad(MarketNames.strikeCents(spot))`.
  - `test_budgetRule`: idle 33e6 gives 10e6; idle 12e6 gives 6e6; idle 1.5e6 reverts `InsufficientIdle`.
  - `test_ownerIsSchedulerKeeperZero`, and `test_eoaCreateMarketReverts` with `Unauthorized`.
  - `test_oracleRevertKeepsSlot` (Review Focus 1).
  - `test_canOpenMirrorsOpen`.
  - `test_constructorRejectsShortTenor`, which expects `InvalidConfig`.
  - Fuzz `testFuzz_openAnySecondOfSlot(uint256 s)`, which warps to `slotStart + s % 60`, succeeds, and passes the hook's
    parameter check.
- [ ] **Step 2:** Run `forge test --match-path test/scheduler/MarketScheduler.t.sol`. Expected: fails to compile.
- [ ] **Step 3:** Implement `IMarketScheduler.sol` and `MarketScheduler.sol`.
- [ ] **Step 4:** Run the file's tests, then the whole suite with `forge test`. Expected: all pass.
  `git diff --exit-code src/PredictionHook.sol src/oracle/UnderlyingOracleHook.sol` must also pass.
- [ ] **Step 5:** Commit `feat: ownerless MarketScheduler that opens one market per slot`.

### Task 3: Deploy scripts for the scheduler and hook pair

**Files:**
- Create: `script/DeployScheduler.s.sol` and `script/RenounceOracle.s.sol`
- Modify:
  - `script/Deploy.s.sol`: `_deployPredictionHook` now deploys the pair; `_verify` asserts `hook.owner() == scheduler`; `_write`
    adds `marketScheduler`.
  - `script/sepolia.sh`: add the `scheduler` and `renounce-oracle` commands, both behind `CONFIRM`.
- Test: `test/script/DeployScheduler.t.sol`

**Interfaces:**
- Consumes: `MarketScheduler` and `Config` from Task 2.
- Produces:
  - JSON keys `marketScheduler` (address) and `legacyPredictionHooks` (address array) in `deployments/<network>.json`.
  - `DeployScheduler.run()` reads the oracle and USDC from the existing JSON. It moves the old `predictionHook` into
    `legacyPredictionHooks`. It reads the config from env with the defaults above (the same env names as `bot/src/config.ts`:
    `MARKET_*`, `QUOTE_*`) plus `SCHEDULER_PERIOD_SEC=60` and `SCHEDULER_MIN_BUDGET_USDC=1`.

**Address prediction (hook needs the scheduler address, scheduler needs the hook address):**
1. `n = vm.getNonce(deployer)`.
2. `scheduler = vm.computeCreateAddress(deployer, n)`.
3. Mine the hook salt with `owner = scheduler`.
4. Deploy `MarketScheduler` (CREATE at nonce `n`).
5. Deploy the hook through the CREATE2 factory (nonce `n + 1`).
6. Assert the predicted addresses, `hook.keeper() == address(0)` and the flags `0x2AA8`.

- [ ] **Step 1:** Write `test/script/DeployScheduler.t.sol`:
  - It runs the script's internal deploy on a local PoolManager with a mock oracle.
  - It asserts the owner, keeper, flags, addresses and the JSON written to a temp path under `deployments/`.
- [ ] **Step 2:** Run `forge test --match-path test/script/DeployScheduler.t.sol`. Expected: fails.
- [ ] **Step 3:** Implement both scripts and the `Deploy.s.sol` changes.
  - `RenounceOracle` requires `feedInfo().lastWriteTime != 0` (pool bound), then calls `renounceOwnership()`.
  - It then asserts `owner() == address(0)`.
- [ ] **Step 4:** Run the file's tests. Then do a dry run on an Anvil fork of Unichain Sepolia:
  `anvil --fork-url https://unichain-sepolia.drpc.org` plus `forge script script/DeployScheduler.s.sol --rpc-url
  http://127.0.0.1:8545 --broadcast` with a funded test key.
  - Expected: the assertions pass, and `cast call <scheduler> 'open()'` succeeds on the fork after `Fund`.
  - Do not touch the real `deployments/unichain-sepolia.json`: write to `deployments/unichain-sepolia-fork.json` through
    `DEPLOYMENTS_FILE`.
- [ ] **Step 5:** Commit `feat: deploy script for the scheduler-owned hook and oracle renounce`.

### Task 4: Off-chain phase 1 (swap-sdk, bot, indexer, copy)

**Files:**
- Modify:
  - `packages/swap-sdk/scripts/gen-abi.mjs`, which adds `marketScheduler.generated.ts`;
  - `packages/swap-sdk/src/abi/index.ts`;
  - `packages/swap-sdk/src/deployments.ts`, which parses `marketScheduler?: Address` and `legacyPredictionHooks: Address[]`,
    defaulting to `[]`;
  - `bot/src/keeper.ts` and `bot/src/config.ts`;
  - `bot/src/abi.ts`;
  - `indexer/src/deployment.ts` (no behaviour change beyond reading the new fields);
  - `web/src/app/page.tsx:14`;
  - `README.md` and `docs/md/RUNBOOK.md`.
- Test:
  - `packages/swap-sdk/test/deployments.test.ts`;
  - `bot/test/mirror-keeper.test.ts` (keeper part) and `bot/test/anvil.test.ts`;
  - `indexer/test/deployment.test.ts`.

**Interfaces:**
- Consumes: `IMarketScheduler` from Task 2 and the JSON keys from Task 3.
- Produces:
  - `Keeper.createMarket(now)` now simulates `scheduler.open()`, sends it, and treats `AlreadyOpened` as "done for this slot".
  - `hookOperator`, `buildMarketParams` and the market-template env parsing go. `settleAndSweep` is unchanged.

- [ ] **Step 1:** Update the tests:
  - The keeper test expects `open` to be called with no args. A second tick in the same slot sends nothing.
  - The deployments test parses both new keys and keeps the old files valid.
  - The Anvil keeper test uses the Task 3 pair.
- [ ] **Step 2:** Run `npm test` in `bot/`, `packages/swap-sdk/` and `indexer/`. Expected: the new assertions fail.
- [ ] **Step 3:** Implement the changes. Regenerate the ABIs with `node packages/swap-sdk/scripts/gen-abi.mjs` after `forge build`.
  Copy changes:
  - `page.tsx`: "No external oracles. No servers. Only Uniswap v4."
  - README and RUNBOOK: document the scheduler, the absence of admin roles, the mirror as a testnet stand-in for arbitrage, and
    "no external oracle".
- [ ] **Step 4:** Run `npm run check` in `bot/`, `npm test` in `packages/swap-sdk/` and `indexer/`, and `npm run lint && npx tsc
  --noEmit` in `web/`. Expected: all pass. `grep -rn "No oracles" web/src README.md docs/md/RUNBOOK.md` must return nothing.
- [ ] **Step 5:** Commit `feat: keeper opens markets through the scheduler; copy says no external oracles`.

### Task 5: TickAccumulator (shared observation and variance core)

**Files:**
- Create: `src/oracle/TickAccumulator.sol` (abstract contract)
- Test: `test/oracle/TickAccumulatorDiff.t.sol`, a differential test against `UnderlyingOracleHook` using `OracleTestBase.sol`

**Interfaces:**
- Produces, for `abstract contract TickAccumulator`:
  - Constructor args, with the same meaning and validation as `UnderlyingOracleHook`: `(uint32 h, uint16 nWindows,
    uint16 minWindows, uint32 winsorTicks, uint256 varMinE36, uint256 varMaxE36, uint256 fallbackVarE36, uint16 cardinality)`.
    All immutable; no setters.
  - `function _init(uint32 t) internal`: the first observation `(t, 0)`.
  - `function _accrue(uint32 t, int256 normTick) internal`: credits `normTick` over `(lastTime, t]`, with the same observation
    ring, segments and window statistics as `UnderlyingOracleHook._write` (`:322-347` and `_cross`).
  - `function _lastTime() internal view returns (uint32)`
  - `function _cumulativeAt(uint32 t) internal view returns (int56)`: answers only for `t <= _lastTime()`, and reverts
    `ObservationUnavailable(t)` otherwise.
  - `function _variance(uint32 now_) internal view returns (uint256 varPerSecE36, bool warm)`: the estimator over completed grids
    up to `now_ <= _lastTime()`.
  - `function _oldestTime() internal view returns (uint32)`

- [ ] **Step 1:** Write the differential tests:
  - Drive a hooked pool (`UnderlyingOracleHook`) and a `TickAccumulator` harness with the same seeded random path: swaps at
    random 1–30 s gaps and random tick moves.
  - For the harness, call `_accrue(t_b, tick(E_{b−1}))` exactly where the hook writes.
  - Assert equal `cumulativeAt(t)` at 200 random past `t`, and equal `varianceE36()`, at 5 checkpoints taken right after a write,
    including before and after `minWindows` and after a ring wrap with cardinality 16.
- [ ] **Step 2:** Run `forge test --match-path test/oracle/TickAccumulatorDiff.t.sol`. Expected: fails to compile.
- [ ] **Step 3:** Implement it by moving, not re-deriving, the logic from `UnderlyingOracleHook` into the abstract contract.
  - Parameters replace its `poolManager.getSlot0` reads.
  - `UnderlyingOracleHook.sol` itself is not modified.
- [ ] **Step 4:** Run the diff test and `forge test --match-path 'test/oracle/*'`. Expected: all pass, and
  `git diff --exit-code src/oracle/UnderlyingOracleHook.sol`.
- [ ] **Step 5:** Commit `feat: TickAccumulator with the oracle hook's estimator, differential-tested`.

### Task 6: Proof stack (headers, block hashes, pool state proof)

**Files:**
- Create:
  - `src/vendor/optimism/{RLPReader,MerkleTrie,SecureMerkleTrie,Bytes}.sol`, copied unmodified from
    `ethereum-optimism/optimism` `packages/contracts-bedrock/src/libraries/` at a pinned commit. Record the commit and the MIT
    license in `src/vendor/optimism/README.md`. Only the pragma and import paths may be adjusted.
  - `src/oracle/PoolStateProof.sol`
  - `src/oracle/BlockHashes.sol`
  - `script/fixtures/unichain-proof.sh`, which writes fixtures with `cast block --raw` and `cast rpc eth_getProof`.
  - `test/vectors/unichain/pool-proof-<block>.json`: three blocks; at least two where the deep pool's `slot0` differs.
- Test: `test/oracle/PoolStateProof.t.sol`

**Interfaces:**
- Produces:

```solidity
library PoolStateProof {
    struct Header { bytes32 parentHash; bytes32 stateRoot; uint256 number; uint256 timestamp; }
    error BadHeader();
    error BadAccountProof();
    error BadStorageProof();
    /// RLP list fields 0, 3, 8, 11 of the 21-field Isthmus header
    function decodeHeader(bytes calldata rlp) internal pure returns (Header memory);
    /// storage root of `account` from its account proof, then pools[poolId].slot0 from the storage proof
    function slot0At(bytes32 stateRoot, address account, bytes32 poolId, bytes[] calldata accountProof, bytes[] calldata slotProof)
        internal pure returns (uint160 sqrtPriceX96, int24 tick);
}
abstract contract BlockHashes {
    address internal constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    error UnknownBlockHash(uint256 n);
    event HeadersCheckpointed(uint256 oldest, uint256 newest);
    /// BLOCKHASH within 256, else EIP-2935 within 8191 (staticcall, 32-byte input, empty/zero = unknown), else stored checkpoint, else 0
    function blockHashOf(uint256 n) public view returns (bytes32);
    /// headers newest first: keccak(h[0]) == blockHashOf(number(h[0])), keccak(h[i+1]) == parentHash(h[i]); stores every hash
    function checkpointHeaders(bytes[] calldata headersNewestFirst) external;
}
```

- [ ] **Step 1:** Generate the fixtures:
  - Run `script/fixtures/unichain-proof.sh <block>` against `https://unichain.drpc.org` for the head minus 20, 40 and 60.
  - The fixture records the block, the raw header, the block hash, the account proof, the slot0 storage proof and the expected
    `(sqrtPriceX96, tick)` from `cast call StateView getSlot0` at that block.
- [ ] **Step 2:** Write the tests:
  - `test_decodeHeaderFields` checks `number`, `timestamp`, `stateRoot` and `parentHash` against the fixture.
  - `test_slot0AtMatchesStateView` covers all three fixtures.
  - `test_rejectsTamperedHeader`, `test_rejectsTamperedAccountNode`, `test_rejectsTamperedStorageNode` and
    `test_rejectsWrongPoolId`.
  - `test_blockHashWindows`:
    - `vm.roll` to the fixture block plus 10, then use `vm.setBlockhash`;
    - roll plus 300 with `vm.etch(HISTORY, mock)`;
    - roll plus 9000, which is unknown.
  - `test_checkpointHeadersWalksBack` uses three consecutive fixture headers.
  - `test_gas` logs the verify gas with `vm.lastCallGas` or snapshot gas. Expected around 0.47M. Record it.
- [ ] **Step 3:** Run `forge test --match-path test/oracle/PoolStateProof.t.sol`. Expected: fails to compile.
- [ ] **Step 4:** Implement the vendored copy, `PoolStateProof` and `BlockHashes`.
- [ ] **Step 5:** Run the file's tests. Expected: all pass.
- [ ] **Step 6:** Commit `feat: Unichain state-proof verification for v4 pool slot0 with block-hash windows`.

### Task 7: SealedPoolOracle

**Files:**
- Create: `src/interfaces/ISealedPoolOracle.sol` and `src/oracle/SealedPoolOracle.sol`
- Test:
  - `test/oracle/SealedPoolOracle.t.sol`, with a local PoolManager, a hookless 5 bp ETH/USDC pool and a harness that exposes
    `_applyProven(block, sqrtP, tick)`;
  - `test/oracle/SealedPoolOracleFuzz.t.sol`.

**Interfaces:**
- Consumes:
  - `TickAccumulator` (Task 5);
  - `PoolStateProof`, `BlockHashes` (Task 6).
- Produces:

```solidity
interface ISealedPoolOracle is IUnderlyingOracle {
    struct BlockProof { bytes header; bytes[] accountProof; bytes[] slotProof; }
    error NotNextBlock(uint256 expected, uint256 got);
    error BadTimestamp(uint256 expected, uint256 got);
    error StaleSpot(uint256 frontier, uint256 blockNumber);
    error NotStarted();
    error InvalidPool();
    event Sealed(uint256 fromBlock, uint256 toBlock, int24 normTick);
    event Queued(uint256 fromBlock, uint256 toBlock);
    event Proven(uint256 blockNumber, int24 normTick);
    function poke() external returns (bool sealedRun);
    function prove(BlockProof calldata p) external;
    function proveMany(BlockProof[] calldata ps) external;
    function frontier() external view returns (uint256);          // K; 0 before start
    function snapshot() external view returns (uint64 blockNumber, uint160 sqrtPriceX96, uint256 fg0, uint256 fg1, uint128 liquidity);
    function queueLength() external view returns (uint256);
    function blockTimeOf(uint256 n) external view returns (uint32); // anchorTs + (n - anchorBlock) * blockTime
}
```

**Constructor:** `(IPoolManager pm, PoolKey key, int8 sign, int16 decimalsShift, uint32 blockTime, uint16 maxStaleBlocks,
TickAccumulator args…)`.
- `prove` verifies and then calls `internal _applyProven(uint256 n, uint160 sqrtPriceX96, int24 rawTick)`. The test harness
  exposes that function directly.
- Reverts `InvalidPool` if `key.hooks != address(0)`, the fee is dynamic, or the fee is 0.
- Stores the anchor as `(block.number, block.timestamp)`.

**Rules (spec, Phase 2 Contract):**
- Applying `E_j` is `_accrue(blockTimeOf(j + 1), normTick(E_j))`. The first applied item calls `_init(blockTimeOf(start))`.
- A sealed run `[a, b − 1]` that starts at or before `K + 1` is applied as one `_accrue(blockTimeOf(b), tick)`. Otherwise it is
  queued (FIFO, a ring of 256 entries; if the queue is full, the oldest run is dropped and must be re-proven).
- `prove` requires `number == K + 1` (or, when not started, any `number >= anchorBlock − 256`).
  - It requires `keccak(header) == blockHashOf(number)` and `timestamp == blockTimeOf(number)`.
  - It applies the proven state, then drains the queue.
- There is one poke per block. A second call in the same block returns `false` and does nothing.

**Tests (Step 1 of this task):**
- `test_idleRunSeals`: poke, roll 5 blocks, poke. The frontier is `b − 1` and `cumulativeAt` equals `tick * 5`.
- `test_swapBreaksSeal`, `test_donateBreaksSeal`.
- `test_pushRestoreSameTxBreaksSeal`: swap up, then swap back with `sqrtPriceLimitX96` equal to the original price. `sqrtP` is
  equal but fee growth moved, so there is no seal.
- `test_zeroLiquiditySnapshotNeverSeals`.
- `test_onePokePerBlock`.
- `test_gapThenProofDrainsQueue`, which uses the harness `_applyProven`.
- `test_proveRejectsWrongNumber` (`NotNextBlock`) and `test_proveRejectsBadTimestamp` (Review Focus 2).
- Spot:
  - `test_spotSealedView`: no poke in the current block, but the live state equals the snapshot, so spot equals the snapshot.
  - `test_spotStaleWithinLimit`.
  - `test_spotRevertsBeyondLimit`: `StaleSpot`, and the hook's `quote()` returns zeros.
- `test_cumulativeNeverExtrapolatesAcrossGap`: `ObservationUnavailable`.
- `test_constructorRejectsHookedOrDynamicOrZeroFee`.
- Fuzz over random swap, poke, roll and harness-proof sequences:
  - `frontier` never decreases;
  - `cumulativeAt(t)` for every `t ≤ time(K + 1)` equals a brute-force sum over the true end-of-block ticks recorded by the test
    after each block.

- [ ] **Step 1:** Write the tests above.
- [ ] **Step 2:** Run `forge test --match-path 'test/oracle/SealedPoolOracle*'`. Expected: fails to compile.
- [ ] **Step 3:** Implement `ISealedPoolOracle.sol` and `SealedPoolOracle.sol`.
  - Read the four state words with one `extsload(stateSlot, 4)`.
  - Views follow the spec's view table exactly.
  - `varianceE36` uses `_variance(min(block.timestamp, lastTime))`.
- [ ] **Step 4:** Run the oracle tests and the full `forge test`. Expected: all pass.
- [ ] **Step 5:** Commit `feat: SealedPoolOracle, a start-of-block oracle for hookless v4 pools via fee-growth seals and state proofs`.

### Task 8: Sealed bot (poker and prover)

**Files:**
- Create:
  - `bot/src/header.ts`, which exports `encodeHeader(block: RpcBlock): Hex` covering all 21 Isthmus fields in order, omitting
    trailing fields the block lacks;
  - `bot/src/proof.ts`, which exports `buildBlockProof(client, oracle, block: bigint): Promise<BlockProof>` using `eth_getProof`
    for the PoolManager with the `slot0` slot;
  - `bot/src/sealed.ts`, with `SealedBot.tick()` and `main()`;
  - `bot/test/header.test.ts`, `bot/test/sealed.test.ts`.
- Modify:
  - `bot/src/config.ts`: `loadSealedConfig` reads `SEALED_ORACLE`, `SEALED_KEY` (falls back to `KEEPER_PRIVATE_KEY`),
    `SEALED_BATCH=16` and `SEALED_POLL_MS=500`;
  - `bot/src/abi.ts`;
  - `bot/package.json` (script `sealed`);
  - `script/bots.sh` (target `sealed`).

**Interfaces:**
- Consumes: `ISealedPoolOracle` from Task 7, through the regenerated ABI.
- Produces: `SealedBot.tick()`:
  1. Call `poke()` once per new block. Skip when `snapshot().blockNumber == head`.
  2. While `frontier() < head − 1` after the poke (the poke could not seal the latest block), build proofs for `frontier()+1 …`
     up to `SEALED_BATCH` and send `proveMany`.
  3. Check that `keccak(encodeHeader(b)) === b.hash` before sending, and throw otherwise.

- [ ] **Step 1:** Write `header.test.ts`. For 5 recent Unichain mainnet blocks and 5 Sepolia blocks (live RPC; skipped when
  `OFFLINE=1`), `keccak256(encodeHeader(block)) === block.hash`. Also assert the result equals `cast block --raw` for one fixture
  from Task 6, offline.
- [ ] **Step 2:** Write `sealed.test.ts` against Anvil (reuse `bot/test/helpers`):
  - Deploy the PoolManager, a hookless pool and `SealedPoolOracle`.
  - Run a swap every 3 blocks for 60 blocks with the bot ticking. The frontier reaches `head − 1`, and every applied tick equals
    the pool's end-of-block tick read with `getSlot0` at that block.
  - `test catches up after 300-block outage` (Review Focus 3): mine 300 blocks with swaps without ticking, then tick until caught
    up.
- [ ] **Step 3:** Run `npm test` in `bot/`. Expected: fails.
- [ ] **Step 4:** Implement `header.ts`, `proof.ts`, `sealed.ts`, the config and the `bots.sh` target.
- [ ] **Step 5:** Run `npm run check` in `bot/`. Expected: all pass.
- [ ] **Step 6:** Commit `feat: sealed-oracle bot that pokes every block and proves every gap`.

### Task 9: End to end and mainnet fork

**Files:**
- Create:
  - `script/rehearsal/sealed-e2e.ts`;
  - `test/integration/SealedUnichainFork.t.sol`, which runs only when `UNICHAIN_RPC_URL` is set.
- Modify: `docs/md/RUNBOOK.md`, adding a "Sealed oracle" section with the commands and the results.

**Interfaces:**
- Consumes: Tasks 2, 3, 7 and 8.

- [ ] **Step 1:** Write `sealed-e2e.ts` for Anvil (not a fork):
  1. Deploy the PoolManager, USDC, a hookless ETH/USDC pool with liquidity, `SealedPoolOracle` and the Task 3 scheduler and hook
     pair wired to that oracle.
  2. Fund the vault and run the sealed bot in-process.
  3. Random swaps create gaps.
  4. Call `open()`, buy UP through UniversalRouter, and pass expiry.
  5. Assert that `settle` reverts while `frontier < expiry` (Review Focus 4), then succeeds after proofs.
  6. Assert that `yesWon` matches the brute-force average of the recorded end-of-block ticks over `[T − window, T)`.
  7. Also run the 8191-block recovery: mock the 2935 window by etching a contract that returns zero, then `checkpointHeaders`,
     then prove.
- [ ] **Step 2:** Write `SealedUnichainFork.t.sol`:
  - Fork `UNICHAIN_RPC_URL` at the latest block and deploy `SealedPoolOracle` on the real pool
    `0x3258f413c7a88cda2fa8709a589d221a80f6574f63df5a5b6774485d8acc39d9`.
  - Poke, `vm.roll` plus 3, then poke. The run seals, and `lnSpotSoBWad` equals `ln(slot0)` from StateView.
  - Swap on the fork, roll, then poke. No seal.
- [ ] **Step 3:** Run `npx tsx script/rehearsal/sealed-e2e.ts` (or `node` with type stripping, as the repo does) and
  `UNICHAIN_RPC_URL=https://mainnet.unichain.org forge test --match-path test/integration/SealedUnichainFork.t.sol`.
  Expected: both pass. Paste the output into the RUNBOOK section.
- [ ] **Step 4:** Commit `test: sealed oracle end to end on Anvil and on a Unichain mainnet fork`.

### Task 10: Live phase-1 deployment on Unichain Sepolia (controller only; ask before each irreversible step)

This task has no new code; it is the spec's live sequence.
1. Stop the keeper with `script/bots.sh stop keeper unichain-sepolia`.
2. `CONFIRM=scheduler script/sepolia.sh scheduler`.
3. Settle and sweep the old markets with the permissionless calls, withdraw the `35e12` shares and deposit into the new vault
   (`script/Fund.s.sol`).
4. `CONFIRM=renounce-oracle script/sepolia.sh renounce-oracle`. **Irreversible.**
5. `node packages/swap-sdk/scripts/vendor-interface.mjs`, then restart the keeper, mirror and dev servers.

- [ ] **Step 1:** Run steps 1–5, confirming with the user before steps 2, 3 and 4.
- [ ] **Step 2:** Verify live:
  - `cast call <scheduler> 'lastSlot()'` advances each minute;
  - a swap works in the fork at :3000;
  - `settle` and `redeem` work;
  - `cast call <oracle> 'owner()'` returns `address(0)`;
  - `cast call <hook> 'keeper()'` returns `address(0)`.
- [ ] **Step 3:** Commit `deploy: scheduler-owned hook on Unichain Sepolia; oracle ownership renounced` with the updated
  `deployments/unichain-sepolia.json`, README addresses and RUNBOOK. Push to `main`.

## Execution order (parallel waves)

| Wave | Tasks | Notes |
|---|---|---|
| 1 | Task 1 → 2 → 3 (one agent); Task 5; Task 6 | three agents, disjoint files, worktree isolation |
| 2 | Task 4 (after 2 and 3); Task 7 (after 5 and 6) | two agents |
| 3 | Task 8 (after 7) | one agent |
| 4 | Task 9 (after 3, 7 and 8); Task 10 (after 4) | Task 10 runs in the controller session |

The controller cherry-picks each reviewed task onto `main`, runs the full `forge test` and the affected `npm test`, pushes, and
deletes the worktree branch.
