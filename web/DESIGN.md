---
name: Phinary Markets, Market Detail and shared header
description: Compact near-black financial interface with violet atmosphere.
colors:
  background: "#080b12"
  surface: "#0d111a"
  surface-2: "#151925"
  foreground: "#f5f5fa"
  muted: "#b4bdd3"
  border: "#252a38"
  primary: "#b739ee"
  hero-accent: "#bf55f5"
  nav-accent: "#bc55ff"
  up: "#d773ff"
  down: "#ff736a"
  live: "#20dfa0"
  header: "rgb(9 12 20 / 94%)"
  featured: "rgb(12 16 25 / 88%)"
  detail-panel: "rgb(11 16 25 / 94%)"
  detail-recess: "#0a0f18"
  detail-input: "#080d15"
  detail-control: "#101522"
  detail-control-border: "#303546"
  detail-input-border: "#384055"
  detail-focus: "#db9bff"
  detail-hover-border: "#b986dd"
  detail-link-hover: "#e1b1ff"
  detail-selection: "#7634a0"
  detail-active: "#6821b4"
  detail-active-border: "#ac37ef"
  detail-up-selected: "#38104e"
  detail-up-selected-border: "#c149f2"
  detail-down-selected: "#361e23"
  detail-quick: "#0b111c"
  detail-quick-selected: "#2d173e"
  detail-disabled-text: "#aeb6c9"
  detail-disabled-selected: "#2c1b3d"
  detail-disabled-selected-border: "#604277"
  detail-disabled-selected-text: "#e6d9f2"
  detail-primary-start: "#a50cdf"
  detail-primary-end: "#6f18f5"
  detail-primary-border: "#a63ce5"
  detail-primary-hover: "#8222ce"
  detail-primary-disabled: "#252034"
  detail-primary-disabled-border: "#4a365d"
  detail-primary-disabled-text: "#c6b8d9"
  detail-status: "#111622"
  detail-status-border: "#394051"
  detail-live-surface: "#09231d"
  detail-live-border: "#17694f"
  detail-model-border: "#642691"
  detail-empty-text: "#d7daE6"
  detail-tooltip-border: "#444058"
  detail-divider: "#202635"
  detail-link-underline: "#626a80"
  detail-scrollbar: "#43445a"
typography:
  display:
    fontFamily: "Manrope, sans-serif"
    fontSize: "clamp(38px, 3.65vw, 58px)"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Manrope, sans-serif"
    fontSize: "25px"
    fontWeight: 800
    letterSpacing: "-0.035em"
  table:
    fontFamily: "Manrope, sans-serif"
    fontSize: "13px"
  label:
    fontFamily: "Manrope, sans-serif"
    fontSize: "11px"
  detail-heading:
    fontFamily: "Manrope, sans-serif"
    fontSize: "clamp(25px, 2.5vw, 36px)"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  detail-heading-mobile:
    fontFamily: "Manrope, sans-serif"
    fontSize: "27px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  detail-section:
    fontFamily: "Manrope, sans-serif"
    fontSize: "17px"
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  detail-trade-title:
    fontFamily: "Manrope, sans-serif"
    fontSize: "24px"
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  detail-body:
    fontFamily: "Manrope, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  detail-label:
    fontFamily: "Manrope, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  detail-control:
    fontFamily: "Manrope, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  detail-empty:
    fontFamily: "Manrope, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  detail-pricing:
    fontFamily: "Manrope, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.35
  detail-quote:
    fontFamily: "Manrope, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.5
  detail-metric:
    fontFamily: "Manrope, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.35
  detail-action:
    fontFamily: "Manrope, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.5
  detail-model-output:
    fontFamily: "Manrope, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.35
  detail-amount:
    fontFamily: "Manrope, sans-serif"
    fontSize: "24px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  card: "12px"
  control: "8px"
  filter: "7px"
  control-group: "9px"
  detail-panel: "10px"
  detail-segment: "5px"
  detail-tooltip: "6px"
  detail-status: "24px"
spacing:
  compact: "12px"
  card-mobile: "16px"
  card: "20px"
  gutter-tablet: "28px"
  gutter-desktop: "48px"
  detail-grid-row: "12px"
  detail-grid-column: "24px"
  detail-panel-inline: "18px"
