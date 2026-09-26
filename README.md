# Phinary

Phinary runs binary prediction markets on ETH through a Uniswap v4 hook. Each market asks a question like "ETH > $2,684.53 at 00:48?". It is priced with Black-Scholes, not with a liquidity curve, and it trades through ordinary Uniswap v4 swaps.

Each market has two tokens, `ETHUP` and `ETHDOWN`. Each costs between $0.00 and $1.00, and a winning token redeems for exactly $1.00.

## How it works

- **PredictionHook** is a Uniswap v4 hook that prices every YES/NO swap itself. It uses a Black-Scholes binary price in its settlement-matched average-price form, and Uniswap's liquidity curve is never used.
- **UnderlyingOracleHook** records the start-of-block ETH/USDC price and its volatility from a Uniswap v4 pool. Swaps earlier in the same block cannot move the price it reports. There is no external oracle: the price a market settles against comes only from this Uniswap v4 pool.
- **MarketScheduler** is an ownerless contract that becomes the hook's `owner`. Anyone can call its `open()` once per time slot to open the next market; there is no admin, no setter and no keeper role, on the scheduler or on the hook it owns.
- **Settlement** uses the pool's average price over the final window of each market. Anyone can call `settle()`, and ties resolve DOWN.
- **The LP vault** underwrites every market. Complete-set accounting means every winning token is always backed by 1 USDC.

## Live on Unichain Sepolia (chain 1301)

| Contract | Address |
|---|---|
| PredictionHook | `0x62bBCbA51cbFC8D0C932e482bD8F62590fEeeAa8` |
| UnderlyingOracleHook | `0x1F356D9E7d6dBE6d807aCBc5D163a7af265cd080` |
| PriceSteerer (demo price mirror) | `0x21C55279188072E6BfeF14c4920eA1cEFEd358a3` |
| USDC (Circle, testnet) | `0x31d0220469e10c4E71834a79b1f276d740d3768F` |

Every address is in `deployments/unichain-sepolia.json`.

## Repository

| Path | What it holds |
|---|---|
| `src/` | Solidity: the hooks, the pricing math (`src/math`), outcome tokens, demo contracts |
| `test/` | Foundry tests: math, oracle, hook, integration, security and attack cases |
| `script/` | Deploy, fund and market scripts, the local fork environment and the rehearsal |
| `bot/` | The price-mirror bot (a testnet stand-in for the arbitrage that would otherwise keep the demo pool near the real price) and the keeper that opens markets by calling the scheduler |
| `packages/swap-sdk/` | `@phinary/swap-sdk`: V4Quoter quotes, UniversalRouter encoding, revert decoding |
| `web/` | The Phinary dashboard (Next.js) |
| `app/` | The backup swap page |
| `interface-patches/` | The Uniswap web app fork, as a patch |
| `sim/`, `formal/` | Reference math, test vectors, z3 lemmas and monotonicity certificates |
| `docs/` | The Phinary docs site (Nextra) |
| `docs/md/` | Plan, spec, runbook, dashboard spec and research |

## Quick start

```sh
make build && make test     # contracts and tests
make local-env              # local fork of Unichain Sepolia with everything deployed and the bots running
make rehearse               # scripted buy, sell, settle and redeem on that fork
cd web && npm install && npm run dev   # dashboard at http://localhost:3100
cd docs && npm install && npm run dev  # docs site at http://localhost:3200
```

The live demo and deployment are covered in [docs/md/RUNBOOK.md](docs/md/RUNBOOK.md), the design in [docs/md/PLAN.md](docs/md/PLAN.md) and [docs/md/SPEC.md](docs/md/SPEC.md), and the dashboard in [docs/md/DASHBOARD.md](docs/md/DASHBOARD.md).
