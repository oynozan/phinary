# Running the Uniswap web app locally: results

Date: 2026-09-26 (JST). Machine: macOS (Darwin 25.6.0), arm64.
Repo: `Uniswap/interface` shallow clone at commit `9023421e7ee21930866668d0cd4c8d1d51287e45` (2026-09-23), at
`/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/repos/uniswap-interface` (called `$REPO` below).
Wall-clock time spent: about 18 minutes (03:26 to 03:44 JST), well inside the 40-minute limit.

## Summary

- **It runs.** The public mirror needs three small repo patches and one env override file first (listed below). After that,
  `bun web dev` serves `http://localhost:3000` and the swap page renders and returns **live quotes**.
- **Setup is quick.** Downloading bun and node took about 3 s, `bun install` took 35.6 s on a cold cache, and the dev server was
  ready about 10 s after start. The first page load takes 30–40 s while Vite optimizes dependencies and forces one reload.
  Disk use was about 6 GiB (from `df`).
- **The placeholder `TRADING_API_KEY` does nothing. What unlocks the Trading API from localhost is a browser session.**
  - A `curl` to `/quote` with `x-api-key: trading_api_key` gets **401** `{"errorCode":"Unauthorized","detail":"Unauthenticated api key or session"}`.
    This is true on dev, staging and prod entry gateways and on `trade-api.gateway.uniswap.org/v1`.
  - In the browser, the app runs `SessionService/InitSession`, then `Challenge` (Turnstile, then Hashcash), then `Verify` against the
    entry gateway and gets a session cookie. After that, `/quote` returns **200** even though the api key is still the placeholder.
  - The same in-page fetch without the cookie (`credentials:'omit'`) gets 401. So the cookie is what authenticates.
- **Only localhost origins pass CORS.** The entry gateway reflects `Access-Control-Allow-Origin` for `http://localhost:3000` and
  `http://localhost:5173`. It does **not** do so for `http://127.0.0.1:3000`, `https://prediction-demo.vercel.app` or
  `https://example.com`. The demo has to run on `http://localhost:<port>`. A deployed fork on its own domain would be CORS-blocked
  on direct calls (UNVERIFIED whether the BFF proxy mode fixes this).
- **Testnet mode and Unichain Sepolia (1301) work.** With testnet mode on, `/swap?chain=unichain_sepolia&inputCurrency=ETH&outputCurrency=0x31d0…768F`
  quoted 0.001 ETH → 30.0397 USDC through the Trading API (dev backend). Route: v3 pool `0xBeAD5792bB6C299AB11Eaa425aC3fE11ebA47b3B`.
  The quote request carries `"protocols":["V4","V3","V2"],"hooksOptions":"V4_HOOKS_INCLUSIVE"`.
  - For a pair with no liquidity on 1301, the Trading API returns **404** `{"errorCode":"NoRouteFoundError","detail":"No route with sufficient liquidity was found for this pair."}`.
    That is what our zero-liquidity hook pools should be expected to get (UNVERIFIED for our pools; nothing is deployed yet).
- **Code-level lever for the fork (not tested):** `TRADING_API_URL_OVERRIDE` sends every Trading API call (`/quote`, `/swap`,
  `/check_approval`, …) to a URL we choose. See `packages/uniswap/src/constants/urls.ts:299` and `packages/config/src/BaseConfig.ts:81`.

Screenshots: `local-run-assets/unichain-sepolia-testnet-quote.png` and `local-run-assets/mainnet-eth-usdc-quote.png`.
Probe scripts: `local-run-assets/probe*.cjs`.

## 1. Runtimes (nothing installed globally)

| Item | Required | Found / used |
|---|---|---|
| Node | `.nvmrc` = `v22.22.2`; `package.json` `engines.node` = `=22.22.2` (with `engine-strict=true` in `.npmrc`) | System has `v24.21.0` (`/usr/local/bin/node`), which **fails** `scripts/check-runtime-versions.sh` (the `preinstall` hook) |
| Bun | `.bun-version` = `1.3.14` (`engines.bun >=1.3.14`) | Not installed on the system |