components:
  featured-card:
    backgroundColor: "{colors.featured}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.card}"
    padding: "20px"
  header:
    backgroundColor: "{colors.header}"
    textColor: "{colors.foreground}"
    height: "52px"
  search:
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    height: "40px"
    width: "215px"
  detail-panel:
    backgroundColor: "{colors.detail-panel}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.detail-panel}"
  detail-primary-disabled:
    backgroundColor: "{colors.detail-primary-disabled}"
    textColor: "{colors.detail-primary-disabled-text}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  detail-amount:
    backgroundColor: "{colors.detail-input}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    height: "48px"
---

# Design System: Phinary

## Overview

This refresh applies to Markets, Market Detail (`/market/[id]`) and the shared header. Market Detail extends the approved Markets system; it does not introduce new branding. It pairs compact financial content with a near-black ground and static violet atmosphere. Other route bodies retain the legacy reference below. The approved surface briefs are `.impeccable/markets.md` and `.impeccable/market-detail.md`; product and data constraints remain in `PRODUCT.md`.

## Colors

Violet has distinct implemented roles: primary token, hero accent, navigation underline and lighter UP text. Coral identifies DOWN; green identifies live/success. Dark panels use fine neutral borders and subdued secondary text. Frontmatter values are extracted from `src/app/markets.css`, `src/app/market/[id]/_components/market-detail.css` and the shared-header rules in `src/app/globals.css`. The `detail-*` primitives are intentional local tonal states for inputs, selectors, status, focus and disabled actions; they do not replace legacy global tokens. Violet gradients mark the primary purchase action, coral identifies DOWN selection, and green is reserved for positive/live/success states.

## Typography

Markets, Market Detail and header use Manrope, with inherited tabular numerals. The header uses a cyan/violet Phi mark and a 23px Manrope Phinary wordmark (20px on mobile), following the user's updated reference. Hero type is bold and tightly tracked; table values use compact regular and semibold text. At tablet widths the hero is 46px; below 640px it uses `clamp(32px, 9vw, 44px)`.

Market Detail adds a compact hierarchy: responsive question, section heading, trade title, metric value, model output, amount and action roles. The exact observed sizes are in the `detail-*` typography tokens. Labels, notes and table cells use the label role; controls and secondary values use the control role. Question headings use tighter tracking and wrap to fit; their mobile role applies below 640px. These are intentional terminal-density steps, not new global heading defaults.

## Layout

Shared header height is 52px on every route. The shell supplies 76px top padding, reduced to 68px below 640px; page bodies must not add a second header offset. Existing bottom dock clearance remains unchanged.

Markets, Market Detail and header containers cap at 1536px, with 48px gutters, 28px below 1280px and 20px below 640px. Markets uses a 1.6:1 hero grid (1.3:1 below 1280px), stacking below 1024px. At the same breakpoint the semantic desktop table becomes compact list rows. Desktop navigation gives way to the existing mobile menu and dock below 1024px.

Market Detail uses an approximately 65/35 desktop split: `minmax(0, 1.95fr) minmax(340px, 1fr)`, with 12px row and 24px column gaps. Below 1280px the ratio becomes 1.75:1 and the column gap 16px. The trade panel sticks at the shared shell offset. Below 1024px it returns to normal flow in a container capped at 780px, ordered overview, chart, trade, position, pricing, then settlement rules, recent trades and onchain information. Charts reserve 235px height, reduced to 220px below 640px. The lower desktop pair uses 1.4:1 columns and stacks below 1024px.

## Elevation & Depth

Thin borders and tonal surfaces establish depth. The header uses an opaque near-black ground with a subdued static orbital image; the featured card is slightly translucent. Static orbital artwork fades behind the hero at 0.65 opacity. Scoped gradient masks and the UP action gradient are approved. Active state filters use an inset border shadow. No permanent artwork animation; Markets and Market Detail honor reduced motion. Detail uses the same static orbital asset at 0.45 opacity behind its upper 380px, translucent panels and fine separators. Detail controls transition colors/borders over 150ms and shift 1px on press; reduced motion removes transitions and the press transform. No new panel shadows are introduced.

