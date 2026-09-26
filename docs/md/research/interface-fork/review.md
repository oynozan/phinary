# Adversarial review: forking the Uniswap web app to swap through PredictionHook pools on Unichain Sepolia

Reviewed 2026-09-26 against the same clone as the sibling reports:
`/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/repos/uniswap-interface`
(commit `9023421`; `$REPO` below). Inputs: `swap-data-path.md`, `local-run.md`, `unichain-sepolia.md`.
Everything below was re-read in source or re-probed on-chain unless marked **UNVERIFIED**.

## Verdict

The plan holds up. The core claims were re-checked and are correct:
- calldata comes from the API, not the browser;
- there is one choke point, the `TradingApiClient` singleton;
- the UI contract is small;
- the UR 2.1.1 address on 1301 points at the wrong PoolManager.

**Strategy B, an in-page override of the singleton, is the right choice.** But the sibling reports miss or understate **six things that can break a live demo**. All six are cheap to fix (items 1-6 below). The effort estimate is roughly right for the fork alone. The fork also sits on top of hook and contract work that is not deployed yet, so plan a go/no-go checkpoint and a fallback path.

---

## A. Claims re-verified (all hold)

| Claim | Evidence re-checked | Result |
|---|---|---|
| Calldata is built by the server; the app signs `swap.{to,data,value,gasLimit}` as returned | `steps/swap.ts:36-49` (async step calls `fetchSwap` and then `validateTransactionRequest(swap)`); `evmSwapRepository.ts:34-47` (`transactions: [response.swap]`); `utils.ts:282-295` in the web sagas (`signer.sendTransaction(step.txRequest)`) | Confirmed |
| One singleton; wrapping it is enough | `TradingApiClient.ts:182-188`. The only other `createTradingApiClient(` call is `TradingApiSessionClient.ts:57` (plan endpoints, unused). `repositories.ts:22-28` reads `TradingApiClient.fetchQuote` and `.fetchIndicativeQuote` at call time. The client object is closures only (`createTradingApiClient.ts:484-508`, 0 uses of `this.`), so `{...base, fetchQuote: ours}` is safe | Confirmed |
| `fetchIndicativeQuote` must be overridden separately | `createTradingApiClient.ts:212-217` calls the internal `fetchQuote` closure, not the exported one | Confirmed |
| `/swaps` finalizes approvals, and the saga blocks on it | `transactions.ts:153-220` (every non-LP tx on 1301 goes to `TradingApiClient.fetchSwaps`; only SUCCESS/FAILED/EXPIRED finalize); `utils.ts:505-523` in the web sagas (`waitForTransaction` loops on `finalizeTransaction`). The e2e fixture forces `status:'SUCCESS'` for anvil txs (`playwright/fixtures/tradingApi.ts:164-215`), which shows the real `/swaps` cannot be relied on for foreign txs | Confirmed |
| Missing `gasFee` disables the button | `mergeGasFeeResults` (`swap/utils/gas.ts:25-37`) returns `value: undefined` if any part is missing. `useTokenApprovalInfo.ts:191` uses `data?.gasFee` when an approval is needed. `validateSwapTxContext.ts:51-54` returns undefined without a gas fee | Confirmed |
| COMMON_BASES entries have no token warning | `buildPartialCurrencyInfo` (`constants/routing.ts:290-304`) sets `TokenList.Default` + `ProtectionResult.Benign`, so `getTokenProtectionWarning` gives `None` (`safetyUtils.ts:71-116`). `useCurrencyInfo.ts:51-65` checks `getCommonBase` before the Data API result | Confirmed. Note `routing.ts:214` has `// TODO(WEB-5160): re-add usdc sepolia`: USDC was removed from 1301 on purpose |
| Web permit flow is Approve, then Sign, then Swap, with deferred `/swap` | `evmSwapInstructionsService.ts:76-92` (legacy service: `signatureMissing` returns `unsignedPermit`); `generateSwapTransactionSteps.ts:93-101` | Confirmed |
| UR 2.0 is on Stack A and UR 2.1.1 is on Stack B | Live `poolManager()` over drpc today: UR `0xf70536…` returns `0x00b036…62ac`; UR 2.1.1 `0x8B844f…` returns `0x9cb26a…6c95`; V4Quoter `0x56dcd4…` returns `0x00b036…`. SDK `universal-router-sdk` `constants.js:357-369` maps V2_0 to `0xf705…` and V2_1_1 to `0x8B84…`; `v4-sdk` `V4Planner.addAction(..., urVersion = URVersion.V2_0)` | Confirmed |
| The V4Quoter has no `msgSender()` | `eth_call msgSender()` (`0xd737d0c7`): V4Quoter `0x56dcd4…` reverts; UR 2.0 returns `0x0` | Confirmed. The hook must not call `msgSender()` unguarded, or quoting breaks |
| drpc works from the page | `csp.json` `connectSrc` has `https://*.drpc.org/`. 25 parallel `eth_blockNumber` calls all returned 200. The response carries `access-control-allow-origin: *` | Confirmed (free-tier limits under sustained polling are still **UNVERIFIED**) |
| Route hops are display-only | `uniswapRoutingProvider.ts:134-170`. But `parseRouteHop` **throws** `'Missing token data in route hop'` if `tokenIn/tokenOut.address` or `chainId` is missing (lines 59-63). So either send complete hops or omit `route` | Confirmed, with that caveat |

