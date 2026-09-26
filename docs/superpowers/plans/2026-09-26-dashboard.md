# Prediction Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Polymarket-style web dashboard for the PredictionHook markets. People list markets, buy and sell UP/DOWN with USDC, and claim winnings. It adds a Ponder indexer for history and a faucet drip for test funds.

**Architecture:** `web/` is a Next.js App Router app. It reads everything needed to trade straight from the chain (wagmi/viem plus the existing `packages/swap-sdk`), and reads history from a Ponder indexer in `indexer/`. When the indexer is down, only the history panels degrade. The contracts do not change.

**Tech Stack:** Next.js 16.3.6, React 19.3.0, wagmi 2.19.5, @rainbow-me/rainbowkit 2.2.11, @tanstack/react-query 5.103.3, viem 2.49.0, Tailwind 4.3.3, Ponder 0.17.12 (+ @ponder/client and @ponder/react 0.17.12, hono 4.13.9), postgres 3.4.9, vitest 5.0.2, @playwright/test 1.63.0.

**Spec:** [docs/DASHBOARD.md](../../DASHBOARD.md). Another agent owns the token-naming scheme and edits to `DASHBOARD.md`. If the spec changes while you work, the spec wins. Re-read §2 and §12 before Tasks 11 and 16.

## Global Constraints

- Chain: Unichain Sepolia (1301) only. All addresses come from `deployments/unichain-sepolia.json`, or from `deployments/local.json` for the local stack. Nothing is hardcoded in components.
- Contracts are unchanged. UP is the hook's YES token and DOWN is its NO token. The UI always says "UP"/"DOWN". Token names and symbols are **read from the chain** and never assumed. The bot's naming change is out of scope; another agent owns it.
- The live path never depends on the indexer. Prices, market status, balances, quotes, swaps, claims, settle and drip all use RPC.
- Refresh rates: live quotes every 1 s; indexer polling fallback every 2 s; price snapshots every 2 blocks; vault snapshots every 30 blocks.
- Drip: 10 USDC and 0.001 ETH per drip; limits of 1 per address and 3 per IP per 12 h; kill switch `DRIP_ENABLED=false`.
- "Open in Uniswap" exists only when `NEXT_PUBLIC_UNISWAP_FORK_URL` is set. That variable is never set on Vercel, and production must never link to `localhost`. There is no "honest line" or disclaimer copy about Uniswap allowlisting anywhere in the UI.
- Branding is our own. No Polymarket name, logo or colours.
- Visual direction comes from the Impeccable skill (Task 6). Charts follow the `dataviz` skill.
- The server-side drip key (`DRIP_PRIVATE_KEY`) is never exposed through `NEXT_PUBLIC_*`.
- Node ≥ 22.18. Web and indexer tests use vitest. E2E uses Playwright with system Chrome (`channel: 'chrome'`).
- Commits are authored by the repo owner. **Never add `Co-Authored-By` or any Claude attribution line.** Work on branch `dashboard`.
- Demo market timing is not fixed. Markets currently last 120 s, and a new one opens every 60 s, so they overlap. Code must read timing from each market and handle several live markets at once.

## Review Focus

1. **A market closes mid-trade.** The quote is taken during trading, but the signature lands after the cutoff. The user should see "Trading has closed for this market", and the trade box should move to the hero market, not show a raw revert. Tested in Task 9 (`friendlyError`) and Task 11 (`tradeInputState` with phase `closed`).
2. **No wallet, or the wrong chain, when tapping Buy.** The app should prompt to connect or switch, and no transaction or signature should be requested. Tested in Task 9 (`tradeInputState`).
3. **The indexer is unreachable or far behind.** Live prices and trading should keep working. The market list should fall back to RPC, and history panels should say "History unavailable". Tested in Task 8 (`mergeMarketSources`, `indexerStatus`) and Task 14 (e2e with the indexer stopped).
4. **Awkward amounts:** empty, `0`, `.`, more than 6 decimals, or more than the balance. The button should be disabled with a reason, and no quote should be requested. Tested in Task 9 (`tradeInputState`, `parseAmount`).
5. **Double-clicking "Get test funds", or two tabs at once.** Only one drip should be sent. Tested in Task 13 (concurrent `tryReserve`).

---

## File Structure

```
web/
  package.json  next.config.ts  tsconfig.json  postcss.config.mjs  vitest.config.ts  playwright.config.ts  .env.example  README.md
  app/layout.tsx  app/providers.tsx  app/globals.css
  app/page.tsx                          markets home
  app/market/[id]/page.tsx              market page
  app/portfolio/page.tsx
  app/activity/page.tsx                 (phase 4)
  app/vault/page.tsx                    (phase 4)
  app/api/drip/route.ts  app/api/drip/status/route.ts
  app/api/token-logo/[address]/route.ts (phase 2)
  components/ui/*                       base kit from Task 6
  components/shell/{Header,NetworkBanner,IndexerStatus,FundsChip}.tsx
  components/market/{Hero,MarketCard,MarketTabs,PhaseChip,Countdown,Timeline,ProbabilityChart,TradeBox,StepList,PositionBox,RulesPanel,MarketTrades}.tsx
  components/portfolio/{Summary,PositionsTable,ClaimBanner,History}.tsx
  components/token/{TokenDrawer,TradeReceipt}.tsx                (phase 2)
  components/price/{WhyThisPrice,EthChart,ResolutionProof}.tsx   (phase 3)
  components/activity/{Feed,Leaderboard}.tsx  components/vault/*  (phase 4)
  lib/config.ts  lib/chain.ts  lib/wallet.ts  lib/format.ts  lib/phases.ts  lib/markets.ts
  lib/trade.ts  lib/errors.ts  lib/tradeBox.ts  lib/indexer.ts  lib/portfolio.ts
  lib/drip/{limits,store,send}.ts  lib/tokenLogo.ts  lib/forkLink.ts
  lib/pricing.ts  lib/settlement.ts  lib/vault.ts  lib/leaderboard.ts
  hooks/{useLiveMarkets,useIndexer,useBalances,useTrade}.ts
  test/*.test.ts(x)  e2e/{mockWallet.ts,globalSetup.ts,core.spec.ts}  scripts/check-no-fork-link.mjs
indexer/
  package.json  ponder.config.ts  ponder.schema.ts  tsconfig.json  vitest.config.ts  .env.example  README.md
  src/deployment.ts  src/markets.ts  src/trades.ts  src/transfers.ts  src/snapshots.ts  src/vault.ts
  src/api/index.ts
  src/lib/accounting.ts  src/lib/attribution.ts
  test/accounting.test.ts  test/attribution.test.ts  test/deployment.test.ts  test/integration.test.ts
Makefile      new target: dashboard-local
```

**Local stack used by the integration and e2e tests:** `cd app && node scripts/local-stack.ts --anvil --bots`. It runs an Anvil fork of 1301 at `http://127.0.0.1:8746`, with the contracts, the bots and a funded vault, and writes `deployments/local.json`.

---

## Phase 0: Setup

### Task 1: `web/` scaffold, config, providers, network guard

**Files:**
- Create: `web/package.json`, `web/next.config.ts`, `web/tsconfig.json`, `web/postcss.config.mjs`, `web/vitest.config.ts`, `web/.env.example`, `web/app/layout.tsx`, `web/app/providers.tsx`, `web/app/globals.css`, `web/app/page.tsx` (placeholder), `web/lib/config.ts`, `web/lib/chain.ts`, `web/lib/wallet.ts`, `web/components/shell/Header.tsx`, `web/components/shell/NetworkBanner.tsx`
- Test: `web/test/config.test.ts`, `web/test/wallet.test.ts`