## Shapes

Cards and table containers use the card radius. Search, select and featured actions use the control radius. Filter buttons use the smaller filter radius; filter groups, row actions and header wallet controls use the control-group radius. Status labels and ETH symbols are rounded independently.

Detail panels use their own smaller panel radius; its segment buttons, chart tooltips and status capsule use the corresponding detail radius tokens. Trade controls retain the shared control radius, and quick amounts retain the filter radius.

## Components

The header keeps a Phi mark and wordmark, luminous active underline and existing wallet behavior. Connected wallet controls show a blue USDC icon and wallet/address/chevron in compact 34px bordered controls; disconnected wallets show Connect wallet. Markets includes a featured preview, UP/DOWN price actions, underlying and state filters, search, sort, and row links with separate price/action targets. Hover and keyboard focus preserve row geometry; search focus highlights its border. Disabled or unavailable prices use muted opaque surfaces. Loading, empty and error states retain card boundaries.

Market Detail includes a question/date/status header, overview metrics, chart mode and range controls, position rows, pricing inputs/output, settlement rules and text-only onchain links. Its rectangular trade card has Buy/Sell controls, explicit UP/DOWN side selection, a USDC amount, quick amounts, a quote summary and a full-width primary action. Its chart controls retain visible selected and disabled states when history is unavailable. The primary action uses the scoped gradient, then an opaque muted fill when disabled. Focus is a 2px violet outline with a 3px offset; amount focus also highlights its border. Transaction steps appear only after an action starts. Data availability and action support are defined in PRODUCT.md and the surface brief.

The user-approved settlement companion is a static orbital robot below the resolved/invalid Settlement panel. It uses the existing palette and a secondary Explore markets link, with a 260px image on desktop, 150px below 1024px and 112px below 640px. Stacked layouts place the image and copy side by side. This character is a scoped exception to the earlier no-decoration direction; trading screens and other route bodies are unchanged.

## Do's and Don'ts

- Do preserve the scoped Markets and Market Detail palette, compact density and visible keyboard focus.
- Do keep the shared header offset consistent across every route.
- Do keep Detail controls and tonal extensions scoped to `.market-detail-page`, with route-conditioned body background/noise handling only.
- Do use text and UP/DOWN triangles for detail hierarchy; avoid decorative icons.
- Don't apply this refresh to other route bodies without a separate decision.
- Don't animate the orbital artwork continuously or replace unavailable data with decorative charts.

## Legacy body reference

The following rules apply only to other route bodies and their existing components. Their atomic.cash-derived panels, dock, typography, noise and pill controls remain unchanged. Shared header and shell spacing follow Layout above.

### Hard rules

- **No gradients anywhere.** No `linear-` / `radial-` / `conic-gradient` in CSS or inline styles, no Tailwind `bg-linear-*` / `bg-gradient-*` / `from-` / `via-` / `to-`, no SVG `<linearGradient>` / `<radialGradient>`, no gradient chart fills, masks or text. Flat solid colours only. Charts are a line, no area fill.
- **Buttons are solid.** Every button, pill button, segmented / tab item, dock icon, menu trigger and the LiquidMetal Trade button has an opaque fill. No `bg-x/NN` alpha fills, no transparent ghost fills, no `backdrop-blur`, no `opacity-*` on a button surface. Tinted buttons use the opaque tint tokens (`bg-up-soft`, `bg-primary-soft`, ...). Outline buttons sit on `bg-surface-2`. Disabled is an opaque muted fill (`bg-primary-disabled` for primary, `bg-surface-2` + `text-subtle` for the rest), never reduced opacity.
- **No labels on or above headings.** No status pill, eyebrow, kicker, overline or tag above, on or attached to a heading or market question. Status is the countdown itself (a live market shows its countdown), disabled / closed actions, or the value in a result line ("Resolved ▲ UP", "Settled $2,696.45").
- **No mock logos.** The header shows the plain "Phinary" wordmark in Akt, no mark. The favicon is a solid orchid "P" on carbon. No generated token discs: where a side needs an indicator use plain inline "▲ UP" / "▼ DOWN" text in the side colour (`SideMark`).

### Copy rules