Downloaded into the scratchpad, with checksums checked against the official SHASUMS256 files:

```sh
S=/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad
curl -fsSL -o $S/bun-bin/bun-darwin-aarch64.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip   # 1.6 s
#   sha256 d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620 (matches SHASUMS256.txt)
curl -fsSL -o $S/node-bin/node.tar.gz https://nodejs.org/dist/v22.22.2/node-v22.22.2-darwin-arm64.tar.gz                      # 0.9 s
#   sha256 db4b275b83736df67533529a18cc55de2549a8329ace6c7bcc68f8d22d3c9000 (matches SHASUMS256.txt)
```

Every command below ran with `source $S/env.sh`, which contains:

```sh
export PATH=$S/node-bin/node-v22.22.2-darwin-arm64/bin:$S/bun-bin/bun-darwin-aarch64:/usr/bin:/bin:/usr/sbin:/sbin
export HOME=$S/home  XDG_CACHE_HOME=$S/home/.cache  BUN_INSTALL=$S/home/.bun  BUN_INSTALL_CACHE_DIR=$S/bun-cache
export CYPRESS_INSTALL_BINARY=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NX_DAEMON=false NX_NO_CLOUD=true DO_NOT_TRACK=1
```

`HOME` points into the scratchpad, so the caches that bun, nx and wrangler write (`$S/home/.cache/bun`, `$S/home/Library/{Caches,Preferences}`, 65 MB)
never touched the real home directory. The only repo-local side effect is the `postinstall` hook running `git config core.hooksPath .husky` inside the clone.

## 2. `bun install`

### Attempt 1 failed immediately

```
error: Workspace not found "tools/uniswap-nx"
    at .../package.json:269:5
```

The public mirror leaves out `tools/uniswap-nx`, `labs/*`, `apps/cli`, `apps/dev-portal`, `apps/mission-control` and
`packages/transactional`. Root config files still reference them.

**Patch 1:** remove `"tools/uniswap-nx"` from `workspaces` in `package.json`. `labs/*` can stay because the glob just matches nothing.

### Attempt 2 succeeded

```
bun install v1.3.14 (0d9b296a)
Resolved, downloaded and extracted [955]
Saved lockfile
$ ./scripts/check-runtime-versions.sh   -> ✓ bun 1.3.14, ✓ node v22.22.2
$ git config core.hooksPath .husky && touch node_modules/.install-marker
4714 packages installed [35.60s]
Removed: 8
```

- No errors or warnings.
- `bun.lock` was rewritten (+440/−4132 lines) because the missing workspaces were dropped and packages were re-hoisted.
  Dependency versions were not audited (UNVERIFIED whether any resolved version drifted).
- `du` reports `node_modules` at 5.4 G and the bun cache at 4.6 G. APFS clonefile shares blocks, so real disk use by `df` went from 46 Gi to 52 Gi, about **6 GiB**.

## 3. Dev server (`bun web dev`)

`bun web dev` runs `nx dev web`. Target `dev` in `apps/web/project.json` runs `vite dev` and depends on `^prepare`, `prepare` and `config:pull`.

### Failure 1: nx sync generator

```
NX   The workspace is probably out of sync because a sync generator failed to run
[@universe/uniswap-nx:tsconfig-sync]: Unable to resolve @universe/uniswap-nx:tsconfig-sync.
```

**Patch 2 (`nx.json`, `sync` block, around line 202):**
`"globalGenerators": []` and `"disabledTaskSyncGenerators": ["@universe/uniswap-nx:tsconfig-sync"]`.
The `targetDefaults` still name the generator, but disabling it is enough.

Separately, the `config:pull` task runs `bun config:pull web --env development --soft`, which is Uniswap's internal config service.
Set `SKIP_CONFIG_PULL=true` so it does not try to (and cannot) overwrite `apps/web/.env`.

### Failure 2: Vite dependency optimization

```
TSConfckParseError: parsing .../tools/uniswap-nx/tsconfig.json failed: ENOENT
[RESOLVE_ERROR] Could not resolve 'node:module' in \0rolldown/runtime.js — Tsconfig not found
```

