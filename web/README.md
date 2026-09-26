# Phinary dashboard

Next.js 16 front end for Phinary markets (PredictionHook). Market reads use the
Unichain Sepolia RPC through `src/lib/data`. Wallet connection, UP/DOWN buys and sells, redemption, and Vault actions are connected. The original mock comparison lives on the main worktree.

```bash
npm install
npm run dev     # http://localhost:3100
npm run build
npm run lint
```

The old `?wallet=` mock overrides are disabled in this worktree.

See [DESIGN.md](DESIGN.md) for the design system.

## Phase 0: on-chain connection foundation

Work on `feat/web-onchain` in a separate worktree. Keep the original mock app on
port 3100; start this worktree with:

```sh
npm ci
npm run dev:onchain       # http://localhost:3101 (loopback only)
# In another terminal:
npm run check:connection  # read-only check through the Next.js SDK bundle
npm run typecheck
npm run lint
npm run build
```

Phase 0 established the connection foundation. Phase 1 now uses live market reads;
Phase 2 adds browser-wallet connection and UP purchases. The development-only diagnostic is available at
`http://localhost:3101/api/dev/connection`; production returns 404. It does not
sign or submit transactions and is not a trading API/backend.

`src/lib/onchain/config.ts` reads addresses from
`../deployments/unichain-sepolia.json`, the existing source of truth. The RPC can
be overridden in `web/.env.local` with `NEXT_PUBLIC_PHINARY_RPC_URL` (restart dev
after changing it). This value is public/browser-visible; do not use a secret RPC
credential. No wallet private key is required. This phase targets the recorded
Sepolia deployment, not a separately deployed local fork. Chain ID 1301 alone
cannot identify a fork; local deployments require their own address configuration.

The check validates chain ID, bytecode at all eight configured addresses, the
hook's collateral address, USDC decimals, and SDK reads of the latest three
markets. A positive market count without a readable latest market is an error.
No tradable market produces a warning: it does not mean the read connection is
broken. Success is not proof of bytecode identity, wallet connectivity, swap
execution, or continued bot health. Those are checked in subsequent phases.

CLI failures exit nonzero. RPC error request details are deliberately omitted
because providers can include credentials in their URLs. The report contains
only contract addresses, market data and block information.

The `.npmrc` setting copies the local `file:` SDK into `node_modules` so its
dependencies resolve inside `web/`. If the
team changes SDK source, reinstall dependencies before testing the updated SDK.
Do not edit the installed package copy.

## Phase 1: live, read-only markets

- The browser reads RPC directly using the existing SDK ABI and viem. No new
  backend is required; the development diagnostic is not used by the dashboard.
- The home page reads the newest 30 markets. Tabs and their counts apply to that
  window only. A direct `/market/<id>` link can read older markets independently.
- Reads refresh five seconds after each completed request; subscribers share one
  request per query. Polling stops when no component uses the query. Each snapshot
  reads market info, parameters, quotes and oracle values at the same block.
- Countdown and phase transitions use the observed chain timestamp plus monotonic
  elapsed time. Resolved winners always come from the contract status, not the
  current ETH price. Settlement average and historical data remain unavailable.
- RPC failures show a Retry action and discard stale display data. A failed quote
  does not hide market rules/status, and is shown as unavailable rather than 0%.
- Phase 2 enables wallet connection and UP purchases on market detail.
  Portfolio now reads complete registry balances; Vault reads deployed balances and supports deposits/withdrawals. Activity now has a separate Ponder integration described below.
- History, volume, trade count and creation/settlement timestamps are not invented.
  `null` represents data that needs the team's history service.

Validation:

```sh
npm test                # Node >=22.18; conversion, cutoff and polling failure tests
npm run typecheck
npm run lint
npm run build
```

For manual checks, open the home page, switch the Live/Upcoming/Resolved tabs,
open a market, and watch its cutoff/settlement transition. Reopen an older market
by ID and check `/market/999999999999` for a not-found state. Compare displayed
strike, expiry and outcome token addresses with the contracts, not the mock app.