**Interfaces:**
- Produces:
  - `interface WebConfig { network: 'unichain-sepolia' | 'local'; chainId: number; rpcUrl: string; explorer: string; contracts: ChainContracts; hook: Address; underlyingOracle: Address; underlyingPoolId: Hex; deployBlock: bigint; indexerUrl?: string; forkUrl?: string; wcProjectId?: string }` (`ChainContracts` comes from swap-sdk)
  - `loadWebConfig(deployment: unknown, env: Record<string, string | undefined>): WebConfig`
  - `webConfig: WebConfig` (the module singleton)
  - `appChain: Chain`
  - `wagmiConfig`
  - `type NetworkState = 'disconnected' | 'wrong-chain' | 'ok'`
  - `networkState(p: { connected: boolean; chainId?: number }, cfg: Pick<WebConfig, 'chainId'>): NetworkState`
  - `interface Connection { kind: 'injected'; name: string; address: Address; chainId: number; wallet: WalletClient }` (the same shape `app/src/trade.ts` expects)

- [ ] **Step 1: Write the failing tests**

```ts
// web/test/config.test.ts
import sepolia from '../../deployments/unichain-sepolia.json'
test('loads sepolia deployment', () => {
  const c = loadWebConfig(sepolia, { NEXT_PUBLIC_NETWORK: 'unichain-sepolia' })
  expect(c.chainId).toBe(1301)
  expect(c.hook).toBe('0x62bBCbA51cbFC8D0C932e482bD8F62590fEeeAa8')
  expect(c.contracts.universalRouter.toLowerCase()).toBe('0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d')
  expect(c.forkUrl).toBeUndefined()
})
test('fork url only from env', () => {
  expect(loadWebConfig(sepolia, { NEXT_PUBLIC_UNISWAP_FORK_URL: 'http://localhost:3000' }).forkUrl).toBe('http://localhost:3000')
})
test('rpc override', () => {
  expect(loadWebConfig(sepolia, { NEXT_PUBLIC_RPC_URL: 'https://x.example' }).rpcUrl).toBe('https://x.example')
})
test('throws without hook', () => {
  expect(() => loadWebConfig({ chainId: 1301 }, {})).toThrow(/hook/i)
})
// web/test/wallet.test.ts
test.each([
  [{ connected: false }, 'disconnected'],
  [{ connected: true, chainId: 1 }, 'wrong-chain'],
  [{ connected: true, chainId: 1301 }, 'ok'],
])('networkState %o', (p, want) => expect(networkState(p, { chainId: 1301 })).toBe(want))
```

- [ ] **Step 2: Scaffold and install.** Pin the versions from the Tech Stack line. Add the dependency `"@prediction/swap-sdk": "file:../packages/swap-sdk"`. In `next.config.ts`, set `transpilePackages: ['@prediction/swap-sdk']` and `turbopack.root` to the repo root, so `../deployments/*.json` and `../packages` resolve.
- [ ] **Step 3: Run the tests; expect FAIL.** `cd web && npx vitest run test/config.test.ts test/wallet.test.ts` should fail with "loadWebConfig is not defined".
- [ ] **Step 4: Implement `loadWebConfig`, `networkState`, `appChain`, `wagmiConfig` and the providers.**
  - `loadWebConfig` uses swap-sdk `parseDeployment`. The network comes from `NEXT_PUBLIC_NETWORK` (default `unichain-sepolia`), and `NEXT_PUBLIC_RPC_URL` overrides the RPC.
  - `providers.tsx` nests `WagmiProvider` → `QueryClientProvider` → `RainbowKitProvider`.
  - `NetworkBanner` renders "Switch to Unichain Sepolia" when the state is `wrong-chain`, using wagmi `useSwitchChain` (which adds the chain if needed).
  - `Header` has the nav items Markets and Portfolio, plus the RainbowKit `ConnectButton`. Activity and Vault are added in Tasks 19 and 20.
- [ ] **Step 5: Run the tests and build; expect PASS.** Run `npx vitest run` and `npx next build`. The build must succeed with a swap-sdk import in use (import `predictionHookAbi` in `lib/markets.ts` as a stub).
- [ ] **Step 6: Commit.** `git add web && git commit -m "web: Next.js scaffold, deployment config, wagmi and RainbowKit providers, network guard"`

### Task 2: `indexer/` scaffold: config, schema, API

**Files:**
- Create: `indexer/package.json`, `indexer/ponder.config.ts`, `indexer/ponder.schema.ts`, `indexer/tsconfig.json`, `indexer/vitest.config.ts`, `indexer/.env.example`, `indexer/src/deployment.ts`, `indexer/src/api/index.ts`
- Test: `indexer/test/deployment.test.ts`

**Interfaces:**
- Produces:
  - `loadIndexerDeployment(env: Record<string, string | undefined>): { chainId: number; rpcUrl: string; hook: Address; oracle: Address; poolManager: Address; deployBlock: number; snapshotStartBlock: number }`
    - `PONDER_NETWORK` is `unichain-sepolia` (default) or `local`.
    - `PONDER_RPC_URL_1301` overrides the RPC.
    - `SNAPSHOT_START_BLOCK` defaults to `deployBlock`.
  - Ponder sources:
    - `PredictionHook`: the hook ABI, `startBlock: deployBlock`, `includeTransactionReceipts: true`.
    - `OutcomeToken`: `factory({ address: hook, event: MarketCreated, parameter: 'yes' })` and the same for `'no'`, as two sources `UpToken` and `DownToken` sharing the ERC-20 `Transfer` ABI.
    - `PriceSnapshot`: blocks, interval 2, from `snapshotStartBlock`.
    - `VaultSnapshot`: blocks, interval 30.
  - Tables in `ponder.schema.ts` (`onchainTable`); all amounts are `bigint` in token units:
    - `market { id: bigint pk; up: hex; down: hex; upPoolId: hex; downPoolId: hex; lnStrikeWad: bigint; openTime: int; expiry: int; window: int; cutoffBuffer: int; status: text ('trading'|'settled'|'invalid'); upWon: bool?; avgNormTickTimesWindow: bigint?; settleTx: hex?; volumeUsdc: bigint; tradeCount: int; createdAt: int }`
    - `trade { id: text pk (txHash-logIndex); marketId: bigint; account: hex; side: text ('UP'|'DOWN'); isBuy: bool; qty: bigint; usdc: bigint; avgPriceWad: bigint; timestamp: int; txHash: hex; attributedBy: text ('transfer'|'txFrom') }`
    - `position { id: text pk (account-marketId-side-origin); account: hex; marketId: bigint; side: text; origin: text ('trade'|'received'); qty: bigint; cost: bigint; realized: bigint }`
    - `transfer { id: text pk; token: hex; marketId: bigint; side: text; from: hex; to: hex; amount: bigint; kind: text ('redeem'|'peer'); timestamp: int; txHash: hex }`
    - `priceSnapshot { id: text pk (marketId-block); marketId: bigint; blockNumber: bigint; timestamp: int; midUp: bigint; askUp: bigint; bidUp: bigint; ethLnWad: bigint; varE36: bigint; tau: bigint }`
    - `vaultSnapshot { blockNumber: bigint pk; timestamp: int; navPlus: bigint; navMinus: bigint; totalShares: bigint; idle: bigint }`
    - `vaultEvent { id: text pk; account: hex; kind: text ('deposit'|'withdraw'); assets: bigint; shares: bigint; timestamp: int; txHash: hex }`
    - `accountStats { account: hex pk; volumeUsdc: bigint; realizedTrade: bigint; marketsTraded: int }`
  - API: `app.use('/sql/*', client({ db, schema }))`, with GraphQL at `/graphql`. Ponder's `/ready` and `/status` are built in.

- [ ] **Step 1: Write the failing test.** In `deployment.test.ts`:
  - with `{}`, `chainId` is 1301, `deployBlock` is 63521900 and `snapshotStartBlock` equals `deployBlock`;
  - with `{ SNAPSHOT_START_BLOCK: '63600000' }`, `snapshotStartBlock` is 63600000;
  - with `{ PONDER_NETWORK: 'local' }`, it reads `deployments/local.json`.
- [ ] **Step 2: Run it; expect FAIL.** `cd indexer && npx vitest run test/deployment.test.ts`
- [ ] **Step 3: Implement** `src/deployment.ts`, the config, the schema and the API. ABIs come from `../packages/swap-sdk/src/abi/index.ts` (they are `as const`).
- [ ] **Step 4: Verify.** `npx vitest run` should PASS. `npx ponder codegen && npx tsc --noEmit` should exit 0.
- [ ] **Step 5: Commit.** `git add indexer && git commit -m "indexer: Ponder config, schema and SQL API for hook events, outcome tokens and snapshots"`