**Patch 3 (root `tsconfig.json`):** drop the `references` entries whose folders do not exist:
`./tools/uniswap-nx`, `./apps/cli`, `./packages/transactional`, `./apps/dev-portal`, `./apps/mission-control`.

### After the three patches

```
> nx run @universe/web:dev
> vite dev
ENV_LOADED: mode=development AWS_API_ENDPOINT=https://beta.gateway.uniswap.org/v1/graphql
VITE v8.1.3  ready in 4122 ms
➜  Local:   http://localhost:3000/
```

- About 10 s from the command to "ready".
- `curl http://localhost:3000/` returned 200 (9131 B, `<title>Uniswap Interface</title>`). `/swap` and `/swap?chain=unichain_sepolia` also returned 200.
- The Cloudflare Vite plugin starts a local `workerd` for the BFF (`apps/web/functions/app.ts`). It serves `/config/*` (Statsig proxy) and `/entry-gateway/*`.

### Failure 3: blank page (browser only)

Checked with headless system Chrome driven by `playwright-core` from the repo's `node_modules`, using a temp profile.

- (a) `Config validation failed: walletConnectProjectId Invalid input: expected string, received undefined`.
  - `apps/web/.env` sets **`WALLET_CONNECT_PROJECT_ID`**, but the code reads **`WALLETCONNECT_PROJECT_ID`** (or `REACT_APP_WALLET_CONNECT_PROJECT_ID`).
    See `apps/web/src/config.ts:21`; the schema at `:109` requires `z.string().min(1)`.
  - The checked-in `.env` therefore always crashes the app at boot.
- (b) Once (a) was fixed: `Cannot initialize the Privy provider with an invalid Privy app ID`, uncaught, so the page is still blank.
  - The placeholder `PRIVY_APP_ID="privy_app_id"` counts as "configured" (`apps/web/src/hooks/useMaybePrivy.ts:20-21`), so `MaybePrivyProvider`
    (`apps/web/src/index.tsx:244-253`) mounts `<PrivyProvider>`.

**Fix: add `apps/web/.env.override`.** This is the "user-defined override layer" in `apps/web/vite/resolveEnvConfigs.ts:65-80`.

```
WALLETCONNECT_PROJECT_ID="walletconnect_project_id"
PRIVY_APP_ID=""
PRIVY_CLIENT_ID=""
```

After a restart the swap page renders fully (see the screenshots).

### Normal dev-mode noise

- On first load, Vite serves one `504 (Outdated Optimize Dep)` and reloads the page. That reload produces about 330 aborted module requests.
- The "agentation" feedback toolbar (dev-only, `__DEV__`-gated) shows up at the bottom right.
- To stop the server, kill the `nx`, `vite`, `workerd` and `esbuild` processes. They were killed and port 3000 is free.

## 4. Backend services seen on `/swap` (placeholder keys)

These were observed in headless Chrome. URL logic for `mode=development`: `ENVIRONMENT` is set to the mode (`apps/web/vite.config.mts:257`).
`ENABLE_ENTRY_GATEWAY_PROXY` is unset in `.env`, so `getEntryGatewayUrl()` (`packages/api/src/getEntryGatewayUrl.ts:51-89`) returns the **dev** entry gateway directly.

