# Demo runbook

This runbook covers the live demo on Unichain Sepolia (chain 1301): the contracts, the two bots, the two front ends, and what to do when something breaks.

Demo markets are 60-second "ETH above K" markets:
- The underlying pool is our own demo WETH/USDC pool with the oracle hook. The price mirror keeps it at the real ETH price.
- The keeper opens a market every wall-clock minute, struck at the current price.
- Trading stops 12 s before expiry (10 s settlement window plus 2 s buffer).
- The keeper settles about 1-2 s after expiry. Winners sell the winning token for exactly 1.00 USDC.

Every command below runs from the repo root. `make` with no target lists all the targets.

| I want to... | Command |
|---|---|
| Practise everything on a private fork | `make local-env`, then `make rehearse` |
| Deploy to the real Unichain Sepolia | `make deploy-sepolia`, then `make fund-sepolia` |
| Run the bots | `make bots` (`make bots-status`, `make bots-logs`, `make bots-stop`) |
| Show the Uniswap web-app fork | `make vendor-interface`, then run `interface/` (section 5) |
| Show the backup page | `make backup-app` |
| Stop the private fork | `make local-stop` |

---

## 1. Prerequisites

- **Foundry 1.8.3** in `~/.foundry/bin`. The Makefile and scripts add that folder to `PATH` themselves.
- **Node 24** for the bots. The rehearsal needs Node 22.18 or later.
- **Dependencies:** run `cd bot && npm ci` once. `make rehearse` installs `script/rehearsal/node_modules` by itself.
- **The repo-root `.env`** (git-ignored) must hold:
  - `DEPLOYER_PRIVATE_KEY`
  - `DEPLOYER_ADDRESS`
  - `UNICHAIN_SEPOLIA_RPC`, which is optional. It defaults to `https://sepolia.unichain.org`.

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
3. It runs `script/Deploy.s.sol` at the live Coinbase ETH price, then `script/Fund.s.sol` with 500 USDC. Together they write `deployments/local.json`.
4. It moves the PriceSteerer to the local mirror key, so deployer-signed scripts never race the mirror for nonces. Then it starts the mirror and the keeper with a 100 USDC market budget.

Logs, pids and forge broadcasts go to `deployments/.run/local/`. They are git-ignored, so local runs never touch `broadcast/`.

Settings you can override: `LOCAL_PORT`, `FORK_URL`, `FORK_BLOCK`, `FUND_USDC`, `DEPLOYER_USDC`, `ETH_PRICE_USD`, `MARKET_BUDGET_USDC`, and `START_BOTS=0`.

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
- `make market-local`: creates a one-off market with `script/CreateMarket.s.sol`. It uses the keeper's env names and defaults (`MARKET_TENOR_SEC=60`, `MARKET_BUDGET_USDC=10`, `STRIKE_USD` = the oracle spot, `QUOTE_*` and so on).
- `make local-wallet ADDR=0x… USDC=100`: sets a wallet's balances on the fork to 10 ETH and 100 Circle USDC, for trying the backup page with MetaMask.
- To point MetaMask at the fork, add `http://127.0.0.1:8545` as an RPC URL of the Unichain Sepolia network (chain 1301) and select it. Switch back afterwards.

## 3. Deploying to Unichain Sepolia (once the deployer is funded)

**Funding.**
- ETH on Unichain Sepolia:
  - The full deploy is about 17M gas, about 0.00002 ETH at the usual 0.001 gwei.
  - The bots use roughly 0.001 ETH per hour: a steer is about 200k gas and `createMarket` about 1.65M gas.
  - Keep 0.02 ETH or more on each signer.
- Circle USDC comes from the faucet (about 20 USDC per 2 h per address). All of it can go into the vault.

```sh
make deploy-sepolia                    # script/sepolia.sh deploy
make fund-sepolia FUND_USDC=40         # vault deposit (default 20)
```

`script/sepolia.sh` guards every broadcast to the real chain.
- It refuses to run when `CI` is set, without a terminal, or when the RPC is not chain 1301 or is an anvil node.
- Before sending anything it prints:
  - the signer's ETH and USDC balances;
  - the ETH price it will use, fetched from Coinbase unless `ETH_PRICE_USD` is set;
  - the full forge simulation.
