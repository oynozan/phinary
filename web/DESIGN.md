# Design system

The look follows atomic.cash (floating pill header, magnifying dock, big centered hero, rounded-3xl panels, pill controls, noise overlay), re-tinted orchid on carbon. Dark theme only.

## Hard rules

- **No gradients anywhere.** No `linear-` / `radial-` / `conic-gradient` in CSS or inline styles, no Tailwind `bg-linear-*` / `bg-gradient-*` / `from-` / `via-` / `to-`, no SVG `<linearGradient>` / `<radialGradient>`, no gradient chart fills, masks or text. Flat solid colours only. Charts are a line, no area fill.
- **Buttons are solid.** Every button, pill button, segmented / tab item, dock icon, menu trigger and the LiquidMetal Trade button has an opaque fill. No `bg-x/NN` alpha fills, no transparent ghost fills, no `backdrop-blur`, no `opacity-*` on a button surface. Tinted buttons use the opaque tint tokens (`bg-up-soft`, `bg-primary-soft`, ...). Outline buttons sit on `bg-surface-2`. Disabled is an opaque muted fill (`bg-primary-disabled` for primary, `bg-surface-2` + `text-subtle` for the rest), never reduced opacity.
- **No labels on or above headings.** No status pill, eyebrow, kicker, overline or tag above, on or attached to a heading or market question. Status is the countdown itself (a live market shows its countdown), disabled / closed actions, or the value in a result line ("Resolved ▲ UP", "Settled $2,696.45").
- **No mock logos.** The header shows the plain "Phinary" wordmark in Akt, no mark. The favicon is a solid orchid "P" on carbon. No generated token discs: where a side needs an indicator use plain inline "▲ UP" / "▼ DOWN" text in the side colour (`SideMark`).

## Copy rules

- No em dashes anywhere (UI, code, comments, docs). Avoid en dashes in UI copy. Use a hyphen, colon or comma.
- No eyebrow / kicker / overline text or status pill above, on or beside headings. Headings stand alone.
- Minimal: numbers and actions. No helper paragraphs, no explanatory labels, no marketing copy. Empty states are one line plus at most one button.
- Sides are always **UP** / **DOWN** (never YES / NO). Prices as cents (`63¢`) or chance (`62%`). Tickers `ETHUP` / `ETHDOWN`.

## Tokens (`src/app/globals.css`)

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

## Fonts

| Class | Font | When |
|---|---|---|
| `font-heading` | Akt 400/500 | h1-h4 (automatic), big numbers (chance %, totals), market questions |
| `font-sans` (default) | Lexend Deca | body, buttons, inputs |
| `font-secondary` | Manrope | small UI text: pills, badges, table numbers, axis ticks, captions |
| `font-mono` | Ubuntu Mono | addresses and tx hashes only, rarely |

## Layout

- Shell: fixed pill header (top, opaque `bg-surface`) and floating dock (bottom, opaque `bg-surface`, icons on `bg-surface-2`) live in `app/layout.tsx`. `<main>` already pads for both (`--shell-top`, `--shell-bottom`) and uses `overflow-x-clip`, so `sticky` works on every page; pages start directly with content.
- Keep the primary action above the fold at 1440x900 and clear of the dock (the dock spans roughly x 568-872 there).
- Containers (`@/components/layout/page`): `PageWide` (1200px, header gutters) for grids and tables; `PageNarrow` (`size="sm"` 575px for trade box and forms, `size="md"` 720px for lists and detail). Everything is centered.
- Headings: `PageHeading` (centered h1, 3xl to 5xl) for section pages; `HeroHeading` + `Accent` (one accent word) for the home hero. Every page hero is centered on the page, above any two-column grid (the market page puts its question, its countdown and the timeline in a full-width row, then the grid). Titles of panels in a column sit inside the panel (`h2 text-xl` in the panel's padding); `SectionHeading` is for centered section titles in a single column.
- Spacing: generous. Panels `p-5 sm:p-6`, grids `gap-5`, sections `space-y-10` or more. Large type.

## Radii and shapes

- `rounded-3xl` (24px): panels, cards, stacked trade card, dialogs. `rounded-4xl` (32px) for a big hero panel.
- `rounded-full`: every button, pill, segmented control, input, badge, the round arrow between stacked sections.
- `rounded-2xl`: menu popovers, list rows inside dialogs, chart tooltip.

## Components

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

## atomic.cash patterns to reuse

- **Stacked trade card**: always `SwapStack` + `SwapOutput` + `AssetChip`, never a hand-rolled copy. One card, not a card inside a card: selectors (pills, outcome buttons) above it, the summary line and CTA below it.
- **Settings row under a card**: `mt-3 flex justify-between px-1 text-xs text-muted-foreground` with `SegmentedPills size="xs"`.
- **Full-width CTA** under the card: `mt-3`, 56px, rounded-full.
- **Stat tiles**: `Panel`, centered, `font-heading text-2xl` value with the `text-xs text-muted-foreground` label under it (never above: that reads as a kicker), in `grid gap-5 md:grid-cols-3`.
- **Tables**: shadcn `Table` inside `<Panel flush>`; numbers right-aligned in `font-secondary num`; on mobile switch to stacked rows (`rounded-2xl border bg-surface-2 p-3`) with CSS breakpoints (`hidden lg:block` / `lg:hidden`), not JS media queries.
- **Tabs**: `SegmentedPills size="sm"` above the content, not underlined tabs.
- **Empty / connect states**: `EmptyState` (flat orchid-tinted surface) with one line and one pill button.
- **Disabled CTAs**: the label stays readable; the surface switches to an opaque muted fill (`LiquidMetalButton` uses its muted rim and surface, the default `Button` goes `bg-primary-disabled`), never reduced opacity.
- **Error panels**: `rounded-3xl border border-down bg-down-soft text-down text-sm` centered one-liner.

## Data

Pages read data only through `@/lib/data`: `useMarkets(tab?)` (rolling 90-minute window), `useMarket(id)`, `useLiveMarketId(exclude?)`, `useQuote(id)`, `usePriceHistory(id)`, `useMarketTrades(id)`, `useEthPrice()`, `usePortfolio()`, `useActivity(limit?)`, `useLeaderboard(limit?)`, `useVault()`, `useWallet()` (state + `connect`, `disconnect`, `switchNetwork`, `requestTestFunds`, `buy`, `sell`, `claim`, `vaultDeposit`, `vaultWithdraw`). Each returns `{ data, isLoading }` (`useWallet` returns state + actions + `isLoading`). `data` is `undefined` on the server and during hydration: render `Skeleton`s, never clock-dependent values. `useNow()` gives the ticking clock.

Helpers: `@/lib/format` (`formatUsd`, `formatCents`, `formatPercent`, `formatCountdown`, `formatTime`, `shortAddress`, `tokenName`, `tokenTicker`, `formatTokens`, `formatAgo`), `@/lib/phase` (`phaseOf`, `PHASE_LABEL`, `DEADLINE_LABEL`, `tabOf`, `nextDeadline`, `isTradable`, `isResolved`, `payoutPerToken`), `@/lib/trade` (`previewBuy`, `previewSell`), `@/lib/pricing` (Black-Scholes port, `midAt` for what-if). Types in `@/lib/types`.

Mock start states: `?wallet=disconnected`, `?wallet=wrong-network`, `?wallet=empty`.