### Task 3: Pure accounting and trade attribution

**Files:**
- Create: `indexer/src/lib/accounting.ts`, `indexer/src/lib/attribution.ts`
- Test: `indexer/test/accounting.test.ts`, `indexer/test/attribution.test.ts`

**Interfaces:**
- Produces (all amounts are 6-decimal `bigint`):
  - `interface Bucket { qty: bigint; cost: bigint; realized: bigint }`
  - `EMPTY: Bucket`
  - `buy(b, qty, usdc): Bucket`
  - `sell(b, qty, usdcOut): Bucket`. It removes cost `cost*qty/b.qty` (floor) and adds `usdcOut − costOut` to `realized`.
  - `transferOut(b, qty): Bucket`. It removes the same cost share and realizes nothing.
  - `transferIn(b, qty): Bucket`. It adds `qty` at zero cost.
  - `splitDebit(trade: Bucket, received: Bucket, qty): { fromTrade: bigint; fromReceived: bigint }`. It debits the trade bucket first.
  - `payoutFor(status: 'settled'|'invalid', isWinner: boolean, qty: bigint): bigint`. It returns `qty` for a settled winner and `qty/2` for invalid.
  - `type TransferKind = 'trade-leg' | 'redeem' | 'peer' | 'ignore'`
  - `classifyTransfer(p: { from: Address; to: Address; poolManager: Address }): TransferKind`. Rules, in order:
    1. `from == 0x0` → `ignore` (a mint to the PoolManager);
    2. `to == 0x0` → `redeem`;
    3. `from` or `to` is the PoolManager → `trade-leg`;
    4. anything else → `peer`.
  - `attributeTrade(p: { logs: readonly Log[]; token: Address; poolManager: Address; isBuy: boolean; qty: bigint; txFrom: Address }): { account: Address; by: 'transfer' | 'txFrom' }`. It finds the ERC-20 `Transfer` of `token` with `from == PoolManager` (on a buy) or `to == PoolManager` (on a sell) and `value == qty`, and takes the other party. If there is none, it falls back to `txFrom`.

- [ ] **Step 1: Write the failing tests.** The spec's worked example goes in exactly:

```ts
const U = 1_000_000n
test('spec §6 worked example', () => {
  let b = buy(EMPTY, 10n * U, 6_200_000n)
  expect(b).toEqual({ qty: 10n * U, cost: 6_200_000n, realized: 0n })
  b = buy(b, 10n * U, 7_000_000n)
  expect(b).toEqual({ qty: 20n * U, cost: 13_200_000n, realized: 0n })
  b = sell(b, 5n * U, 3_500_000n)
  expect(b).toEqual({ qty: 15n * U, cost: 9_900_000n, realized: 200_000n })
  b = transferOut(b, 5n * U)
  expect(b).toEqual({ qty: 10n * U, cost: 6_600_000n, realized: 200_000n })
  b = sell(b, 10n * U, payoutFor('settled', true, 10n * U))
  expect(b).toEqual({ qty: 0n, cost: 0n, realized: 3_600_000n })
  expect(transferIn(EMPTY, 5n * U)).toEqual({ qty: 5n * U, cost: 0n, realized: 0n })
})
test('splitDebit takes trade bucket first', () => {
  expect(splitDebit({ ...EMPTY, qty: 3n }, { ...EMPTY, qty: 5n }, 4n)).toEqual({ fromTrade: 3n, fromReceived: 1n })
})
test('invalid pays half', () => expect(payoutFor('invalid', false, 7n)).toBe(3n))
// attribution.test.ts
const PM = '0x00B036B58a818B1BC34d502D3fE730Db729e62AC', Z = '0x0000000000000000000000000000000000000000'
test.each([
  [{ from: Z, to: PM }, 'ignore'], [{ from: ALICE, to: Z }, 'redeem'],
  [{ from: PM, to: ALICE }, 'trade-leg'], [{ from: ALICE, to: PM }, 'trade-leg'], [{ from: ALICE, to: BOB }, 'peer'],
])('classify %o', (t, k) => expect(classifyTransfer({ ...t, poolManager: PM })).toBe(k))
test('buy attributed to PoolManager recipient', () => {
  const logs = [transferLog(UP, Z, PM, 7n), transferLog(UP, PM, ALICE, 7n)]
  expect(attributeTrade({ logs, token: UP, poolManager: PM, isBuy: true, qty: 7n, txFrom: RELAYER })).toEqual({ account: ALICE, by: 'transfer' })
})
test('falls back to tx.from', () => {
  expect(attributeTrade({ logs: [], token: UP, poolManager: PM, isBuy: false, qty: 7n, txFrom: RELAYER })).toEqual({ account: RELAYER, by: 'txFrom' })
})
```

  `transferLog(token, from, to, value)` is a test helper that builds a viem `Log` with the ERC-20 Transfer topic.

- [ ] **Step 2: Run them; expect FAIL.** `cd indexer && npx vitest run test/accounting.test.ts test/attribution.test.ts`
- [ ] **Step 3: Implement both modules.** Decode transfers with `parseEventLogs({ abi: erc20Abi, eventName: 'Transfer' })`.
- [ ] **Step 4: Run them; expect PASS.**
- [ ] **Step 5: Commit.** `git add indexer/src/lib indexer/test && git commit -m "indexer: average-cost accounting and trade attribution from token transfers"`

### Task 4: Ponder handlers and integration test

**Files:**
- Create: `indexer/src/markets.ts`, `indexer/src/trades.ts`, `indexer/src/transfers.ts`, `indexer/src/snapshots.ts`, `indexer/src/vault.ts`
- Test: `indexer/test/integration.test.ts`

**Interfaces:**
- Consumes: Task 2's tables and sources; Task 3's `accounting.ts` and `attribution.ts`.
- Produces the indexed tables that Tasks 8, 12, 19 and 20 read.

Handler rules:
- **`PredictionHook:MarketCreated`:** read `marketInfo(id)` at the event block for `openTime`, `window` and `cutoffBuffer`, then insert the `market` row.
- **`PredictionHook:Trade`:**
  - Attribute the trade with `attributeTrade(event.transactionReceipt.logs, …, event.transaction.from)` and insert the `trade` row.
  - Update the account's `trade` bucket: `buy` on a buy. On a sell, use `splitDebit`, then `sell` on the trade part and `sell` on the received part. A claim by swap is a sell at the price set by `payoutFor`.
  - Add `usdc` to `market.volumeUsdc`.
  - In `accountStats`: add to `volumeUsdc`, add the trade bucket's realized change to `realizedTrade`, and increment `marketsTraded` on the account's first trade in that market.
- **`UpToken:Transfer` / `DownToken:Transfer`:**
  - `ignore` and `trade-leg` do nothing, because Trade already handled the leg.
  - `redeem`: `splitDebit`, then `sell` with `payoutFor(market.status, side won, amount)`, and insert a `transfer` row.
  - `peer`: the sender gets `transferOut` via `splitDebit`, the receiver's `received` bucket gets `transferIn`, and a `transfer` row is inserted.
- **`PredictionHook:MarketSettled`:** set `status`, `upWon`, `avgNormTickTimesWindow` and `settleTx`. The `invalid` flag maps to status `invalid`.
- **`PriceSnapshot:block`:** select markets with `openTime ≤ ts < expiry` (a Drizzle select via `context.db.sql`). For each, read `quote(id)`; read `oracle.lnSpotSoBWad()` once. Insert the rows.
- **`VaultSnapshot:block`:** read `navPlus`, `navMinus`, `totalShares` and `vaultIdle`.
- **`Deposit` / `Withdraw`:** insert `vaultEvent` rows.

