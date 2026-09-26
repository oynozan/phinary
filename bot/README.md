# Demo bots (Unichain Sepolia)

Small Node 24 processes that keep the live demo moving:

- **`mirror`** keeps the underlying demo v4 pools (each demo asset against demo USDC 6 dec, hooked by its own
  `UnderlyingOracleHook`) at the real prices, ETH and SOL from one process. Every ~1 s it reads `<SYM>-USD` for every
  pool in parallel from Coinbase (fallback Kraken, then Binance.US), computes the exact `sqrtPriceX96` for the pool's
  token order and decimals, and calls `PriceSteerer.steer(key, target)` for each pool more than
  `MIRROR_THRESHOLD_BPS` away.
- **`keeper`** calls the ownerless `MarketScheduler`'s permissionless `open()` once per slot. The scheduler builds the
  market on chain, struck at the oracle's start-of-block price rounded to the cent (tickers `ETHUP` / `ETHDOWN`, name
  for example `ETH > $2701.35 26 Sep 14:32`). The keeper then settles every market once it expires and sweeps its
  surplus back to the LP vault.
- **`sealed`** keeps a `SealedPoolOracle`'s history complete, for a hookless pool we do not own (see
  [Sealed-oracle bot](#sealed-oracle-bot)). The demo pair above does not need it.

TypeScript runs directly on Node 24 (type stripping), so there is no build step. The only runtime dependency is viem.

## Setup

```sh
cd bot
npm ci                                   # local install only
cp .env.example .env                     # then set DEPLOYER_PRIVATE_KEY
cp config/unichain-sepolia.example.json ../deployments/unichain-sepolia.json   # if the deploy script has not written it
```

`../deployments/unichain-sepolia.json` (override with `DEPLOYMENTS_FILE`) holds the addresses. The example file has the
chain-1301 constants from `docs/md/SPEC.md` §4 and zero placeholders for our contracts. Keys, flat or under `"contracts"`:

| Key | Used by | Notes |
|---|---|---|
| `poolManager` | mirror | Stack A PoolManager `0x00b0…62ac` |
| `priceSteerer`, `demoWeth`, `demoUsdc` | mirror | from the demo deploy |
| `underlyings` | mirror | optional list `[{symbol, token, oracle, pool: {currency0, currency1, fee, tickSpacing, hooks}, poolId}]`, one per steered asset (ETH, SOL). Each `pool` pairs `token` with `demoUsdc` and is hooked by `oracle`, and `poolId` must match it. When absent, the mirror steers the single ETH pool from `demoWeth`, `underlyingOracle` and `underlyingPool` |
| `underlyingOracle` | mirror | the `UnderlyingOracleHook`; also the underlying pool's `hooks` |
| `predictionHook` | keeper | the hook whose markets it settles and sweeps |
| `marketScheduler` | keeper | the ownerless `MarketScheduler` that owns `predictionHook`; its `open()` is the only way to a new market |
| `sealedOracle` | sealed | the `SealedPoolOracle` to poke and prove (or `SEALED_ORACLE`) |
| `underlyingPool` | mirror | optional `{currency0, currency1, fee, tickSpacing, hooks}`, or `underlyingPoolFee` / `underlyingPoolTickSpacing`. Normally left out: the mirror reads the key from the oracle's `poolKey()`. A key set here (or via `UNDERLYING_POOL_FEE` / `UNDERLYING_POOL_TICK_SPACING`) must match it, or the mirror refuses to start. Without an oracle the key is the sorted demo tokens with fee 500, spacing 10 |
| `rpcUrl`, `chainId` | all | `RPC_URL` / `CHAIN_ID` override |

Every address can also be overridden from the environment (`PRICE_STEERER`, `PREDICTION_HOOK`, `MARKET_SCHEDULER`,
`UNDERLYING_ORACLE`, `SEALED_ORACLE`, `DEMO_WETH`, `DEMO_USDC`, `POOL_MANAGER`). See `.env.example` for every setting and
its default.

### Keys and permissions

- The mirror's account must own the `PriceSteerer`. The keeper needs no role: `open()`, `settle`, `settleInvalid` and
  `sweep` are permissionless, so any funded key works. Both default to `DEPLOYER_PRIVATE_KEY`.
- The sealed bot signs with `SEALED_KEY`, else `KEEPER_PRIVATE_KEY`, and needs no role either.
- Running bots from one key works (each waits for its receipt before the next transaction), but two processes can race
  for the same nonce. For an unattended demo give each bot its own key: `MIRROR_PRIVATE_KEY` (then
  `PriceSteerer.transferOwnership` to it), `KEEPER_PRIVATE_KEY` and `SEALED_KEY`.
- Keys are validated but never logged; only the derived address and the variable name are printed.

## Run

```sh
npm run mirror        # loop every MIRROR_INTERVAL_MS
npm run keeper        # loop every KEEPER_POLL_MS, open() once per scheduler slot
npm run sealed        # loop every SEALED_POLL_MS, needs SEALED_ORACLE or sealedOracle in the file
DRY_RUN=1 npm run mirror                 # compute and log, send nothing (no key needed)
DRY_RUN=1 npm run keeper                 # simulates open(), settle and sweep, no key needed
ONCE=1 LOG_LEVEL=debug npm run keeper    # a single iteration
```

From the repo root, `script/bots.sh start <network>` runs the mirror and the keeper in the background, and
`script/bots.sh start <network> sealed` runs the sealed bot on its own (`stop`, `status` and `logs` work the same way).

Log format (values illustrative):

```
2026-09-26T14:30:01.204Z INFO  [mirror] steered symbol=ETH source=coinbase feed=2701.35 pool=2700.64 devBps=2.63 target=15… tx=0x… block=… gas=…
2026-09-26T14:30:02.377Z INFO  [mirror] steered symbol=SOL source=coinbase feed=148.27 pool=148.19 devBps=5.39 target=… tx=0x… block=… gas=…
2026-09-26T14:31:00.611Z INFO  [keeper] market opened market=17 now=… slot=29840551 budget=10.00 strikeCents=270135 tx=0x…
2026-09-26T14:32:02.090Z INFO  [keeper] settled market=17 yesWon=true status=2 tx=0x…
2026-09-26T14:32:03.311Z INFO  [keeper] swept market=17 usdc=8.41 tx=0x…
```

### Mirror behaviour

- Pools: every `underlyings` entry, or without that list the demoWeth/demoUsdc pool as ETH, exactly as before.
  `MIRROR_SYMBOLS=ETH` (comma-separated) steers only the listed ones. On start-up each pool is checked against its
  oracle's `poolKey()`: it must pair the entry's own token with demo USDC, be hooked by that oracle, and equal the key
  in the file.
- Target: `sqrtPriceX96 = floor(sqrt(P · 10^dUSDC / 10^dBase) · 2^96)` when the base token is `currency0`, and the
  inverse price when demo USDC sorts first. Decimals are read from the tokens on start-up, and so is the owner check.
- Each asset has its own guard. A feed price outside its band is dropped: `MIRROR_<SYM>_MIN_PRICE` /
  `MIRROR_<SYM>_MAX_PRICE`, by default ETH 100..100000 and SOL 5..2000 (the older `MIRROR_MIN_PRICE` /
  `MIRROR_MAX_PRICE` still set ETH's). So is a jump of more than `MIRROR_MAX_JUMP_BPS` against that asset's last
  accepted price, until it repeats 3 times in a row (then it is real).
- The pools that need a steer are sent one after the other from the one mirror account, each waiting for its receipt.
  The nonce is read once per tick and counted up locally, so a lagging RPC cannot hand the second steer a used one. A
  feed, RPC or transaction failure on one asset logs `tick failed symbol=…` and leaves the others running.
- The steer is an exact-in swap with the target as the price limit, so the pool lands on the target exactly. The steerer
  pays from its balance and mints any shortfall (it should be a `DemoToken` minter of both tokens).
- The oracle hook writes on the first swap of each block, which adds about 70k gas (a steer is ~193k first in a block,
  ~122k after). An RPC that estimates in a block that already has a steer would miss that write, so the gas limit is
  `estimate · 1.3 + 100k`.
- `binance` prices `<SYM>USDT`, not `<SYM>-USD`, and is not in the default list; the mirror warns when it is
  configured and tags a fallback to it with `quotedIn=USDT`.

### Keeper behaviour

- The keeper passes no parameters. Each `open()` builds the market from the scheduler's immutable config (on Unichain
  Sepolia: period 60 s, tenor 120 s, `window` 10 s, `cutoffBuffer` 2 s, `nSamples` 10, `h0` 0.02, `gammaS` 0.00002,
  `lambda` 0.001, `qEpochMax` 100, `pMin` 0.02, `sigmaMode` 0, `kernel` 0). `openTime` is the block's timestamp,
  `expiry = slot × period + tenor`, and the budget is `min(maxBudget, vaultIdle / 2)` with `maxBudget` 10 USDC.
  Below `minBudget` (1 USDC) `open()` reverts `InsufficientIdle`.
- Slots follow block timestamps: a block's slot is `block.timestamp / period`, and `open()` succeeds once per slot. The
  keeper reads the period from the scheduler's `config()` on start-up, warning when `KEEPER_PERIOD_SEC` differs (it is
  only the fallback), and with `KEEPER_ALIGN=1` (default) wakes on wall-clock multiples of it.