---

## B. Gaps that can break the live demo (fix before the demo)

### 1. The batching path (`/swap_5792`) is likely on. Disable it in code, not in wallet settings.
- `WebUniswapContext.tsx:280-290`: `getCanBatchTransactions = BatchedSwaps flag && one-click setting && wallet atomic batching`.
- When it is true, two things change:
  - `useTokenApprovalInfo.ts:109-111` **skips `/check_approval` entirely**;
  - `evmSwapInstructionsService.ts:173` routes to `/swap_5792`, which returns `calls[]` and executes through `wallet_sendCalls`.
- `local-run.md` shows `/config/initialize` returning real feature gates on the first call. So production flag values may apply. The flag state is **UNVERIFIED**.
- MetaMask reports `atomic` capability for EOAs it can upgrade (**UNVERIFIED** on 1301).
- **Fix:** make `getCanBatchTransactions` return false when `chainId === UniverseChainId.UnichainSepolia` (1 line). This is cheaper and safer than implementing `fetchSwap5792`.

### 2. Permit-as-transaction path.
- `useGetCanSignPermits.ts`: `forceTrue = ForcePermitTransactions flag`, or (account mismatch && `EnablePermitMismatchUX`).
- A MetaMask **smart account** (7702-delegated to MetaMask's delegator) counts as a mismatch. The quote request then carries `generatePermitAsTransaction: true`, and the UI expects `quote.permitTransaction` plus `permitGasFee` (`swapTxAndGasInfoService/utils.ts:485-497`), not `permitData`.
- **Fix:** use a fresh plain-EOA demo account, and have the override refuse (log loudly) when `generatePermitAsTransaction` is set. Optionally implement it as a `Permit2.approve(token, UR, max160, exp)` transaction (about 20 LOC).

### 3. The override must throw a real `FetchError`, or every failure shows the generic router warning.
- `getSwapWarningFromError.ts` maps `ResourceNotFound` to "No routes found" and `QuoteAmountTooLowError` to "Enter a larger amount", but only when `error instanceof FetchError` (from `@universe/api`, `packages/api/src/clients/base/errors.ts:3-16`) with `error.data.errorCode`.
- In Strategy B nothing goes over HTTP. Build it as `new FetchError({ response: new Response(null, { status: 404 }), data: { errorCode: 'ResourceNotFound' } })`.
- Do **not** use statuses 412-429. Those map to the rate-limit warning (`isRateLimitFetchError`).

### 4. Hidden dependency on Uniswap's dev gateway, even for our pairs.
- Strategy B avoids the gateway for quote, approval and swap. But confirmation still needs it:
  - `usePollPendingTransactions` returns early unless `lastBlockNumber` and `publicClient` exist (`transactions.ts:226`);
  - both come from wagmi and ethers providers that resolve to **UniRPC `/rpc/1301`** (`wagmiConfig.ts:153-178`, `resolveRpcConfig.web.ts:40-50`, `unichain.ts:125-127` Public = UniRPC). UniRPC needs the Turnstile/Hashcash session cookie.
- So if the session or the dev gateway fails on demo Wi-Fi, three things break: balances go blank, the block number never updates, and **the approval step hangs** even though our `/swaps` override is correct.
- The report's item B7 is marked "optional". **Treat it as required hardening:**
  - make `webResolveUniRpcConfig.getFeatureFlag` return false for 1301;
  - point 1301's Public RPC at `https://unichain-sepolia.drpc.org`, because `asUniRpcConfig` re-promotes gateway URLs.
- Test it with the gateway blocked in DevTools. Whether this alone is sufficient is **UNVERIFIED**.
- Also: block polling stops when the tab is hidden (`useBlockNumber.tsx:71-90`, `windowVisible`). Keep the app tab in front.

### 5. Demo-account funding contradicts the example.
- `swap-data-path.md` §0 has Alice holding 500 USDC and buying 100 USDC of YES.
- The Circle faucet gives **20 USDC per 2 h per address** (`unichain-sepolia.md` §3).
- Use 5-20 USDC trade sizes, or pre-fund the demo wallet from several faucet addresses over the next 3 days.
- The hook's own USDC and YES inventory or collateral is design-dependent. It must be seeded before sells can pay out.
- The example also says "a little Sepolia ETH". It must be **Unichain Sepolia** ETH.

### 6. Exact-output and "You receive" typing.
- If the presenter types into the output field, the app sends `EXACT_OUTPUT`. The override then needs `quoteExactOutputSingle` plus `SWAP_EXACT_OUT_SINGLE` / `SETTLE_ALL(maxIn)`.
- If the hook does not support exact-out, return `FetchError 404 QuoteAmountTooLowError` or `ResourceNotFound` so the UI degrades cleanly. Also rehearse only exact-in.

## C. Smaller risks and notes

- **Quote drift vs. acceptance prompt.**
  - Quotes refetch every about 3 s on L2 (`usePollingIntervalByChain.ts:18-37`, `AVERAGE_L2_BLOCK_TIME_MS`).
  - The review screen auto-accepts price moves under 1% (`trade.ts:125-149`, `ACCEPT_NEW_TRADE_THRESHOLD`).
  - Per-block impact above 1% triggers an "Accept" prompt mid-demo. Use 1-2% custom slippage and small sizes.
- **Deep-link token warnings.** `usePrefilledNeedsTokenProtectionWarning` shows a modal on Swap click for prefilled tokens with any warning, including `NonDefault` = Low. The COMMON_BASES patch avoids it. Without the patch, even Circle USDC comes back `STRONG_WARNING` from the Data API.
- **Logos.** `UNICHAIN_SEPOLIA_CHAIN_INFO.assetRepoNetworkName: undefined` (`unichain.ts:96`), so YES/NO/USDC show letter avatars. Build the CurrencyInfo by hand with a `logoUrl` if that matters.
- **USD values.** `useUSDCPrice` uses only the remote price service (`useUSDCPrice.ts:30-97`); there is no quote-based fallback. Expect no $ values for YES. USDC is priced at $1 only if it is the chain's primary stablecoin.
- **Testnet mode.** Testnet mode needs a connected wallet. Disconnecting turns it off (`DisconnectButton.tsx:38`), and deep links to 1301 then fall back to the default chain (`Swap/state/hooks.tsx:39-60`). Do not disconnect on stage.
- **Success UX.** The swap step does not wait for confirmation (`swapSaga.ts:88-95`, `shouldWaitForConfirmation: false`). A revert, for example the hook band check or slippage, first shows "success" and then a failed Activity row. Pre-check with `simulateTransaction` (`eth_estimateGas`) in `fetchSwap` and throw on revert.
- **Flag overrides.** In dev, `DevFlagsBox` (`apps/web/src/dev/DevFlagsBox.tsx:142`, registered in `modalRegistry.tsx:237`) opens `FeatureFlagModal` with Local Overrides. It can force `batched_swaps`, `force_permit_transactions` and `enable_permit2_mismatch_ux` off. Hard-coding (item 1) is still more reliable. How the box is opened is **UNVERIFIED**.
- **Polling cadence.** `tradingApiPollingIntervalMs: 150` for 1301 (`unichain.ts:151`) means the receipt-based `fetchSwaps` runs up to 20 times at 150 ms per pending tx. That is fine on drpc (25 burst requests OK), but cache receipts.
- **Hook-side quotability.** V4Quoter requires `amountSpecified` to be fully filled (`NotEnoughLiquidity` otherwise), and it runs as an `eth_call` at `latest`. Start-of-block pricing and per-block impact state keyed on `block.number` can price differently in `eth_call` than in the mined block (**UNVERIFIED** until the hook is deployed). Pass `from: swapper` in the quoter `eth_call` if the hook reads `tx.origin`.
- **Hosting.** Hosting must stay on `http://localhost:3000`. The entry-gateway CORS rejects `127.0.0.1` and any other domain (`local-run.md`). The forked app carries Uniswap branding, so keep it local and do not deploy it publicly.
- **Small arithmetic inconsistencies in the examples.**
  - 100 / 0.2427 = 412.03 YES, not 411.96.
  - The two reports use different spot prices (3,850 vs 3,900).
  - The corrected example below uses one consistent set.

## D. Effort sanity check

| Item | Reports | Reviewer estimate | Why |
|---|---|---|---|
| Run the stock fork locally | 0.5 h | 0.5-1 h | Patches already exist; first load is 30-40 s |
| Strategy B override + token patch | 11-13 h | **13-17 h** | Add items 1-4 above (about 2-3 h: batching off, permit-tx guard, FetchError mapping, RPC hardening plus a blocked-gateway test) and about 1 h exact-out. Subtract about 1-2 h: `vite dev` does not typecheck, so the "monorepo typecheck" line can be skipped for a demo |
| Deploy hook, tokens, pools on 1301 | 2-4 h | 3-5 h | Hook-address mining, seeding inventory and collateral under the faucet limits |
| **Total fork path** | about 14-17 h | **about 17-23 h** | On top of finishing the hook itself |

With about 3 days left this is feasible but tight.
- **Checkpoint:** by end of day 1, a first-time buy (approve, sign, swap) must succeed end to end on 1301 in the fork.
- **Fallback, ready in parallel (about 1-2 h):** a `cast`/viem script, or a 1-page viem UI, that sends the same UR `execute(0x0a10…)`. If the fork misbehaves on stage, the on-chain story (hook pricing, NoOp delta) still demos.

## E. Corrected "Alice buys YES" walkthrough (use this one in chat)

All numbers are illustrative. The setup is Strategy B, Unichain Sepolia, UR 2.0 `0xf70536…`, Circle USDC `0x31d0…768F`, and a plain MetaMask EOA. Pricing uses plain N(d2) with a ±1¢ spread; the real hook adds impact, caps and a band.

| Market "ETH ≥ $4,000 at 2026-09-29 16:00 UTC" | Value |
|---|---|
| Day 0: S = 3,850, σ = 60%, T = 3 d | fair YES 0.2327 (d2 = −0.730), ask 0.2427 |
| Day 1: S = 3,950, T = 2 d | fair YES 0.3800 (d2 = −0.305), bid 0.3700 |

1. **Setup.**
   - Alice gets 0.05 ETH from the Superchain faucet and 20 USDC from faucet.circle.com.
   - She connects MetaMask at `http://localhost:3000` and turns on **Testnet mode** in settings.
   - She opens `/swap?chain=unichain_sepolia&inputCurrency=0x31d0…768F&outputCurrency=<YES>`.
   - USDC and YES resolve from our COMMON_BASES entries, so there are no spam warnings.
   - Her balance of 20 USDC comes from `balanceOf`.
2. **She types 10 USDC.**
   - The form calls `TradingApiClient.fetchQuote`. Our wrapper sees YES on 1301 and does not call Uniswap. Instead it `eth_call`s V4Quoter `0x56dcd4…` with `quoteExactInputSingle(poolKey{USDC,YES,fee 0,hooks:PredictionHook}, exactAmount 10e6)`.
   - Inside the simulation, `PoolManager.swap` calls `PredictionHook.beforeSwap`. The hook prices at the ask (0.2427) and returns a delta of +10 USDC / −41.203131 YES with `amountToSwap = 0`, so the empty curve is skipped.
   - `Permit2.allowance(alice, USDC, UR)` is 0, so the quote includes `permitData`.
   - `/check_approval` finds `USDC.allowance(alice, Permit2) = 0` and returns `approve(Permit2, max)` plus a `gasFee`.
   - The UI shows **41.20 YES**, "min received 40.79" at 1% slippage, and route "V4 · USDC → YES".
3. **Review** shows three steps: Approve USDC, Sign, Swap.
4. **Popup 1: approve.** The saga waits until our `fetchSwaps` reads the receipt and reports SUCCESS, which takes about 1-2 s on 1 s blocks.
5. **Popup 2: sign.** Alice signs the EIP-712 `PermitSingle` (spender = UR 2.0, 30-day expiry). It costs no gas.
6. **Popup 3: swap.** Our `fetchSwap` encodes `UR.execute(0x0a10, [PERMIT2_PERMIT(sig), V4_SWAP(SWAP_EXACT_IN_SINGLE → SETTLE_ALL(USDC,10e6) → TAKE_ALL(YES, 40.79e6))], deadline)`, runs `eth_estimateGas`, and returns it. On-chain, in one block:
   - UR registers the permit;
   - `PoolManager.unlock` → `swap` → `beforeSwap` checks cutoff, caps and band, then prices;
   - Permit2 pulls 10 USDC from Alice into the PoolManager;
   - the PoolManager pays 41.2 YES to Alice;
   - the hook settles its side (keeps the USDC as collateral, supplies the YES; design-dependent).

   The UI shows "submitted" at once. The Activity row flips to "Swapped" when our `/swaps` reads the receipt.
7. **Next buy:** there is one popup, because both allowances exist and `/swap` is prepared during review.
8. **Day 1:** Alice sells 20 YES at the bid 0.37 and receives **7.40 USDC**. Approve and sign happen once for YES.
9. **After the cutoff:** the hook reverts, so the quoter reverts. The wrapper throws `FetchError 404 ResourceNotFound`, and the UI shows "No routes found".
10. **Settlement:** a TWAP decides the market. If ETH ≥ 4,000, Alice redeems 21.20 YES for 21.20 USDC through our own contract or page, not the Uniswap UI.

**What still depends on Uniswap's servers during this flow:**
- the browser session (Turnstile/Hashcash);
- UniRPC for balances and block polling, unless item 4 is done;
- token and price data for non-prediction tokens.

## Commands run for this review

```sh
# poolManager() wiring (drpc)
curl … eth_call {to:0xf70536…, data:0xdc4c90d3}  -> 0x…00b036b58a818b1bc34d502d3fe730db729e62ac
curl … eth_call {to:0x8B844f…, data:0xdc4c90d3}  -> 0x…9cb26a7183b2f4515945dc52cb4195b0d2d06c95
curl … eth_call {to:0x56dcd4…, data:0xdc4c90d3}  -> 0x…00b036b58a818b1bc34d502d3fe730db729e62ac
# msgSender() (0xd737d0c7)
V4Quoter 0x56dcd4… -> {"error":{"code":3,"message":"execution reverted"}} ; UR 2.0 -> 0x0
# drpc burst + CORS
25 parallel eth_blockNumber -> 25 x 200 ; access-control-allow-origin: * ; head 63,510,199
# N(d2): S=3850,T=3d -> 0.2327 ; S=3900,T=3d -> 0.3111 ; S=3950,T=2d -> 0.3800
```

## UNVERIFIED

- Live Statsig values on localhost for `batched_swaps`, `force_permit_transactions`, `enable_permit2_mismatch_ux` and `use_ur_version_2.1.1`.
- Whether MetaMask reports atomic batching on 1301 for a plain EOA.
- Whether the RPC hardening in item 4 fully removes the UniRPC dependency.
- Whether the Turnstile challenge stays non-interactive on the venue network.
- All on-chain behavior of PredictionHook: not deployed.
