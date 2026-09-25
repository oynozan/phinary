# Recommendation: demoing PredictionHook swaps in a fork of the Uniswap web app

Date: 2026-09-26. Demo in about 3 days.
Based on the four reports in this folder:
- `local-run.md`: getting the app to run;
- `swap-data-path.md`: how a swap flows through the app;
- `unichain-sepolia.md`: contracts and faucets on chain 1301;
- `review.md`: an adversarial check of the other three.

Interface clone: `Uniswap/interface` at commit `9023421` (2026-09-23), at
`/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/repos/uniswap-interface` (called `$REPO` below).
I re-checked the key line references against that clone today: `TradingApiClient.ts:182-188`, `WebUniswapContext.tsx:281-290`,
`routing.ts:211-216` and `urls.ts:299` all match. I also re-computed the example prices.

---

## The question

> "If we fork the Uniswap web app, change the network, put our own pools in it and call swap, would that work?"

## 1. Verdict: yes, with changes. Not as described.

**What does not work.** Changing the network, adding the pools and pressing Swap will **not** work on its own. The reason is simple.
- The Uniswap web app does not build swaps itself.
- For every quote it asks Uniswap's servers (the Trading API) three things: "what is the price?", "what approval is needed?" and "give me the transaction to sign".
- The app then signs whatever transaction the server returns (`steps/swap.ts:36-49`, `evmSwapRepository.ts:34-47`).
- Uniswap's servers do not know our pools. Pools with zero liquidity and custom hook pricing are skipped by their router unless Uniswap Labs allowlists them.
- For a pair they cannot route on 1301, the server answers `404 NoRouteFoundError` (seen live in `local-run.md` §4). The app then shows "no route", and the Swap button never turns on.

**What does work.** The app sends all of those server calls through **one object**, the `TradingApiClient` singleton
(`packages/uniswap/src/data/apiClients/tradingApi/TradingApiClient.ts:182-188`).
- If we wrap that object, our code can answer for YES/NO tokens on chain 1301.
- It prices the trade with the official V4Quoter and builds the UniversalRouter transaction itself.
- The rest of the app accepts our answers because they have the same shape as Uniswap's.
- Everything else (normal tokens, balances, the wallet flow) keeps working unchanged.

**Proven so far:**
- the app runs locally, and quotes on Unichain Sepolia work;
- all the code paths were traced;
- the transaction encoding was checked against the SDKs the app already installs;
- the contract addresses were checked on-chain.

**Not proven yet (UNVERIFIED):**
- An end-to-end swap in the fork. Nothing is deployed on 1301 yet, and no wallet has signed anything in the fork.
- Everything the hook does on-chain.

## 2. The approach: Strategy B, a patched service layer

### Why B and not A

| | A: mock Trading API server (`TRADING_API_URL_OVERRIDE=http://localhost:8787`) | **B: wrap the `TradingApiClient` in the page** |
|---|---|---|
| Our pairs | Work | Work |
| Normal pairs (for example ETH→USDC) | **Break** without a real Trading API key. The browser session cookie belongs to `*.uniswap.org`, so a proxy on `localhost:8787` gets 401 | Unchanged. They still use Uniswap's API and the session |
| Extra moving parts | A second process, plus CORS, CSP (`apps/web/public/dev-csp.json`) and cookie handling | None. Our pairs never leave the page, except for JSON-RPC calls |
| Effort | 12–14 h | 11–13 h, plus about 4 h of hardening from `review.md` |

Option A2, the same-origin `/entry-gateway` proxy, might fix the cookie problem. Whether the Vite proxy or the Cloudflare dev worker wins
on `/entry-gateway/*` is **UNVERIFIED**, so it is not worth betting the demo on.

### What to change, file by file (paths relative to `$REPO`)

**To make the fork run at all** (already done in the scratch clone; see `local-run.md` §2–3):