## Phase 2: wallet and UP purchase

Open http://localhost:3101, choose a live market, connect a browser wallet and
switch to Unichain Sepolia (1301). The wallet needs test USDC and test ETH for gas.
Enter a USDC amount; review the real quote, minimum ETHUP received and slippage
(default 1%). Buy UP requests the required USDC approval, Permit2 signature and
purchase confirmation. Confirmed purchases refresh USDC and market UP balances.
No private key is stored by the web app. The v1.0 extension below adds DOWN, selling and claiming; complete history remains unavailable. no backend or contract changes are required.

Quotes refresh every five seconds and execution rejects reviews older than 30
seconds or after the trading cutoff. Price checks never lower the reviewed
minimum. Account/network changes abort subsequent signing steps. Submitted
transactions are persisted by hash: after a timeout or reload use Check
confirmation, which reads the receipt without resending. Cancellation and RPC
errors are visible. A wallet and read RPC on different chains/forks are rejected.

Validation:

```sh
npm test
npm run typecheck
npm run lint
npm run build
# Optional: install Anvil from Foundry, then test a disposable local fork:
ANVIL_BIN=/path/to/anvil npm run test:buy:fork
```

The fork test starts an isolated loopback node, generates a temporary account,
funds it only on the fork, then verifies approval, signature, purchase, minimum
output and balances from a new client. It never submits to public Sepolia. It
requires network access and an open market on the recorded deployment. USDC
funding uses this deployment's storage slot 9; the test asserts the funded balance.
Browser quote rendering and the disconnected wallet dialog were checked locally;
actual extension signature prompts and public Sepolia submission still need a
manual end-to-end check with your test wallet.

## Activity: live indexed history

Activity uses the Ponder service in [`../indexer`](../indexer/README.md). Start it
with `npm run dev` from `indexer/`, then use `npm run dev:onchain` here. Local
development defaults to `http://127.0.0.1:42069`; production requires server-only
`PHINARY_INDEXER_URL`. No indexer URL or credential is sent to the browser.

The fixed last-hour summary, newest 12 events and top 10 traders share a single
snapshot. The read-only proxy and five-second refresh are independent of wallet
and execution paths. Failed refreshes retain the last snapshot; missing or
ambiguous accounting shows N/A. UI-only sample scenarios remain available via
`npm run preview:activity`. See the indexer README for exact realisation,
transfer, settlement and deployment limitations.

## Frontend v1.0

UP/DOWN exact-input purchases and sales use the existing SDK, Permit2 and UniversalRouter. Quotes expire after 30 seconds; reviewed minimum output is never lowered. Portfolio scans the entire market registry in chunks at a pinned block, including markets older than the home page window. Partial reads fail visibly rather than reporting an empty wallet. This full scan trades latency for completeness; the history service is not required for execution.

Winning balances redeem through `redeem`; invalid markets combine UP and DOWN balances before the contract floors the half payout. Claim All submits sequentially and stops on a failure or unknown outcome, preserving successful claims. Pending receipts persist across reloads. A shared in-page operation guard prevents concurrent market/Portfolio/Vault submissions and blocks new submissions while a stored transaction awaits confirmation. Wallet extension prompts on public Sepolia are not part of the automated acceptance test.

Current holdings come from RPC. Complete transaction history, historical acquisition costs and P&L are unavailable in this release and remain N/A. Activity uses the separately supplied indexer API; that backend is not included in this frontend PR. Set server-only `PHINARY_INDEXER_URL` to an existing compatible service. Local development assumes port 42069. Missing service shows an unavailable state and does not prevent trading or Vault actions.

Validation commands:

```sh
npm test
npm run typecheck
npm run lint
npm run build -- --webpack
npm run test:lifecycle:fork
```

The lifecycle fixture starts loopback Anvil at deployment block + 200, funds a generated test-only account, and creates an isolated test market with a deterministic test oracle. All modifications occur on the disposable fork, never public Sepolia. Existing deployed contracts and SDK sources are unchanged. Anvil must be installed or supplied with `ANVIL_BIN`.