- It broadcasts only after you type the command name (`deploy`, `fund` or `market`). It uses `--slow`, so transactions go one at a time.

`ALLOW_ANVIL=1 UNICHAIN_SEPOLIA_RPC=http://127.0.0.1:8545 make deploy-sepolia` runs the same flow against the private fork. It writes `deployments/sepolia-rehearsal.json` instead.

Deploy (`script/Deploy.s.sol`) does these steps in order:

1. Deploys the demo tokens: `DemoToken` dWETH (18 decimals, faucet 1 per call and 5 per hour) and dUSDC (6 decimals, faucet 10,000 per call and 50,000 per hour).
2. Deploys `UnderlyingOracleHook` at a CREATE2 address mined for flags `AFTER_INITIALIZE | BEFORE_SWAP`, through `0x4e59…956C`.
3. Initialises the dWETH/dUSDC pool (fee 500, tick spacing 10) from the deployer, the oracle owner. The initial price is `ETH_PRICE_USD`, with either token order handled.
4. Deploys `PriceSteerer` (owner = deployer). It becomes a minter of both demo tokens and seeds full-range liquidity (`DEMO_LIQUIDITY`, default 1e18, about 19k dWETH and 52M dUSDC).
5. Deploys `PredictionHook(PoolManager, Circle USDC, deployer)` at a mined address with flags `0x2AA8`.
6. Calls `setKeeper(KEEPER_ADDRESS)`, which defaults to the deployer.

It then checks:
- both flag masks;
- the pool binding;
- every owner;
- the oracle's start-of-block price against `ETH_PRICE_USD`;
- that the oracle starts on its warm-up variance.

