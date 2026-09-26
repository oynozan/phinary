# Phinary demo runbook

This runbook covers the live demo on Unichain Sepolia (chain 1301): the contracts, the two bots, the two front ends, and what to do when something breaks.

Demo markets ask "ETH above K" or "SOL above K". They run on four **tracks** with two cadences, all on one hook and one LP vault:

| Track | Ticker and tokens | A new market | Trading per market | Settlement window |
|---|---|---|---|---|
| ETH, 1 minute | `ETH`: `ETHUP` / `ETHDOWN` | every 60 s | 48 s | 10 s |
| ETH, 15 minutes | `ETH15M`: `ETH15MUP` / `ETH15MDOWN` | every 900 s, on the quarter hour | 868 s | 30 s |
| SOL, 1 minute | `SOL`: `SOLUP` / `SOLDOWN` | every 60 s | 48 s | 10 s |
| SOL, 15 minutes | `SOL15M`: `SOL15MUP` / `SOL15MDOWN` | every 900 s, on the quarter hour | 868 s | 30 s |

- On every track the tenor equals the period, so markets run back to back: a market expires in the second the next one of its track opens.
- The underlying pools are our own demo WETH/USDC and SOL/USDC pools, each with its own oracle hook. There is no external oracle: the strike and the settlement price both come only from the Uniswap v4 pool of the market's asset. The price mirror keeps both pools at the real prices; it stands in for the arbitrage that would otherwise do this job, since a fresh testnet pool has no organic liquidity or traders to keep it in line on its own.
- An ownerless `MarketGatekeeper` owns the hook. It deployed the four `MarketScheduler`s in its constructor and forwards `createMarket` from them only. Anyone can call a scheduler's `open()` once per slot until the slot's deadline, after which it reverts `TooLate`. Slots follow block timestamps (`block.timestamp / period`), not the wall clock, and the keeper bot is just the account that calls `open()` first. There is no admin, no setter and no keeper role on the hook itself.
- Trading stops 12 s before expiry on the 1-minute tracks (10 s window plus 2 s buffer) and 32 s before on the 15-minute tracks (30 s window plus 2 s).
- The keeper opens the new markets first, then settles and sweeps the ones that just expired, a few seconds after expiry. Winners sell the winning token for exactly 1.00 USDC.

Every command below runs from the repo root. `make` with no target lists all the targets.

| I want to... | Command |
|---|---|
| Practise everything on a private fork | `make local-env`, then `make rehearse` |
| Deploy to the real Unichain Sepolia | `make deploy-sepolia`, then `make fund-sepolia` |
| Add a price source (another asset) | `make underlying-sepolia`, `make seed-underlying-sepolia`, `make renounce-underlying-sepolia` (section 3.2) |
| Move the vault to a new hook and set of tracks | `make tracks-sepolia` inside the sequence of section 3.3 |
| Run the bots | `make bots` (`make bots-status`, `make bots-logs`, `make bots-stop`) |
| Show the Uniswap web-app fork | `make vendor-interface`, then run `interface/` (section 5) |
| Show the backup page | `make backup-app` |
| Stop the private fork | `make local-stop` |
| Rehearse the sealed oracle on a plain anvil | `forge build`, then `node script/rehearsal/sealed-e2e.ts` (section 8) |

---

## 1. Prerequisites

- **Foundry 1.8.3** in `~/.foundry/bin`. The Makefile and scripts add that folder to `PATH` themselves.
- **Node 24** for the bots. The rehearsal needs Node 22.18 or later.
- **Dependencies:** run `cd bot && npm ci` once. `make rehearse` installs `script/rehearsal/node_modules` by itself.
- **The repo-root `.env`** (git-ignored) must hold:
  - `DEPLOYER_PRIVATE_KEY`
  - `DEPLOYER_ADDRESS`
  - `UNICHAIN_SEPOLIA_RPC`, which is optional. It defaults to `https://sepolia.unichain.org`.
  - `MIRROR_PRIVATE_KEY` and `MIRROR_ADDRESS`, only for `seed-underlying`, which the PriceSteerer's owner must sign (section 3.2).

  Forge and the bots read `.env` themselves. No script prints a key.

## 2. The private fork (rehearse without spending anything)

```sh
make local-env      # about 20 s when contracts are already built
make rehearse       # 1 to 2.5 minutes: it waits for a fresh keeper market and for its expiry
make local-stop     # CLEAN=1 also deletes logs and deployments/local.json
```

`make local-env` runs `script/local-env.sh`. It sends nothing to the real network.

1. It starts `anvil --fork-url https://sepolia.unichain.org --block-time 1 --port 8545`. The chain id stays 1301, and the real PoolManager, V4Quoter, UniversalRouter 2.0, Permit2 and Circle USDC are all there.
2. It gives ETH to three accounts: the deployer, a local keeper account and a local mirror account. It also gives the deployer 10,000 Circle USDC by writing the FiatToken balance slot (slot 9).
3. It runs `script/Deploy.s.sol` at the live Coinbase ETH and SOL prices, then `script/Fund.s.sol` with 500 USDC. Together they write `deployments/local.json`. As on Unichain Sepolia, the hook is owned by a `MarketGatekeeper` with the four tracks of section 3: ETH and SOL, every 60 s and every 900 s, each market with a budget of `min(10 USDC, vaultIdle / 2)`.
4. It moves the PriceSteerer to the local mirror key, so deployer-signed scripts never race the mirror for nonces. Then it starts the mirror, which steers both pools, and the keeper, which calls every track's `open()` once per slot and settles and sweeps each market. The summary it prints lists each track with its scheduler.

Logs, pids and forge broadcasts go to `deployments/.run/local/`. They are git-ignored, so local runs never touch `broadcast/`.

Settings you can override: `LOCAL_PORT`, `FORK_URL`, `FORK_BLOCK`, `FUND_USDC`, `DEPLOYER_USDC`, `ETH_PRICE_USD`, `SOL_PRICE_USD`, and `START_BOTS=0`. The track settings of section 3 (`TRACK_<TICKER>_*`, `TRACKS_ETH_ONLY`) pass through to the deploy.

### What `make rehearse` checks

`script/rehearsal/rehearse.ts` uses `packages/swap-sdk`, the same code the web app vendors. It prints a narrated log with the spot price, strike, σ, τ, and the YES/NO mid, ask and bid at every step.

1. It creates two fresh EOAs, Alice and Bob, with 1 ETH and 50 USDC each.
2. It picks the newest keeper market that has no trades yet and at least 25 s of trading left.
3. **Alice buys YES** for 10 USDC through UniversalRouter 2.0. This is the first-time Permit2 flow:
   - an ERC-20 approve of Permit2;
   - a signed PermitSingle;
   - a swap with commands `0x0a10`.
4. **Bob buys NO** for 10 USDC in the same way.
5. **Alice sells half her YES.** OutcomeTokens pre-approve Permit2, so she only signs a permit.
6. It waits for the cutoff and shows that the V4Quoter refuses to quote (`NotTradable`).
7. It waits for expiry and asserts that **the keeper bot** settles the market.
8. It recomputes the outcome from the oracle's tick-cumulative TWAP and the hook's integer threshold.
9. **The winner redeems** by swapping the winning token for exactly 1 USDC each. A quote for the losing token is refused (`MarketClosed`).

After every step it asserts the SPEC §3.2 ledger, with all values read at one block:
- the hook's ERC-6909 claims equal its inventory;
- supply minus inventory equals the outstanding tokens, which equal the traders' balances;
- `bucket` equals the budget plus the traders' net USDC;
- solvency holds;
- `Σ bucket + vaultIdle` equals the hook's USDC claims, across all markets.

