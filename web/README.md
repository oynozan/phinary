# Phinary dashboard

Next.js 16 front end for Phinary markets (PredictionHook). Market reads use the
Unichain Sepolia RPC through `src/lib/data`. Wallet and transaction actions are
not connected yet. The original mock comparison lives on the main worktree.

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
  Portfolio, Activity and Vault still show their unconnected state.
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
No private key is stored by the web app. DOWN, selling, claiming and history are
outside this phase; no backend or contract changes are required.

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
