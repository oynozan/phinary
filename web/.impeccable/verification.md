# Markets refresh verification

Date: 2026-09-26
Connection baseline: 9cfc578
Scope: Markets route and shared header; all implementation changes under web/.

## Automated checks

- ESLint: pass.
- Typecheck: pass.
- 18 Node tests: pass, including existing purchase/resource/adapter tests and new explorer/markup cases.
- Production build: pass. Final restricted-environment build stalled at compilation and was interrupted; rerun with normal permissions passed.
- git diff --check: pass.
- Impeccable detector: no findings on scanned Markets stylesheet/components/header.
- Asset provenance scan: one raster, zero missing; source prompt retained beside WebP.

## Browser evidence

Read-only CUA verification on localhost:3101:
- Populated real Markets at 1536, 1280 and 390 CSS px; clientWidth equals scrollWidth at each size. Browser zoom was accounted for and viewport override reset.
- Featured real quote, probability, strike and countdown; history explicitly unavailable.
- Live and Resolved tables; actual UP WON/DOWN WON outcomes; missing volume/settlement/settlement time remain N/A.
- Upcoming empty state; search with no result; Clear filters; Show more expanded 12 to 24 rows.
- DOWN preview navigated to /market/494?side=down and preserved existing UP-only purchase notice and disabled amount field.
- Wallet Connect opens existing provider-selection dialog, closed without connecting.
- Portfolio retains its previous body styling, with clear spacing below the new header.
- Intermittent RPC read failures show an error without removing hero and recover through the existing polling behavior.
- Mobile stacks hero and shows compact market rows; original dock retained.

Screenshots were inspected inline through CUA. They are not persisted as repository artifacts.

## Independent review

A separate reviewer inspected source, ran lint/typecheck/tests and inspected live desktop/mobile and Portfolio UI. Disposition: Ship. It observed a market changing from price links/Trade to N/A/View at cutoff. Heading phrasing markup was corrected after its source review. A separate documenter reconciled DESIGN.md and schema-v2 design.json with implemented tokens and shared-header geometry.

## Limits

- No wallet connection, signature, approval or purchase was submitted. Connected-wallet and wrong-network visual states were not exercised on a live wallet; existing wallet guards passed their unit tests and wallet/transaction source is unchanged.
- Public-testnet purchase validation still awaits test ETH.
- Data-reader/API/contract/SDK/backend files and other route bodies have no changes relative to the connection baseline.
