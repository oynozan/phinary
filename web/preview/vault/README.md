# Vault preview and live connection

From `web/`, run `npm run dev:onchain` for the live application at `http://localhost:3101/vault`. It uses the configured deployed Unichain Sepolia contracts and existing wallet connection. Deposits and withdrawals are real actions when submitted through a connected wallet.

Run `npm run preview:vault` for the isolated UI at `http://localhost:3104`. Its persistent “Sample data” label and toolbar distinguish fixtures from live data. It bundles no live data, RPC or wallet execution modules and sends no transactions. Start the app or run a build first to make the local Manrope font assets available; the preview reuses those assets. Restart the preview after source edits to rebuild its bundle, or use `npm run preview:vault -- --build-only` to rebuild without starting a server.

The scenario selector covers Normal, Disconnected, Wrong network, Loading, Update failure, Limited idle, Rejected, Revert and Confirmation delay. Pause/Resume updates retains the previous snapshot; Reset restores initial sample balances. Deposit/Withdraw, quick amounts, Max, filters, sorting, View all and Learn more are interactive. Preview execution only mutates in-memory fixtures. It includes illustrative historical charts and multiple market categories, neither of which implies a live data source.

## Live data and transactions

TVL equals idle USDC plus all market buckets, including funds reserved for trader payouts. Vault Range is NAV− through NAV+, the equity valuations after liabilities. Share Price shows the withdrawal value; deposits use NAV+ and withdrawals NAV−. One displayed share is 10^12 raw units. USDC has six decimals. Estimated APY, historical charts, 24h volume and fee APR remain N/A/absent without an indexed source.

Core reads refresh five seconds after completion; all-market exposure refreshes after 30 seconds. Each snapshot reads at one block. Delayed reads retain successful values and indicate failure. A failed core read pauses submission. Every amount, Max boundary, approval and execution calculation uses bigint; display formatting does not feed execution. Withdrawals cannot exceed owned shares or idle USDC. The contract has no minimum-output parameter, so a confirmed amount can differ from its estimate.

Insufficient allowance triggers exact-amount USDC approval. Actions recheck wallet/account/network and current contract state, simulate and estimate gas before sending. Pending hashes persist locally; a reload or Check confirmation resumes receipt checking without resending a transaction. An approval recovered after reload requires a new explicit deposit action. Rejected, reverted, replaced and unknown-confirmation states remain distinguishable.

## Verification

`npm test`, `npm run lint`, `npm run typecheck` and `npm run build` cover the application. The implementation pass recorded 57 passing tests and passing lint, typecheck and production build. Read-only browser verification observed 725 deployed markets; this is a snapshot observation, not a fixed count.

Run `npm run test:vault:fork` for the disposable local Anvil integration test. Anvil must be installed or provided through `ANVIL_BIN`; the configured public RPC is read only to create the fork. The script binds an ephemeral loopback port, funds a generated local test account, performs exact approval/deposit/withdrawal, verifies receipt events and balance deltas, then stops Anvil. It never sends a public-chain test write. The recorded run deposited 1 USDC, minted 1049313380310 raw share units (1.049313380310 displayed shares) and withdrew 0.999999 USDC, matching contract integer rounding. Values may change with the fork snapshot.

Visual review targets 1672, 1440, 1280, 768 and 390px, keyboard focus, modal close/return focus, input precision/limits, error/stale states, table scrolling and reduced motion. Shared navigation and other route designs stay outside the Vault styling scope.