| Service | URL | Result with placeholder keys |
|---|---|---|
| Sessions | `POST https://entry-gateway.backend-dev.api.uniswap.org/uniswap.platformservice.v1.SessionService/{InitSession,Challenge,Verify}` | 200. `needChallenge:true`, then `CHALLENGE_TYPE_TURNSTILE`, then `CHALLENGE_TYPE_HASHCASH`, then Verify `{}`. Establishes a cookie session. |
| **Trading API** | `POST .../quote`, `GET .../swappable_tokens`, `POST .../permissions` on the same host. There is no `/v1` prefix (`TradingApiClient.ts:181-187`); headers are `x-api-key: trading_api_key` and `x-request-source: uniswap-web` (`TradingApiClient.ts:33-51`); `credentials:'include'` (`packages/api/src/clients/trading/createTradingApiFetchClient.ts:24`) | **200 once the session exists.** Mainnet 0.01 ETH → 26.93 USDC (route included a `v4-pool`). Unichain Sepolia quotes are covered below. One testnet `/quote` returned 404 `UpstreamTimeoutError` and then succeeded on retry. |
| JSON-RPC | `POST .../rpc/1` (UniRPC) | 401 `{"message":"Unauthorized"}` until the session is verified, then 200 |
| Compliance | `.../compliancev2Service/{FeatureGatedTokens,GatedFeatures}` | 401 before the session, then 200 (`{"tokens":[]}`) |
| Data API | `.../data.v1.DataApiService/GetTokenPrices`, `data.v2.../GetToken`, `ConvertFiat`; plus `entry-gateway.backend-prod.../ListRwas` | 200 (one `GetToken` returned 404 for the testnet token) |
| Notifications | `.../NotificationService/GetNotifications`, `EventSubscriptionService/Subscribe` | 200 |
| WebSocket | `wss://entry-gateway.backend-dev.api.uniswap.org/ws` | Failed: "HTTP Authentication failed" (real-time price push; not needed for swaps) |
| GraphQL | `POST https://beta.gateway.uniswap.org/v1/graphql` (`AWS_API_ENDPOINT`) | Mixed. 2 × 200, then 2 × CORS preflight blocked ("No 'Access-Control-Allow-Origin'"). Affects charts and some token metadata. |
| Statsig | `POST http://localhost:3000/config/initialize` and `/config/rgstr` (BFF proxy to the Cloudflare statsig proxy) | First `initialize` 200 with `feature_gates`. Later calls 409 `{"error":"client packet length exceeds 255 buffer"}`. Flags fall back to defaults and cached values. |
| Amplitude | `https://metrics.interface.gateway.uniswap.org/v1/amplitude-proxy` | CORS-blocked (analytics only; harmless) |
| WalletConnect / Reown | `api.web3modal.org/appkit/v1/project-limits?projectId=walletconnect_project_id`, `pulse.walletconnect.org` | 403 / 400. The **WalletConnect QR flow will not work** without a real project ID. Injected wallets (MetaMask) should still work (UNVERIFIED; no wallet was connected). |
| Other | `challenges.cloudflare.com/turnstile` 200; `nbstream.binance.click` DNS fail; coingecko and GitHub token lists 200 | — |

### Direct Trading API test (curl, `Origin: http://localhost:3000`, placeholder key)

Request body: `{"type":"EXACT_INPUT","amount":"10000000000000000","tokenInChainId":1,"tokenOutChainId":1,"tokenIn":"0x0000000000000000000000000000000000000000","tokenOut":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","swapper":"0x0000000000000000000000000000000000000001","routingPreference":"BEST_PRICE"}`

| Endpoint | OPTIONS preflight | POST |
|---|---|---|
| `https://entry-gateway.backend-dev.api.uniswap.org/quote` | 204, ACAO `http://localhost:3000`, allow-headers `Content-Type, X-Api-Key, X-Request-Source`, credentials true | **401** `{"errorCode":"Unauthorized","detail":"Unauthenticated api key or session"}` |
| `https://entry-gateway.backend-staging.api.uniswap.org/quote` | 204, same | **401**, same body |
| `https://entry-gateway.backend-prod.api.uniswap.org/quote` | 204, same | **401**, same body |
| `https://trade-api.gateway.uniswap.org/v1/quote` | 204, same | **401**, same body |

### In-page fetch after the app established a session (`local-run-assets/probe-fetch.cjs`)

| Call | Status | Body |
|---|---|---|
| mainnet ETH→USDC, `credentials:'include'` | **200** | `{"routing":"CLASSIC",…"route":[[{"type":"v4-pool",…` |
| same, `credentials:'omit'` | **401** | `Unauthenticated api key or session` |
| 1301 USDC → a non-token address, `protocols:[V4,V3,V2]`, `hooksOptions:V4_HOOKS_INCLUSIVE` | **404** | `{"errorCode":"NoRouteFoundError","detail":"No route with sufficient liquidity was found for this pair."}` |