| File | Change |
|---|---|
| `package.json` | Remove `"tools/uniswap-nx"` from `workspaces` |
| `nx.json` (`sync` block) | `"globalGenerators": []`, `"disabledTaskSyncGenerators": ["@universe/uniswap-nx:tsconfig-sync"]` |
| `tsconfig.json` | Drop the `references` to folders that do not exist in the public mirror (`tools/uniswap-nx`, `apps/cli`, `packages/transactional`, `apps/dev-portal`, `apps/mission-control`) |
| `apps/web/.env.override` (new) | `WALLETCONNECT_PROJECT_ID="walletconnect_project_id"`, `PRIVY_APP_ID=""`, `PRIVY_CLIENT_ID=""` |
| Run command | `SKIP_CONFIG_PULL=true bun web dev`, then open **`http://localhost:3000`**. Use `localhost`, not `127.0.0.1`: Uniswap's gateway rejects every other origin |

**To make our pools swappable** (Strategy B, `swap-data-path.md` §4.4 plus fixes from `review.md` §B):

| # | File | Change | Size |
|---|---|---|---|
| 1 | NEW `packages/uniswap/src/features/predictionMarkets/config.ts` | Chain 1301, token and pool addresses, contract addresses (table below), RPC `https://unichain-sepolia.drpc.org` (already allowed by the app's CSP) | ~40 LOC |
| 2 | NEW `packages/uniswap/src/features/predictionMarkets/predictionTradingApi.ts` | `withPredictionMarketOverrides(base)`, which overrides `fetchQuote`, **`fetchIndicativeQuote`** (it must be overridden separately), `fetchCheckApproval`, `fetchSwap`, `fetchSwaps` (confirmation from receipts) and `fetchCheckPermissions`. It calls V4Quoter with `eth_call`, reads the Permit2 and ERC20 allowances, and encodes `UR.execute(0x0a10 or 0x10, …)` with `V4Planner` (`URVersion.V2_0`). Response shapes are in `swap-data-path.md` §4.2 | ~300 LOC |
| 3 | EDIT `TradingApiClient.ts:182-188` | `export const TradingApiClient = withPredictionMarketOverrides(createTradingApiClient({...}))` | ~5 LOC |
| 4 | EDIT `packages/uniswap/src/constants/routing.ts:211-216` | Add USDC, YES and NO to `COMMON_BASES[UnichainSepolia]`. Tokens then load without a server lookup and without "spam" warnings | ~5 LOC |
| 5 | EDIT `apps/web/src/app/WebUniswapContext.tsx:285-289` | `getCanBatchTransactions` returns `false` for chain 1301. Otherwise the app may skip the approval check and call `/swap_5792` | 1 LOC |
| 6 | EDIT `packages/uniswap/src/features/providers/resolveRpcConfig.web.ts` and `features/chains/evm/info/unichain.ts:125-127` | Point chain 1301's Public RPC at drpc instead of Uniswap's UniRPC. Otherwise balances and confirmation polling depend on Uniswap's dev gateway session. Whether this alone is enough is **UNVERIFIED** | ~5 LOC |
| 7 | Inside #2 | On failure, throw `FetchError` from `@universe/api` with status 404 and `errorCode: 'ResourceNotFound'` (shows "No routes found") or `'QuoteAmountTooLowError'` (shows "Enter a larger amount"). Never use status 412–429, which show a rate-limit warning | — |
| 8 | Inside #2 | Refuse, with a loud log, if a quote request has `generatePermitAsTransaction: true`. Run `eth_estimateGas` in `fetchSwap` and throw on revert, so a failing swap never shows "success" first | — |
| 9 | Optional: `components/TokenSelector/lists/TokenSelectorSwapList.tsx`; `features/settings/slice.ts:32` | A "Prediction markets" section in the token picker; testnet mode on by default | ~15 LOC |

**Contracts to hard-code (chain 1301, "Stack A", verified on-chain in `unichain-sepolia.md`):**

| Contract | Address |
|---|---|
| PoolManager | `0x00b036b58a818b1bc34d502d3fe730db729e62ac` |
| V4Quoter | `0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472` |
| UniversalRouter 2.0 (5-field swap struct) | `0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| USDC (Circle, 6 decimals) | `0x31d0220469e10c4E71834a79b1f276d740d3768F` |
| **Never use:** UR 2.1.1 | `0x8B844f885672f333Bc0042cB669255f93a4C1E6b`. It points at a different PoolManager. Ignore the app's `x-universal-router-version` header |

**Requirements on the hook** that both the fork and a custom page need:
- The hook must not call `msgSender()` unguarded. The deployed V4Quoter does not implement it, so every quote would revert.
- The hook must fill the whole amount, or V4Quoter reports `NotEnoughLiquidity`.
- **Pick a demo market whose trading cutoff is after the demo.** The spec's cutoff is `T − w − 5 min` with w = 4 h. The market used in the earlier reports ("ETH ≥ $4,000 at 2026-09-29 16:00 UTC") would stop trading at about 11:55 UTC on 2026-09-29, possibly before the demo. That is why the example below uses a market that expires on 2026-10-02.

## 3. Effort and what could go wrong live

### Hours (fork path)

| Item | Hours |
|---|---|
| Run the stock fork locally (patches already exist) | 0.5–1 |
| Strategy B override, token patch, hardening items 5–8 | 13–17 |
| Deploy hook, YES/NO tokens and pools on 1301; seed USDC | 3–5 |
| **Total** | **about 17–23 h**, on top of finishing the hook itself |

It fits in 3 days only if the hook is deployed on 1301 early. The fork cannot be tested end to end before that.

### Live-demo risks, most likely first

| Risk | What the audience sees | Prevention |
|---|---|---|
| Uniswap's dev gateway or bot check (Turnstile/Hashcash) misbehaves on venue Wi-Fi | Blank balances, and the approval step spins forever | Item 6 (own RPC); test with the gateway blocked in DevTools; tether to a phone as backup |
| Wallet is a MetaMask **smart account** | Batching or permit-as-transaction paths our override does not implement | Use a fresh plain EOA; items 5 and 8 |
| Price moves between quote and click (1 s blocks, per-block impact) | An "Accept new price" prompt, or a slippage revert | Small trades (5–10 USDC), 1–2% custom slippage |
| Presenter types into "You receive" | Exact-output path | Implement it, or return a clean error; rehearse exact-input only |
| Swap reverts on-chain | The app shows "success", then a failed Activity row | Gas estimate in `fetchSwap` (item 8) |
| Wallet disconnects or tab is hidden | Testnet mode switches off and deep links fall back to mainnet; block polling pauses | Never disconnect on stage; keep the tab in front |
| Faucet limits (20 USDC per 2 h per address) | Not enough USDC for trades or for the hook's collateral | Start collecting from several addresses today |
| First page load | 30–40 s of Vite warm-up | Open and warm the app before going on stage |
| Visual gaps | Letter icons for YES/NO, no $ values, no price chart; testnet mode hides the rate row | Accept them, or add `logoUrl` in the token entries |

## 4. Fork vs a small custom swap page

A custom page talks to the same contracts directly:
- `V4Quoter.quoteExactInputSingle` to get a price;
- `USDC.approve(Permit2)` and `Permit2.approve(USDC, UR, …)` once each (plain transactions, so no EIP-712 signing is needed);
- `UniversalRouter.execute(0x10, [V4_SWAP(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL)])` to swap.

| | Uniswap web app fork (Strategy B) | Custom page (viem + injected wallet) |
|---|---|---|
| Effort | 17–23 h | 1–2 h for a bare script with `cast`; **6–9 h** for a clean page with market info and redeem |
| Depends on Uniswap's servers during the demo | Yes: session, bot check, flags, Data API for other tokens | No. Only the chain RPC |
| Main risks | Many hidden app paths (batching, permits, flags, confirmation polling) | Only our own bugs |
| What judges see | "It's the real Uniswap app. Our market trades like any token." A strong composability story | A purpose-built market: probability, strike, countdown, ETH price, **redeem** |
| Can it show settlement and redemption? | **No.** Redemption is not a swap, so we need our own page anyway | Yes |
| Honesty caveat | It runs only on `localhost` with a patched API client. Production Uniswap would need Uniswap Labs to allowlist the pools, and we must say so. Keep it local, because it carries Uniswap branding | None |

Most of the work is shared. The code that quotes through V4Quoter and encodes the UniversalRouter call is the core of
`predictionTradingApi.ts` (#2 above). Build it once as a plain TypeScript/viem module, and the custom page and the fork both use it.

## 5. Recommendation: a hybrid, with the page first

1. **Today (day 1): chain first.** Deploy the hook, YES/NO tokens and pools on 1301 (Stack A). Seed USDC. Prove one buy and one sell with a
   `cast` script against UR 2.0. **Go/no-go:** if this is not working by tonight, drop the fork entirely.
2. **Day 2: insurance.** Write the shared quote-and-encode module. Build the custom page on top of it: buy/sell YES and NO, live
   probability, countdown and redeem. Rehearse. This alone is a complete, safe demo.
3. **Day 3: the fork as the headline.** Port the module into Strategy B (items 1–8), plus about 4 h of end-to-end testing with MetaMask.
   **Checkpoint at midday:** a first-time buy (approve, sign, swap) must succeed in the fork. If not, stop and demo the custom page.
4. **Demo day:** open with the fork ("our market inside Uniswap's own app"). Switch to the custom page for market details and
   redemption. Show the transaction on `https://sepolia.uniscan.xyz` so judges see the v4 `Swap` event from the official PoolManager.
   Keep a screen recording of a successful run as the last fallback.

If the hook slips by a day, skip the fork. The custom page plus the explorer trace still shows the real claim: a v4 hook that prices every swap itself.

---

## Worked example: Alice buys YES, Bob buys NO, Alice sells, the market settles

The market expires after the demo on purpose (see the cutoff note in §2). These are realistic but **illustrative** numbers:
- prices use plain Black–Scholes `N(d2)` with a ±1¢ spread;
- the real hook adds a geometric-Asian correction, per-block impact, caps and a price band.

This is the fork (Strategy B) on Unichain Sepolia. The custom page makes the same contract calls with a simpler UI.

**The market.** "Will ETH be ≥ $4,000 at 2026-10-02 16:00 UTC?"
- There are two tokens. Each **YES** pays 1 USDC if the answer is yes; each **NO** pays 1 USDC if it is no.
- So YES + NO is always worth 1 USDC, and the YES price reads as a probability.
- ETH's price S comes from our own ETH/USDC v4 pool, which has an oracle-only hook.
- On testnet we seeded that pool's price ourselves, because testnet prices are arbitrary. The stock testnet pool quoted about $30,000 per ETH.

**Day 0 (2026-09-29, demo day). S = $3,850, volatility 60%, 3 days left.**
- d2 = −0.730, so the fair YES price is **0.2327** (a 23% chance) and the fair NO price is 0.7673.
- The hook sells YES at 0.2427 and buys YES back at 0.2227.

### 1. Setup (once)
- Alice gets 0.05 ETH for gas (Superchain faucet) and 20 USDC (faucet.circle.com).
- She opens `http://localhost:3000`, connects MetaMask (a plain account, not a smart account) and turns on **Testnet mode**.
- She opens `/swap?chain=unichain_sepolia&inputCurrency=0x31d0…768F&outputCurrency=<YES>`.
- USDC and YES appear with no spam warning, because we added them to `COMMON_BASES`. Her balance shows **20 USDC**.

### 2. Alice types "10" in "You pay"
- **What she sees:** "You receive **41.20 YES**", minimum received 40.79 at 1% slippage, route "V4 · USDC → YES".
- **Behind the scenes:**
  1. The app calls `TradingApiClient.fetchQuote`. Our wrapper sees YES on chain 1301, so it does not call Uniswap's server.
  2. It makes an `eth_call` to V4Quoter: `quoteExactInputSingle(pool {USDC, YES, fee 0, hook PredictionHook}, 10 USDC)`.
  3. Inside that simulation, PoolManager calls `PredictionHook.beforeSwap`. The hook prices 10 USDC at 0.2427 and returns "+10 USDC in, −41.203131 YES out".
     It also returns `amountToSwap = 0`, so Uniswap's normal AMM curve (empty anyway) is skipped.
  4. The wrapper checks allowances. Alice has never approved USDC, so it asks for an approval and a signature.

### 3. Alice clicks Review, then Swap. There are three wallet popups the first time.
1. **Approve USDC for Permit2.** A normal transaction. Our `fetchSwaps` override reads the receipt and marks it confirmed in about 1–2 s.
2. **Sign a permit.** Gas-free. It lets UniversalRouter 2.0 spend her USDC through Permit2 for 30 days.
3. **Swap.** Our `fetchSwap` builds `UniversalRouter.execute(PERMIT2_PERMIT, V4_SWAP[swap, SETTLE_ALL 10 USDC, TAKE_ALL ≥ 40.79 YES])`, checks it with a gas estimate, and hands it to the wallet.

**On-chain, in one 1-second block:**
- the router opens a PoolManager session;
- the hook checks the cutoff, caps and price band, then prices the trade;
- 10 USDC moves from Alice into the PoolManager;
- **41.20 YES** go to Alice;
- the hook keeps the 10 USDC as collateral for this market.

**Alice now has 10 USDC and 41.20 YES.** Her next buy needs only **one** popup, because both approvals are in place.

### 4. Bob buys NO
- Bob thinks ETH will stay below $4,000. He pays 10 USDC for NO at 0.7773 and gets **12.87 NO**.
- It is the same flow on the {NO, USDC} pool.
- The market now holds 20 USDC from traders.
- 41.20 YES and 12.87 NO are outstanding. If YES wins, the market owes 41.20 USDC.
- The difference is covered by liquidity-provider capital deposited when the market was created, capped per market.
  This is the "complete sets" rule: the market must always hold at least max(YES outstanding, NO outstanding) in USDC. The exact accounting is design-dependent.

### 5. Day 1 (2026-09-30). ETH rises to $3,950, 2 days left.
- d2 = −0.305, so the fair YES price is now **0.38** (38%). The hook buys YES at 0.37.
- Alice flips the tokens and sells **20 YES**. She approves YES and signs once (first sale of YES), then swaps.
- She receives **7.40 USDC**. She has taken back 7.40 of her 10 USDC and still holds **21.20 YES**.
- If she had waited too long: after the cutoff (4 h 5 min before expiry) the hook reverts every swap, and the app shows "No routes found".

### 6. Settlement, after 2026-10-02 16:00 UTC
- The outcome is decided from ETH's average (geometric TWAP) price over the last 4 hours, not a single price, so it is hard to manipulate.
- **If ETH ≥ $4,000:** Alice redeems 21.20 YES for **21.20 USDC**. In total she paid 10 USDC, took out 28.60 USDC, and made +18.60. Bob's NO is worth 0.
- **If not:** Alice's YES is worth 0, and she is down 2.60 USDC net. Bob redeems 12.87 NO for 12.87 USDC.
- **Redemption happens on our own page** (a contract call), not in the Uniswap app. That is one more reason to build the custom page.

### What still depends on Uniswap's servers in this flow
- **The browser session and bot check.** The fork needs them to load at all.
- **UniRPC.** Balances and confirmation polling go through it, unless item 6 is done.
- **Token data and prices for tokens that are not ours.** For example ETH→USDC swaps.

Nothing in the YES/NO swap itself goes through Uniswap's servers.

---

## UNVERIFIED (carry into testing)
- A full end-to-end swap in the fork with a real wallet. No `/swap` or `/check_approval` call has been exercised.
- All on-chain hook behaviour. Nothing is deployed on 1301 yet.
- Live values of the `batched_swaps`, `force_permit_transactions`, `enable_permit2_mismatch_ux` and `use_ur_version_2.1.1` flags on localhost.
- Whether item 6 fully removes the UniRPC dependency.
- Whether the bot check stays invisible on the venue network.
- drpc free-tier rate limits under quote polling.
- Whether faucet.circle.com currently lists Unichain Sepolia.