- [ ] **Step 1: Write the failing integration test.** It needs the local stack and `PONDER_NETWORK=local npx ponder dev` running, and is skipped unless `INDEXER_URL` is set. Using swap-sdk `buildSwap` with Anvil accounts #3 (ALICE) and #4 (BOB) on the live market, it does the following:
  1. ALICE buys UP for 5 USDC and DOWN for 2 USDC.
  2. ALICE sells half her UP.
  3. ALICE transfers 1 UP to BOB.
  4. After settlement, ALICE claims the winning side by swap.
  5. Poll `/sql` with `@ponder/client` for up to 30 s.

  Assertions:
  - for each (account, token), the sum of `position.qty` over both origins equals `balanceOf` on-chain;
  - BOB's `received` bucket has `cost == 0`;
  - every `trade` row for ALICE has `attributedBy == 'transfer'`;
  - the market row's `status != 'trading'`;
  - at least one `priceSnapshot` exists for the market, with `0 < midUp < 1e18`.
- [ ] **Step 2: Run it; expect FAIL** (no handlers). `cd indexer && INDEXER_URL=http://localhost:42069 RPC_URL=http://127.0.0.1:8746 npx vitest run test/integration.test.ts`
- [ ] **Step 3: Implement the handlers** as specified above.
- [ ] **Step 4: Run it; expect PASS.** Also run `npx vitest run test/accounting.test.ts test/attribution.test.ts` again.
- [ ] **Step 5: Commit.** `git add indexer && git commit -m "indexer: handlers for markets, trades, transfers, settlement, vault and price snapshots"`

### Task 5: One-command local run and hosting config

**Files:**
- Modify: `Makefile` (add the `dashboard-local` target only)
- Create: `web/README.md`, `indexer/README.md`

- [ ] **Step 1: Add the `dashboard-local` target.** It starts `indexer` (`PONDER_NETWORK=${NETWORK}`, embedded PGlite) and `web` (`next dev`, with `NEXT_PUBLIC_INDEXER_URL=http://localhost:42069`) together, and stops both on Ctrl-C. It is listed in `make help`.
- [ ] **Step 2: Write the two READMEs.**
  - **Vercel:** project root `web/`. Env: `NEXT_PUBLIC_NETWORK`, `NEXT_PUBLIC_INDEXER_URL`, `NEXT_PUBLIC_WC_PROJECT_ID` (optional), `DRIP_PRIVATE_KEY`, `DRIP_USDC=10`, `DRIP_ETH=0.001`, `DRIP_ENABLED`, `DATABASE_URL`. `NEXT_PUBLIC_UNISWAP_FORK_URL` must **never** be set.
  - **Railway:** Ponder with `DATABASE_URL` (Postgres), a keyed `PONDER_RPC_URL_1301`, and `SNAPSHOT_START_BLOCK`. Start with `ponder start`.
- [ ] **Step 3: Verify.** `make dashboard-local NETWORK=unichain-sepolia` serves `http://localhost:3000`, and `http://localhost:42069/ready` returns 200 once the indexer has synced.
- [ ] **Step 4: Commit.** `git add Makefile web/README.md indexer/README.md && git commit -m "dashboard: one-command local run and hosting notes"`

**Phase 0 gate:** deploy both services. The hosted page renders, and `/ready` on the hosted indexer is 200.

---

## Phase 1: Core

### Task 6: Visual direction and base UI kit

**Files:**
- Modify: `web/app/globals.css`
- Create: `web/components/ui/{Button,Card,Chip,Tabs,Stat,Skeleton}.tsx`, `web/DESIGN.md`

- [ ] **Step 1: Set the direction with the Impeccable skill** (`impeccable:impeccable`). The brief: a live prediction-market dashboard; UP and DOWN as the primary actions; numbers and countdowns are the hero content; light and dark themes; our own brand, not Polymarket's; judges watch it on a projector. Record the result in `web/DESIGN.md`.
- [ ] **Step 2: Encode the tokens in `globals.css`.** Tailwind 4 `@theme` holds the colours (including the UP and DOWN colours), type scale, radii and spacing. Dark-mode values go under `prefers-color-scheme`, plus a `[data-theme]` override.
- [ ] **Step 3: Build the base components** from the tokens.
- [ ] **Step 4: Verify.** `npx next build` succeeds, and a scratch page shows every component correctly in both themes (check with a screenshot).
- [ ] **Step 5: Commit.** `git add web && git commit -m "web: visual direction, design tokens and base components"`

### Task 7: Market logic: phases, tabs, hero, copy, formatting

**Files:**
- Create: `web/lib/phases.ts`, `web/lib/markets.ts`, `web/lib/format.ts` (port `app/src/format.ts`)
- Test: `web/test/phases.test.ts`, `web/test/markets.test.ts`, `web/test/format.test.ts` (port `app/test/format.test.ts`)

**Interfaces:**
- Consumes: swap-sdk `Market` and `MarketInfo`.
- Produces:
  - `type UiPhase = 'upcoming' | 'live' | 'closed' | 'averaging' | 'awaiting' | 'resolved' | 'invalid'`
  - `uiPhase(info: Timing, now: number): UiPhase`
  - `phaseLabel(m: Market, now: number): string`
  - `type Tab = 'live' | 'upcoming' | 'resolved'`
  - `tabOf(p: UiPhase): Tab`. Live covers `live`, `closed`, `averaging` and `awaiting`; resolved covers `resolved` and `invalid`.
  - `groupTabs(markets: Market[], now: number): Record<Tab, Market[]>`. Resolved is sorted by expiry, newest first, capped at 20.
  - `heroMarket(markets: Market[], now: number): Market | undefined`. It picks the `live` market with the latest cutoff; ties go to the highest id.
  - `questionText(m: Market, tz?: string): string`
  - `rulesText(m: Market, cfg: Pick<WebConfig, 'underlyingPoolId'>, tz?: string): string`
  - `strikeUsd(m: Market): number`

- [ ] **Step 1: Write the failing tests.** Use a fixture market with open 1000, expiry 1120, window 10, cutoffBuffer 2 (so the cutoff is 1108 and the window starts at 1110), status Trading, a strike of $2,684.00, and `tz: 'UTC'`.

```ts
test.each([[999, 'upcoming'], [1000, 'live'], [1107, 'live'], [1108, 'closed'], [1110, 'averaging'], [1120, 'awaiting']])('uiPhase(%i)', (now, p) => expect(uiPhase(info, now)).toBe(p))
test('settled labels', () => {
  expect(phaseLabel(settled(true), 2000)).toBe('Resolved UP')
  expect(phaseLabel(settled(false), 2000)).toBe('Resolved DOWN')
  expect(phaseLabel(invalid(), 2000)).toBe('Invalid, 50/50')
  expect(phaseLabel(m, 988)).toBe('Opens in 0:12')
})
test('hero picks latest cutoff among live', () => expect(heroMarket([live(1, 1108), live(2, 1168), closed(3)], 1100)?.id).toBe(2n))
test('question', () => expect(questionText(m, 'UTC')).toBe('ETH above $2,684.00 at 00:18:40?'))
const cfg = { underlyingPoolId: '0xb2b89f12e31fa12e75c4e85bd234fa5fdc5ee19d65e11a12c4f57dfe0e437331' }
test('rules copy', () => expect(rulesText(m, cfg, 'UTC')).toBe(
  'Resolves UP if the average ETH price from 00:18:30 to 00:18:40 is above $2,684.00. Exactly equal resolves DOWN. ' +
  'The price source is the Uniswap v4 ETH/USDC pool (0xb2b8…7331). Anyone can settle after 00:18:40. There is no admin override.'))
test('resolved tab capped at 20, newest first', () => {
  const g = groupTabs(Array.from({ length: 25 }, (_, i) => settledAt(1000 + i)), 5000)
  expect(g.resolved).toHaveLength(20); expect(g.resolved[0].info.expiry).toBe(1024n)
})
```

The fixture helpers `live(id, cutoff)`, `closed(id)`, `settled(upWon)`, `settledAt(expiry)` and `invalid()` live in `web/test/fixtures.ts`.

- [ ] **Step 2: Run them; expect FAIL.** `cd web && npx vitest run test/phases.test.ts test/markets.test.ts test/format.test.ts`
- [ ] **Step 3: Implement.** Port `marketPhase`, `cutoffOf` and `windowStartOf` from `app/src/market.ts`, then split `closing` into `closed` and `averaging` at the window start.
- [ ] **Step 4: Run them; expect PASS.**
- [ ] **Step 5: Commit.** `git add web/lib web/test && git commit -m "web: market phases, tabs, hero selection, question and rules copy"`

