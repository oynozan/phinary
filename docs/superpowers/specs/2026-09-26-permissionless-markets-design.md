# Permissionless markets: design

**Date:** 2026-09-26. **Status:** approved in chat; awaiting review of this written spec.

## Goal

After this change, no key can create markets, change pricing or touch the oracle. Anyone can open, settle, sweep and redeem.
Settlement, redeem, sweep, deposit and withdraw are already permissionless. Two privileged powers remain today:

1. `PredictionHook.createMarket` accepts only `owner` or `keeper` (`src/PredictionHook.sol:137-138`). Both are our keys.
2. `UnderlyingOracleHook.setVarianceBounds` is `onlyOwner` (`src/oracle/UnderlyingOracleHook.sol:160`).

## Decisions

- **A new `MarketScheduler` contract owns a freshly deployed `PredictionHook`.**
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
- The function emits `MarketOpened(marketId, slot, caller)`.
- Views: `lastSlot`, `nextOpenTime()`, and `canOpen()` (whether `open()` would succeed now).

## Deployment

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

## Out of scope

- An "open market" button in the dashboard.
- Indexing the legacy hook.
- A mainnet deployment.
- On-chain parameter bounds inside the hook. The scheduler is the only creator, and its immutable settings are the bounds.

## Risks

- **Two-minute markets remain outside the research's backtests.** The 2¢ spread lowers LP risk but does not remove it.
- **Names are in UTC**, as the keeper's default was. Screens that show local time format it from `expiry`.
- **The deployer nonce could shift between simulation and broadcast.** The post-deploy assertions catch it; the only cost is
  wasted gas.
