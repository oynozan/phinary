# Market tracks behind a MarketGatekeeper: design

**Date:** 2026-09-27. **Status:** approved in chat and live on Unichain Sepolia since 2026-09-26 17:40 UTC. It supersedes
the single-scheduler parts of [2026-09-26-permissionless-markets-design.md](2026-09-26-permissionless-markets-design.md).

## Goal

Run more than one kind of market on the one hook and vault: two assets (ETH and SOL) and two lengths (1 and 15 minutes),
with each track's markets back to back. No key may gain a power the single scheduler did not have: nobody can create a
market outside a schedule, change a market or choose an outcome.

## Why a new hook

`PredictionHook.owner` is immutable and only the owner (or a keeper the owner sets) can call `createMarket`. The old
hook's owner was the single scheduler, so a second scheduler could never create markets there. The hook's code does not
change; a new hook is deployed with a new owner and the vault moves over.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | `scheduler.hook()` stays the real `PredictionHook`, read only for `vaultIdle()`. A new immutable `scheduler.gatekeeper()` is its only path to `createMarket` | Everything that checks `scheduler.hook() == predictionHook` keeps working |
| D2 | `MarketGatekeeper(IPredictionHook hook, Track[] tracks)` with `Track {address oracle; Config config;}` deploys its own schedulers with `new`. 1 to 8 tracks, distinct tickers, one oracle per track | Two deployer transactions (gatekeeper, then hook), the same recovery cases as before. The i-th scheduler is provably the gatekeeper's child at `computeCreateAddress(gatekeeper, i + 1)` |
| D3 | `open()` reverts `TooLate(slot)` when `block.timestamp + window + cutoffBuffer >= expiry`, checked before `lastSlot` is written. The constructor rule becomes `tenor > window + cutoffBuffer`. No on-chain minimum trading time; the keeper skips a slot with less than `KEEPER_MIN_TRADE_SEC` (5 s) left | `tenor == period` must be allowed, and a late call must fail with the slot named instead of the hook's generic `InvalidParams`. A 1 s stub market is harmless, and a new `Config` field would change the ABI everywhere |
| D4 | The error is named `TooLate(uint256 slot)`. Its selector differs from `BinaryPricer.TooLate()` | The swap SDK maps the name `TooLate` to "Trading has closed", which is also right here |
| D5 | On-chain track index: `scheduler.marketOfSlot(slot)` and `gatekeeper.schedulerOf(marketId)`. No gatekeeper event | Readers that scan the newest N ids would lose the 15-minute markets among the 1-minute ones. `marketOfSlot` lists a track's recent markets directly, `schedulerOf` classifies any id. About 2 × 22k gas per open |
| D6 | Names and symbols come from the track's ticker through the unchanged `MarketNames`. Tickers: `ETH`, `ETH15M`, `SOL`, `SOL15M` (1-minute tracks keep the plain asset ticker) | `ETHUP` / `ETHDOWN` stay as before. The longest symbol, `SOL15MDOWN`, is 10 characters, under MetaMask's 11. The Uniswap app fork shows outcome symbols in full |
| D7 | Configs, frozen at deploy: 1-minute tracks period = tenor = 60 s, window 10 s, 10 samples; 15-minute tracks period = tenor = 900 s, window 30 s, 30 samples. All: cutoff buffer 2 s, h0 0.02, gammaS 0.00002, lambda 0.001, qEpochMax 100 tokens, pMin 0.02, budget `min(10 USDC, vaultIdle / 2)`, min 1 USDC | Same pricing on every track; a longer window on the longer markets |
| D8 | Exactly four tracks, in this order: ETH, ETH15M, SOL, SOL15M | The track set can never change without a new hook and a vault migration |
| D9 | Deployments JSON gains `marketGatekeeper`, `marketSchedulers` (gatekeeper order), `legacyMarketSchedulers` and `underlyings`; `legacyPredictionHooks` gets the old hook. `marketScheduler` is removed | Readers that were not updated fail loudly instead of quietly running one track. `underlyings` names each price source, `{symbol, token, oracle, pool, poolId}` |
| D10 | Markets of the old hooks are not listed anywhere; their winners stay redeemable by a direct `redeem` | Sweep and withdraw never touch what winners can claim |
| D11 | Migration order: drain the old hook, withdraw, deploy and record the tracks, fund the new vault, restart the keeper | The deployments file changes only once the new set is checked on chain, so nothing points at a half-deployed set |
| D12 | One keeper process drives every track. Each tick opens the due tracks first, shortest period first, then settles and sweeps | Two keepers would both settle and sweep the shared hook. With back-to-back markets, settling first would delay every open |

**SOL price source.** SOL needs its own oracle, so a second `UnderlyingOracleHook` sits on a dSOL/dUSDC pool, built the
way the ETH one was (`script/DeployUnderlying.s.sol`) and seeded through the same PriceSteerer. The steerer is owned by
the mirror key, so the seed is signed by the mirror key. The one mirror bot steers every pool in `underlyings`. The SOL
oracle's ownership is renounced like the ETH one's. There is still no external oracle: each market's strike and result
come from the Uniswap pool of its asset.

## Timeline of a slot

The 1-minute slot that starts at 14:34:00 expires at 14:35:00. Trading stops at 14:34:48, so `open()` succeeds from
14:34:00 to 14:34:47 and reverts `TooLate` from 14:34:48. The next slot opens at 14:35:00. The 15-minute slot that
starts at 14:30:00 expires at 14:45:00; with its 30 s window `TooLate` starts at 14:44:28. At 14:45:00 all four tracks
open a market, and their names differ by ticker (`ETH > … 14:46`, `ETH15M > … 15:00`).

## Vault sizing

All tracks share one vault and take `min(10, idle / 2)` in call order. At a quarter hour the keeper opens before it
sweeps, so the four expiring markets still hold 40 USDC. The four new markets all get 10 USDC while the vault holds about
90 USDC. The runbook asks for 150 USDC or more, which leaves room for a run of losing markets. The vault started with
174.99 USDC.

## Live result

| Item | Value |
|---|---|
| MarketGatekeeper | `0x755dBc10AB4b9BFDB8c46939702dC08B8F3e607A` |
| PredictionHook | `0xb4544Af6c126773c2f8f4f02f7a1Bde7b975aaa8`, keeper unset, `deployBlock` 63,591,962 |
| Schedulers | ETH `0x8f1b…60e0`, ETH15M `0x02f0…A10e`, SOL `0x0671…6b83`, SOL15M `0x950e…4E74` |
| SOL source | dSOL `0x49f3…0417`, oracle `0xc7dD…d080` (ownership renounced) |
| Legacy | hooks `0x62bB…eaa8` and `0xE678…6aA8`, scheduler `0x511f…44Dd` |

The migration ran on 2026-09-26 from 17:36 to 17:41 UTC: keeper stopped, the old hook's last two markets settled and
swept with the keeper key, 94.416599 USDC withdrawn, the tracks deployed and recorded, 174.99 USDC deposited, the keeper
restarted, and the Uniswap app fork re-vendored. The exact commands are in `docs/md/RUNBOOK.md` section 3.3.

## Risks

- **Frozen for good.** The track list and every config are fixed; a change means another hook and another migration.
- **The old scheduler cannot be disabled.** It opens again for anyone who deposits into the old hook. Nothing lists
  or indexes it.
- **Deployer nonce.** The two track transactions need consecutive deployer nonces; the script asserts it.
- **Short trading.** A 1-minute market trades for at most 48 s, less the time to open it.
- **Demo-only windows.** 10 s and 30 s settlement windows are for the demo only; real money needs windows of 30 minutes
  or more.