### Task 8: Data hooks: live path, indexer client, fallback, status

**Files:**
- Create: `web/lib/indexer.ts`, `web/hooks/useLiveMarkets.ts`, `web/hooks/useIndexer.ts`, `web/hooks/useBalances.ts`, `web/components/shell/IndexerStatus.tsx`
- Test: `web/test/indexer.test.ts`

**Interfaces:**
- Consumes: `webConfig`; swap-sdk `listMarkets`; Task 2's tables, via a local copy of the schema import path `../indexer/ponder.schema.ts`.
- Produces:
  - `useLiveMarkets(): { markets: Market[]; error?: Error }`. It calls swap-sdk `listMarkets(pub, { hook, limit: 40 })` every 1000 ms.
  - `ponderClient`, from `createClient(`${indexerUrl}/sql`, { schema })`.
  - `useIndexerQuery<T>(key, fn): { data?: T; available: boolean }`. It uses live queries and falls back to polling every 2000 ms.
  - `type IndexerHealth = { state: 'synced' | 'behind' | 'down'; behind?: number }`
  - `indexerStatus(p: { reachable: boolean; indexedBlock?: bigint; headBlock?: bigint }): IndexerHealth`. It reports `behind` at 10 or more blocks behind.
  - `mergeMarketSources(rpc: Market[], indexed?: IndexedMarket[]): MarketRow[]`. The row type is `MarketRow = Market & { volumeUsdc?: bigint; tradeCount?: number }`. RPC is authoritative; the indexer only adds volume and trade count.
  - `useBalances(tokens: Address[]): Record<Address, bigint>`, a multicall `balanceOf` every 2000 ms, plus USDC and ETH.

- [ ] **Step 1: Write the failing tests.**

```ts
test.each([
  [{ reachable: false }, { state: 'down' }],
  [{ reachable: true, indexedBlock: 100n, headBlock: 105n }, { state: 'synced' }],
  [{ reachable: true, indexedBlock: 100n, headBlock: 130n }, { state: 'behind', behind: 30 }],
])('indexerStatus %o', (p, want) => expect(indexerStatus(p)).toEqual(want))
test('merge keeps rpc markets when indexer is down', () => {
  expect(mergeMarketSources([mA, mB], undefined).map((r) => r.id)).toEqual([mA.id, mB.id])
})
test('merge adds volume, never drops rpc rows', () => {
  const rows = mergeMarketSources([mA, mB], [{ id: mA.id, volumeUsdc: 5_000_000n, tradeCount: 2 }])
  expect(rows[0].volumeUsdc).toBe(5_000_000n); expect(rows[1].volumeUsdc).toBeUndefined()
})
```

- [ ] **Step 2: Run them; expect FAIL.** `npx vitest run test/indexer.test.ts`
- [ ] **Step 3: Implement** the hooks and the pure functions. `IndexerStatus` renders a green, amber ("N blocks behind") or red dot.
- [ ] **Step 4: Run them; expect PASS.**
- [ ] **Step 5: Commit.** `git add web && git commit -m "web: live market polling, indexer client with fallback, indexer status"`

### Task 9: Trade engine port, error copy, input state

**Files:**
- Create: `web/lib/trade.ts` (port `app/src/trade.ts`), `web/lib/errors.ts`, `web/lib/tradeBox.ts`, `web/hooks/useTrade.ts`
- Test: `web/test/trade.test.ts` (port `app/test/trade.test.ts`), `web/test/errors.test.ts`, `web/test/tradeBox.test.ts`

**Interfaces:**
- Consumes: `Connection` (Task 1), built from wagmi `useWalletClient`; `WebConfig`.
- Produces:
  - `executeSwap(ctx, req, onSteps)`, `executeRedeem(ctx, market, amount, onSteps)` and `executeSettle(ctx, market, onSteps)`, with the same signatures as `app/src/trade.ts`. `ExecContext.cfg` is `WebConfig`.
  - `friendlyError(err: unknown): string`
  - `tradeInputState(p: { network: NetworkState; phase: UiPhase; isBuy: boolean; input: string; balance?: bigint; quoteError?: unknown }): { enabled: boolean; reason?: string; amount?: bigint }`
  - `tradeSummary(p: { isBuy: boolean; amountIn: bigint; amountOut: bigint; midWad: bigint }): { avgPrice: number; toWin?: number; impactPct: number }`

- [ ] **Step 1: Write the failing tests.** Port the existing `trade.test.ts` cases, and add:

```ts
test.each([
  [userRejection(), 'Cancelled'],
  [swapError('MARKET_CLOSED'), 'Trading has closed for this market'],
  [swapError('OUT_OF_BAND'), 'That trade is too large right now; try a smaller amount'],
  [swapError('CAPACITY'), 'That trade is too large right now; try a smaller amount'],
  [swapError('SLIPPAGE'), 'The price moved; review the new quote'],
])('friendlyError', (e, msg) => expect(friendlyError(e)).toBe(msg))
test.each([
  [{ network: 'disconnected' }, 'Connect a wallet'],
  [{ network: 'wrong-chain' }, 'Switch to Unichain Sepolia'],
  [{ phase: 'closed' }, 'Trading has closed for this market'],
  [{ input: '' }, 'Enter an amount'], [{ input: '0' }, 'Enter an amount'], [{ input: '.' }, 'Enter an amount'],
  [{ input: '1.1234567' }, 'Too many decimals'],
  [{ input: '6', balance: 5_000_000n }, 'Not enough USDC'],
  [{ input: '6', isBuy: false, balance: 5_000_000n }, 'Not enough tokens'],
])('tradeInputState %o', (over, reason) => {
  expect(tradeInputState({ network: 'ok', phase: 'live', isBuy: true, input: '5', balance: 100_000_000n, ...over })).toMatchObject({ enabled: false, reason })
})
test('summary: $5 buys 7.9 UP at mid 62c', () => {
  const s = tradeSummary({ isBuy: true, amountIn: 5_000_000n, amountOut: 7_900_000n, midWad: 620_000_000_000_000_000n })
  expect(s.avgPrice).toBeCloseTo(0.6329, 4); expect(s.toWin).toBeCloseTo(7.9, 6); expect(s.impactPct).toBeCloseTo(2.08, 2)
})
```

- [ ] **Step 2: Run them; expect FAIL.** `npx vitest run test/trade.test.ts test/errors.test.ts test/tradeBox.test.ts`
- [ ] **Step 3: Port and implement.** `friendlyError` maps swap-sdk `PredictionSwapError.code`, and falls back to the decoded message. The Buy button's reason text is shown verbatim.
- [ ] **Step 4: Run them; expect PASS.**
- [ ] **Step 5: Commit.** `git add web && git commit -m "web: trade engine port, friendly errors, trade input state and summary"`

### Task 10: Markets home

**Files:**
- Modify: `web/app/page.tsx`
- Create: `web/components/market/{Hero,MarketCard,MarketTabs,PhaseChip,Countdown}.tsx`, `web/components/market/Sparkline.tsx` (use the `dataviz` skill)
- Test: `web/test/home.test.tsx`

**Interfaces:**
- Consumes: `useLiveMarkets`, `groupTabs`, `heroMarket`, `phaseLabel`, `questionText`, `mergeMarketSources`, and `useIndexerQuery` for sparklines (the last 60 `priceSnapshot` rows per market).

- [ ] **Step 1: Write the failing render test** (jsdom, with fixture markets and the indexer unavailable):
  - the hero shows `questionText(hero)`, "UP 62%", and buttons "Buy UP 63¢" and "Buy DOWN 39¢" (askUp 0.63, askDown 0.39);
  - the Live tab lists every live-tab market;
  - the Resolved tab card shows "Resolved UP";
  - sparklines render the text "History unavailable" and no chart.
