# Demo bots (Unichain Sepolia)

Two small Node 24 processes that keep the live demo moving:

- **`mirror`** keeps the underlying demo ETH/USDC v4 pool (demo WETH 18 dec / demo USDC 6 dec, hooked by
  `UnderlyingOracleHook`) at the real ETH price. Every ~1 s it reads ETH-USD from Coinbase (fallback Kraken, then
  Binance.US), computes the exact `sqrtPriceX96` for the pool's token order and decimals, and calls
  `PriceSteerer.steer(key, target)` when the pool is more than `MIRROR_THRESHOLD_BPS` away.
- **`keeper`** creates a 1-minute market on the `PredictionHook` every period, struck at the oracle's start-of-block
  price rounded to the cent (tickers `ETHUP` / `ETHDOWN`, name for example `ETH > $2701.35 26 Sep 14:32`), then settles every market once it expires and
  sweeps its surplus back to the LP vault.

TypeScript runs directly on Node 24 (type stripping), so there is no build step. The only runtime dependency is viem.

## Setup

```sh
cd bot
npm ci                                   # local install only
cp .env.example .env                     # then set DEPLOYER_PRIVATE_KEY
cp config/unichain-sepolia.example.json ../deployments/unichain-sepolia.json   # if the deploy script has not written it
```

`../deployments/unichain-sepolia.json` (override with `DEPLOYMENTS_FILE`) holds the addresses. The example file has the
chain-1301 constants from `docs/SPEC.md` §4 and zero placeholders for our contracts. Keys, flat or under `"contracts"`:

| Key | Used by | Notes |
|---|---|---|
| `poolManager` | mirror | Stack A PoolManager `0x00b0…62ac` |
| `priceSteerer`, `demoWeth`, `demoUsdc` | mirror | from the demo deploy |
| `underlyingOracle` | keeper, mirror | the `UnderlyingOracleHook`; also the underlying pool's `hooks` |
| `predictionHook` | keeper | |
| `underlyingPool` | mirror | optional `{currency0, currency1, fee, tickSpacing, hooks}`, or `underlyingPoolFee` / `underlyingPoolTickSpacing`. Normally left out: the mirror reads the key from the oracle's `poolKey()`. A key set here (or via `UNDERLYING_POOL_FEE` / `UNDERLYING_POOL_TICK_SPACING`) must match it, or the mirror refuses to start. Without an oracle the key is the sorted demo tokens with fee 500, spacing 10 |
| `rpcUrl`, `chainId` | both | `RPC_URL` / `CHAIN_ID` override |

Every address can also be overridden from the environment (`PRICE_STEERER`, `PREDICTION_HOOK`, `UNDERLYING_ORACLE`,
`DEMO_WETH`, `DEMO_USDC`, `POOL_MANAGER`). See `.env.example` for every setting and its default.

### Keys and permissions

- The mirror's account must own the `PriceSteerer`; the keeper's account must be the hook owner or its `keeper`
  (`setKeeper`). Both default to `DEPLOYER_PRIVATE_KEY`.
- Running both bots from one key works (each waits for its receipt before the next transaction), but two processes can
  race for the same nonce. For an unattended demo use `MIRROR_PRIVATE_KEY` and `KEEPER_PRIVATE_KEY` with
  `PriceSteerer.transferOwnership` and `setKeeper`.
- Keys are validated but never logged; only the derived address and the variable name are printed.

## Run

```sh
npm run mirror        # loop every MIRROR_INTERVAL_MS
npm run keeper        # loop every KEEPER_POLL_MS, a new market every KEEPER_PERIOD_SEC
DRY_RUN=1 npm run mirror                 # compute and log, send nothing (no key needed)
DRY_RUN=1 npm run keeper                 # simulates as the hook's keeper (else owner) when no key is set
ONCE=1 LOG_LEVEL=debug npm run keeper    # a single iteration
```

Log format (values illustrative):

```
2026-09-26T14:30:01.204Z INFO  [mirror] steered source=coinbase feed=2701.35 pool=2700.64 devBps=2.63 target=15… tx=0x… block=… gas=…
2026-09-26T14:31:00.611Z INFO  [keeper] market created market=17 name="ETH > $2701.35 26 Sep 14:32" strike=2701.35 openTime=… expiry=… budget=10.00 sigma=58.3% tx=0x…
2026-09-26T14:32:02.090Z INFO  [keeper] settled market=17 yesWon=true status=2 tx=0x…
2026-09-26T14:32:03.311Z INFO  [keeper] swept market=17 usdc=8.41 tx=0x…
```

