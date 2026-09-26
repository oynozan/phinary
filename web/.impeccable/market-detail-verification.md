# Market Detail verification

Date: 2026-09-26. Worktree: `/private/tmp/phinary-web-onchain`, branch `feat/web-onchain`.

## Automated checks

- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: 24 tests passed, including existing purchase/network/resource/adapter checks.
- `npm run build`: passed with Next.js 16.3.6.
- `git diff --check`: passed.
- New tests cover exact cutoff and all inactive phases, quote-derived display arithmetic, range filtering, missing settlement values, unknown underlying, and settled payouts versus live asks.
- An isolated esbuild view harness substitutes hooks only inside test bundles, never in the app. It checks disconnected/connected/wrong-network wallets, no USDC/gas, missing balances, stale/unavailable quotes, pending/busy transactions, DOWN preview, all phases, real-balance rendering, balance failure and invalid 50/50 payout.

## Live browser checks

Connected development app at `http://localhost:3101`; no live data was replaced.

- Real market 519 inspected at **1536**, **1280** and **390 CSS px**. DOM clientWidth and scrollWidth matched at all three widths. Screenshots visually inspected through CUA.
- Desktop: compact overview and chart left, Trade right, positions/model below chart, full-width settlement rules and two lower panels. Header remained unchanged.
- Mobile: overview, chart, trade, position, pricing, rules, history and onchain information. Trade is in normal flow. Existing dock retains shell clearance.
- Market 519 was observed live and subsequently Resolved UP. Overview changed to payout labels, right panel to settlement, missing settlement average/time stayed N/A.
- Back to Markets worked with Enter. Market 524 DOWN link opened `?side=down`, showed preview-only copy and disabled purchase. Keyboard activation of UP changed URL to `?side=up` and enabled the input while live. $10 populated the amount and Advanced details exposed slippage controls.
- History/trade history correctly showed unavailable states. No decorative history or fabricated volume/cost basis was introduced.
- Browser viewport restored after checks.

## Independent review and detector

Independent reviewer `detail_review`: **ship**, no material findings in bounded code and browser review. Reviewer inspected real market 521, independently verified DOWN preview and mobile ordering. Its mobile override yielded 433 CSS px, so exact 390 evidence comes from the parent check above.

Impeccable detector ran once on changed detail components and TradeCard. Reported advisory palette/type-ramp additions are documented as intentional scoped Market Detail tokens by the independent documenter. The approved reference permits violet gradients and translucent dark surfaces.

## Limits

- Screenshots were rendered and reviewed inside CUA. This session did not expose a supported screenshot-to-disk export; no screenshot artifact is claimed.
- Real connected-wallet and wrong-network visual states were not exercised with the user's wallet. Their view rendering and guards were checked in isolated tests. No wallet permission, signing or transaction was performed.
- Public testnet purchase remains blocked on test ETH and is outside this redesign's completion conditions.
- Populated history charts/trades are unavailable from the current data hooks. Range selection is tested with fixtures; no populated live-history browser check is claimed.
- RPC errors and non-live edge phases use test coverage where the short live-market lifecycle did not provide a stable browser capture.
- Sell, DOWN purchase, Claim and permissionless settlement remain unconnected. They are not introduced by this design change.

## Boundary

Only `web/` presentation, display helpers, tests and documentation changed. Smart contracts, protocol math, backend, indexer, SDK, ABI, addresses and transaction mechanics were not modified. Existing header and Markets/Portfolio/Activity/Vault bodies are unchanged.

## Settlement companion refinement

User requested a character to fill the empty area below the resolved Settlement sidebar. Added a static generated orbital robot, shown only for resolved/invalid states, with an Explore markets link to `/`. Image is a 640px WebP (~30 KB), exact prompt and provenance sidecar shipped alongside it.

- Parent visually inspected 1536px desktop and 390px mobile; clientWidth and scrollWidth match. Mobile uses a compact horizontal row. Viewport restored.
- Independent `companion_review`: ship, no material findings. Independently inspected desktop at 1680px and clicked Explore markets to confirm navigation. Mobile evidence is parent's capture.
- Lint, typecheck and all 24 existing tests passed. No new tests for this presentational-only change.
- Standard Turbopack build failed on an internal process port binding with Operation not permitted, including a retry outside the default sandbox. `npm run build -- --webpack` passed. It emitted warnings from unchanged Akt font metadata and viem/ox dependency loading.
- Detector: one advisory for existing #000 mask color, no non-advisory findings. No detector-driven source changes.
- Documentation follow-up agent could not start because the thread limit was reached; parent completed the small documented component extension using the skill's documenter fallback.
- Transaction code and underlying data hooks are unchanged.