- No em dashes anywhere (UI, code, comments, docs). Avoid en dashes in UI copy. Use a hyphen, colon or comma.
- No eyebrow / kicker / overline text or status pill above, on or beside headings. Headings stand alone.
- Minimal: numbers and actions. No helper paragraphs, no explanatory labels, no marketing copy. Empty states are one line plus at most one button.
- Sides are always **UP** / **DOWN** (never YES / NO). Prices as cents (`63¢`) or chance (`62%`). Tickers `ETHUP` / `ETHDOWN`.

### Tokens (`src/app/globals.css`)

| Token (Tailwind) | Value | Use |
|---|---|---|
| `bg-background` | `#191919` Carbon Black | page |
| `bg-surface` | `#201f21` | panels, cards, top section of a stacked card |
| `bg-surface-2` / `bg-secondary` | `#282629` | lower stacked section, inputs on panels |
| `bg-surface-3` | `#312e32` | hover on surface-2 |
| `text-foreground` | `#f4f2f5` | primary text |
| `text-muted-foreground` | `#a19ea4` | labels, secondary numbers |
| `text-subtle` | `#8a8790` | tertiary (4.6:1 on carbon) |
| `primary` / `accent` / `orchid` | `#C828D6` Vivid Orchid | primary buttons, active pills, accent word, focus |
| `accent-2` / `amethyst` | `#9C30A5` | hover of primary, depth, Averaging phase |
| `up` | `#e070ea` | UP side, ▲ (lighter and pinker than the brand orchid, so chrome never reads as a side) |
| `down` | `#e5604f` | DOWN side, ▼ |
| `up-soft` / `up-soft-hover` | up 16% / 26% mixed into surface (opaque) | Buy UP button, UP pill, active UP selector |
| `down-soft` / `down-soft-hover` | down 16% / 26% into surface (opaque) | Buy DOWN, DOWN pill, destructive |
| `primary-soft` / `primary-soft-hover` | orchid 16% / 26% into surface (opaque) | active dock icon, "You" rows and pills, icon discs, menu focus |
| `primary-disabled` | orchid 32% into carbon (opaque) | disabled primary button |
| `warn-soft` | warn 14% into surface (opaque) | Closed phase pill |
| `wash` | orchid 12% into surface (opaque) | `Panel highlight`, `EmptyState` |
| `warn` | `#e0a64a` | Closed phase, warnings |
| `border` | white 10% | every border (atomic.cash) |
| `border-strong` | white 16% | chart guides, emphasis |

Always pair UP / DOWN colours with ▲ / ▼ or the words UP / DOWN. Profit is not a side: positive profit is `foreground` with a `+`, losses are `down` (use `Profit`). Tints are always the opaque `*-soft` tokens (a colour mixed into a surface with `color-mix`), never `bg-up/15`-style alpha.

Utilities: `num` (tabular numbers, also on by default on body), `bg-accent-wash` (flat `wash` colour for highlight and empty panels), `animate-live` (pulsing dot), `no-scrollbar`.

### Fonts

| Class | Font | When |
|---|---|---|
| `font-heading` | Akt 400/500 | h1-h4 (automatic), big numbers (chance %, totals), market questions |
| `font-sans` (default) | Lexend Deca | body, buttons, inputs |
| `font-secondary` | Manrope | small UI text: pills, badges, table numbers, axis ticks, captions |
| `font-mono` | Ubuntu Mono | addresses and tx hashes only, rarely |

### Layout