- [ ] **Step 2: Run it; expect FAIL.** `npx vitest run test/home.test.tsx`
- [ ] **Step 3: Implement** the page and components. Tapping Buy on a card routes to `/market/[id]?side=up|down`.
- [ ] **Step 4: Run it; expect PASS.** Then check by eye with `make dashboard-local` against Sepolia.
- [ ] **Step 5: Commit.** `git add web && git commit -m "web: markets home with hero, tabs, cards and sparklines"`

### Task 11: Market page

**Files:**
- Create: `web/app/market/[id]/page.tsx`, `web/components/market/{Timeline,ProbabilityChart,TradeBox,StepList,PositionBox,RulesPanel,MarketTrades}.tsx`
- Test: `web/test/tradeBox.render.test.tsx`

**Interfaces:**
- Consumes: Tasks 7–9.
  - Quotes come from swap-sdk `quoteExactIn`, debounced 300 ms and refreshed every 1000 ms while the input is valid.
  - The position quantity comes from `useBalances`. Cost and profit come from the indexer's `position` rows, or "Cost unavailable" when it is down.
  - The chart shows `priceSnapshot` history plus the latest RPC point.

- [ ] **Step 1: Write the failing render test:**
  - with the phase `closed`, the button is disabled and reads "Trading has closed for this market";
  - with a disconnected wallet, it reads "Connect a wallet";
  - with a valid quote, the summary shows the average price, "To win $7.90" and the impact;
  - `RulesPanel` renders `rulesText` exactly.
- [ ] **Step 2: Run it; expect FAIL.** `npx vitest run test/tradeBox.render.test.tsx`
- [ ] **Step 3: Implement.**
  - `StepList` renders the steps from `executeSwap` (approve → sign → swap), with explorer links.
  - After expiry and before settlement, a **Settle** button calls `executeSettle`.
  - On resolved markets, **Claim** sells the winning token by swap with `executeSwap` (`isBuy: false`).
- [ ] **Step 4: Run it; expect PASS.** Then do one buy and one sell by hand on the local stack.
- [ ] **Step 5: Commit.** `git add web && git commit -m "web: market page with chart, trade box, position, rules and trades"`

### Task 12: Portfolio

**Files:**
- Create: `web/lib/portfolio.ts`, `web/app/portfolio/page.tsx`, `web/components/portfolio/{Summary,PositionsTable,ClaimBanner,History}.tsx`
- Test: `web/test/portfolio.test.ts`

**Interfaces:**
- Produces:
  - `interface Holding { marketId: bigint; side: 'UP' | 'DOWN'; qty: bigint; cost?: bigint; realized?: bigint; bidWad?: bigint; claimPayout?: bigint }`
  - `portfolioSummary(h: Holding[], usdc: bigint): { value: bigint; unrealized?: bigint; realized?: bigint }`. `value` is Σ qty × bid + USDC. The profit fields are undefined if any holding lacks a cost.
  - `claimables(h: Holding[]): { total: bigint; items: Holding[] }`. Items are holdings with `claimPayout > 0`: settled winners pay qty, and invalid markets pay qty/2.

- [ ] **Step 1: Write the failing tests:**
  - 10 UP at a 62¢ bid with $6.60 cost, plus $4 USDC, gives value $10.20 and unrealized −$0.40;
  - a missing cost makes `unrealized` undefined;
  - claimables: 10 UP settled as a winner plus 4 DOWN in an invalid market gives a total of $12.00.
