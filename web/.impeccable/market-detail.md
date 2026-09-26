# Market Detail direction

Mode: Operate. Approved extension of the Markets visual system, 2026-09-26. This is not a new brand or a redesign of Markets, Portfolio, Activity or Vault. The shared header stays unchanged. DESIGN.md frontmatter is normative for the implemented tokens; scoped detail CSS supplies the actual surface.

## Structure and responsive behavior

Near-black financial terminal, Manrope with tabular numerals, static violet orbital atmosphere, compact bordered panels, restrained translucency, violet UP/primary, coral DOWN and green positive/live/success. No decorative icons beyond UP/DOWN triangles. Desktop max width 1536px with 48px gutters; gutters become 28px below 1280px and 20px below 640px. Approximately 65/35 desktop split, with the right trade panel sticky at the shared header offset. Mobile/tablet below 1024px uses normal flow: overview, chart, trade, position, pricing, rules, recent trades and onchain information. The container caps at 780px in this stacked layout.

## Data and transaction boundaries

Use real market reads and the existing wallet, quote and UP purchase path. Buy UP is the only supported trade action. DOWN selection is preview only; Sell and Claim are visibly disabled with availability copy. Do not create working-looking controls for unsupported actions. Show transaction progress only once an action has started; keep advanced details collapsed by default.

Holdings use real UP and DOWN token balances. Average cost and unrealized P&L are N/A without cost-basis data. Live bid-based position values and resolved redeemable values are display-only derivations of available data; claiming remains unavailable. Chart history and recent trades remain explicit unavailable states when their data sources are unavailable, not synthetic series or rows. Unknown pool addresses and unavailable settlement data stay N/A. The approved illustrative chart and trade examples do not authorize fabricated data.

Use the actual phase for Live, Trading Closed, Settlement Window, Awaiting Settlement, Resolved and Invalid presentation. Invalid retains the existing 50/50 payout meaning. Display exact cutoff and settlement-window times with seconds in UTC. Keep the existing protocol resolution rule, pricing, oracle, contracts, backend, APIs, indexer and swap mechanics unchanged.

## Intentional design-system extensions

Detail adds scoped 10px panels, compact typography roles and tonal states for selected sides, quick amounts, input focus, live status and disabled controls. These values are documented in DESIGN.md and the design sidecar, including the gradient purchase CTA and static atmosphere. They are intentional responses to the detector's advisory on previously undocumented tonal colors and type steps, not a new global palette. Other route bodies retain the legacy design rules.

## Evidence and review

Source: the user-approved Market Detail brief, attached as pasted-text.txt in the active task; implemented market-detail.css, detail-presentation.tsx and trade-card.tsx. Independent design review disposition reported by the coordinating agent: ship, no material findings. The detector was already run once; this documentation incorporates its advisory without rerunning it. Application verification evidence is recorded in `.impeccable/market-detail-verification.md`: 24 tests, lint, typecheck and production build passed, as reported by the coordinating agent.

## Settlement companion refinement

User requested a character to occupy the unused right-column space after resolution. A static moon-seated orbital robot now appears below Settlement for resolved and invalid markets, with What’s next? and an Explore markets link to `/`. Desktop image width is 260px; stacked layouts use a horizontal 150px image, reduced to 112px on phones. The decorative image has empty alt text and no motion. Generated art and exact provenance are stored under `public/markets/orbital-companion.*`. Purchase and settlement behavior is unchanged.
