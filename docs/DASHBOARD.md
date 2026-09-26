# Phinary dashboard: the prediction-market front end for the PredictionHook

**Status: draft for review, 2026-09-26.** Section 4 (architecture) was presented in chat; the other sections have not been reviewed yet. No dashboard code gets written until you approve this document. After approval, the next step is a step-by-step implementation plan.

The contracts already work without any platform: an UP or DOWN position is a Uniswap v4 swap. Uniswap's app is a swap screen, not a prediction market, though. It has no market list, no probability chart, and no "claim your winnings" button. This dashboard adds that experience on top of the same pools, without changing the contracts.

---

## 1. Goal

**What you decided**
- It is for the hackathon only, but it must feel advanced. The core comes first, then the extras in this order: platformless proofs, price transparency, then social and LP.
- The dashboard is the main demo surface. The Uniswap app fork (`interface/`) gets a short "same tokens, Uniswap's own app" moment as proof.
- Stack: Next.js + wagmi + Ponder.
- Hosting: a public deployment, plus a local fallback that runs the same code on your laptop.
- The UI calls the sides **UP** and **DOWN**.
- New wallets get USDC and gas from a server-side drip funded by a demo wallet.

**What I assumed** (correct me)
- The code goes in new `web/` and `indexer/` folders. `app/` (the current swap page) stays untouched as a backup.
- The contracts do not change. UP is the YES token and DOWN is the NO token; the contract names stay as they are.
- It supports Unichain Sepolia (chain 1301) only.
- The layout is Polymarket-style, but the branding is our own. We do not use Polymarket's name, logo or colours.

**Success looks like this.** On the public link, you connect a wallet, get test USDC in one click, buy UP, and watch the price move. You then sell, or wait for the result and claim. The trade shows up in your portfolio and in the live feed. On the block explorer it is a plain UniversalRouter → PoolManager swap.