- [ ] **Step 2: Run them; expect FAIL.** `npx vitest run test/portfolio.test.ts`
- [ ] **Step 3: Implement.**
  - Quantities come from the chain (`useBalances` over every token in the account's indexed positions, plus live markets). Cost and profit come from the indexer.
  - "Claim all" runs `executeSwap` sells one after another, one per market.
  - The History tab lists `trade` and `transfer` rows.
- [ ] **Step 4: Run them; expect PASS.**
- [ ] **Step 5: Commit.** `git add web && git commit -m "web: portfolio with positions, profit, claims and history"`

### Task 13: Test-funds drip

**Files:**
- Create: `web/lib/drip/limits.ts`, `web/lib/drip/store.ts`, `web/lib/drip/send.ts`, `web/app/api/drip/route.ts`, `web/app/api/drip/status/route.ts`, `web/components/shell/FundsChip.tsx`
- Test: `web/test/drip.test.ts`

**Interfaces:**
- Produces:
  - `interface DripStore { tryReserve(address: Address, ip: string, now: number): Promise<{ ok: true } | { ok: false; retryAt: number }>; release(address: Address, ip: string, now: number): Promise<void> }`
  - `memoryStore(): DripStore`
  - `postgresStore(url: string): DripStore`. It uses a `drips(address text, ip text, at bigint)` table, created if missing, outside Ponder's schema. It reserves inside a transaction under `pg_advisory_xact_lock(hashtext(address))`.
  - `DRIP_WINDOW_SEC = 43_200`, `PER_ADDRESS = 1`, `PER_IP = 3`
  - `needsDrip(p: { usdc: bigint; eth: bigint }): boolean`. It returns false when USDC ≥ 10_000_000 and ETH ≥ 0.0005 ether.
  - `POST /api/drip { address }` returns `{ status: 'sent', usdcTx, ethTx } | { status: 'skipped' } | { status: 'limited', retryAt } | { status: 'empty' } | { status: 'disabled' }`.
  - `dripMessage(r: DripResponse, tz?: string): string`
  - `GET /api/drip/status` returns `{ enabled, address, usdc, eth }`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('one per address per 12h', async () => {
  const s = memoryStore()
  expect(await s.tryReserve(A, '1.1.1.1', 0)).toEqual({ ok: true })
  expect(await s.tryReserve(A, '2.2.2.2', 60)).toEqual({ ok: false, retryAt: 43_200 })
  expect(await s.tryReserve(A, '2.2.2.2', 43_200)).toEqual({ ok: true })
})
test('three per ip', async () => {
  const s = memoryStore()
  for (const a of [A, B, C]) expect((await s.tryReserve(a, '9.9.9.9', 0)).ok).toBe(true)
  expect((await s.tryReserve(D, '9.9.9.9', 0)).ok).toBe(false)
})
test('concurrent double click sends once', async () => {
  const s = memoryStore()
  const r = await Promise.all([s.tryReserve(A, 'x', 0), s.tryReserve(A, 'x', 0)])
  expect(r.filter((x) => x.ok)).toHaveLength(1)
})
test('release frees the slot after a failed send', async () => {
  const s = memoryStore(); await s.tryReserve(A, 'x', 0); await s.release(A, 'x', 0)
  expect(await s.tryReserve(A, 'x', 1)).toEqual({ ok: true })
})
test('skip when funded', () => expect(needsDrip({ usdc: 10_000_000n, eth: 10n ** 15n })).toBe(false))
test('route disabled', async () => {
  process.env.DRIP_ENABLED = 'false'
  const res = await POST(new Request('http://x/api/drip', { method: 'POST', body: JSON.stringify({ address: A }) }))
  expect(await res.json()).toEqual({ status: 'disabled' })
})
test('chip copy', () => {
  expect(dripMessage({ status: 'limited', retryAt: 1790382000 }, 'UTC')).toBe('Test funds already sent; try again at 00:20')
  expect(dripMessage({ status: 'empty' }, 'UTC')).toBe('Faucet is empty; ask the presenter')
})
```

  `dripMessage(r, tz?)` lives in `web/lib/drip/limits.ts`. The route answers `{ status: 'empty' }` when the drip wallet's USDC is below `DRIP_USDC` or its ETH is below `DRIP_ETH`.

- [ ] **Step 2: Run them; expect FAIL.** `npx vitest run test/drip.test.ts`
- [ ] **Step 3: Implement.**
  - The client IP is the first `x-forwarded-for` entry.
  - `send.ts` makes a viem `walletClient` from `DRIP_PRIVATE_KEY`, sends a USDC `transfer` of `DRIP_USDC × 1e6` and an ETH transfer of `parseEther(DRIP_ETH)`, then calls `release` on failure.
  - The store is Postgres when `DATABASE_URL` is set, and memory otherwise.
  - `FundsChip` shows USDC; when the wallet is short of USDC or gas, it becomes **Get test funds** and shows the drip transaction or the retry time.
- [ ] **Step 4: Run them; expect PASS.**
- [ ] **Step 5: Commit.** `git add web && git commit -m "web: rate-limited test-funds drip and funds chip"`

### Task 14: Phase 1 end-to-end gate

**Files:**
- Create: `web/playwright.config.ts`, `web/e2e/mockWallet.ts` (port `installMockWallet` from `app/scripts/e2e.ts` to Playwright `exposeFunction` + `addInitScript`), `web/e2e/globalSetup.ts`, `web/e2e/core.spec.ts`

- [ ] **Step 1: Write the e2e spec.**
  - Global setup: fund the drip wallet (Anvil account #2) with ETH and USDC, using `fundEth` and `dealErc20` ported from `app/src/devtools.ts`.
  - `core flow`: connect the injected wallet → **Get test funds** → Buy UP $5 on the hero → the portfolio shows the UP position with cost $5.00 → sell half → wait up to 180 s for resolution → claim if UP won, otherwise check the position shows as lost → the portfolio has no claimables left.
  - `indexer down`: with `NEXT_PUBLIC_INDEXER_URL` pointing at a closed port, buying UP $1 still succeeds, the history panel reads "History unavailable", and the status dot is red.
- [ ] **Step 2: Run it against the local stack; expect PASS.** Start `node scripts/local-stack.ts --anvil --bots` (in `app/`) and `make dashboard-local NETWORK=local`, then run `cd web && npx playwright test`.
- [ ] **Step 3: Deploy and run the manual gate on the public link, three times:** drip → buy UP → sell → claim a winner. Check the portfolio is right and the transaction shows as a UniversalRouter → PoolManager swap on `sepolia.uniscan.xyz`. Then run it once more with the hosted indexer stopped, and confirm that trading still works (spec §9).
- [ ] **Step 4: Commit.** `git add web/e2e web/playwright.config.ts && git commit -m "web: Playwright core flow and indexer-down e2e"`

---

## Phase 2: Platformless proofs

### Task 15: Token logo endpoint

**Files:**
- Create: `web/lib/tokenLogo.ts`, `web/app/api/token-logo/[address]/route.ts`
- Test: `web/test/tokenLogo.test.ts`

**Interfaces:**
- Produces:
  - `renderTokenLogo(p: { side: 'UP' | 'DOWN'; strikeUsd: number; expiry: number; tz?: string }): string` (SVG)
  - `resolveHookToken(client, cfg, address): Promise<{ marketId: bigint; side: 'UP' | 'DOWN'; info: MarketInfo } | null>`. It reads `hook()`, `marketId()` and `isYes()` on the token, and requires `hook() == cfg.hook` **and** `marketInfo(id).yes|no == address`.
  - The route returns `image/svg+xml` with `Cache-Control: public, max-age=86400, immutable`, and 404 when `resolveHookToken` returns null.

- [ ] **Step 1: Write the failing tests:**
  - an UP logo contains "▲", "2,684" and "14:31", with the UP colour token;
  - a DOWN logo contains "▼";
  - a token whose `hook()` matches but that is not `marketInfo(id).yes` resolves to null (a mocked client);
  - a non-token address resolves to null.
- [ ] **Step 2: Run them; expect FAIL.** `npx vitest run test/tokenLogo.test.ts`
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run them; expect PASS.**
- [ ] **Step 5: Commit.** `git add web && git commit -m "web: generated token logos for hook-created outcome tokens"`

### Task 16: Trade receipts and token drawer

**Files:**
- Create: `web/lib/forkLink.ts`, `web/components/token/{TradeReceipt,TokenDrawer}.tsx`, `web/scripts/check-no-fork-link.mjs`
- Modify: `web/components/market/TradeBox.tsx` and `web/components/portfolio/PositionsTable.tsx` (to mount them)
- Test: `web/test/forkLink.test.ts`

**Interfaces:**
- Produces:
  - `forkLink(cfg: Pick<WebConfig, 'forkUrl' | 'contracts'>, token: Address): string | undefined`. It returns `${forkUrl}/swap?chain=unichain_sepolia&inputCurrency=${usdc}&outputCurrency=${token}` only when `forkUrl` is set. This deep-link format is verified in `docs/research/interface-fork/local-run.md:25`.
  - `watchAssetParams(p: { address: Address; symbol: string; origin: string }): { type: 'ERC20'; options: { address; symbol; decimals: 6; image: string } } | { error: string }`. Symbols longer than 11 characters give `{ error: 'Symbol too long for MetaMask' }`.
- The receipt reads "Executed on Uniswap v4 · UniversalRouter → PoolManager → hook · pool 0x1a2b…" with a **View on explorer** link. It takes the pool id from the token's `PoolKey` via swap-sdk `poolId`.
- The drawer has the token address, **Add to wallet** (`wallet_watchAsset` with the logo URL from Task 15), **Send** (ERC-20 `transfer` via wagmi `useWriteContract`), and **Open in Uniswap** only when `forkLink` is defined. Otherwise it shows the explorer link.

- [ ] **Step 1: Write the failing tests.** `forkLink` is undefined when `forkUrl` is unset, and gives the exact URL when it is set. `watchAssetParams` rejects a 12-character symbol and accepts `ETHDOWN`.
- [ ] **Step 2: Run them; expect FAIL.** `npx vitest run test/forkLink.test.ts`
- [ ] **Step 3: Implement** it. `check-no-fork-link.mjs` greps `web/.next` for `localhost:3000` and `NEXT_PUBLIC_UNISWAP_FORK_URL`'s value, and exits 1 on any match.
- [ ] **Step 4: Verify.** The tests PASS, and `npx next build && node scripts/check-no-fork-link.mjs` (with the env unset) exits 0.
- [ ] **Step 5: Phase 2 gate.** On the local build with `NEXT_PUBLIC_UNISWAP_FORK_URL=http://localhost:3000`, buy UP in the dashboard, then open in Uniswap and sell it in the fork.
- [ ] **Step 6: Commit.** `git add web && git commit -m "web: v4 trade receipts, token drawer with add to wallet, send and local-only fork link"`

---

## Phase 3: Price transparency

### Task 17: TypeScript pricer

**Files:**
- Create: `web/lib/pricing.ts`
- Test: `web/test/pricing.test.ts`, `web/test/pricing.parity.test.ts`

**Interfaces:**
- Produces:
  - `normCdf(x: number): number`, using the Hart (1968) / West (2005) double-precision algorithm
  - `interface PricerInputs { xWad: bigint; varE36: bigint; tau: bigint; window: number; nSamples: number }`
  - `midUp(p: PricerInputs): number`
  - `sigmaAnnual(varE36: bigint): number`, which is `sqrt(varE36 * 31_557_600 / 1e36)`
  - `spotUsd(xWad: bigint, strikeUsd: number): number`, which is `K·e^x`
  - `shiftSpot(p: PricerInputs, spot: number, deltaUsd: number): PricerInputs`, which adds `ln((S+Δ)/S)` to `x`

The formula, copied from SPEC §3.3, with σ² = varE36/1e36 per second, w = window, n = nSamples and Δ = w/n:

```
n ≥ 1:  μ = x − ½σ²·(τ − w + (n−1)Δ/2)      v = σ²·[(τ − w) + Δ(n−1)(2n−1)/(6n)]
n = 0:  μ = x − ½σ²·(τ − w/2)                 v = σ²·(τ − 2w/3)
mid = Φ(μ / √v)
```

- [ ] **Step 1: Write the failing tests:**

```ts
import vec from '../../test/vectors/binary_pricer.json'
test('Φ anchors', () => { expect(normCdf(0)).toBe(0.5); expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 14) })
test('matches 6,600 mpmath vectors', () => {
  for (let i = 0; i < vec.x.length; i++) {
    const got = midUp({ xWad: BigInt(vec.x[i]), varE36: BigInt(vec.varE36[i]), tau: BigInt(vec.tau[i]), window: Number(vec.window[i]), nSamples: Number(vec.n[i]) })
    expect(Math.abs(got - Number(vec.midRefE36[i]) / 1e36)).toBeLessThanOrEqual(1e-12)
  }
})
test('what-if is monotone in spot', () => {
  const p = { xWad: 0n, varE36: 11_407_711_613_050_422_085_329_682_865n, tau: 60n, window: 10, nSamples: 0 }
  expect(midUp(shiftSpot(p, 2684, 10))).toBeGreaterThan(midUp(p))
  expect(midUp(shiftSpot(p, 2684, -10))).toBeLessThan(midUp(p))
})
```

  The parity test runs only when `RPC_URL` is set. For every trading market on the local stack, `midUp` computed from `quote()` and `marketParams()` must be within 1e-6 of `quote().midYes / 1e18`.

- [ ] **Step 2: Run them; expect FAIL.** `npx vitest run test/pricing.test.ts`
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run them; expect PASS.** Also run `RPC_URL=http://127.0.0.1:8746 npx vitest run test/pricing.parity.test.ts`.
- [ ] **Step 5: Commit.** `git add web && git commit -m "web: TypeScript Black-Scholes Asian binary pricer pinned to mpmath vectors and on-chain mid"`

### Task 18: Why-this-price panel, ETH chart, resolution proof

**Files:**
- Create: `web/lib/settlement.ts`, `web/components/price/{WhyThisPrice,EthChart,ResolutionProof}.tsx`
- Modify: `web/app/market/[id]/page.tsx`
- Test: `web/test/settlement.test.ts`

**Interfaces:**
- Produces:
  - `averagePrice(cumFrom: bigint, cumTo: bigint, seconds: number, decimalsShift: number): number`, ported from `app/src/market.ts` `averagePriceFromCumulatives`
  - `settledAverage(avgNormTickTimesWindow: bigint, window: number, decimalsShift: number): number`, which is `1.0001^(D/window) · 10^shift`
  - `resolvesUp(D: bigint, window: number, lnStrikeWad: bigint, decimalsShift: number): boolean`. It mirrors SPEC §3.5: YES iff `D·1e18 > window·(strikeTickWad − 0.5e18)`, where `strikeTickWad = (lnStrikeWad − decimalsShift·ln10)/ln(1.0001)`.
  - `verdictText(up: boolean): string`, which returns 'currently resolving UP' or 'currently resolving DOWN'.
- `WhyThisPrice` shows S, K, σ (annualised), τ and the window. It shows mid = Φ(d), and ask and bid from `quote()`. A slider from −$50 to +$50 recomputes `midUp(shiftSpot(…))`.
- `EthChart` plots the ETH price from snapshots with a strike line and the window shaded. During `averaging`, it also shows the running `averagePrice` from `oracle.cumulativeAt(windowStart)` and `cumulativeAt(now)`, plus `verdictText`.
- `ResolutionProof` shows `settledAverage`, the strike, the winner, the settle transaction link, and "Anyone could call settle()".

- [ ] **Step 1: Write the failing tests:**
  - `resolvesUp` is false exactly on the boundary (a tie resolves DOWN) and true one unit above it;
  - `settledAverage` for D = window × tick(2684) is within 0.02% of 2684;
  - `averagePrice` reproduces a hand-computed cumulative pair.
- [ ] **Step 2: Run them; expect FAIL.** `npx vitest run test/settlement.test.ts`
- [ ] **Step 3: Implement** it. Use the `dataviz` skill for `EthChart`.
- [ ] **Step 4: Run them; expect PASS.** Then watch one market through its window on the local stack and check the verdict against the settled result.
- [ ] **Step 5: Commit.** `git add web && git commit -m "web: why-this-price panel with what-if, ETH chart with settlement window, resolution proof"`

---

## Phase 4: Social and LP

### Task 19: Activity feed and leaderboard

**Files:**
- Create: `web/lib/leaderboard.ts`, `web/app/activity/page.tsx`, `web/components/activity/{Feed,Leaderboard}.tsx`
- Modify: `web/components/shell/Header.tsx` (add the Activity nav item)
- Test: `web/test/leaderboard.test.ts`

**Interfaces:**
- Consumes: the `accountStats`, `position`, `trade` and `market` tables.
- Produces:
  - `leaderboardRows(stats: AccountStats[], positions: Position[]): { account: Address; profit: bigint; volume: bigint; winRate?: number }[]`
    - It sorts by `profit` (= `realizedTrade`) descending, then by volume.
    - `winRate` is the number of markets where the account's `trade`-origin realized profit is above 0, divided by the number of markets where its `trade`-origin qty is 0 and it had trades.
    - `received` buckets never count.
  - `feedText(t: Trade, sideLabel: 'UP' | 'DOWN'): string`, e.g. `0x12…ab bought 7.9 UP at 63.3¢`.

- [ ] **Step 1: Write the failing tests:**
  - ordering by profit, then volume;
  - a friend who only received 5 UP and claimed them has a profit of 0 and is not ranked above traders;
  - the `winRate` example: 2 wins out of 3 closed markets gives 0.667;
  - the exact `feedText` string above.
- [ ] **Step 2: Run them; expect FAIL.** `npx vitest run test/leaderboard.test.ts`
- [ ] **Step 3: Implement** it. The feed also lists new markets and settlements, newest first, via a live query.
- [ ] **Step 4: Run them; expect PASS.**
- [ ] **Step 5: Commit.** `git add web && git commit -m "web: live activity feed and leaderboard"`

### Task 20: Vault page

**Files:**
- Create: `web/lib/vault.ts`, `web/app/vault/page.tsx`, `web/components/vault/{VaultStats,DepositWithdraw,RiskTable,ShareChart}.tsx`
- Modify: `web/components/shell/Header.tsx` (add the Vault nav item)
- Test: `web/test/vault.test.ts`

**Interfaces:**
- Produces (from SPEC §3.6):
  - `navFromMarkets(idle: bigint, ms: { bucket: bigint; outUp: bigint; outDown: bigint }[]): { navPlus: bigint; navMinus: bigint }`
  - `marketRisk(m): { worstReturn: bigint; bestReturn: bigint }`, where worst = `bucket − max(out)` and best = `bucket − min(out)`
  - `sharesForDeposit(assets, totalShares, navPlus)`, which is `assets*(totalShares+1_000_000n)/(navPlus+1n)`
  - `assetsForWithdraw(shares, totalShares, navMinus)`, which is `shares*(navMinus+1n)/(totalShares+1_000_000n)`
  - `withdrawable(userAssets, idle)`, which is `min`
- Deposit is an ERC-20 `approve(hook)` followed by `hook.deposit(assets)`. Withdraw is `hook.withdraw(shares)`, disabled above the idle amount. The chart plots `vaultSnapshot` share value (`navMinus / totalShares`).

- [ ] **Step 1: Write the failing tests** (spec §5 worked example, values in USDC units):

```ts
const U = 1_000_000n
test('vault range', () => expect(navFromMarkets(900n * U, [{ bucket: 100n * U, outUp: 60n * U, outDown: 30n * U }])).toEqual({ navPlus: 970n * U, navMinus: 940n * U }))
test('market risk', () => expect(marketRisk({ bucket: 100n * U, outUp: 60n * U, outDown: 30n * U })).toEqual({ worstReturn: 40n * U, bestReturn: 70n * U }))
test('withdraw capped by idle', () => expect(withdrawable(50n * U, 20n * U)).toBe(20n * U))
test('share math round-trips conservatively', () => {
  const s = sharesForDeposit(100n * U, 1_000n * U, 970n * U)
  expect(assetsForWithdraw(s, 1_000n * U + s, 1_010n * U)).toBeLessThanOrEqual(100n * U)
})
```

- [ ] **Step 2: Run them; expect FAIL.** `npx vitest run test/vault.test.ts`
- [ ] **Step 3: Implement** it.
- [ ] **Step 4: Run them; expect PASS.** Then deposit and withdraw once on the local stack.
- [ ] **Step 5: Phase 4 gate.** Deposit and withdraw work on the hosted site, and the leaderboard matches the indexer's tables.
- [ ] **Step 6: Commit.** `git add web && git commit -m "web: LP vault page with deposit, withdraw, risk per market and share history"`

---

## Deferred (not in this plan)

Strike ladder, presenter mode, and batched Claim all (spec §3 and §11). Also the bot's token-naming change, which another agent owns.