| Env | Default | Meaning |
|---|---|---|
| `ETH_PRICE_USD` | live Coinbase price (the script's own default is 2700) | Initial pool price |
| `KEEPER_ADDRESS` | deployer | `PredictionHook.keeper` |
| `DEMO_LIQUIDITY` | 1e18 | Full-range liquidity L of the underlying pool |
| `UNDERLYING_FEE`, `UNDERLYING_TICK_SPACING` | 500, 10 | Underlying pool key |
| `ORACLE_GRID_SECONDS` | 10 | TWAP-return grid H |
| `ORACLE_N_WINDOWS` | 180 | 30 min lookback |
| `ORACLE_MIN_WINDOWS` | 30 | 5 min warm-up on the fallback σ |
| `ORACLE_WINSOR_TICKS` | 100 | About 8 SD of a 10 s window-mean move at 250 % |
| `ORACLE_SIGMA_MIN`, `ORACLE_SIGMA_MAX`, `ORACLE_SIGMA_FALLBACK` | 0.2, 2.5, 0.6 | Annual σ clamps and warm-up value |
| `ORACLE_CARDINALITY` | 14400 | Observation ring: 4 h of 1 s writes (at least 7200 is required) |
| `NETWORK` / `DEPLOYMENTS_FILE` | `unichain-sepolia` | Output `deployments/<NETWORK>.json` |
| `DEPLOYMENTS_RPC_URL` | `https://sepolia.unichain.org` | `rpcUrl` written into the file for the bots |

`deployments/unichain-sepolia.json` is read by:
- the bots (`bot/src/config.ts`);
- `packages/swap-sdk` (`loadDeployment`);
- `vendor-interface.mjs`;
- the backup page (`app/vite.config.ts`).

It is flat:
- `chainId`, `rpcUrl`, `explorer`, `deployBlock`, `deployedAt`;
- `deployer`, `keeper`;
- `poolManager`, `v4Quoter`, `universalRouter` (2.0), `permit2`, `stateView`, `multicall3`, `usdc`;
- `predictionHook`, `underlyingOracle`, `priceSteerer`, `demoWeth`, `demoUsdc`;
- `underlyingPool {currency0, currency1, fee, tickSpacing, hooks}`, `underlyingPoolId`;
- `initialEthPriceUsd`, `oracleParams`.

Commit it together with `broadcast/Deploy.s.sol/1301/run-latest.json`. Addresses are deterministic: the demo tokens come from the deployer's nonce, and both hooks come from CREATE2 over their exact bytecode. A private-fork run from a fresh deployer therefore predicts the real addresses.

**Sanity checks after deploying.** Set these variables from the json first:

```sh
R=https://sepolia.unichain.org
HOOK=$(node -p "require('./deployments/unichain-sepolia.json').predictionHook")
ORACLE=$(node -p "require('./deployments/unichain-sepolia.json').underlyingOracle")
cast call $HOOK "vaultIdle()(uint256)" --rpc-url $R            # USDC units in the vault
cast call $HOOK "keeper()(address)" --rpc-url $R
cast call $ORACLE "lnSpotSoBWad()(int256)" --rpc-url $R        # ln(ETH price) in WAD
cast call $ORACLE "varianceE36()(uint256,bool)" --rpc-url $R   # false = still warming up (first 5 min)
```

**Separate bot signers (recommended for demo day).** With one key, the mirror, the keeper and any manual script share a nonce and sometimes collide. They recover on the next loop, but a collision can cost a market.

```sh
cast wallet new                                                 # twice: MIRROR and KEEPER; fund each with about 0.02 ETH
cast send $STEERER "transferOwnership(address)" $MIRROR --rpc-url $R --private-key $DEPLOYER_PRIVATE_KEY
cast send $HOOK "setKeeper(address)" $KEEPER --rpc-url $R --private-key $DEPLOYER_PRIVATE_KEY
# bot/.env: MIRROR_PRIVATE_KEY=..., KEEPER_PRIVATE_KEY=...
```

Alternatively, pass `KEEPER_ADDRESS=$KEEPER` to `make deploy-sepolia`.

**Volatility.**
- For the first 5 minutes after deploy, the oracle quotes the 60 % fallback σ.
- After that it quotes the realised σ of the demo pool, clamped to [20 %, 250 %].
- The mirror only steers on moves of 2 bp or more, so on a quiet market the estimate often sits on the 20 % floor.
- On that floor, a 60 s market's price swings hard on each 2-3 bp steer. One standard deviation of ETH over 50 s is only about 3 bp at 20 %.

For calmer demo prices, the oracle owner can raise the floor at any time:

```sh
# setVarianceBounds(min, max, fallback), per-second variance at 1e36 = sigma^2 / 31557600 * 1e36
#   20 % 1267523512561158009481075873    40 % 5070094050244632037924303495    50 % 7922021953507237559256724212
#   60 % 11407711613050422085329682865   250 % 198050548837680938981418105305
cast send $ORACLE "setVarianceBounds(uint256,uint256,uint256)" \
  7922021953507237559256724212 198050548837680938981418105305 11407711613050422085329682865 \
  --rpc-url $R --private-key $DEPLOYER_PRIVATE_KEY
```

The fallback must be at least the new minimum.

## 4. Running the bots

```sh
make bots                          # NETWORK=unichain-sepolia: mirror + keeper in the background
make bots-status                   # running or not, last two log lines each
make bots-logs                     # tail -f
make bots-stop
DRY_RUN=1 make bots                # compute and log, send nothing
MARKET_BUDGET_USDC=10 make bots    # any bot setting passes through, see bot/.env.example
```

`script/bots.sh` runs `bot/src/mirror.ts` and `bot/src/keeper.ts` with `nohup`, using `DEPLOYMENTS_FILE=deployments/<NETWORK>.json`. Logs and pids go to `deployments/.run/<NETWORK>/`.

**Keys.**
- The mirror uses `MIRROR_PRIVATE_KEY`, else `DEPLOYER_PRIVATE_KEY`. It must own the PriceSteerer.
- The keeper uses `KEEPER_PRIVATE_KEY`, else `DEPLOYER_PRIVATE_KEY`. It must be the hook owner or keeper.
- Keys are read from the environment, `bot/.env` or `.env`.

**Healthy logs look like this:**
- the mirror logs `steered … devBps=…` whenever ETH has moved 2 bp or more;
- the keeper logs, every minute:
  - `market created market=N name="ETH > $2680.57 26 Sep 21:59" …`;
  - `settled market=N-1 yesWon=…`;
  - `swept market=N-1 usdc=…`.

**Budget sizing.**
- A market's budget is the most its LPs can lose. It also caps trade size: a buy of `x` USDC at price `p` needs `budget + x ≥ x / p`, so near 0.5 a single buy is capped at about the budget.
- The keeper needs `vaultIdle ≥ budget` at each creation, and about two markets hold budget at once.

With a 40 USDC vault, use `MARKET_BUDGET_USDC=10` and demo trades of 2-5 USDC. The keeper skips creation, with a warning, while the vault is short.

## 5. Front ends

### Uniswap web-app fork (`interface/`)

1. Run `make vendor-interface` (this is `NETWORK=unichain-sepolia`). It copies `packages/swap-sdk` into the fork and writes `deployment.generated.ts` from `deployments/unichain-sepolia.json`. If the dev server is running, Vite hot-reloads.
2. Start the fork as in `interface/PREDICTION_README.md` §1:
   - bun 1.3.14 and node 22.22.2 on `PATH`;
   - `cd interface && SKIP_CONFIG_PULL=true bun web dev`;
   - open `http://localhost:3000`. It must be localhost, because Uniswap's gateway only accepts that origin.
   - The first load takes 30-40 s, so warm it up.
3. In MetaMask:
   - use a plain EOA, not a smart account and not an anvil default account (those are 7702-delegated on 1301);
   - turn on Settings → Testnet mode, and do not disconnect afterwards;
   - select Unichain Sepolia.
4. Deep link: `http://localhost:3000/swap?chain=unichain_sepolia&inputCurrency=0x31d0220469e10c4E71834a79b1f276d740d3768F&outputCurrency=<YES>`. Or use the token picker's "Prediction markets" section.
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
- [ ] `make deploy-sepolia`, then `make fund-sepolia`.
- [ ] Set up separate mirror and keeper signers (section 3).
- [ ] Run `make bots` and leave them running for at least 2 hours. This builds oracle history and gives σ a real estimate, and it proves the keeper's cadence.
- [ ] Do one full run each in the web-app fork and in the backup page: buy YES, buy NO, sell, wait for settlement, redeem at 1.00.
- [ ] Record a screen capture of a good run as the last fallback.
- [ ] `make local-env && make rehearse` passes on the laptop you will present from.

### One hour before
- [ ] `make bots-status`: both bots are running, and the keeper logged `market created` within the last minute.
- [ ] Vault idle is at least 3 × `MARKET_BUDGET_USDC` (`cast call $HOOK "vaultIdle()(uint256)"`). Top up with `make fund-sepolia`.
- [ ] ETH on the mirror, keeper and deployer is at least 0.01 each (`cast balance <addr> --ether --rpc-url $R`).
- [ ] The demo wallet holds 20 USDC or more and a little ETH. Faucet if needed.
- [ ] The mirror tracks Coinbase: the pool price in its log is within a few bp of `feed=`.
- [ ] Start the web-app fork and load the swap page once (the warm-up takes 30-40 s). Testnet mode is on, slippage is on Auto.
- [ ] Open the backup page in a second tab, and the explorer (`https://sepolia.uniscan.xyz`) in a third.

### On stage
1. Open the newest market as soon as it appears, at the start of the minute. Trade in the first 30 s, because the cutoff is at T-12 s.
2. Buy YES with 2-5 USDC. Point at the quote refreshing every second and the price moving with ETH.
3. Optionally sell part of it back.
4. At expiry the keeper settles within about 2 s.
5. If YES won, sell YES → USDC in the same swap box: exactly 1.00 each. Show the swap on the explorer: UniversalRouter → PoolManager → hook.

### Fallbacks

| Symptom | Action |
|---|---|
| Web-app fork will not load, or Uniswap's gateway or bot check fails | Switch to the backup page (`make backup-app`, or the prebuilt `app/dist`) |
| Public RPC slow or failing | Bots: `RPC_URL=https://unichain-sepolia.drpc.org make bots` (after `make bots-stop`). Backup page: `?rpc=https://unichain-sepolia.drpc.org` |
| No new markets | `make bots-status` and `make bots-logs`. The usual causes are vault idle below budget, the keeper out of ETH, or nonce errors. Restart with `make bots-stop bots`. For one market by hand, run `make market-sepolia` |
| A market is past expiry but not settled | `cast send $HOOK "settle(uint256)" <id> --rpc-url $R --private-key …`. Settlement is permissionless after expiry |
| Vault idle stuck low | Sweep settled markets with `cast send $HOOK "sweep(uint256)" <id> …` (permissionless), fund more, or lower `MARKET_BUDGET_USDC` |
| Mirror feed errors | It falls back from Coinbase to Kraken to Binance.US. If all are down, the pool holds its last price, and markets still trade and settle |
| Swap reverts with `V4TooLittleReceived` | Keep slippage on Auto, trade earlier in the minute, trade less |
| "No routes found" on a normal size | The trade hits the band, the per-block cap or solvency. Trade 1-2 USDC |
| `nonce too low` in bot logs | Two processes share a key. Use separate signers (section 3) |
| Everything on the real chain is down | `make local-env`, `make rehearse` and `make backup-app NETWORK=local` on the laptop, then the screen recording |

## 7. Files

| Path | What |
|---|---|
| `script/Deploy.s.sol`, `script/Fund.s.sol`, `script/CreateMarket.s.sol` | Forge scripts. Shared helpers are in `script/base/ScriptBase.sol` |
| `script/local-env.sh`, `script/local-env-stop.sh` | Private anvil fork: bring-up and teardown |
| `script/bots.sh` | Start, stop, status and logs of the bots for a network |
| `script/sepolia.sh` | Guarded deploy, fund and market on the real chain |
| `script/rehearsal/` | Scripted rehearsal (`rehearse.ts`), its helpers and unit tests |
| `deployments/<network>.json` | Addresses for bots, SDK and front ends. `local.json` is git-ignored |
| `deployments/.run/<network>/` | Logs, pids and local broadcasts (git-ignored) |

---

## Live deployment notes (Unichain Sepolia, 2026-09-26)

| Item | Value |
|---|---|
| Deployment | `deployments/unichain-sepolia.json` (block 63,521,900) |
| PredictionHook | `0x62bBCbA51cbFC8D0C932e482bD8F62590fEeeAa8` (vault funded with 35 USDC) |
| UnderlyingOracleHook | `0x1F356D9E7d6dBE6d807aCBc5D163a7af265cd080` |
| PriceSteerer owner (mirror signer) | `0x642c95Ad042C32289687152EE838D14BC219eDAc` |
| Hook keeper (keeper signer) | `0x7B7675a09801049C1D3296d76A29D69913Da3dF0` |

- **RPC for bots and scripts:** `https://unichain-sepolia.drpc.org`. The load-balanced `https://sepolia.unichain.org` sometimes serves stale state (pending nonce 0) and causes `nonce too low`.
- **Demo bot command:**

  ```sh
  RPC_URL=https://unichain-sepolia.drpc.org MARKET_BUDGET_USDC=10 QUOTE_H0=0.01 QUOTE_GAMMA_S=0.00002 MIRROR_THRESHOLD_BPS=1 MARKET_TENOR_SEC=120 KEEPER_PERIOD_SEC=60 script/bots.sh start unichain-sepolia
  ```

  - Demo markets last 2 minutes and a new one opens every minute. Markets overlap, so one is always open with at least ~45 s of trading left. Each market settles every minute.
  - This gives an ATM spread of about ±4¢, widening toward the cutoff.
  - The production values (h0 = 0.02, gammaS = 0.00005) quote ±10¢ at σ ≈ 20%, which is too wide for 60-second markets.
- **Real-chain smoke test:**

  ```sh
  cd script/rehearsal && SMOKE_USDC=1 node smoke-real.ts
  ```

  It buys YES with the deployer's USDC and sells half back through UniversalRouter 2.0, and prints uniscan links. It passed on 2026-09-26.
- **Gas:** the mirror and keeper each started with 0.015 ETH. At 0.0015 gwei that lasts about a day of continuous running. Top them up from the deployer with `cast send <addr> --value 0.01ether`.