---

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Purpose | Hackathon, advanced, built in phases | Your choice |
| Relationship to the Uniswap fork | Dashboard main; fork only as proof | Your choice. The fork only runs on `localhost` (Uniswap's gateway rule), so it cannot be the public face. The real app.uniswap.org cannot route our tokens either: Uniswap Labs' routing servers skip hook-priced, zero-liquidity pools unless they allowlist the hook ([00-SUMMARY.md:235](research/00-SUMMARY.md#L235)). Verified on 2026-09-26 (§12). |
| Stack | Next.js (App Router) + wagmi + RainbowKit + Tailwind; Ponder indexer | Your choice over "grow `app/`". The design below makes sure trading never depends on the indexer. |
| Hosting | Vercel for `web/`; Railway (or similar) for Ponder + Postgres; one-command local fallback | Your choice |
| Faucet | Server drip of Circle test USDC plus a little ETH, rate-limited | The deployed hook uses **Circle's test USDC** (`0x31d0…768F`) as collateral, which we cannot mint. |
| Labels and token names | UP / DOWN in the UI. Tickers are `ETHUP` / `ETHDOWN`. Token names use the compact `ETH > PRICE DATE` form: `ETH > $2684.00 26 Sep 14:31`, meaning the strike, then the deadline's date and time in UTC. Both tokens of a market share the name. The ticker and a generated logo ("▲ 2,684 · 14:31") tell UP and DOWN apart. | Your choice (2026-09-26): `ETHUP` / `ETHDOWN` tickers, with names in the compact style of the current keeper names (`YES ETH>2684.93 22:17:00`). MetaMask's "Add to wallet" rejects symbols longer than 11 characters ([MetaMask/core `TokensController.ts:1044`](https://github.com/MetaMask/core/blob/main/packages/assets-controllers/src/TokensController.ts)), so target and deadline cannot both fit in the symbol. The name and the icon carry them instead, and the token address stays the real identity. |
| Shared code | Reuse `packages/swap-sdk` (quotes, UniversalRouter encoding, revert decoding). Port the tested logic from `app/src` (market phases, formatting, trade steps). | This code is already tested against a local stack. |
| Visual direction | Set with the Impeccable design skill before building the phase 1 UI | Keeps the look deliberate rather than generic |

---

## 3. Ideas and when they land

Every idea below is backed by data the contracts already expose.

| # | Idea | Phase |
|---|---|---|
| 1 | **Markets home:** market cards with UP chance, countdown, volume, mini chart, and one-tap Buy UP / Buy DOWN. Tabs for Live, Upcoming and Resolved. | 1 Core |
| 2 | **Market page:** probability chart, trade box, rules, and your position | 1 Core |
| 3 | **Portfolio:** positions, value, profit, Claim | 1 Core |
| 4 | **Onboarding:** connect, switch network, one-click test funds | 1 Core |
| 10 | **Platformless proofs:** "executed on Uniswap v4" receipts, Add to wallet, Send to a friend, Open in Uniswap | 2 |
| 5 | **"Why this price":** live Black–Scholes inputs, plus a what-if slider | 3 |
| 6 | **ETH chart:** strike line, shaded settlement window, and a running average during the window | 3 |
| 7 | **Resolution proof:** on-chain average against the strike, the result, the settle transaction | 3 |
| 11 | **Live trade feed and leaderboard** | 4 |
| 9 | **LP vault page:** deposit, withdraw, share value, risk per market | 4 |
| 8 | **Strike ladder:** several strikes per expiry; needs a bot change | Deferred |
| 12 | **Presenter mode:** steer ETH's price live with `PriceSteerer` | Deferred |

---

## 4. Architecture

```
web/        Next.js (App Router) + wagmi + RainbowKit + Tailwind
  /                 markets home
  /market/[id]      market page
  /portfolio        positions, claims, history
  /activity         live feed + leaderboard            (phase 4)
  /vault            LP vault                           (phase 4)
  /api/drip         demo wallet → Circle USDC + a little ETH, rate-limited
  /api/token-logo/[address]   generated SVG icon: side, strike and deadline (phase 2)
indexer/    Ponder: hook events, UP/DOWN token Transfers, price snapshots
packages/swap-sdk   (existing) quote + UniversalRouter encoding + revert decoding
deployments/unichain-sepolia.json   single source of addresses for web/ and indexer/
app/        untouched backup swap page
interface/  Uniswap fork, the target of "Open in Uniswap"
```

### The rule: two data paths

Anything you need in order to trade never goes through the indexer.

| Path | Source | Used for |
|---|---|---|
| **Live** | RPC through wagmi/viem | Current prices (`hook.quote`), market status (`marketInfo`), your balances, V4Quoter quotes, the swap, claims, the drip |
| **History** | Ponder | Charts, volume, the feed, the leaderboard, cost basis and profit, trade history |

If Ponder is down or behind, the history panels say "history unavailable" and the market list falls back to `marketCount` + `marketInfo` from the chain. Buying, selling and claiming keep working.

### Worked example: buying UP

1. You open `/market/42`. The big number (UP 62%) comes from `hook.quote(42).midYes` over RPC and refreshes every second. The chart comes from Ponder's snapshots, and the newest RPC point is appended to it.
2. You enter $5 and tap **Buy UP**. The swap-sdk asks the V4Quoter what $5 buys (for example, 7.9 UP at an average 63.3¢).
3. If this is your first trade, you approve USDC for Permit2 (a one-time transaction). Then you sign a Permit2 message, and `UniversalRouter.execute` sends the swap.
4. The transaction lands. Ponder sees the hook's `Trade` event and the UP token's `Transfer` to your wallet, and within about 2 s the trade appears in the feed and in your portfolio with a $5.00 cost.

---

## 5. Pages

### Everywhere
- The header has Markets, Portfolio, Activity and Vault, plus the wallet button (RainbowKit).
- A **wrong network** banner offers a one-click switch to Unichain Sepolia (adding the chain if needed).
- A **USDC balance** chip. With no USDC or no gas, it becomes **Get test funds** (§7).
- An **indexer status** dot: green when synced, amber with "N blocks behind", red when unreachable.
- Light and dark themes.

### Market phases in plain words
The phases come from `app/src/market.ts`. The "closing" phase is split in two so the UI can say what is happening.

| Chain state | Label | What the user can do |
|---|---|---|
| before `openTime` | Opens in 0:12 | Nothing yet |
| `openTime` ≤ now < cutoff | **Live** | Buy and sell |
| cutoff ≤ now < window start | Trading closed | Wait |
| window start ≤ now < `expiry` | **Averaging** (the settlement window) | Wait; phase 3 shows the running average |
| now ≥ `expiry`, not settled | Awaiting settlement | Anyone can press **Settle** |
| Settled | **Resolved UP** / **Resolved DOWN** | Winners claim $1.00 per token |
| Invalid | Invalid, 50/50 | Both sides claim $0.50 |

Demo markets last 2 minutes and a new one opens every minute. Each has about 105 s live, a 2 s closed gap, then a 10 s window. Markets overlap, so one is always live, and one resolves every minute.

### `/` Markets home
- **Hero:** the market that is live now, with a big UP percentage, a countdown bar, and **Buy UP** / **Buy DOWN** buttons (prices are the asks, e.g. "UP 63¢", "DOWN 39¢").
- **Tabs:**
  - *Live*: trading, closed and averaging markets;
  - *Upcoming*;
  - *Resolved*: the latest 20, then "load more".
- **Card:** the question ("ETH above $2,684.00 at 14:31:00?"), the UP chance, the phase chip, the countdown, volume, and a sparkline. A resolved card shows the winner and the settlement average.

### `/market/[id]` Market page
- **Header:** the question, phase chip, countdown, and a timeline bar (open → cutoff → window → expiry).
- **Chart:** UP probability over time. Phase 3 adds a toggle for the ETH price with the strike and window.
- **Trade box:**
  - Buy/Sell tabs and an UP/DOWN toggle showing the current prices.
  - The amount is in USDC for buys and in tokens for sells, with quick buttons ($1, $5, $10, Max).
  - A summary: average price, tokens received, "to win $X", and price impact against the mid.
  - The step list from `app/` (approve → sign → swap), each step with its transaction link.
- **Your position:** tokens held, value at the bid, cost, profit, and Sell or Claim buttons.
- **Rules:** "Resolves UP if the average ETH price from 14:30:50 to 14:31:00 is above $2,684.00. Exactly equal resolves DOWN. The price source is the Uniswap v4 ETH/USDC pool (address). Anyone can settle after 14:31:00. There is no admin override."
- **Trades in this market** (from Ponder).

### `/portfolio`
- **Summary:** portfolio value (positions at the bid plus USDC), unrealised profit, realised profit.
- **Positions table:** market, side, tokens, average cost, current bid, value, profit, and an action (Sell or Claim).
- **Claimable banner:** "You have $15.00 to claim" with **Claim all**. In phase 1 that sends one transaction per market; batching them into a single UniversalRouter transaction is a later nice-to-have.
- **History tab:** trades, claims, and transfers in and out.

### Phase 2 additions: platformless proofs
- **Trade receipts:** "Executed on Uniswap v4 · UniversalRouter → PoolManager → hook · pool 0x1a2b…" with a **View on explorer** link to `sepolia.uniscan.xyz`. This is the platformless proof on the public site, and it works for anyone.
- **Token drawer** for each position:
  - the UP/DOWN token address;
  - **Add to wallet** (`wallet_watchAsset`). It passes the generated logo as `image`, so each ETHUP row in the wallet shows its own "▲ 2,684 · 14:31" icon. The logo comes from `/api/token-logo/[address]`: a green ▲ for UP or a red ▼ for DOWN, the strike, and the deadline, all read from `marketInfo`. It returns 404 for any address the hook did not create. The dashboard's own cards and the portfolio use the same icon.
  - **Send** (a plain ERC-20 transfer, so positions visibly move between wallets);
  - **Open in Uniswap** (local build only), a deep link into the fork with USDC → this token prefilled:
    - The production build never shows it, so the public site can never send a visitor to `localhost` on their own machine.
    - The button exists only when `NEXT_PUBLIC_UNISWAP_FORK_URL` is set, and that variable is set only in the local run, never in the Vercel environment. A test checks that the production build contains no fork link.
    - In the production build the drawer shows the explorer link in its place.

### Phase 3 additions: price transparency
- **"Why this price" panel.** It reads the inputs from `hook.quote(id)`:
  - ETH at the start of the block: `S = K·e^x`;
  - annualised volatility: `σ = √(varE36 × 31,557,600 / 1e36)`;
  - time left: `τ`;
  - the window.

  It then shows how they become the probability: mid = Φ(d), and ask/bid = mid ± spread. A **what-if slider** ("if ETH is $10 higher") recomputes the mid in the browser with a TypeScript port of the pricing formula. A test pins that port to the on-chain `midYes`.
- **ETH chart:** the ETH price with a strike line and the settlement window shaded. During the window it also shows a running average from `oracle.cumulativeAt(windowStart)` and `cumulativeAt(now)`, with a live verdict: "currently resolving UP".
- **Resolution proof:** once settled, it shows the average price from `MarketSettled.avgNormTickTimesWindow`, the strike, the result, who called `settle()`, and the transaction.

### Phase 4 additions: social and LP
- **`/activity`:** a live feed of trades, new markets and settlements ("0x12…ab bought 7.9 UP at 63.3¢"), and a leaderboard by total profit, with volume and win rate.
- **`/vault`:**
  - the vault's value range, idle funds, share value, and your shares;
  - deposit, which needs an ordinary USDC approve to the hook;
  - withdraw, limited to idle funds;
  - a table of risk per market.

  *Worked example:* the vault has $900 idle and one live market with a $100 bucket, 60 UP and 30 DOWN outstanding.
  - If DOWN wins, the market returns 100 − 30 = $70 to the vault. If UP wins, it returns 100 − 60 = $40.
  - So the vault is worth between $940 (`navMinus`) and $970 (`navPlus`).
  - Withdrawals are priced at the safe end, $940.

---

## 6. Indexer (Ponder)

### Sources
- **PredictionHook** from `deployBlock`: `MarketCreated`, `Trade`, `MarketSettled`, `Redeemed`, `Swept`, `Deposit`, `Withdraw`.
- **UP/DOWN tokens**, discovered from `MarketCreated.yes` / `.no` (Ponder's factory pattern): `Transfer`.
- **Block snapshots** every 2 blocks (about 2 s on Unichain):
  - for each market that is live, closed or averaging, read `quote(id)` and `oracle.lnSpotSoBWad()` at that block;
  - every 30 blocks, read `navPlus`, `navMinus`, `totalShares` and `vaultIdle`.

The ETH oracle emits no price events, and prices move without trades (time decay, ETH moves), so the charts need these snapshots.

### Tables

| Table | Key | Contents |
|---|---|---|
| `market` | id | tokens, pool ids, strike, open time, expiry, window, cutoff, status, winner, settlement average, volume, trade count |
| `trade` | tx hash + log index | market, account, side, buy/sell, tokens, USDC, average price, time, tx |
| `position` | account + market + side | tokens, cost basis, realised profit, whether it was received by transfer |
| `transfer` | tx hash + log index | token, from, to, amount, kind (trade, claim, peer) |
| `price_snapshot` | market + block | mid, ask, bid (UP), ETH price, σ, τ |
| `vault_snapshot` | block | navPlus, navMinus, total shares, idle |
| `account_stats` | account | volume, realised profit, markets traded, wins |

### Who traded
The hook's `Trade.sender` is the **router**, not the user. So the account is taken from the UP/DOWN token `Transfer` in the same transaction:
- on a buy, PoolManager → account;
- on a sell or a claim by swap, account → PoolManager.

The `Trade` event supplies the side, the token amount and the USDC amount. If a transaction has no matching transfer (an unusual router path), the indexer falls back to the transaction's sender (`tx.from`). Any other transfer is classified by its counterparty:
- to or from the zero address: `redeem` (a burn);
- between two ordinary accounts: a peer transfer.

### Profit, worked example (average cost)

| Step | Tokens | Cost basis | Realised |
|---|---|---|---|
| Buy 10 UP for $6.20 | 10 | $6.20 (avg 62¢) | 0 |
| Buy 10 UP for $7.00 | 20 | $13.20 (avg 66¢) | 0 |
| Sell 5 UP for $3.50 | 15 | $13.20 − 5 × 66¢ = $9.90 | +$3.50 − $3.30 = **+$0.20** |
| Send 5 UP to a friend | 10 | $9.90 − 5 × 66¢ = $6.60 | 0 (a transfer, not a sale) |
| UP wins; claim 10 | 0 | 0 | +$10.00 − $6.60 = **+$3.40** |

The friend's 5 UP carry no cost and are marked "received". Their value counts in the friend's portfolio, but not in the friend's leaderboard profit.

### API
The web app reads Ponder over its SQL-over-HTTP client (`@ponder/client`) with live queries. If live queries misbehave on the host, it falls back to polling every 2 s.

### Cost of snapshots
Snapshots every 2 blocks from the deploy block mean many RPC reads during backfill. Ponder caches RPC results in its database, so restarts do not refetch. The snapshot start block is an environment setting, so a fresh demo deployment starts close to "now". Ponder uses a keyed RPC (Alchemy or QuickNode for Unichain Sepolia) with the public `sepolia.unichain.org` as a fallback. A probe on 2026-09-26 showed the public RPC returns the hook's full log history in one call at the current size, but its limits under sustained load are unknown.

---

## 7. Test-funds drip

- `POST /api/drip {address}` sends **10 USDC and 0.001 ETH** (both configurable) from a demo wallet whose key lives only in the server environment.
- **Limits:** one drip per address and three per IP address per 12 h, recorded in a `drips` table in the same Postgres as Ponder but outside Ponder's schema. Locally the limits live in memory.
- **Skip rules:** if the address already holds at least 10 USDC and enough gas, there is nothing to send.
- **Kill switch:** `DRIP_ENABLED=false`. `GET /api/drip/status` shows the demo wallet's balances so you know when to top it up from Circle's faucet.
- The page shows the drip transaction and refreshes balances.

---

## 8. Errors and degraded modes

| Situation | What the user sees |
|---|---|
| No wallet | RainbowKit's connect modal |
| Wrong network | Banner with **Switch to Unichain Sepolia** |
| User rejects a signature or transaction | "Cancelled" and the step resets; no scary error |
| Hook revert `MarketClosed` | "Trading has closed for this market" |
| Price band (`Band`) or per-block cap | "That trade is too large right now; try a smaller amount" |
| Price moved beyond slippage | "The price moved; review the new quote" and a fresh quote |
| Quote unavailable (V4Quoter reverts) | Trade button disabled with the decoded reason (`swap-sdk/errors.ts`) |
| Ponder down or behind | Status dot turns amber or red; history panels say "history unavailable"; trading still works |
| Drip limit reached or wallet empty | "Test funds already sent; try again at 15:40" or "Faucet is empty; ask the presenter" |
| Market expired and not settled | **Settle** button (permissionless); the keeper bot normally does it first |

---

## 9. Testing

- **Pure logic, as unit tests:** phases and labels, formatting, trade attribution, the average-cost profit table in §6 (as a test case), vault value, and drip limits. Tests already in `app/test` are ported with the code they cover.
- **Pricing parity:** the TypeScript what-if pricer, fed the on-chain `x`, `varE36`, `τ`, window and sample count, must match `quote().midYes` to within 1e-6 across a sweep of states on the local stack.
- **Indexer integration:** run the local stack (`app/scripts/local-stack.ts`: Anvil, contracts, bots), make scripted trades, sells, a peer transfer and a claim, then check Ponder's tables against the expected positions and profit.
- **End to end:** Playwright against the local stack with a test wallet: drip → buy UP → sell part → wait for settlement → claim, then check the portfolio and the feed.
- **Before the demo:** the same flow by hand on the hosted site on Unichain Sepolia, three times, plus one run with Ponder deliberately stopped to confirm that trading still works.

---

## 10. Hosting and local fallback

| | Hosted | Local fallback |
|---|---|---|
| Web | Vercel (`web/`) | `next dev` or `next start` |
| Indexer | Railway: Ponder + Postgres | Ponder with its embedded database (PGlite) |
| Chain | Unichain Sepolia | Unichain Sepolia (or the Anvil local stack for tests) |
| Start | Push to deploy | One command, e.g. `make web-local` |

Both halves read addresses from `deployments/unichain-sepolia.json`. After a contract redeployment, you update that file and restart, and nothing else changes.

---

## 11. Phases and gates

| Phase | Scope | Gate |
|---|---|---|
| **0 Setup** | `web/` and `indexer/` scaffolds, shared config, swap-sdk import, local one-command start, hosting skeleton, visual direction (Impeccable) | The hosted page loads live markets from RPC and the indexer shows synced |
| **1 Core** | Home, market page, portfolio with claims, onboarding with the drip. Bot: `ETHUP` / `ETHDOWN` tickers and `ETH > PRICE DATE` names (§12). | On the **public link**: drip → buy UP → sell → claim a winner, with the portfolio correct |
| **2 Platformless proofs** | Receipts, token drawer (add to wallet, send, Open in Uniswap) | Demo step works: a token bought in the dashboard is sold in the Uniswap fork |
| **3 Price transparency** | Why-this-price panel with what-if, ETH chart with window and running average, resolution proof | Parity test passes; a judge can see why the price moved |
| **4 Social and LP** | Activity feed, leaderboard, vault page | Deposit and withdraw work; the leaderboard matches Ponder's tables |
| Deferred | Strike ladder, presenter mode, batched Claim all | - |

Each phase is shippable on its own. If time runs out after any phase, the demo still works.

---

## 12. Risks and open questions

- **Time.** Next.js + Ponder is the heaviest of the three options discussed. The phases limit the damage, and `app/` remains a working swap page if the new dashboard is not ready.
- **Test USDC supply.** Circle's faucet hands out small amounts, so the drip wallet should be funded early and topped up before the demo.
- **Indexer backfill and RPC limits.** Start the hosted indexer well before the demo, and use a keyed RPC.
- **The bot needs a small change for UP/DOWN token names.** *(Done 2026-09-26: `bot/src/market.ts`, `bot/src/config.ts`, `script/CreateMarket.s.sol`; live from market #147 or so after the keeper restart.)*
  - Why: [bot/src/market.ts:179-182](../bot/src/market.ts#L179-L182) passes the literal `"YES"` / `"NO"` as `{side}` into the name and symbol templates. One template serves both tokens, so the environment-variable templates alone cannot produce UP/DOWN.
  - Change:
    - pass `"UP"` / `"DOWN"` as the side, and update the `renderTemplate` type and its test;
    - add a `{ticker}` placeholder (`MARKET_TICKER=ETH`, set explicitly because the demo token's own symbol is `dWETH`);
    - add a `{date}` placeholder (`26 Sep`, in `MARKET_TIMEZONE`, which defaults to UTC).
  - Templates:
    - `MARKET_SYMBOL_TEMPLATE={ticker}{side}` gives `ETHUP` / `ETHDOWN` (7 characters at most).
    - `MARKET_NAME_TEMPLATE={ticker} > ${strike} {date} {hhmm}` gives `ETH > $2684.00 26 Sep 14:31`. `{strike}` renders two decimals with no thousands separator. The name template has no `{side}`, so both tokens of a market get the same name.
  - Also update [CreateMarket.s.sol:78-81](../script/CreateMarket.s.sol#L78-L81), which hardcodes `"YES-"`, to the same scheme.
  - Existing tokens keep their names. Markets last 2 minutes and a new one opens every minute, so every live market has the new names within two minutes of restarting the bot.
  - The dashboard shows UP/DOWN either way. The change is for wallets, the explorer and the Uniswap fork.
- **The official Uniswap app does not route our tokens (verified 2026-09-26).**
  - How: app.uniswap.org in testnet mode on Unichain Sepolia, in headless Chrome with no wallet, asked to swap 1 USDC for the UP token of a live market.
  - Result: its Trading API answered every request with 404 `NoRouteFoundError: No route with sufficient liquidity was found for this pair`. That covered the app's own requests (V4, V4+V3+V2, the default routing) and the same quote replayed with `V4_HOOKS_ONLY`. The Buy box stayed at 0.
  - Control, at the same moments: Uniswap's own V4Quoter quoted the same trade on-chain every time (11 of 11; 1 USDC → 1.46–1.88 UP).
  - Setup check: the same session and page quoted ETH → USDC normally (0.001 ETH → 30.04 USDC through a v3 pool).
  - Coverage: two independent live markets (131 and 135). A third market (134) was excluded because its UP price was 1–2¢, below the tradable band, so it could not quote on-chain either.
  - Conclusion: the pools work, and Uniswap's router does not consider them. That fits the allowlist rule for zero-liquidity, hook-priced pools (the API does not say why).
  - Evidence: [research/interface-fork/official-app-check/](research/interface-fork/official-app-check/), which holds the probe script, the raw results and two screenshots.
- **Open:** which host for Ponder (Railway, Render or Fly); the exact drip amounts; whether the Uniswap fork deep-link format for chain 1301 needs a query flag (to be checked in phase 2).