- Shell: the shared translucent header and existing floating dock live in `app/layout.tsx`. `<main>` provides the shared top offset described above and existing bottom padding (`--shell-bottom`), with `overflow-x-clip` so sticky content works; pages start directly with content.
- The dock is mobile and tablet navigation only (hidden from 1024 px, where the header nav takes over). Keep primary actions clear of it below 1024 px.
- Containers (`@/components/layout/page`): `PageWide` (1200px, header gutters) for grids and tables; `PageNarrow` (`size="sm"` 575px for trade box and forms, `size="md"` 720px for lists and detail). Everything is centered.
- Headings: `PageHeading` (centered h1, 3xl to 5xl) for section pages; `HeroHeading` + `Accent` (one accent word) for the home hero. Every page hero is centered on the page, above any two-column grid (the market page puts its question, its countdown and the timeline in a full-width row, then the grid). Titles of panels in a column sit inside the panel (`h2 text-xl` in the panel's padding); `SectionHeading` is for centered section titles in a single column.
- Spacing: generous. Panels `p-5 sm:p-6`, grids `gap-5`, sections `space-y-10` or more. Large type.

### Radii and shapes

- `rounded-3xl` (24px): panels, cards, stacked trade card, dialogs. `rounded-4xl` (32px) for a big hero panel.
- `rounded-full`: every button, pill, segmented control, input, badge, the round arrow between stacked sections.
- `rounded-2xl`: menu popovers, list rows inside dialogs, chart tooltip.

### Components

Layout and wallet:

| Import | What |
|---|---|
| `@/components/layout/page` | `PageWide`, `PageNarrow`, `PageHeading`, `HeroHeading`, `Accent`, `SectionHeading` |
| `@/components/layout/panel` | `Panel` (rounded-3xl bordered surface; `highlight` for the orchid wash, `flush` for no padding), `EmptyState` (one line + action) |
| `@/components/layout/logo` | `Logo` (the "Phinary" wordmark, no mark) |
| `@/components/wallet/*` | `ConnectButton`, `BalancePill`, `WalletDialog`, `WrongNetworkBanner` (already in the shell) |
| `@/config/brand` | `BRAND_NAME`, `DISPLAY_TIMEZONE` (UTC, matches token names), `CHAIN` |

Primitives (`@/components/ui/*`, shadcn, themed): `button` (variants `default` orchid, `outline` (surface-2), `secondary`, `ghost` (surface), `up`, `down`, `destructive`, all opaque; sizes `xs sm default lg xl`; `xl` = 56px full-width CTA), `card`, `tabs`, `input`, `badge`, `dialog`, `sheet`, `tooltip`, `separator`, `table`, `skeleton`, `dropdown-menu`, `toggle-group`, `progress`, `slider`, `scroll-area`, `sonner` (`toast` from `sonner`), `chart`.

`@/components/ui/liquid-metal-button`: `LiquidMetalButton` (`label`, `fullWidth`, `disabled`, `onClick`, `type`, `href`). The Trade CTA in the trade box only; every other primary action is `<Button size="xl">`. The shader draws only the rim; the rim backing and the inner surface are flat opaque colours, and disabled swaps both for a muted opaque fill and hides the shader.

Market (`@/components/market`):

| Component | Props |
|---|---|
| `MarketQuestion` | `strike`, `expiry`, `as`, `accentStrike`: "ETH > $2,684.53 at 00:48?" |
| `PhaseBadge` | `phase`: opaque phase pill for table cells only (e.g. an invalid outcome in the feed). Never on, above or beside a heading |
| `Countdown` | `to` (unix s): live `m:ss`, client-only |
| `ProbabilityBar` | `up` (0..1), `labels` |
| `SideMark` | `side`: plain inline "▲ UP" / "▼ DOWN" text in the side colour, the side indicator wherever a logo would go |
| `PriceTag` | `side`, `price?`: "▲ UP 63¢", or just "▲ UP" without a price. The one UP / DOWN pill everywhere (tables, feed, portfolio) |
| `Chance` | `value`, `className` (number size): big "48% ▲ UP" |
| `Money` | `value`, `dimCents`: $1,234 with small muted cents for hero numbers |
| `Profit` | `value`: signed USD, foreground / coral / muted when flat |
| `AssetChip` | `asset` (`{kind:"usdc"}`, `{kind:"shares"}`, `{kind:"outcome", side}`), `title`: the token pill of stacked cards; plain ticker text with no logo; outcome chips lead with a ▲ / ▼. `Balance` (wallet icon + amount) sits beside it |
| `SwapStack` | `top`, `bottom`, `onFlip?` (arrow becomes a spinning button), `flipLabel`: the atomic.cash stacked card, focus ring on the card when its input has focus |
| `SwapOutput` | `chip`, `value` (string or null for the grey 0), `htmlFor`, `label`: the "You receive" half |
| `Sparkline` | `data` (0..1), `domain`, `color`: a line, no fill |
| `ProbabilityChart` | `points` (`usePriceHistory`), `domain` (`[openTime, cutoff]` to show the full life), `height`: a line, no area fill |
| `MarketCard` | `market`, `onBuy?` (defaults to linking `/market/[id]?side=up`). Question first, no phase pill. Live: Buy UP / DOWN and the countdown in the footer row; closed, averaging, settling: countdown row; resolved: winner and a "Settled" average row |
| `AmountInput` | `value` (string), `onChange`, `label`, `adornment`, `quick` (default 1/5/10), `max`: 48px input + pills; the pill matching the value is filled orchid |
| `SegmentedPills` | `options` (`activeClassName` per option, e.g. `bg-up text-white`), `value`, `onChange`, `size` `xs`/`sm`/`md`, `fullWidth`. Radio group with arrow keys and a focus ring |

Also exported: `PHASE_DOT` (status dot classes per phase) from `phase-badge`. Trade (`@/components/trade`): `TradeCard` (swaps to an outcome card with Claim once resolved), `useClaims` (`claimOne`, `claimAll`, switches network first; the only claim hook).

### atomic.cash patterns to reuse

- **Stacked trade card**: always `SwapStack` + `SwapOutput` + `AssetChip`, never a hand-rolled copy. One card, not a card inside a card: selectors (pills, outcome buttons) above it, the summary line and CTA below it.
- **Settings row under a card**: `mt-3 flex justify-between px-1 text-xs text-muted-foreground` with `SegmentedPills size="xs"`.
- **Full-width CTA** under the card: `mt-3`, 56px, rounded-full.
- **Stat tiles**: `Panel`, centered, `font-heading text-2xl` value with the `text-xs text-muted-foreground` label under it (never above: that reads as a kicker), in `grid gap-5 md:grid-cols-3`.
- **Tables**: shadcn `Table` inside `<Panel flush>`; numbers right-aligned in `font-secondary num`; on mobile switch to stacked rows (`rounded-2xl border bg-surface-2 p-3`) with CSS breakpoints (`hidden lg:block` / `lg:hidden`), not JS media queries.
- **Tabs**: `SegmentedPills size="sm"` above the content, not underlined tabs.
- **Empty / connect states**: `EmptyState` (flat orchid-tinted surface) with one line and one pill button.
- **Disabled CTAs**: the label stays readable; the surface switches to an opaque muted fill (`LiquidMetalButton` uses its muted rim and surface, the default `Button` goes `bg-primary-disabled`), never reduced opacity.
- **Error panels**: `rounded-3xl border border-down bg-down-soft text-down text-sm` centered one-liner.

### Data

Pages read data only through `@/lib/data`: `useMarkets(tab?)` (rolling 90-minute window), `useMarket(id)`, `useLiveMarketId(exclude?)`, `useQuote(id)`, `usePriceHistory(id)`, `useMarketTrades(id)`, `useEthPrice()`, `usePortfolio()`, `useActivity(limit?)`, `useLeaderboard(limit?)`, `useVault()`, `useWallet()` (state + `connect`, `disconnect`, `switchNetwork`, `requestTestFunds`, `buy`, `sell`, `claim`, `vaultDeposit`, `vaultWithdraw`). Each returns `{ data, isLoading }` (`useWallet` returns state + actions + `isLoading`). `data` is `undefined` on the server and during hydration: render `Skeleton`s, never clock-dependent values. `useNow()` gives the ticking clock.

Helpers: `@/lib/format` (`formatUsd`, `formatCents`, `formatPercent`, `formatCountdown`, `formatTime`, `shortAddress`, `tokenName`, `tokenTicker`, `formatTokens`, `formatAgo`), `@/lib/phase` (`phaseOf`, `PHASE_LABEL`, `DEADLINE_LABEL`, `tabOf`, `nextDeadline`, `isTradable`, `isResolved`, `payoutPerToken`), `@/lib/trade` (`previewBuy`, `previewSell`), `@/lib/pricing` (Black-Scholes port, `midAt` for what-if). Types in `@/lib/types`.

Mock start states: `?wallet=disconnected`, `?wallet=wrong-network`, `?wallet=empty`.
