# Vault · Operate

Reference authority: user-provided 1672×941 Vault image. Replace the old Vault body; preserve shared navigation, wallet behavior and every other route. Black/violet surfaces, bright magenta primary actions, fine boundaries, compact Manrope/tabular type. Purple planet/orbit backdrop and Ethereum hero motif are explicitly requested exceptions to restrained default guidance.

First viewport: compact hero, six metrics, aligned 38/30/32 columns for input/how-it-works/composition, full-width Exposure table. At 1672px, content spans approximately x92–1580. No chart library or new runtime dependencies. Local SVG charts and existing orbital artwork. Actual account data only on production; a labelled isolated preview at 3104 carries the illustrative charts and multi-category dataset.

Deposit/Withdraw are real wallet actions, exact integer arithmetic. Display shares have 12 decimals. Two valuation prices and idle-limited withdrawal are stated rather than hidden. No guaranteed yield, no anytime-withdrawal promise. Missing historical/APY/volume metrics remain N/A. UI composition and costs never determine execution data.

Verification matrix: 1672,1440,1280,768,390px; keyboard, empty/error/stale, wallet/network, input validation, Max, filter/sort and modal. One batched initial capture, one correction/confirmation; independent finish review with captures. Scope-specific documentation only; pre-existing system-sidecar drift is not a license for app-wide changes.

## Verification · 2026-09-26

- Preview and live browser checks at 1672/1440/1280/768/390 px: no document horizontal overflow; 7-column exposure scroll is contained. Mobile wallet CTA opens the shared wallet dialog; floating Dock remains shared and the content can scroll clear of it. Focus/scroll clearance added for Vault controls.
- Sample Deposit and Withdraw change balances and quotes; results say `Simulation complete`. Exact Max (42.18 USDC), idle-limited withdrawal (1 USDC), invalid text/zero/excess precision/insufficient balance blocking, category filtering, numeric sorting, modal Escape, rejected action, update failure and recovery verified. Five-second updates retain input, keyboard focus and scroll position.
- Live browser read 725 markets, actual TVL and NAV; APY/history/24h volume/Fee APR remain N/A. Wallet-disconnected connection dialog verified. No test values imported by the live route; preview bundler rejects live RPC/wallet imports.
- 57 tests pass, including 12 Vault arithmetic/read/transaction tests; lint, typecheck and webpack production build pass. Existing viem/ox dependency warning persists.
- Local Anvil fork approved and deposited $1, minted 1,049,313,380,310 integer shares, withdrew those shares for $0.999999 after integer rounding; receipt outputs and balances asserted. No public-chain test writes.
- Detector ran once. Its font mismatch was corrected to Manrope; purple/card/gradient findings are intentionally specified by the user, palette additions remain Vault-scoped. Independent finish review requested typography, authored crypto SVG, readable disabled CTA and scoped documentation; corrections applied together.
- Browser screenshots: `.impeccable/review/vault/`. Reference is the user-provided image in conversation; no local source image exists for pixel-difference testing.
