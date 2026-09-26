# Phinary

Our developer feedback for ETHGlobal Tokyo 2026 is in [FEEDBACK.md](FEEDBACK.md).

Phinary brings ETH and SOL binary options into Uniswap v4. Traders buy and sell UP or DOWN tokens through ordinary Uniswap swaps. A custom hook calculates the option price, and a shared USDC vault backs the payouts. At expiry, the winning side redeems for 1 USDC per token.

## Uniswap integration: code and documentation

Start with the hook's swap callback, then follow the quote and execution path through the SDK. The code links below are pinned to commit `422fb4f` so the highlighted lines stay stable.

| What to inspect | Implementation | Explanation |
|---|---|---|
| Hook permissions and custom swap accounting | [permissions](https://github.com/oynozan/phinary/blob/422fb4ff933c6f01d8caeeed076cbf60e6b1a208/src/PredictionHook.sol#L119-L126) · [beforeSwap](https://github.com/oynozan/phinary/blob/422fb4ff933c6f01d8caeeed076cbf60e6b1a208/src/PredictionHook.sol#L221-L247) | [Hook reference](docs/content/contracts/prediction-hook.mdx) |
| Underlying pool price at the start of a block | [price capture and read](https://github.com/oynozan/phinary/blob/422fb4ff933c6f01d8caeeed076cbf60e6b1a208/src/oracle/UnderlyingOracleHook.sol#L202-L221) | [Oracle reference](docs/content/contracts/oracle.mdx) |
| Quotes through V4Quoter | [quote calls](https://github.com/oynozan/phinary/blob/422fb4ff933c6f01d8caeeed076cbf60e6b1a208/packages/swap-sdk/src/quote.ts#L29-L79) | [Quote and swap](docs/content/integration/quote-and-swap.mdx) |
| UniversalRouter swap encoding and execution calldata | [V4_SWAP, settlement and execute](https://github.com/oynozan/phinary/blob/422fb4ff933c6f01d8caeeed076cbf60e6b1a208/packages/swap-sdk/src/swap.ts#L102-L164) | [Quote and swap](docs/content/integration/quote-and-swap.mdx) |
| Permit2 permissions and token approvals | [permit, allowances and approval](https://github.com/oynozan/phinary/blob/422fb4ff933c6f01d8caeeed076cbf60e6b1a208/packages/swap-sdk/src/permit2.ts#L46-L149) | [SDK usage](packages/swap-sdk/README.md) |
| Settlement from pool observations and redemption | [settle and redeem](https://github.com/oynozan/phinary/blob/422fb4ff933c6f01d8caeeed076cbf60e6b1a208/src/PredictionHook.sol#L379-L453) | [Settlement rules](docs/content/concepts/settlement.mdx) |
| Vault deposits, withdrawals and PoolManager unlock callback | [vault and unlockCallback](https://github.com/oynozan/phinary/blob/422fb4ff933c6f01d8caeeed076cbf60e6b1a208/src/PredictionHook.sol#L470-L510) | [Vault accounting](docs/content/concepts/vault.mdx) |

For the wallet walkthrough, see [Trade in the Uniswap app](docs/content/guides/uniswap-app.mdx). That guide uses a local interface fork; it does not imply that the public Uniswap app routes these pools.

Markets run on four tracks, all on one hook and one LP vault. On each track a market expires in the second the next one opens.

| Track | Tokens | A new market | Trading stops | Settlement window |
|---|---|---|---|---|
| ETH, 1 minute | `ETHUP` / `ETHDOWN` | every minute | 12 s before expiry | 10 s |
| ETH, 15 minutes | `ETH15MUP` / `ETH15MDOWN` | every quarter hour | 32 s before expiry | 30 s |
| SOL, 1 minute | `SOLUP` / `SOLDOWN` | every minute | 12 s before expiry | 10 s |
| SOL, 15 minutes | `SOL15MUP` / `SOL15MDOWN` | every quarter hour | 32 s before expiry | 30 s |

## How it works

- **PredictionHook** is a Uniswap v4 hook that prices every YES/NO swap itself. It uses a Black-Scholes binary price in its settlement-matched average-price form, and Uniswap's liquidity curve is never used.
- **UnderlyingOracleHook** records the start-of-block price and volatility of one Uniswap v4 pool; there is one for ETH/USDC and one for SOL/USDC. Swaps earlier in the same block cannot move the price it reports. Both have renounced their ownership, so no key can change them.
- **MarketGatekeeper** is an ownerless contract that is the hook's `owner`. Its constructor deployed one **MarketScheduler** per track, and it forwards market creation from those four only, so the track set is fixed for good. Anyone can call a scheduler's `open()` once per time slot to open that track's next market, until the slot's deadline, when it reverts `TooLate`. There is no admin, no setter and no keeper role on the gatekeeper, the schedulers or the hook. See [gatekeeper implementation](https://github.com/oynozan/phinary/blob/422fb4ff933c6f01d8caeeed076cbf60e6b1a208/src/MarketGatekeeper.sol#L35-L66) and the [scheduler guide](docs/content/contracts/scheduler.mdx).
- **Settlement** uses the pool's average price over the final window of each market. Anyone can call `settle()`, and ties resolve DOWN.
- **The LP vault** underwrites every market. Complete-set accounting means every winning token is always backed by 1 USDC.

## Oracle: Uniswap, and nothing external

Phinary is not oracle-free. Settling "ETH > $X at expiry" needs a price, and whatever supplies it is an oracle. Phinary's oracle is a Uniswap pool: no third party observes prices off-chain and posts them, so there is no operator, feed admin or pause switch to trust. Pool liquidity and the cost of manipulating its price remain security assumptions; see the [security notes](docs/content/contracts/security.mdx).

- **Testnet (live):** our own Uniswap v4 ETH/USDC and SOL/USDC pools, each read by its own `UnderlyingOracleHook`. Unichain Sepolia has no real ETH or SOL market, so one mirror bot trades both pools to the Coinbase prices, standing in for the arbitrage that keeps real pools in line. The contracts never see Coinbase; they only read the pools.
- **Mainnet design:** `SealedPoolOracle` reads Unichain's deep ETH/USDC pool, which has no hook, through fee-growth seals and Merkle-Patricia proofs against Unichain's own block hashes. It is tested against the real pool on a mainnet fork and not deployed yet.
- **Bots** (keeper, and on mainnet the poke-and-prove bot) only send permissionless transactions. They cannot choose a price; if they stop, markets pause, and anyone can run them.

Say "no external oracle", not "oracle-free" or "no oracles".

## Live on Unichain Sepolia (chain 1301)

| Contract | Address |
|---|---|
| PredictionHook | `0xb4544Af6c126773c2f8f4f02f7a1Bde7b975aaa8` |
| MarketGatekeeper (the hook's only owner) | `0x755dBc10AB4b9BFDB8c46939702dC08B8F3e607A` |
| MarketScheduler, ETH 1 minute | `0x8f1b371e41FeCBb825d0baAB19f906E645C760e0` |
| MarketScheduler, ETH 15 minutes | `0x02f0B250120c817A45C6ba580FE68eB461E0A10e` |
| MarketScheduler, SOL 1 minute | `0x067180DE54F4a800C88C3dC9EDa8b106f7126b83` |
| MarketScheduler, SOL 15 minutes | `0x950eEDA8303253b76f0d47f4a3eD33aA7fF54E74` |
| UnderlyingOracleHook, ETH/USDC (ownership renounced) | `0x1F356D9E7d6dBE6d807aCBc5D163a7af265cd080` |
| UnderlyingOracleHook, SOL/USDC (ownership renounced) | `0xc7dDbB6648BE0DFCF3eF2a68D40d66374184D080` |
| dSOL (demo SOL for the SOL/USDC pool) | `0x49f3768635A2Db5e4bdcB76A4F191EC48B770417` |
| PriceSteerer (demo price mirror) | `0x21C55279188072E6BfeF14c4920eA1cEFEd358a3` |
| USDC (Circle, testnet) | `0x31d0220469e10c4E71834a79b1f276d740d3768F` |
| Legacy PredictionHooks (old markets, redeem only) | `0x62bBCbA51cbFC8D0C932e482bD8F62590fEeeAa8`, `0xE6780bBeAee4183Ffd8EBe0d2862dEd221B96aA8` |
| Legacy MarketScheduler | `0x511fFFb9fE5d393B10bF185A9c580A732Eff44Dd` |
| PoolManager | `0x00B036B58a818B1BC34d502D3fE730Db729e62AC` |
| V4Quoter | `0x56DCD40A3F2d466F48e7F48bDBE5Cc9B92Ae4472` |
| UniversalRouter | `0xf70536B3bcC1bD1a972dc186A2cf84cC6da6Be5D` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Every address is in [deployment manifest](deployments/unichain-sepolia.json). Tell the tracks apart with `schedulerOf(marketId)` on the gatekeeper, or by which scheduler emitted a market's `MarketOpened` event.

## Repository

| Path | What it holds |
|---|---|
| `src/` | Solidity: the hooks, the pricing math (`src/math`), outcome tokens, demo contracts |
| `test/` | Foundry tests: math, oracle, hook, integration, security and attack cases |
| `script/` | Deploy, track, price-source, fund and withdraw scripts, the local fork environment and the rehearsal |
| `bot/` | The price-mirror bot (a testnet stand-in for the arbitrage that would otherwise keep the demo pool near the real price), the keeper that opens every track's markets by calling its scheduler, and the sealed-oracle poke-and-prove bot |
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