### CORS allowlist check (OPTIONS on dev `/quote`)

- **Reflected:** `http://localhost:3000` and `http://localhost:5173`.
- **Not reflected:** `http://127.0.0.1:3000`, `https://prediction-demo.vercel.app` and `https://example.com`.
- **Prod gateway:** reflects `localhost:3000` but not the vercel origin.

## 5. Testnet mode and Unichain Sepolia

**Code:**
- **Chain definition:** `UNICHAIN_SEPOLIA_CHAIN_INFO` in `packages/uniswap/src/features/chains/evm/info/unichain.ts:84-151`.
  - `testnet: true`, `supportsV4: true`, `urlParam: 'unichain_sepolia'`, `supportedURVersions: [2.0, 2.1.1]`.
  - USDC is `0x31d0220469e10c4E71834a79b1f276d740d3768F` and WETH is `0x4200…0006`.
- **Testnet toggle:** `apps/web/src/components/AccountDrawer/TestnetsToggle.tsx:11-38` dispatches `setIsTestnetModeEnabled`.
  - It sits in the account drawer settings. The e2e test `AccountDrawer.e2e.test.ts:57` uses it with a connected wallet, and
    "disconnected wallet settings should not be accessible" (`:69`).
  - `DisconnectButton.tsx:38` turns testnet mode off. In the demo: **connect the wallet first, then toggle Testnet mode in settings.**
- **Persisted state:** redux-persist key `redux/persist:interface` in localStorage (`apps/web/src/state/index.ts:16-24`), field `userSettings.isTestnetModeEnabled`.

**Verified in headless Chrome (`local-run-assets/probe-testnet.cjs`):**

1. Set `userSettings.isTestnetModeEnabled=true` in `redux/persist:interface` and reload. The value persisted, and the navbar shows the testnet wrench icon.
2. Open `/swap?chain=unichain_sepolia&inputCurrency=ETH&outputCurrency=0x31d0220469e10c4E71834a79b1f276d740d3768F` and type `0.001`.
   The UI shows **Buy 30.0397 USDC** with Unichain Sepolia chain badges.
3. The app sent this request to `POST https://entry-gateway.backend-dev.api.uniswap.org/quote`:
   `{"amount":"1000000000000000","tokenInChainId":1301,"tokenOutChainId":1301,"tokenIn":"0x0000…0000","tokenOut":"0x31d0…768F","type":"EXACT_INPUT","urgency":"urgent","protocols":["V4","V3","V2"],"hooksOptions":"V4_HOOKS_INCLUSIVE","autoSlippage":"DEFAULT",…}`
4. It got back 200:
   `routing:"CLASSIC"`, `routeString:"[v3] 100.00% = [0.05%] 0xBeAD5792bB6C299AB11Eaa425aC3fE11ebA47b3B"`, `output.amount:"30039664"`, `blockNumber:"63509169"`, `slippage:2.5`.
5. `swappable_tokens` for 1301 returned `{"tokens":[]}`, which is harmless.

## 6. What breaks without real API keys

| Placeholder | Effect | Workaround used |
|---|---|---|
| `WALLET_CONNECT_PROJECT_ID` (wrong key name) | **App crashes at boot** (config validation) | `.env.override`: `WALLETCONNECT_PROJECT_ID="walletconnect_project_id"` |
| `PRIVY_APP_ID` / `PRIVY_CLIENT_ID` | **App crashes** (invalid Privy app ID) | `.env.override`: both set to `""`, which disables Privy (embedded wallet / email login) |
| `TRADING_API_KEY` | None observed. Session auth covers it on localhost. Direct server-side calls without a session get 401. | None needed |
| `WALLETCONNECT_PROJECT_ID` value | WalletConnect / Reown QR connections fail (403) | Use the MetaMask injected connector (UNVERIFIED) |
| `STATSIG_API_KEY` | Later `/config` calls 409; flags stay at defaults | None |
| `AWS_API_ENDPOINT` (beta GraphQL) | Some calls CORS-blocked (charts and metadata) | None |
| `AMPLITUDE_PROXY_URL` | CORS-blocked analytics | None |
| `INFURA_KEY`, `ALCHEMY_API_KEY`, `QUICKNODE_*` | Not hit on the swap page. RPC goes through UniRPC `.../rpc/{chainId}`, which works after the session. | None |

