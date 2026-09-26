# Phinary

Our developer feedback for ETHGlobal Tokyo 2026 is in [FEEDBACK.md](FEEDBACK.md).

Phinary brings binary options into Uniswap v4. Traders buy and sell UP or DOWN tokens through ordinary Uniswap swaps. A custom hook prices the options using Black-Scholes adapted to the settlement window, and a shared USDC vault backs the payouts.

Each option has a strike and an expiry. The winning side redeems for $1 per token, based on the underlying Uniswap pool's average price over the settlement window. The option pricing and accounting live in the hook; quotes and trades use V4Quoter, Permit2 and UniversalRouter.

## How it works

- **PredictionHook** is a Uniswap v4 hook that prices every YES/NO swap itself. It uses a Black-Scholes binary price in its settlement-matched average-price form, and Uniswap's liquidity curve is never used.
- **UnderlyingOracleHook** records the start-of-block ETH/USDC price and its volatility from a Uniswap v4 pool. Swaps earlier in the same block cannot move the price it reports. Its ownership is renounced, so no key can change it.
- **MarketScheduler** is an ownerless contract that becomes the hook's `owner`. Anyone can call its `open()` once per time slot to open the next market; there is no admin, no setter and no keeper role, on the scheduler or on the hook it owns.
- **Settlement** uses the pool's average price over the final window of each market. Anyone can call `settle()`, and ties resolve DOWN.
- **The LP vault** underwrites every market. Complete-set accounting means every winning token is always backed by 1 USDC.

## Oracle: Uniswap, and nothing external

Phinary is not oracle-free. Settling "ETH > $X at expiry" needs a price, and whatever supplies it is an oracle. Phinary's oracle is a Uniswap pool: no third party observes prices off-chain and posts them, so there is no operator, feed admin or pause switch to trust. The only attack is paying to move the pool itself.

- **Testnet (live):** our own Uniswap v4 ETH/USDC pool, read by `UnderlyingOracleHook`. Unichain Sepolia has no real ETH market, so a mirror bot trades that pool to the Coinbase price, standing in for the arbitrage that keeps real pools in line. The contracts never see Coinbase; they only read the pool.
- **Mainnet design:** `SealedPoolOracle` reads Unichain's deep ETH/USDC pool, which has no hook, through fee-growth seals and Merkle-Patricia proofs against Unichain's own block hashes. It is tested against the real pool on a mainnet fork and not deployed yet.
- **Bots** (keeper, and on mainnet the poke-and-prove bot) only send permissionless transactions. They cannot choose a price; if they stop, markets pause, and anyone can run them.

Say "no external oracle", not "oracle-free" or "no oracles".

## Live on Unichain Sepolia (chain 1301)

| Contract | Address |
|---|---|
| MarketScheduler (the hook's only owner) | `0x511fFFb9fE5d393B10bF185A9c580A732Eff44Dd` |
| PredictionHook | `0xE6780bBeAee4183Ffd8EBe0d2862dEd221B96aA8` |
| UnderlyingOracleHook (ownership renounced) | `0x1F356D9E7d6dBE6d807aCBc5D163a7af265cd080` |
| Legacy PredictionHook (old markets, redeem only) | `0x62bBCbA51cbFC8D0C932e482bD8F62590fEeeAa8` |
| PriceSteerer (demo price mirror) | `0x21C55279188072E6BfeF14c4920eA1cEFEd358a3` |
| USDC (Circle, testnet) | `0x31d0220469e10c4E71834a79b1f276d740d3768F` |

Every address is in `deployments/unichain-sepolia.json`.

## Repository

| Path | What it holds |
|---|---|
| `src/` | Solidity: the hooks, the pricing math (`src/math`), outcome tokens, demo contracts |
| `test/` | Foundry tests: math, oracle, hook, integration, security and attack cases |
| `script/` | Deploy, fund and market scripts, the local fork environment and the rehearsal |
| `bot/` | The price-mirror bot (a testnet stand-in for the arbitrage that would otherwise keep the demo pool near the real price), the keeper that opens markets by calling the scheduler, and the sealed-oracle poke-and-prove bot |
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
