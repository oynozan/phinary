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

The check validates chain ID, bytecode at all nine configured addresses (including
MarketScheduler), the hook's collateral address and USDC decimals. It verifies
Hook.owner is the scheduler, Hook.keeper is zero, and the scheduler's hook/oracle
references match the deployment. It uses the dashboard's market reader for the
latest 30 markets and reports the latest three, all at one pinned block.
Unreadable market info or parameters are errors; unavailable quotes are reported separately.
No tradable market produces a warning: it does not mean the read connection is
broken. Success is not proof of bytecode identity, wallet connectivity, swap
execution, or continued bot health. Those are checked in subsequent phases.

CLI failures exit nonzero. RPC error request details are deliberately omitted
because providers can include credentials in their URLs. The report contains
only contract addresses, market data and block information.

The oracle ABI preserves both outputs of `varianceE36()`: variance and `warm`.
The diagnostic reports fallback variance (`warm=false`) as a warning, without
disabling trades that the contract permits. `canOpen=false` can simply mean the
current scheduler slot was already opened; it is not a connection failure.

Read-only browser verification (requires installed Chrome and a running dev server):

```sh
PHINARY_DEV_URL=http://127.0.0.1:3101 node scripts/test-market-reads-browser.mjs
```

This checks live market reads, an older direct link, missing-market handling,
RPC failure and Retry recovery. Screenshots go to ignored `.review/phase2/`.
It does not connect a wallet or submit transactions. See
[`../docs/md/FRONTEND-INTEGRATION.md`](../docs/md/FRONTEND-INTEGRATION.md)
for the current integration phases (separate from the historical phases below).

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

## Indexed market history and Activity

The frontend's Next.js routes adapt the repository's existing Ponder `/graphql`
API. Set server-only `PHINARY_INDEXER_URL` to the indexer's base URL; development
otherwise uses `http://127.0.0.1:42069`. No separate `/activity` service is needed.
The browser calls `/api/activity` and `/api/markets/:id/history` on the frontend.
Upstream URLs and credentials stay on the server.

Market detail shares one history request across its chart, trades and indexed
metadata (volume, trade count, creation time). It polls every ten seconds.
Charts use warm-oracle samples before the trading cutoff; zero-valued cutoff
sentinels are excluded. RPC remains authoritative for quotes, balances and
settlement state. Home-page market aggregates are not yet connected.

Activity refreshes every five seconds. It fetches all trade pages in the last two
hours, computes the current hour and previous-hour comparison, and displays the
newest twelve Buy/Sell events. Hourly realized profit, win rate, rankings and claim
payout history remain unavailable because the current schema cannot establish them.
Accounts attributed only by transaction sender are labelled `(sender)`.

The adapter checks `/ready`, chain ID, indexed block time, and the first market's
UP/DOWN addresses against the configured Hook over RPC. More than 60 seconds of
indexing lag fails visibly. Pagination errors, duplicate rows and the 20-page cap
fail the entire request rather than presenting partial totals as complete. Activity
retains its last good snapshot as paused; market history becomes unavailable on
failure. Neither blocks wallet execution or Vault actions.

For local validation, run the existing indexer from `indexer/`:

```sh
SNAPSHOT_START_BLOCK=63569470 npm run dev -- --port 42070 --disable-ui
```

At the default snapshot start, `navMinus` returned empty data during validation.
Using the existing `SNAPSHOT_START_BLOCK` option allowed backfill to proceed
without changing backend code or the start of trade-event indexing.
Backfilling snapshots through a public RPC can be slow. Choosing a later snapshot
start speeds a smoke test but only provides price history from that block onward;
it must not be described as full historical chart coverage.

The Phase 5 stop at block 63575170 was traced to Ponder's empty-response cache.
The approved indexer patch now bypasses those entries and retries RPC reads;
`indexer` installs it automatically through `npm ci`. See
[`INDEXER-VAULT-INVESTIGATION.md`](../docs/md/INDEXER-VAULT-INVESTIGATION.md).
The current deployment also defaults to a safe snapshot start, so the explicit
`SNAPSHOT_START_BLOCK=63569470` above is optional.

Start the frontend with `PHINARY_INDEXER_URL=http://127.0.0.1:42070`, then verify a
market that has snapshots:

```sh
PHINARY_DEV_URL=http://127.0.0.1:3112 PHINARY_HISTORY_MARKET_ID=90 npm run test:indexer:browser
```

The read-only browser test checks real history, desktop/mobile rendering, shared
polling, history failure with RPC still available, and automatic recovery. Choose
a market ID covered by your indexer's snapshot range. Unit tests cover nonempty
trades and multipage totals; the public deployment had zero trades during Phase 5
validation. UI-only samples remain available with `npm run preview:activity`.

## Frontend v1.0

UP/DOWN exact-input purchases and sales use the existing SDK, Permit2 and UniversalRouter. Quotes expire after 30 seconds; reviewed minimum output is never lowered. Portfolio scans the entire market registry in chunks at a pinned block, including markets older than the home page window. Partial reads fail visibly rather than reporting an empty wallet. This full scan trades latency for completeness; the history service is not required for execution.