## 7. Implications for the PredictionHook demo

- **Where to run it:** on `http://localhost:3000` (not `127.0.0.1`), in `vite dev` mode, with testnet mode on and Unichain Sepolia selected.
  - The stock Trading API (dev backend) works there without any Uniswap key.
- **Our YES/NO pools with the stock routing:** these pools have zero liquidity and use custom NoOp accounting.
  - The expected answer is `404 NoRouteFoundError` (the same shape as the non-routable probe above). The UI would show no quote.
  - UNVERIFIED for our actual pools, because nothing is deployed on 1301 yet.
  - The request already asks for `V4_HOOKS_INCLUSIVE`, but hook inclusion alone does not make a zero-liquidity pool routable.
- **Code lever, not tested:** set `TRADING_API_URL_OVERRIDE=http://localhost:<port>` in `apps/web/.env.override`. It is read at
  `packages/config/src/BaseConfig.ts:81` and wins at `packages/uniswap/src/constants/urls.ts:299`.
  - All Trading API calls would then go to a local shim of our own that serves `/quote`, `/swap`, `/check_approval`, `/permissions`
    and `/swappable_tokens` at unversioned paths.
  - The shim could price YES/NO swaps through the V4Quoter and build the UniversalRouter `V4_SWAP` calldata.
  - The shim must answer CORS for `http://localhost:3000` with credentials.
  - Everything else (sessions, RPC, token data) would keep using Uniswap's dev gateway.
- **Backend reliability:** local dev always talks to Uniswap's **dev** backend (`entry-gateway.backend-dev…`).
  - One `UpstreamTimeoutError` was seen, and the retry succeeded.
  - Bot challenges (Turnstile, Hashcash) run on every fresh profile. They passed silently in headless Chrome.

## 8. Not verified

- Connecting a real wallet (MetaMask) and signing or broadcasting a swap. `/swap` and `/check_approval` were never called.
- Whether our YES/NO tokens show up in token search on 1301 (Data API `GetToken` returned 404 for one testnet token). Pasting the address may still work.
- Whether `ENABLE_ENTRY_GATEWAY_PROXY=true` (the BFF `/entry-gateway/*` proxy in `apps/web/functions/app.ts:132`) avoids the CORS
  allowlist for a non-localhost deployment, and whether sessions and Turnstile work on another domain.
- The `TRADING_API_URL_OVERRIDE` shim approach (code reading only).
- Whether the `bun.lock` rewrite changed any resolved dependency versions.
- Production build (`bun web build:production`) and preview were not tried.

## 9. Reproduce (copy-paste)

```sh
S=/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad
source $S/env.sh; cd $REPO
# patches (already applied in the scratch clone; `git diff --stat` shows bun.lock, nx.json, package.json, tsconfig.json)
#   package.json: remove "tools/uniswap-nx" from workspaces
#   nx.json: sync.globalGenerators=[]; sync.disabledTaskSyncGenerators=["@universe/uniswap-nx:tsconfig-sync"]
#   tsconfig.json: drop references to ./tools/uniswap-nx ./apps/cli ./packages/transactional ./apps/dev-portal ./apps/mission-control
printf 'WALLETCONNECT_PROJECT_ID="walletconnect_project_id"\nPRIVY_APP_ID=""\nPRIVY_CLIENT_ID=""\n' > apps/web/.env.override
bun install                       # ~36 s cold
SKIP_CONFIG_PULL=true bun web dev # ready in ~10 s -> http://localhost:3000 (use "localhost", not 127.0.0.1)
# In the app: Connect wallet -> settings -> Testnet mode ON -> /swap?chain=unichain_sepolia
```