At the end it checks that USDC is conserved between the traders and the vault. Any failure exits non-zero with the reason.

Rehearsal options:
- `REHEARSAL_USDC`: trade size, default 10.
- `REHEARSAL_MIN_SECONDS`: minimum trading time left when picking a market, default 25.
- `REHEARSAL_SELF_SETTLE=1`: settle the market directly if the keeper has not done so within 45 s.

### Other local helpers

- `make local-status`: shows anvil, the bots, and their last log lines.
- To open a market by hand, call a scheduler: `cast send <scheduler> "open()" --rpc-url http://127.0.0.1:8545 --private-key …`. Any funded key works, and it reverts `AlreadyOpened` if the keeper was first. `script/CreateMarket.s.sol` calls `createMarket` directly, so it only works against a hook with an EOA owner, never behind the gatekeeper.
- `make local-wallet ADDR=0x… USDC=100`: sets a wallet's balances on the fork to 10 ETH and 100 Circle USDC, for trying the backup page with MetaMask.
- To point MetaMask at the fork, add `http://127.0.0.1:8545` as an RPC URL of the Unichain Sepolia network (chain 1301) and select it. Switch back afterwards.

## 3. Deploying to Unichain Sepolia (once the deployer is funded)

**Funding.**
- ETH on Unichain Sepolia:
  - A fresh full deploy is roughly 30M gas (the gatekeeper, its four schedulers and the hook are about 15.8M, one price source about 5.5M), well under 0.0001 ETH at the usual 0.001 gwei.
  - The bots use roughly 0.002 ETH per hour at that price: the mirror steers two pools (a steer is about 200k gas), and the keeper opens about 128 markets an hour at about 1.65M gas each, plus a settle and a sweep for each one.
  - Keep 0.02 ETH or more on each signer.
- Circle USDC comes from the faucet (about 20 USDC per 2 h per address). All of it can go into the vault. Keep the vault at 150 USDC or more (section 4).

```sh
make deploy-sepolia                    # script/sepolia.sh deploy
make fund-sepolia FUND_USDC=150        # vault deposit (default 20)
```

`script/sepolia.sh` guards every broadcast to the real chain.
- It refuses to run when `CI` is set, without a terminal (unless `CONFIRM=<command>` is set), or when the RPC is not chain 1301 or is an anvil node.
- Before sending anything it prints:
  - the signer's ETH and USDC balances;
  - the price it will use, fetched from Coinbase unless `ETH_PRICE_USD` (or `UNDERLYING_PRICE_USD`) is set;
  - the full forge simulation.
- It broadcasts only after you type the command name, or with `CONFIRM=<command>` as a non-interactive, explicit opt-in. It uses `--slow`, so transactions go one at a time.

| Command | Make target | What it does |
|---|---|---|
| `script/sepolia.sh deploy` | `make deploy-sepolia` | The full stack below, written to a fresh deployments file |
| `script/sepolia.sh fund` | `make fund-sepolia` | Deposits `FUND_USDC` (default 20) of the deployer's Circle USDC into the vault of `predictionHook` |
| `script/sepolia.sh withdraw` | | Withdraws every vault share of the deployer from `WITHDRAW_HOOK` (required), which must be drained (`navMinus == vaultIdle`) and be the file's `predictionHook` or one of its `legacyPredictionHooks` |
| `script/sepolia.sh tracks` | `make tracks-sepolia` | IRREVERSIBLE. A new `MarketGatekeeper` with its four schedulers and the new hook it owns, checked on chain before the file changes (section 3.3) |
| `script/sepolia.sh underlying` | `make underlying-sepolia` | A new price source for `UNDERLYING_SYMBOL`: demo token, oracle hook and pool (section 3.2) |
| `script/sepolia.sh seed-underlying` | `make seed-underlying-sepolia` | `demoLiquidity` into that pool through the PriceSteerer, signed by the mirror key |
| `script/sepolia.sh renounce-underlying` | `make renounce-underlying-sepolia` | IRREVERSIBLE. That oracle loses its owner |
| `script/sepolia.sh renounce-oracle` | | IRREVERSIBLE. The ETH oracle loses its owner (already done on the live one) |

`script/sepolia.sh market` still runs `script/CreateMarket.s.sol`, which only works against a hook with an EOA owner; the live hook refuses it.

`ALLOW_ANVIL=1 UNICHAIN_SEPOLIA_RPC=http://127.0.0.1:8545 make deploy-sepolia` runs the same flow against the private fork. It writes `deployments/sepolia-rehearsal.json` instead, and every other command rehearses the same way.

Deploy (`script/Deploy.s.sol`) does these steps in order:

1. Deploys the demo tokens: `DemoToken` dWETH (18 decimals, faucet 1 per call and 5 per hour) and dUSDC (6 decimals, faucet 10,000 per call and 50,000 per hour).
2. Deploys `UnderlyingOracleHook` at a CREATE2 address mined for flags `AFTER_INITIALIZE | BEFORE_SWAP`, through `0x4e59…956C`.
3. Initialises the dWETH/dUSDC pool (fee 500, tick spacing 10) from the deployer, the oracle owner. The initial price is `ETH_PRICE_USD`, with either token order handled.
4. Deploys `PriceSteerer` (owner = deployer). It becomes a minter of both demo tokens and seeds full-range liquidity (`DEMO_LIQUIDITY`, default 1e18, about 19k dWETH and 52M dUSDC).
5. Builds the same stack for SOL: dSOL (18 decimals, faucet 20 per call and 100 per hour), its own oracle hook and a dSOL/dUSDC pool at `SOL_PRICE_USD`, with the steerer as a dSOL minter seeding the same liquidity. `TRACKS_ETH_ONLY=1` skips this step and the two SOL tracks.
6. Deploys the tracks (`script/base/TrackSet.sol`) in exactly two deployer transactions: the `MarketGatekeeper` at the deployer's next nonce, which deploys the four `MarketScheduler`s in its constructor, then the `PredictionHook` through CREATE2, mined to flags `0x2AA8` with the gatekeeper as its `owner`. The gatekeeper has no owner and no setter and forwards `createMarket` from its schedulers only, so it is the only way to create a market. The hook's `keeper` is never set. `KEEPER_ADDRESS` only names the keeper bot's account in the deployments file; it grants no role, since anyone can call a scheduler's `open()`.

It then checks:
- every flag mask;
- both pool bindings;
- the oracle owners and the steerer owner (the deployer), and that the hook's owner is the gatekeeper with no keeper set;
- the gatekeeper's hook and scheduler list, and each scheduler's hook, gatekeeper, oracle and config;
- each oracle's start-of-block price against its initial price;
- that the oracles start on their warm-up variance.

The track configs are frozen in the schedulers. Changing any of them later means a new gatekeeper and hook and a move of the vault (section 3.3).