### Mirror behaviour

- Target: `sqrtPriceX96 = floor(sqrt(P · 10^dUSDC / 10^dWETH) · 2^96)` when WETH is `currency0`, and the inverse
  price when demo USDC sorts first. Decimals are read from the tokens on start-up, and so is the owner check.
- A feed price outside `[MIRROR_MIN_PRICE, MIRROR_MAX_PRICE]` is dropped. So is a jump of more than
  `MIRROR_MAX_JUMP_BPS` against the last accepted price, until it repeats 3 times in a row (then it is real).
- The steer is an exact-in swap with the target as the price limit, so the pool lands on the target exactly. The steerer
  pays from its balance and mints any shortfall (it should be a `DemoToken` minter of both tokens).
- The oracle hook writes on the first swap of each block, which adds about 70k gas (a steer is ~193k first in a block,
  ~122k after). An RPC that estimates in a block that already has a steer would miss that write, so the gas limit is
  `estimate · 1.3 + 100k`.
- `binance` prices ETHUSDT, not ETH-USD, and is not in the default list; the mirror warns when it is configured and
  tags a fallback to it with `quotedIn=USDT`.

### Keeper behaviour

- Market parameters per SPEC §3.1: `openTime` = latest block time (+ `MARKET_OPEN_DELAY_SEC`),
  `expiry = openTime + MARKET_TENOR_SEC` (optionally rounded up to `MARKET_EXPIRY_ALIGN_SEC`), `window` 10 s,
  `cutoffBuffer` 2 s, `nSamples` 10, `budget` 10 USDC, `h0` 0.02 (the frozen PLAN §10 value), `gammaS` 0.00005,
  `lambda` 0.001, `qEpochMax` 100 tokens, `pMin` 0.02, `sigmaMode` 0 (oracle), `kernel` 0 (Gaussian, the only kernel
  `PredictionHook` accepts). `window` must be at least 1 s.
- `lnStrikeWad` is `ln(strike)` computed exactly in bigint (40-digit internal precision, rounded to the nearest wei).
- With `KEEPER_ALIGN=1` (default) markets are created on wall-clock multiples of `KEEPER_PERIOD_SEC`, so 60 s
  markets expire on the minute.
- Creation is skipped (with a warning) while `vaultIdle()` is below the budget. Settlement runs before creation, so
  sweeps recycle budget into the next market.
- A creation that fails before its transaction is sent (RPC error, revert, budget) is retried on the next poll, and
  `openTime` comes from a block read just before `createMarket`, after settle and sweep receipts.
- A market that cannot `settle` (oracle history unavailable) is retried every poll; after
  `KEEPER_INVALID_AFTER_SEC` past expiry (default 3601, and never below the hook's `GRACE` + 1, read on start-up) the
  keeper also tries `settleInvalid`.
- A market whose `marketInfo` read fails for a reason other than a revert is kept pending and re-read every poll, so a
  flaky RPC cannot make the keeper lose a market.
- Market ids are scanned from `marketCount()` and work whether the hook numbers markets from 0 or 1. On start-up the last
  `KEEPER_SCAN_BACK` markets are picked up, so a restarted keeper settles what it missed.

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
  `lnWad` against mpmath, parameter building and names, sweep amounts, config and env parsing, feed parsers
  with fallback, and (with a fake RPC client) the keeper's retry of failed market reads and failed creations.
- `test/abi.test.ts` checks the TypeScript ABIs against the forge artifacts of `IPredictionHook`,
  `IUnderlyingOracle`, `PriceSteerer` and `PoolManager`.
- `test/anvil.test.ts` starts anvil, deploys the real `PoolManager`, `DemoToken` and `PriceSteerer`, and runs the
  mirror in both token orderings through a pool hooked by `test/demo/mocks/MockSobHook.sol` (oracle flags, CREATE2-mined
  address), including the `poolKey()` lookup, a pinned-key mismatch and the gas padding. It then drives the keeper
  against `test/demo/mocks/MockPredictionHook.sol`: create, a struct round-trip through Solidity, settle, sweep, the
  invalid fallback, the budget guard, `GRACE` and dry runs without a key.
- `test/demo/PriceSteererHooked.t.sol` (Foundry) steers through the mock hook and, when
  `src/oracle/UnderlyingOracleHook.sol` is in the build, through the real oracle: `lnSpotSoBWad` in the next block
  matches the target price in both orderings, and the gas padding covers the first-in-block write.
- The ABI and anvil tests need `forge build` in the repo root and `anvil` on `PATH` or in `~/.foundry/bin`; they skip
  otherwise.