- `open()` is simulated first. `AlreadyOpened` for the slot of the later of the wall clock and the latest block means
  another caller opened it, and the keeper waits for the next slot. `AlreadyOpened` for an earlier slot means the RPC's
  latest block is still in the previous slot, so the keeper retries every poll until a block of the new slot lands.
- A refused `open()` (`InsufficientIdle`, or an oracle revert such as the sealed oracle's `StaleSpot`) logs one warning
  per slot, `open() refused slot=… error=…`, and is retried every poll. An RPC failure logs `tick failed` and is retried
  every poll too.
- Every transaction is sent with `estimate × 1.3 + 30k` gas (swap-sdk's `gasWithHeadroom`), since the oracle's
  start-of-block read can cost more in the block than at the estimate.
- Settlement runs before creation, so sweeps recycle budget into the next market.
- A market that cannot `settle` (oracle history unavailable) is retried every poll; after
  `KEEPER_INVALID_AFTER_SEC` past expiry (default 3601, and never below the hook's `GRACE` + 1, read on start-up) the
  keeper also tries `settleInvalid`.
- A market whose `marketInfo` read fails for a reason other than a revert is kept pending and re-read every poll, so a
  flaky RPC cannot make the keeper lose a market.
- Market ids are scanned from `marketCount()` and work whether the hook numbers markets from 0 or 1. On start-up the last
  `KEEPER_SCAN_BACK` markets are picked up, so a restarted keeper settles what it missed.

### Sealed-oracle bot

`npm run sealed` (or `script/bots.sh start <network> sealed`) keeps a `SealedPoolOracle`'s history complete. It needs no
role: the contract verifies every seal and proof, so a faulty bot can stall the oracle but never corrupt it. Its
settings are `SEALED_ORACLE`, `SEALED_KEY`, `SEALED_BATCH` (16), `SEALED_POLL_MS` (500) and `SEALED_RPC_FALLBACKS`.

- Every `SEALED_POLL_MS` it pokes once per new block, unless `snapshot()` already comes from the latest block. A poke
  that finds the pool untouched since the last one seals every block in between.
- When the frontier is still below the block before its poke, it proves `frontier() + 1` onwards with `proveMany`, up to
  `SEALED_BATCH` blocks per transaction and 4 transactions per round, then pokes again. While behind it does not wait
  between rounds.
- Headers are rebuilt from `eth_getBlockByNumber` (`src/header.ts`, the 21 Isthmus fields) and must hash to the block
  hash before anything is sent. `eth_getProof` of the PoolManager's `slot0` slot (`src/proof.ts`) must start at the
  header's state root. Refusals are retried with backoff, then on `SEALED_RPC_FALLBACKS`.
- Recovering from an outage proves blocks as old as the outage, so `RPC_URL` or a `SEALED_RPC_FALLBACKS` entry must
  serve historical `eth_getProof` (an archive node or a wide proof window). Most `mainnet.unichain.org` backends refuse
  a few dozen blocks back, and publicnode needs an archive plan. On start-up the bot asks every RPC for a proof 300
  blocks back and warns once, without exiting, when none answers.
- A block hash comes from `BLOCKHASH` for 256 blocks, then from EIP-2935 for 8,191. Past those, and 32 blocks early to
  leave time to land, it first stores the missing hashes with `checkpointHeaders`, walking back from the oldest block a
  window still serves.
- Gas is estimated before every transaction and padded, and no limit exceeds the block's or EIP-7825's 16,777,216 per
  transaction. A `proveMany` is halved while its estimate fails or exceeds half the block gas limit or 5/6 of that cap,
  so the padded batch always fits one transaction. A single proof that still fails is retried next round.

## Seeding the underlying pool

The deploy script owns this, but by hand with `cast` it is:

```sh
# demo tokens: name, symbol, decimals, faucet per call, faucet per hour, owner
forge create src/demo/DemoToken.sol:DemoToken --broadcast --rpc-url $RPC --private-key $PK \
  --constructor-args "Demo Wrapped Ether" dWETH 18 1000000000000000000 5000000000000000000 $ME
forge create src/demo/DemoToken.sol:DemoToken --broadcast --rpc-url $RPC --private-key $PK \
  --constructor-args "Demo USD Coin" dUSDC 6 10000000000 50000000000 $ME
forge create src/demo/PriceSteerer.sol:PriceSteerer --broadcast --rpc-url $RPC --private-key $PK \
  --constructor-args 0x00b036b58a818b1bc34d502d3fe730db729e62ac $ME
cast send $WETH "setMinter(address,bool)" $STEERER true --rpc-url $RPC --private-key $PK
cast send $USDC "setMinter(address,bool)" $STEERER true --rpc-url $RPC --private-key $PK
# after PoolManager.initialize(key, sqrtPriceX96) with hooks = the oracle hook:
cast send $STEERER "addLiquidityFullRange((address,address,uint24,int24,address),uint128)" \
  "($C0,$C1,500,10,$ORACLE)" 1000000000000000000 --rpc-url $RPC --private-key $PK
```

Full-range liquidity `L` holds about `L / sqrtP` raw token0 and `L · sqrtP` raw token1 (`sqrtP` unscaled). At ETH =
$2,700 with WETH as token0, `L = 1e18` is ~19,200 dWETH and ~52M dUSDC. Deep liquidity is the point: anyone can take
faucet tokens, and a faucet-sized swap should barely move the oracle between two mirror steps. The steerer mints what
it needs, so depth costs nothing.

## Tests

```sh
npm run typecheck
npm test              # unit tests + an anvil end-to-end test
```

- Unit tests cover the pure parts: `sqrtPriceX96` targets for both orientations against exact-integer vectors,
  inverse and deviation, `PoolId` and the PoolManager storage slot against `cast`, strike rounding at the half-cent,
  `lnWad` against mpmath, sweep amounts, config and env parsing (including `underlyings` and per-asset bands), ETH and
  SOL feed parsers with fallback, and (with a fake RPC client) the mirror's per-asset guards and consecutive nonces
  across pools, and the keeper's retry of failed market reads and creations, its `AlreadyOpened` slot check, gas padding and
  one warning per refused slot.
- `test/abi.test.ts` checks the TypeScript ABIs against the forge artifacts of `IPredictionHook`,
  `IUnderlyingOracle`, `PriceSteerer`, `PoolManager`, `ISealedPoolOracle` and `SealedPoolOracle`.
- `test/header.test.ts` rebuilds the Task 6 fixture header offline and, unless `OFFLINE=1`, 5 recent Unichain mainnet
  and Sepolia headers from their public RPCs. `test/sealed.test.ts` checks proof building on the same fixture, then on
  anvil runs the sealed bot against a hookless pool with a swap every 3 blocks, a 300-block outage (caught up through
  EIP-2935) and the same outage with EIP-2935 blanked (caught up through `checkpointHeaders`), comparing every applied
  tick with the pool's end-of-block tick.
- `test/anvil.test.ts` starts anvil, deploys the real `PoolManager`, `DemoToken` and `PriceSteerer`, and runs the
  mirror in both token orderings through a pool hooked by `test/demo/mocks/MockSobHook.sol` (oracle flags, CREATE2-mined
  address), including the `poolKey()` lookup, a pinned-key mismatch and the gas padding, then ETH and SOL pools from an
  `underlyings` list steered in one tick with consecutive nonces. It then drives the keeper
  through the real `MarketScheduler` owning `test/demo/mocks/MockPredictionHook.sol`: `open()` and the market it
  builds, padded gas, settle, sweep, the invalid fallback, `InsufficientIdle` (one warning per slot), `GRACE` and dry
  runs without a key.
- `test/demo/PriceSteererHooked.t.sol` (Foundry) steers through the mock hook and, when
  `src/oracle/UnderlyingOracleHook.sol` is in the build, through the real oracle: `lnSpotSoBWad` in the next block
  matches the target price in both orderings, and the gas padding covers the first-in-block write.
- The ABI and anvil tests need `forge build` in the repo root and `anvil` on `PATH` or in `~/.foundry/bin`; they skip
  otherwise.