| Env | Default | Meaning |
|---|---|---|
| `ETH_PRICE_USD` | live Coinbase price (the script's own default is 2700) | Initial ETH pool price |
| `SOL_PRICE_USD` | 150 (`make local-env` fetches the live price) | Initial SOL pool price |
| `TRACKS_ETH_ONLY` | 0 | 1 deploys only the two ETH tracks and no SOL stack |
| `KEEPER_ADDRESS` | deployer | Label only, in the deployments file; grants no role |
| `DEMO_LIQUIDITY` | 1e18 | Full-range liquidity L of each underlying pool |
| `UNDERLYING_FEE`, `UNDERLYING_TICK_SPACING` | 500, 10 | Underlying pool keys |
| `ORACLE_GRID_SECONDS` | 10 | TWAP-return grid H |
| `ORACLE_N_WINDOWS` | 180 | 30 min lookback |
| `ORACLE_MIN_WINDOWS` | 30 | 5 min warm-up on the fallback σ |
| `ORACLE_WINSOR_TICKS` | 100 | About 8 SD of a 10 s window-mean move at 250 % |
| `ORACLE_SIGMA_MIN`, `ORACLE_SIGMA_MAX`, `ORACLE_SIGMA_FALLBACK` | 0.2, 2.5, 0.6 | Annual σ clamps and warm-up value |
| `ORACLE_CARDINALITY` | 14400 | Observation ring: 4 h of 1 s writes (at least 7200 is required) |
| `NETWORK` / `DEPLOYMENTS_FILE` | `unichain-sepolia` | Output `deployments/<NETWORK>.json` |
| `DEPLOYMENTS_RPC_URL` | `https://sepolia.unichain.org` | `rpcUrl` written into the file for the bots |

Every market setting is per track. Prefix the name with `TRACK_<TICKER>_`, where the ticker is `ETH`, `ETH15M`, `SOL` or `SOL15M`, for example `TRACK_ETH15M_MARKET_BUDGET_USDC=5`. The tickers themselves are fixed in `demoTracks()`.

| Track env (after `TRACK_<TICKER>_`) | 1-minute default | 15-minute default | Meaning |
|---|---|---|---|
| `SCHEDULER_PERIOD_SEC` | 60 | 900 | Seconds per slot; `open()` succeeds at most once per slot |
| `MARKET_TENOR_SEC` | 60 | 900 | Expiry is slot start plus tenor, so equal to the period runs markets back to back. It must exceed window plus cutoff buffer |
| `MARKET_WINDOW_SEC`, `MARKET_CUTOFF_BUFFER_SEC`, `MARKET_N_SAMPLES` | 10, 2, 10 | 30, 2, 30 | Each opened market's settlement timing |
| `QUOTE_H0`, `QUOTE_GAMMA_S`, `QUOTE_LAMBDA`, `QUOTE_Q_EPOCH_MAX`, `QUOTE_P_MIN` | 0.02, 0.00002, 0.001, 100, 0.02 | the same | Pricing parameters passed to every opened market |
| `MARKET_BUDGET_USDC`, `SCHEDULER_MIN_BUDGET_USDC` | 10, 1 | 10, 1 | Max and min per-market budget; `open()` uses `min(MARKET_BUDGET_USDC, vaultIdle / 2)` and reverts `InsufficientIdle` below the minimum |

`deployments/unichain-sepolia.json` is read by:
- the bots (`bot/src/config.ts`);
- `packages/swap-sdk` (`loadDeployment`);
- `vendor-interface.mjs`;
- the web dashboard (at build time) and the indexer;
- the backup page (`app/vite.config.ts`).

Its keys:
- `chainId`, `rpcUrl`, `explorer`, `deployBlock`, `deployedAt`;
- `deployer`, `keeper`;
- `poolManager`, `v4Quoter`, `universalRouter` (2.0), `permit2`, `stateView`, `multicall3`, `usdc`;
- `predictionHook`, `marketGatekeeper`, and `marketSchedulers`, an array in the gatekeeper's order (ETH, ETH15M, SOL, SOL15M);
- the ETH price source, flat: `underlyingOracle`, `priceSteerer`, `demoWeth`, `demoUsdc`, `underlyingPool {currency0, currency1, fee, tickSpacing, hooks}`, `underlyingPoolId`, `initialEthPriceUsd`, `oracleParams`;
- `underlyings`, one entry per price source, `{symbol, token, oracle, pool {currency0, currency1, fee, tickSpacing, hooks}, poolId}`: ETH first, with the same values as the flat keys, then SOL;
- `legacyPredictionHooks` and `legacyMarketSchedulers`, the earlier hooks and schedulers, oldest first. Their markets stay redeemable through a direct `redeem`; nothing indexes or lists them.

There is no `marketScheduler` key any more, so a reader that was never updated for tracks fails loudly instead of quietly running one track. `deployBlock` is the block the current hook landed in, where the indexer starts.

Commit the file together with the forge broadcast of the run. Addresses are deterministic: the demo tokens and the gatekeeper come from the deployer's nonce, the schedulers from the gatekeeper's, and the hooks from CREATE2 over their exact bytecode. A private-fork run from a fresh deployer therefore predicts the real addresses.

**Sanity checks after deploying.** Set these variables from the json first:

```sh
R=https://unichain-sepolia.drpc.org
D=./deployments/unichain-sepolia.json
HOOK=$(node -p "require('$D').predictionHook")
GATEKEEPER=$(node -p "require('$D').marketGatekeeper")
ORACLE=$(node -p "require('$D').underlyingOracle")
cast call $HOOK "vaultIdle()(uint256)" --rpc-url $R              # USDC units in the vault
cast call $HOOK "owner()(address)" --rpc-url $R                  # the gatekeeper; keeper() is always address(0)
cast call $GATEKEEPER "hook()(address)" --rpc-url $R             # the hook
cast call $GATEKEEPER "schedulers()(address[])" --rpc-url $R     # equals marketSchedulers, same order
for S in $(node -p "require('$D').marketSchedulers.join(' ')"); do
  cast call $S "config()((uint32,uint32,uint32,uint32,uint32,(uint64,uint64,uint128,uint128,uint64),uint256,uint256,string))" --rpc-url $R
  cast call $S "canOpen()(bool)" --rpc-url $R                    # true when the next open() would succeed
  cast call $S "nextOpenTime()(uint256)" --rpc-url $R            # at or before now: open() is due
done
cast call $ORACLE "lnSpotSoBWad()(int256)" --rpc-url $R          # ln(ETH price) in WAD; the SOL oracle is in underlyings
cast call $ORACLE "varianceE36()(uint256,bool)" --rpc-url $R     # false = still warming up (first 5 min)
```

**Separate bot signers (recommended for demo day).** With one key, the mirror, the keeper and any manual script share a nonce and sometimes collide. They recover on the next loop, but a collision can cost a market.

```sh
cast wallet new                                                 # twice: MIRROR and KEEPER; fund each with about 0.02 ETH
cast send $STEERER "transferOwnership(address)" $MIRROR --rpc-url $R --private-key $DEPLOYER_PRIVATE_KEY
# bot/.env: MIRROR_PRIVATE_KEY=..., KEEPER_PRIVATE_KEY=...
```

After this the mirror key owns the PriceSteerer, so anything the steerer does for the owner, such as seeding a new pool (section 3.2), is signed with the mirror key. The keeper's signer needs no role: `open()` on every scheduler is permissionless, so any funded key can call it. `KEEPER_ADDRESS` only labels the account in the deployments file; pass it to `make deploy-sepolia` if you want a specific address recorded there.

**Volatility.**
- For the first 5 minutes after deploy, an oracle quotes the 60 % fallback σ.
- After that it quotes the realised σ of its demo pool, clamped to [20 %, 250 %].
- The mirror only steers on moves of `MIRROR_THRESHOLD_BPS` or more (default 2 bp), so on a quiet market the estimate often sits on the 20 % floor.
- On that floor, a 1-minute market's price swings hard on each 2-3 bp steer. One standard deviation of ETH over 50 s is only about 3 bp at 20 %.

Both live Sepolia oracles have renounced their ownership (ETH on 2026-09-26, SOL right after its pool was seeded), so their bounds are fixed at [20 %, 250 %] for good. `setVarianceBounds` works only on a fresh oracle (for example the local env) before its owner renounces:

```sh
# setVarianceBounds(min, max, fallback), per-second variance at 1e36 = sigma^2 / 31557600 * 1e36
#   20 % 1267523512561158009481075873    40 % 5070094050244632037924303495    50 % 7922021953507237559256724212
#   60 % 11407711613050422085329682865   250 % 198050548837680938981418105305
cast send $ORACLE "setVarianceBounds(uint256,uint256,uint256)" \
  7922021953507237559256724212 198050548837680938981418105305 11407711613050422085329682865 \
  --rpc-url $R --private-key $DEPLOYER_PRIVATE_KEY
```

The fallback must be at least the new minimum.

### 3.2 Adding a price source (how SOL was added)

Every track reads one oracle, so a new asset first needs its own price source: a demo token, an `UnderlyingOracleHook` and a token/dUSDC pool, built the way Deploy built the ETH one and reusing the file's PoolManager, dUSDC and PriceSteerer. Tracks on it then need a new gatekeeper and hook (section 3.3).

```sh
UNDERLYING_SYMBOL=SOL make underlying-sepolia               # deployer key: token, oracle, pool, steerer as minter, then record()
script/bots.sh stop unichain-sepolia mirror                 # the seed signs with the mirror's key
UNDERLYING_SYMBOL=SOL make seed-underlying-sepolia          # mirror key: demoLiquidity into the pool through the PriceSteerer
UNDERLYING_SYMBOL=SOL make renounce-underlying-sepolia      # deployer key: the new oracle loses its owner (IRREVERSIBLE)
RPC_URL=https://unichain-sepolia.drpc.org MIRROR_THRESHOLD_BPS=1 script/bots.sh start unichain-sepolia mirror
```

1. **`underlying`** (`script/DeployUnderlying.s.sol`) takes `SOL-USD` from Coinbase unless `UNDERLYING_PRICE_USD` is set, then sends four deployer transactions, with no other deployer transaction in between:
   - the dSOL `DemoToken` (18 decimals, faucet `UNDERLYING_FAUCET_PER_CALL` 20 and `UNDERLYING_FAUCET_PER_HOUR` 100);
   - the oracle hook at a mined CREATE2 address, with the file's `oracleParams`;
   - the dSOL/dUSDC pool (fee 500, spacing 10), initialised at that price by the deployer, the oracle's owner;
   - `setMinter` for the PriceSteerer.

   The run is staged in `unichain-sepolia.underlying.pending.json`. `record()` reads the stack back from the chain and only then appends it to `underlyings`, seeding the ETH entry from the flat keys when the list is missing. A failed step prints what landed and how to finish.
2. **`seed-underlying`** (`script/SeedUnderlying.s.sol`) adds `demoLiquidity` through the PriceSteerer, so its owner must sign. On the live deployment that owner is the **mirror key** `0x642c…eDAc`, not the deployer. The command therefore signs with `MIRROR_PRIVATE_KEY` (and `MIRROR_ADDRESS`) from `.env` and refuses when the steerer's `owner()` is anyone else. Stop the mirror first, because it signs with the same key and would race the seed for nonces. With `UNDERLYING_PRICE_USD` set, the steerer first moves the still empty pool to that price, which costs nothing.
3. **`renounce-underlying`** (`script/RenounceUnderlyingOracle.s.sol`) freezes the new oracle's variance bounds at [20 %, 250 %] with the 60 % fallback, as on the ETH oracle. It refuses the ETH oracle, which has its own `renounce-oracle`.
4. **Restart the mirror.** One mirror process steers every pool in `underlyings` from one account, checking each pool against its oracle's `poolKey()` at start-up. `MIRROR_SYMBOLS=ETH` limits it to the listed symbols.

The live SOL source landed this way on 2026-09-26: dSOL `0x49f3768635A2Db5e4bdcB76A4F191EC48B770417`, oracle `0xc7dDbB6648BE0DFCF3eF2a68D40d66374184D080` on pool `0x9453ba24…cde35394`, initialised at 121.325 USD.

### 3.3 Moving the vault to a new hook and set of tracks

The hook's owner is immutable and the gatekeeper's track list is fixed, so any change to the tracks (a new asset, a new length, any config value) means a new gatekeeper, a new hook, and moving the vault's USDC over. This is the sequence that moved the live vault from the single-scheduler hook `0xE6780bBeAee4183Ffd8EBe0d2862dEd221B96aA8` to the four tracks on 2026-09-26, between 17:36 and 17:41 UTC. Markets paused for about 4 minutes.

```sh
R=https://unichain-sepolia.drpc.org
OLD=0xE6780bBeAee4183Ffd8EBe0d2862dEd221B96aA8
```

1. **Stop the keeper.** The mirror keeps running.

   ```sh
   script/bots.sh stop unichain-sepolia keeper
   ```

2. **Settle and sweep the old hook with the keeper key.** The keeper opened its last markets on the old hook at 17:35 and 17:36 (ids 370 and 371, two-minute markets). Once each had expired, `settle` and `sweep` it; both are permissionless.

   ```sh
   for ID in 370 371; do
     cast send $OLD "settle(uint256)" $ID --rpc-url $R --private-key $KEEPER_PRIVATE_KEY
     cast send $OLD "sweep(uint256)" $ID --rpc-url $R --private-key $KEEPER_PRIVATE_KEY
   done
   cast call $OLD "navMinus()(uint256)" --rpc-url $R      # drained when it equals vaultIdle()
   cast call $OLD "vaultIdle()(uint256)" --rpc-url $R
   ```

   The new keeper cannot do this, since it only drives the hook named in the file, and the file still names the old hook until step 4. If anyone calls the old scheduler's `open()` meanwhile, wait for that market too.

3. **Withdraw** every deployer share from the drained hook.

   ```sh
   WITHDRAW_HOOK=$OLD CONFIRM=withdraw script/sepolia.sh withdraw
   ```

   It refuses unless `navMinus == vaultIdle`, and reads `sharesOf` back from the chain afterwards. The live run burned 93,355,145e6 shares for 94.416599 USDC and left 1 unit of dust. From here on the old scheduler `0x511fFFb9fE5d393B10bF185A9c580A732Eff44Dd` reverts `InsufficientIdle`, but a deposit into the old hook would revive it.

4. **Deploy the tracks.** IRREVERSIBLE: the four configs are frozen for good.

   ```sh
   CONFIRM=tracks script/sepolia.sh tracks          # or make tracks-sepolia
   ```

   - Exactly two deployer transactions, with nothing else from the deployer in between: the gatekeeper at nonce n, which deploys the schedulers at `computeCreateAddress(gatekeeper, 1..4)`, then the hook through CREATE2 with the gatekeeper as its owner.
   - The result is staged in `unichain-sepolia.tracks.pending.json`. The script reads the hook's landing block from the broadcast receipt, then `record()` checks the whole set on chain and only then rewrites `deployments/unichain-sepolia.json`: the new `predictionHook`, `marketGatekeeper` and `marketSchedulers`, the old hook appended to `legacyPredictionHooks`, the old `marketScheduler` moved into `legacyMarketSchedulers`, and `deployBlock` 63,591,962, the block the hook landed in.
   - If a step fails, rerunning the command reports which of the two contracts landed and prints the exact command that finishes the job. `record()` rebuilds the configs from the env, so a recovery needs the same `TRACKS_ETH_ONLY` and `TRACK_*` values as the run.

   Then check, read-only: the new hook's `owner()` is the gatekeeper and its `keeper()` is `0x0`, `gatekeeper.schedulers()` equals `marketSchedulers`, every scheduler's `hook()` and `gatekeeper()` match, and the old scheduler's `canOpen()` is false.

5. **Fund the new vault** with what came out of the old one, topped up from the deployer's other Circle USDC.

   ```sh
   FUND_USDC=174.99 CONFIRM=fund script/sepolia.sh fund
   ```

6. **Start the keeper** on the rewritten file.

   ```sh
   RPC_URL=https://unichain-sepolia.drpc.org script/bots.sh start unichain-sepolia keeper
   ```

   At start-up it checks the ownership chain and logs one `track scheduled` line per track, and each track whose `canOpen()` is true opens its current slot at once. The first markets opened at 17:40:44 (ETH), 17:40:47 (ETH15M) and 17:40:50 (SOL15M). SOL skipped its first slot with 4 s of trading left (`slot skipped, too little trading time left`) and opened at 17:41:04.

7. **Point the front ends at the new hook.**

   ```sh
   make vendor-interface
   ```

   This rewrites the Uniswap app fork's `deployment.generated.ts`. Then regenerate `interface-patches/prediction-fork.patch`, rebuild the web dashboard (it imports the deployments file at build time), restart the backup page, and re-sync the indexer on a fresh schema from the new `deployBlock`.

**Rollback before step 6.** `git checkout deployments/unichain-sepolia.json`, withdraw from the new hook, fund the old one, and restart the keeper build that drives the old scheduler. The old scheduler can open again as soon as the old vault's idle USDC is 2 or more.

**Old markets.** Winning tokens of the old hook stay redeemable with a direct `redeem` on that hook: a sweep only returns what winners cannot claim, and a withdrawal only pays idle USDC. The web dashboard and the app fork list only the current hook.

## 4. Running the bots

```sh
make bots                          # NETWORK=unichain-sepolia: mirror + keeper in the background
make bots-status                   # running or not, last two log lines each
make bots-logs                     # tail -f
make bots-stop
DRY_RUN=1 make bots                # compute and log, send nothing
KEEPER_POLL_MS=1000 make bots      # any bot setting passes through, see bot/.env.example
```

`script/bots.sh` runs `bot/src/mirror.ts` and `bot/src/keeper.ts` with `nohup`, using `DEPLOYMENTS_FILE=deployments/<NETWORK>.json`. Logs and pids go to `deployments/.run/<NETWORK>/`. Its arguments are `start|stop|status|logs <network> [mirror|keeper|sealed|all]`, so one bot restarts with, for example, `script/bots.sh stop unichain-sepolia keeper`.

**Keys.**
- The mirror uses `MIRROR_PRIVATE_KEY`, else `DEPLOYER_PRIVATE_KEY`. It must own the PriceSteerer.
- The keeper uses `KEEPER_PRIVATE_KEY`, else `DEPLOYER_PRIVATE_KEY`. Every scheduler's `open()` is permissionless, so any funded key works; the keeper's own key just needs ETH for gas.
- Keys are read from the environment, `bot/.env` or `.env`.

**One keeper for every track.** A single keeper process drives all four schedulers. Two keepers would both settle and sweep the shared hook, and would collide on `keeper.pid` and `keeper.log`.
- At start-up it reads every scheduler's `config()` and exits if a read fails. It also exits unless the hook's owner is `marketGatekeeper`, the gatekeeper's hook is `predictionHook`, `gatekeeper.schedulers()` equals `marketSchedulers`, and every scheduler's `hook()` and `gatekeeper()` match.
- Each tick opens the due tracks first, shortest period first (at a quarter hour ETH and SOL, then ETH15M and SOL15M), then settles and sweeps every market that is due.
- It skips a slot with less than `KEEPER_MIN_TRADE_SEC` (default 5) of trading left, and a `TooLate` revert skips the slot the same way. Each skip logs one `slot skipped` line, then the track waits for its next slot.

**Healthy logs look like this:**
- the mirror logs `steered symbol=ETH …` and `steered symbol=SOL …` whenever a price has moved `MIRROR_THRESHOLD_BPS` or more;
- at start-up the keeper logs a `track track=… scheduler=… periodSec=… tenorSec=…` line and a `track scheduled` line per track;
- every minute it logs:
  - `market opened track=ETH market=N slot=… budget=… strikeCents=… …` and the same for `track=SOL`;
  - `settled market=… track=… yesWon=…` and `swept market=… track=… usdc=…` for the markets that just expired;
- every quarter hour it adds the same lines for `ETH15M` and `SOL15M`, opened right after the 1-minute tracks.

**Budget sizing.**
- A market's budget is the most its LPs can lose. It also caps trade size: a buy of `x` USDC at price `p` needs `budget + x ≥ x / p`, so near 0.5 a single buy is capped at about the budget.
- Each opened market's budget is `min(maxBudget, vaultIdle / 2)`, decided by its scheduler, with `maxBudget` 10 USDC and `minBudget` 1 USDC on every live track. `open()` reverts `InsufficientIdle` below the minimum.
- All four tracks draw on the one vault, in the order the keeper opens them. One market per track trades at a time, but at a boundary the keeper opens before it sweeps, so the markets that just expired still hold their budgets. At a quarter hour that is 40 USDC; ETH then takes `min(10, idle / 2)`, then SOL, ETH15M and SOL15M from what is left. All four get the full 10 USDC while the vault holds about 90 USDC or more.
- **Keep the vault at 150 USDC or more.** That leaves room for a run of losing markets before any budget shrinks. The live tracks started with 174.99 USDC.

The budgets are fixed in the schedulers; `MARKET_BUDGET_USDC` and `SCHEDULER_MIN_BUDGET_USDC` (with their `TRACK_<TICKER>_` prefix) are read only when the tracks are deployed. While the vault is too short to afford the minimum, `open()` reverts `InsufficientIdle`. The keeper logs `open() refused track=… slot=… error=InsufficientIdle(…)` once per slot as a warning and retries every poll (`KEEPER_POLL_MS`, default 2 s) until the vault is funded. An oracle revert inside `open()`, such as the sealed oracle's `StaleSpot`, is logged the same way.

## 5. Front ends

### Uniswap web-app fork (`interface/`)

1. Run `make vendor-interface` (this is `NETWORK=unichain-sepolia`). It copies `packages/swap-sdk` into the fork and writes `deployment.generated.ts` from `deployments/unichain-sepolia.json`, including the gatekeeper and the schedulers. If the dev server is running, Vite hot-reloads.
2. Start the fork as in `interface/PREDICTION_README.md` §1:
   - bun 1.3.14 and node 22.22.2 on `PATH`;
   - `cd interface && SKIP_CONFIG_PULL=true bun web dev`;
   - open `http://localhost:3000`. It must be localhost, because Uniswap's gateway only accepts that origin.
   - The first load takes 30-40 s, so warm it up.
3. In MetaMask:
   - use a plain EOA, not a smart account and not an anvil default account (those are 7702-delegated on 1301);
   - turn on Settings → Testnet mode, and do not disconnect afterwards;
   - select Unichain Sepolia.
4. Deep link: `http://localhost:3000/swap?chain=unichain_sepolia&inputCurrency=0x31d0220469e10c4E71834a79b1f276d740d3768F&outputCurrency=<YES>`. Or use the token picker, which lists USDC once and then one section per track: "ETH 1-minute", "ETH 15-minute", "SOL 1-minute" and "SOL 15-minute". Outcome tokens show their full symbol, such as `ETH15MDOWN`.
5. To swap the hook without a rebuild, run `localStorage.setItem('prediction.hook', '0x…')` in the browser console.

On the private fork, the web-app fork reads chain 1301 only through the hard-coded drpc URL. It therefore always shows the real chain, and cannot show the anvil fork. Rehearse the fork against the real deployment, and use the backup page for the anvil fork.

### Backup page (`app/`)

```sh
make backup-app                   # http://localhost:5173, addresses from deployments/unichain-sepolia.json
make backup-app NETWORK=local     # against the anvil fork (VITE_RPC_URL=http://127.0.0.1:8545, dev tools on)
```

- The page talks only to the chain: V4Quoter, UniversalRouter 2.0 and Permit2.
- URL parameters override everything, for example `?hook=0x…&rpc=https://unichain-sepolia.drpc.org`.
- For a static copy, run `cd app && DEPLOYMENT_FILE=../deployments/unichain-sepolia.json npm run build`, then serve `app/dist`.

## 6. Demo day

### The day before
- [ ] `make deploy-sepolia`, then `make fund-sepolia FUND_USDC=150` or more.
- [ ] Set up separate mirror and keeper signers (section 3).
- [ ] Run `make bots` and leave them running for at least 2 hours. This builds oracle history and gives σ a real estimate on both pools, and it proves the keeper's cadence on all four tracks.
- [ ] Do one full run each in the web-app fork and in the backup page: buy YES, buy NO, sell, wait for settlement, redeem at 1.00.
- [ ] Record a screen capture of a good run as the last fallback.
- [ ] `make local-env && make rehearse` passes on the laptop you will present from.

### One hour before
- [ ] `make bots-status`: both bots are running, and the keeper logged `market opened` for `track=ETH` and `track=SOL` within the last minute.
- [ ] Vault idle is at least 150 USDC (`cast call $HOOK "vaultIdle()(uint256)"`). Top up with `make fund-sepolia`.
- [ ] ETH on the mirror, keeper and deployer is at least 0.01 each (`cast balance <addr> --ether --rpc-url $R`).
- [ ] The demo wallet holds 20 USDC or more and a little ETH. Faucet if needed.
- [ ] The mirror tracks Coinbase: the pool prices in its log are within a few bp of `feed=`, for ETH and for SOL.
- [ ] Start the web-app fork and load the swap page once (the warm-up takes 30-40 s). Testnet mode is on, slippage is on Auto.
- [ ] Open the backup page in a second tab, and the explorer (`https://sepolia.uniscan.xyz`) in a third.

### On stage
1. Open the newest 1-minute market as soon as it appears, at the start of the minute. Trade in the first 30 s: the cutoff is 12 s before expiry, 48 s after the open. For a slower demo use a 15-minute market, which trades until 32 s before its quarter hour.
2. Buy YES with 2-5 USDC. Point at the quote refreshing every second and the price moving with ETH (or SOL).
3. Optionally sell part of it back.
4. At expiry the keeper opens the next market, then settles this one within a few seconds.
5. If YES won, sell YES → USDC in the same swap box: exactly 1.00 each. Show the swap on the explorer: UniversalRouter → PoolManager → hook.

### Fallbacks

| Symptom | Action |
|---|---|
| Web-app fork will not load, or Uniswap's gateway or bot check fails | Switch to the backup page (`make backup-app`, or the prebuilt `app/dist`) |
| Public RPC slow or failing | Bots: `RPC_URL=https://unichain-sepolia.drpc.org make bots` (after `make bots-stop`). Backup page: `?rpc=https://unichain-sepolia.drpc.org` |
| No new markets | `make bots-status` and `make bots-logs`. The usual causes are vault idle below budget, the keeper out of ETH, or nonce errors. Restart with `make bots-stop bots`. To open one market by hand, `cast send <scheduler> "open()" --rpc-url $R --private-key …` with any funded key; past the slot's deadline it reverts `TooLate`, so wait for the next slot |
| One track has no new markets | `make bots-logs` and look for `open() refused track=…` or `slot skipped track=…`. A refusal names the error; skips are normal only right after a keeper restart |
| A market is past expiry but not settled | `cast send $HOOK "settle(uint256)" <id> --rpc-url $R --private-key …`. Settlement is permissionless after expiry |
| Vault idle stuck low | Sweep settled markets with `cast send $HOOK "sweep(uint256)" <id> …` (permissionless) or fund more. Each market's budget already shrinks to `vaultIdle / 2`, and every scheduler's maximum is fixed at deploy |
| Mirror feed errors | It falls back from Coinbase to Kraken to Binance.US, per asset. If all are down, the pool holds its last price, and markets still trade and settle |
| Swap reverts with `V4TooLittleReceived` | Keep slippage on Auto, trade earlier in the market, trade less |
| "No routes found" on a normal size | The trade hits the band, the per-block cap or solvency. Trade 1-2 USDC |
| `nonce too low` in bot logs | Two processes share a key. Use separate signers (section 3) |
| Everything on the real chain is down | `make local-env`, `make rehearse` and `make backup-app NETWORK=local` on the laptop, then the screen recording |

## 7. Files

| Path | What |
|---|---|
| `script/Deploy.s.sol`, `script/Fund.s.sol` | Forge scripts for a fresh stack and a vault deposit. Shared helpers are in `script/base/ScriptBase.sol`, `script/base/Underlyings.sol` and `script/base/TrackSet.sol` |
| `script/base/TrackSet.sol` | The four demo tracks (`demoTracks()`), their `TRACK_<TICKER>_*` env overrides, the two-transaction gatekeeper and hook deploy, and the on-chain check of the whole set |
| `script/DeployTracks.s.sol` | A new gatekeeper, its schedulers and the hook it owns on an existing deployment, then `record()` (section 3.3) |
| `script/Withdraw.s.sol` | Every vault share of the signer out of a drained `WITHDRAW_HOOK` |
| `script/DeployUnderlying.s.sol`, `script/SeedUnderlying.s.sol`, `script/RenounceUnderlyingOracle.s.sol` | A new price source: deploy and record, seed through the PriceSteerer, renounce (section 3.2) |
| `script/RenounceOracle.s.sol` | Renounces the ETH `UnderlyingOracleHook`'s owner once a recorded scheduler reads it |
| `script/CreateMarket.s.sol` | Manual one-off market creation as an EOA; only works against an EOA-owned hook, never behind the gatekeeper |
| `script/local-env.sh`, `script/local-env-stop.sh` | Private anvil fork: bring-up and teardown |
| `script/bots.sh` | Start, stop, status and logs of the bots for a network |
| `script/sepolia.sh` | Guarded broadcasts to the real chain: deploy, fund, withdraw, tracks, underlying, seed-underlying and the renounce commands |
| `script/rehearsal/` | Scripted rehearsal (`rehearse.ts`), the sealed-oracle end to end run (`sealed-e2e.ts`), their helpers and unit tests |
| `deployments/<network>.json` | Addresses for bots, SDK and front ends. `local.json` is git-ignored |
| `deployments/.run/<network>/` | Logs, pids and local broadcasts (git-ignored) |

## 8. Sealed oracle

`SealedPoolOracle` (`src/oracle/SealedPoolOracle.sol`) is the start-of-block oracle for a hookless v4 pool we do not own, such as Unichain's deep ETH/USDC pool. It keeps a gap-free history of end-of-block pool states. Each block enters that history in one of two ways:
- a **seal**: two pokes that see the same price and fee growth, so no swap happened between them;
- a **proof**: the pool's `slot0` proven against the chain's own block hash.

The sealed bot (`bot/src/sealed.ts`, `npm run sealed` in `bot/`) pokes every block and proves every block no seal covers. It needs no role, since the contract checks every seal and proof.

**RPC for proofs.** Keeping up needs `eth_getProof` only for the last few blocks, which any node serves. Recovering from an outage means proving every block the outage left unsealed, so `RPC_URL` or one of `SEALED_RPC_FALLBACKS` must serve `eth_getProof` for blocks as old as the outage: an archive node, or one with a wide proof window.
- On 2026-09-26 most `https://mainnet.unichain.org` backends refused a few dozen blocks back (`distance to target block exceeds maximum proof window`), and publicnode serves old proofs only on an archive plan.
- At start-up the bot asks every configured RPC for a proof 300 blocks back. If none answers, it logs one warning and keeps running, since it can still keep up with the head.

### End to end on anvil

```sh
forge build                                            # the script reads the artifacts in out/
node script/rehearsal/sealed-e2e.ts                    # about 3 minutes, starts and stops its own anvil
SEED=696076038 node script/rehearsal/sealed-e2e.ts     # replays the random swaps of an earlier run
```

It needs Node 24 and `npm ci` in `bot/` and `script/rehearsal/` (section 1). It sends nothing to any real network. `script/rehearsal/sealed-e2e.ts` runs the mainnet design on a plain anvil (chain 31337, not a fork):

1. **Chain.** It starts its own anvil, with every block exactly 1 s after its parent. `poke` and `prove` revert unless a block's timestamp is the oracle's anchor plus one second per block. It deploys in automine, then mines one block per second, as `anvil --block-time 1` does.
2. **Contracts.** It deploys:
   - a PoolManager, a demo USDC, and a hookless native ETH/USDC pool (fee 500, spacing 10, full-range liquidity at $2700);
   - `SealedPoolOracle` on that pool, with the parameters of the mainnet fork test;
   - the `MarketScheduler` that owns a `PredictionHook` reading that oracle. The hook's salt is mined for flags `0x2AA8` with the scheduler as its owner.

   The vault gets 200 USDC.
3. **Random swaps.** The sealed bot runs in-process. A trader swaps random sizes through v4-core's `PoolSwapTest` every one to three blocks, so most pokes cannot seal and the bot proves the gaps. The frontier must stay within 16 blocks of the head.
4. **Market 1: settle waits for the proofs.**
   - The keeper opens a market with `scheduler.open()`. Alice buys UP and Bob buys DOWN for 5 USDC each through `PoolSwapTest`.
   - The bot stops 3 s before the settlement window, and the swaps go on.
   - Past expiry, `settle` must revert with `ObservationUnavailable(expiry)`.
   - The bot restarts with 4-block proof batches. After each batch, `settle` must keep reverting while the frontier is below the last block before expiry, then succeed.
   - The keeper settles and sweeps.
5. **Market 2: recovery after a long outage.**
   - A second market opens. EIP-2935 is replaced by code that returns zero, which is how the history contract answers for a block past its 8191-block window.
   - The bot stops before the window, and the chain moves more than 300 blocks on, past BLOCKHASH's 256. `blockHashOf` knows none of the missing blocks, and `settle` reverts.
   - A restarted bot stores their hashes with `checkpointHeaders`, then proves them, and `settle` succeeds.
6. **Outcome.** For each market, the settled tick sum must equal a brute-force sum of the pool's end-of-block ticks, each read from its block's own state, over every block with a timestamp in `[T - window, T)`. `yesWon` must equal `sum * 1e18 > threshold`, with the threshold recomputed from the strike. The winner redeems for exactly 1 USDC per token, and the loser's tokens do not redeem.
7. **Whole run.** At the end:
   - every `Sealed` and `Proven` event must carry its block's end-of-block tick;
   - the applied blocks must be contiguous up to the frontier;
   - every block must be 1 s after its parent;
   - the bot must have logged no warning or error.

Two details of the script:
- `anvil_setCode` rewrites the latest block's state in place, so anvil can never prove that block. The script etches EIP-2935 while the pool is idle, so the next poke seals that block.
- Markets open, and Alice and Bob trade, while the random swaps run and the bot pokes and proves. The oracle's start-of-block read costs different gas depending on how far the frontier trails the block, so the keeper pads every gas estimate by 30 % plus 30k (swap-sdk's `gasWithHeadroom`) before it sends `open()`, `settle` or `sweep`.

