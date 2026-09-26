# Portfolio UI preview

This is an isolated design preview, labelled **UI preview · Sample data**. It does not connect a wallet, call RPC, read user positions or send transactions. The production `/portfolio` route does not import these fixtures or supply execution callbacks.

## Run

From the worktree's `web/` directory:

```sh
npm run preview:portfolio
```

Open <http://localhost:3102>. The server binds only to `127.0.0.1`. It bundles once on startup; restart after source edits. Keep the connected development server at port 3101 available if you want to follow Markets or market-detail links. Those links leave the sample preview.

The preview reuses local Manrope font files from an existing Next dev/build cache when available, and falls back to sans-serif otherwise. It does not download fonts. Start the normal development server or build the app to populate those assets if needed.

## Scenarios and actions

The persistent toolbar selects Normal, Empty, Disconnected, Wrong network, Loading, Unavailable, RPC error, Missing accounting, Quote unavailable, Sell rejected, Trading closed, Partial claim failure or All claims fail. Changing a scenario resets its sample rows and local action state. **Reset actions** restores that scenario; **Reset clock & data** reloads the preview and restarts sample deadlines.

ETH sample rows cover open, awaiting settlement, winning, losing, Invalid, claimed and refunded positions. Winner payout is 1 USDC per token, loser payout is 0 and Invalid payout is 0.5. Open positions expire shortly after startup so that cutoff behaviour is visible. Reload before testing a fresh sale if those deadlines have passed. Some prices and accounting values are deliberately missing; Normal can therefore show N/A for aggregate value and unrealised P&L.

- Sell opens a token-quantity form with 25%, 50%, 75% and Max controls. Quotes and submissions use short local delays. Oversized quantities, unavailable quotes, rejection, cutoff and successful balance updates can be inspected without execution.
- Claim all confirms position count, total receivable amount and transaction count. Transactions mean distinct markets, even when two position sides share one market. Execution here is a sequence of local callbacks only.
- Partial claim failure preserves the successful sample market and leaves the failed one claimable. All claims fail leaves every claimable position unchanged.
- Connect and network scenarios display state messages without invoking a wallet or network action. The connected app retains its existing real connect/switch UI, but Portfolio accounting, Sell and Claim remain unavailable.

Summary total is unsettled position value plus claimable value, excluding wallet USDC. Missing required values remain N/A. Losing rows appear in History; unclaimed Invalid rows stay Claimable. Original costs and realised P&L come only from explicit sample fixtures, not new production accounting.

## Verification record

Implementation-session browser checks covered 1536px, 1280px and 390px layouts with no page-wide horizontal overflow. The team inspected screenshots inline; no screenshot files were exported. Browser interactions verified a 12.195-token sample sale and partial claim success of 160 USDC with 50 USDC remaining claimable. These are local UI simulations, not onchain purchase, sale or claim verification.

The independent review identified unit-price rounding and missing dialog focus restoration. The final source uses 2–4 decimal unit prices and explicit opener/heading focus restoration in both dialogs. Run the repository checks from `web/` with `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. The implementation session reported 32 passing tests and a passing webpack build (`npm run build -- --webpack`); no real Portfolio integration or testnet transaction is implied by these checks.

The Impeccable source detector reported only palette/type-ramp advisories; Portfolio-specific tokens are documented in DESIGN.md and its sidecar. Independent review covered source correctness and accessibility fixes. A separate screenshot-based finish review could not run because the agent thread limit was reached; visual inspection was performed inline by the implementing agent. Actual connected-wallet/network-switch actions were not exercised. The webpack build retains the existing viem/ox dynamic dependency warning.