Winning balances redeem through `redeem`; invalid markets combine UP and DOWN balances before the contract floors the half payout. Claim All submits sequentially and stops on a failure or unknown outcome, preserving successful claims. Pending receipts persist across reloads. A shared in-page operation guard prevents concurrent market/Portfolio/Vault submissions and blocks new submissions while a stored transaction awaits confirmation. Wallet extension prompts on public Sepolia are not part of the automated acceptance test.

Current holdings come from RPC. Portfolio transaction history, historical acquisition costs and P&L remain unavailable. Market Buy/Sell history and Activity use the repository indexer through the frontend adapter described above. Missing history does not prevent trading or Vault actions.

Validation commands:

```sh
npm test
npm run typecheck
npm run lint
npm run build -- --webpack
npm run test:lifecycle:fork
npm run test:browser:fork
```

The lifecycle fixture starts loopback Anvil at deployment block + 200, funds a generated test-only account, and creates an isolated test market with a deterministic test oracle. All modifications occur on the disposable fork, never public Sepolia. Existing deployed contracts and SDK sources are unchanged. Anvil must be installed or supplied with `ANVIL_BIN`.

## Scheduler deployment: trading verification

```sh
npm run test:trading:scheduler:fork
npm run test:browser:fork
```

The first test opens a market through the deployed Scheduler on a local fork,
using its real oracle and an ordinary generated trader account. It checks UP/DOWN
purchases, partial/full sales, minimum outputs, exact balance deltas, insufficient
balance, stale quotes, account mismatch, Permit2 signature rejection and cutoff.
It explicitly uses 10% slippage for short-dated test markets; the UI default is unchanged.

The pinned new deployment predates LP funding. Both fixture modes now fund a
separate local LP and call the existing USDC approval and Hook.deposit paths
before market creation. Only local ETH/USDC balances are supplied through Anvil;
the Hook's storage is not patched to manufacture liquidity.

The browser suite retains the isolated long-lived market and test oracle so UI
timing, pending reload and settlement checks are repeatable. It asserts token and
USDC deltas for each trade, no balance changes on wallet rejection, and no extra
submission during receipt recovery. It also checks wrong-network/account changes.
This is an injected test EIP-1193 wallet, not validation of an installed wallet
extension. No test sends transactions to public Sepolia.

## Holdings, claims and Vault boundaries

`npm run test:lifecycle:fork` also verifies winning redemption, refusal of repeat
claims, and post-claim holdings. Invalid-market cases use ordinary token transfers
to leave 3 raw units on each side: the combined refund is 3 USDC raw units, not 2.
A single raw unit is excluded from Claim All and cannot submit a redemption.
Portfolio totals use the same per-market integer rounding as the claim plan.

Vault checks compare minted shares and withdrawn USDC with frontend integer
estimates and actual balances. A local market reserves nearly all idle collateral
to verify the exact maximum withdrawal against contract simulation: the maximum
succeeds and one additional raw share fails. All state changes stay on Anvil.

## Phase 6: browser, chain and indexer integration

Use Node 24, Anvil and installed Chrome. Install the existing dependencies in
`packages/swap-sdk/`, `indexer/` and `web/` with `npm ci` first; the indexer install
must report that its Ponder patch applied successfully. From `web/`:

```sh
npm run test:integration:fork
npm run test:trading:scheduler:fork
```

`test:integration:fork` extends the browser fork suite with an actual Ponder
instance. It creates a temporary source copy and fresh PGlite database, excludes
shared database environment variables, and uses a loopback-only Anvil RPC with
random test accounts. It starts Next on 3111 and Ponder on 42071; keep those ports
free. It stops only its own processes when finished. No public-chain transaction
is sent, and no existing database is opened.

The suite compares browser UP/DOWN buys and sells with exact wallet balance
deltas, indexed quantities/USDC and successful transaction receipts. It checks
market history and Activity in the browser, then stops and restarts Ponder to
verify delayed updates and recovery without duplicate trade rows. It also covers
wallet rejection, pending-approval reload without resubmission, chain/account
switches, Vault event amounts, winning redemption, and a second market's creation
and settlement. The existing responsive checks cover five routes at three widths.

This browser fixture uses a local test oracle and owner impersonation to make
settlement deterministic. The separate scheduler suite uses the deployed scheduler
and real oracle on another local fork. Neither modifies contract source or the
public deployment. Wallet signatures use a test EIP-1193 bridge, not a browser
extension's actual permission/signature dialogs.

The integrated fixture starts near wall-clock time so history freshness checks
remain enabled. Settlement then advances the fork by a day; the post-settlement
checks use RPC, the claim UI and raw GraphQL. The wall-clock Activity check occurs
before that jump; future-dated snapshots correctly cease to be presented as live.
Claims and hourly realized P&L remain outside Activity's supported schema.

Indexer logs are saved in `.review/phase6/indexer.log`; route screenshots are in
`.review/v1/`. Temporary databases remain in the OS temporary directory for
failure inspection. A successful local run does not replace a separate, explicitly
authorized testnet check with a real wallet extension or long-duration monitoring.