**Results.** On 2026-09-26 two runs in a row passed, with seeds 503634050 and 696076038, about 3 minutes each, while markets still opened on an idle pool. Once the keeper padded its gas, a run that opens both markets while the swaps run passed with seed 739513192. This is the second run, with tx hashes trimmed:

```text
Sealed oracle end to end on a plain anvil (seed 696076038)

== Setup
block    0  anvil   http://127.0.0.1:<port>, plain chain 31337 (not a fork), every block exactly 1 s after its parent
block    8  pool    hookless native ETH/USDC 0x674e43f4… (fee 500, spacing 10) at $2700, full range 1924.50 ETH + 5196152.42 USDC
block    9  oracle  SealedPoolOracle 0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6 anchored at block 9 (maxStaleBlocks 3, parameters of the Unichain fork test)
block   11  market  MarketScheduler 0x8A791620dd6260079BF849Dc5567aDC3F2FdC318 owns PredictionHook 0x25b41973F5C3865C89069764fd90D9fBCcC7aAa8 (flags 0x2aa8, salt found in 6779 tries)
block   19  vault   200.00 USDC deposited; Alice and Bob hold 50 USDC each, the trader swaps from 0xb34db21A319DB87EB63c22fE712A4d4e9D63f3D5
block   19  chain   one block per second from here on

== Sealed bot and random swaps
block   22  bot     the first idle seal started the oracle at block 20 (frontier 21)
block   52  noise   15 swaps in 30 blocks: 3 seals and 24 blocks proven, frontier 49, worst lag 2 blocks behind head - 1

== Market 1: settle is refused until the proofs reach expiry
            INFO  [keeper] market opened market=1 now=1790424382 slot=179042438 budget=10.00 strikeCents=269437
block   55  market  #1 "ETH > $2694.37 26 Sep 12:07": strike $2694.37 from the oracle's start-of-block price, expiry t=1790424420 (block 92), window 10 s, trading stops at T-12 s
block   55  quote   YES mid 0.5010 ask 0.5347, NO ask 0.5326, sigma 60.0%, tau 37 s
block   56  Alice   buys 9.2661 UP for 5.00 USDC at 0.5396 through PoolSwapTest (block 56)
block   56  Bob     buys 9.4641 DOWN for 5.00 USDC at 0.5283 through PoolSwapTest (block 56)
block   80  bot     stops at frontier 78, 3 s before the window; the swaps go on
block   94  settle  past expiry, frontier 78 < block 91: settle(1) reverts ObservationUnavailable(1790424420)
block  102  bot     restarts with 4-block proof batches, settle probed after each (frontier:result) 82:revert 86:revert 90:revert 94:ok
            INFO  [keeper] settled market=1 yesWon=true status=2
            INFO  [keeper] swept market=1 usdc=10.73
block  104  settle  market #1 settled in block 103: YES (UP) won
            end-of-block ticks of blocks 82..91 (t = 1790424410..1790424419): -197295, -197296, -197296, -197282, -197282, -197282, -197280, -197280, -197271, -197271
            brute force: sum -1972835, average -197283.5 vs strike tick -197330.88 (TWAP $2707.17 vs $2694.37), sum * 1e18 > threshold -1973313801477551346901240: matches the hook
block  105  Alice   redeems 9.2661 UP for 9.27 USDC (block 105); Bob's 9.4641 DOWN redeem for nothing

== Market 2: outage past BLOCKHASH and EIP-2935, recovered with checkpointHeaders
            INFO  [keeper] market opened market=2 now=1790424437 slot=179042443 budget=10.00 strikeCents=270697
block  110  market  #2 "ETH > $2706.97 26 Sep 12:07": strike $2706.97 from the oracle's start-of-block price, expiry t=1790424470 (block 142), window 10 s, trading stops at T-12 s
block  110  quote   YES mid 0.4988 ask 0.5338, NO ask 0.5361, sigma 60.0%, tau 32 s
block  111  Alice   buys 9.2805 UP for 5.00 USDC at 0.5388 through PoolSwapTest (block 111)
block  111  Bob     buys 9.4004 DOWN for 5.00 USDC at 0.5319 through PoolSwapTest (block 111)
block  112  chain   EIP-2935 now answers zero for every block (etched at block 111, covered by the seal of blocks 107..111)
block  131  bot     goes down with frontier 129, 3 s before the window; the swaps go on
block  443  outage  313 blocks since block 130 (swaps every 25 blocks), blockHashOf(130) = 0: settle(2) reverts ObservationUnavailable(1790424470)
            INFO  [sealed] checkpointed oldest=205 newest=220 headers=16 gas=1151110
            INFO  [sealed] checkpointed oldest=130 newest=205 headers=76 gas=5364761
            INFO  [sealed] checkpointed oldest=220 newest=228 headers=9 gas=637882
            INFO  [sealed] checkpointed oldest=228 newest=230 headers=3 gas=215495
block  475  bot     restarted: 6 ticks, 104 headers checkpointed, 343 blocks proven (block 130 in block 447, 317 blocks later); settle(2) succeeds from frontier 193
            INFO  [keeper] settled market=2 yesWon=false status=2
            INFO  [keeper] swept market=2 usdc=10.60
block  477  settle  market #2 settled in block 476: NO (DOWN) won
            end-of-block ticks of blocks 132..141 (t = 1790424460..1790424469): -197292, -197292, -197292, -197292, -197292, -197292, -197296, -197297, -197297, -197297
            brute force: sum -1972939, average -197293.9 vs strike tick -197284.22 (TWAP $2704.35 vs $2706.97), sum * 1e18 <= threshold -1972847226411140413841520: matches the hook
block  478  Bob     redeems 9.4004 DOWN for 9.40 USDC (block 478); Alice's 9.2805 UP redeem for nothing

== Whole run
block  481  oracle  frontier 479 = head - 1; blocks 20..479 all applied: 20 by 7 seal events, 440 by proofs, 0 runs queued behind gaps (0 left); each equals the pool's end-of-block tick
block  481  chain   473 blocks from the anchor, each exactly 1 s after its parent; 87 random swaps

sealed e2e passed: gaps proven, settle gated on the frontier, outcomes match the brute force, winners redeemed, recovery via checkpointHeaders
```

### On a Unichain mainnet fork

```sh
UNICHAIN_RPC_URL=https://mainnet.unichain.org forge test --match-path test/integration/SealedUnichainFork.t.sol
```

`test/integration/SealedUnichainFork.t.sol` deploys `SealedPoolOracle` on the real deep ETH/USDC pool `0x3258f413c7a88cda2fa8709a589d221a80f6574f63df5a5b6774485d8acc39d9` (native ETH, fee 500, spacing 10). It checks three things:
- an idle run of three blocks seals, and `lnSpotSoBWad` matches the `slot0` that StateView reports;
- a 25 ETH swap inside a run breaks the seal, and the frontier holds;
- with no poke after that swap, `lnSpotSoBWad` stays at the frontier's price for `maxStaleBlocks` blocks, then reverts `StaleSpot`, until a later idle run re-seals and the spot matches the pool's new `slot0`.

All three pass live against the real pool. Without `UNICHAIN_RPC_URL` they are skipped.

---

## Live deployment notes (Unichain Sepolia)

The four tracks went live on 2026-09-26 at 17:40 UTC (27 Sep in Japan), after the vault moved over as in section 3.3. No key holds an admin role: the hook's only owner is the gatekeeper, its keeper slot is empty, and both oracles' owners are the zero address.

| Item | Value |
|---|---|
| Deployment | `deployments/unichain-sepolia.json` (`deployBlock` 63,591,962, the block the hook landed in) |
| MarketGatekeeper | `0x755dBc10AB4b9BFDB8c46939702dC08B8F3e607A` (the hook's owner; no owner of its own, no setter) |
| PredictionHook | `0xb4544Af6c126773c2f8f4f02f7a1Bde7b975aaa8` (keeper unset; vault funded with 174.99 USDC) |
| MarketScheduler `ETH` | `0x8f1b371e41FeCBb825d0baAB19f906E645C760e0` (period and tenor 60 s, window 10 s, 10 samples) |
| MarketScheduler `ETH15M` | `0x02f0B250120c817A45C6ba580FE68eB461E0A10e` (period and tenor 900 s, window 30 s, 30 samples) |
| MarketScheduler `SOL` | `0x067180DE54F4a800C88C3dC9EDa8b106f7126b83` (period and tenor 60 s, window 10 s, 10 samples) |
| MarketScheduler `SOL15M` | `0x950eEDA8303253b76f0d47f4a3eD33aA7fF54E74` (period and tenor 900 s, window 30 s, 30 samples) |
| Every track | cutoff buffer 2 s, h0 0.02 (a 2 cent half-spread), gammaS 0.00002, lambda 0.001, qEpochMax 100, pMin 0.02, budget `min(10 USDC, vaultIdle / 2)`, min 1 USDC |
| UnderlyingOracleHook, ETH | `0x1F356D9E7d6dBE6d807aCBc5D163a7af265cd080` on the dWETH/dUSDC pool (ownership renounced) |
| UnderlyingOracleHook, SOL | `0xc7dDbB6648BE0DFCF3eF2a68D40d66374184D080` on the dSOL/dUSDC pool `0x9453ba24…cde35394` (ownership renounced) |
| dSOL | `0x49f3768635A2Db5e4bdcB76A4F191EC48B770417` |
| Legacy PredictionHooks | `0x62bBCbA51cbFC8D0C932e482bD8F62590fEeeAa8` and `0xE6780bBeAee4183Ffd8EBe0d2862dEd221B96aA8` (drained, vaults empty; their tokens stay redeemable there) |
| Legacy MarketScheduler | `0x511fFFb9fE5d393B10bF185A9c580A732Eff44Dd` (owns `0xE678…`; `open()` reverts `InsufficientIdle` while that vault is empty) |
| PriceSteerer owner (mirror signer) | `0x642c95Ad042C32289687152EE838D14BC219eDAc` |
| Keeper signer (no role; any key works) | `0x7B7675a09801049C1D3296d76A29D69913Da3dF0` |

- **RPC for bots and scripts:** `https://unichain-sepolia.drpc.org`. The load-balanced `https://sepolia.unichain.org` sometimes serves stale state (pending nonce 0) and causes `nonce too low`.
- **Demo bot command:**

  ```sh
  RPC_URL=https://unichain-sepolia.drpc.org MIRROR_THRESHOLD_BPS=1 script/bots.sh start unichain-sepolia
  ```

  Append `mirror` or `keeper` to start only one of them, for example after `script/bots.sh stop unichain-sepolia keeper`.
  - Market settings live in the schedulers, so `MARKET_*` and `QUOTE_*` do not affect the bots. The keeper reads every scheduler's `config()` at start-up and exits if one fails.
  - Each track runs its markets back to back: a 1-minute market trades for 48 s, then 12 s pass without trading on that track until the next one opens. A 15-minute market trades for 868 s, then 32 s pass. At every quarter hour all four tracks settle and open together.
  - The spread is h0 = 2¢ plus a gamma term that widens toward the cutoff.
- **Real-chain smoke test:**

  ```sh
  cd script/rehearsal && SMOKE_USDC=1 node smoke-real.ts
  ```

  It buys YES with the deployer's USDC and sells half back through UniversalRouter 2.0, and prints uniscan links. It last passed on 2026-09-26, against the previous hook.
- **Gas:** the mirror and keeper each started with 0.015 ETH. With two pools to steer and four tracks to open, plan on topping them up at least daily from the deployer with `cast send <addr> --value 0.01ether`.
