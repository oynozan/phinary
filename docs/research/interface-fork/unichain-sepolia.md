# Unichain Sepolia (chain 1301): v4 stack check and testnet setup

Checked 2026-09-25 18:30 UTC (2026-09-26 JST). Every address below was checked on-chain with `eth_getCode` and wiring calls (`poolManager()`, `permit2()`, `manager()`) against public RPCs. Evidence and commands are at the end.

Scratch outputs: `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-UniswapPrediction/1b01c4fe-2032-47bf-9776-990202883598/scratchpad/unisep/` (`rpccheck.py`, `cfg.json`, `rpccheck.out`, `calldata_5field.hex`, `calldata_6field.hex`, `bs_*.json`, `deployments.json`, `faucets.mdx`, `netinfo.mdx`).

---

## TL;DR

1. **Unichain Sepolia works, but it has two separate Uniswap v4 stacks.** Each stack has its own PoolManager, and you must not mix contracts from the two.
   - **Stack A (use this one):** PoolManager `0x00b036b5…62ac`. It is the stack in the developers.uniswap.org v4 deployments page, in sdk-core (both the version the interface pins, 7.19.1, and repo HEAD), and in the v4-periphery `broadcast/*/1301` files. It is also the active one: Blockscout shows 2,401 txs and 1.2M token transfers, and its latest Swap log was about 4 h before this check.
   - **Stack B (avoid):** PoolManager `0x9cB26A71…6C95`. It is the stack in `developers.uniswap.org/deployments.json`, which is generated from `Uniswap/contracts`. **UniversalRouter 2.1.1 `0x8B844f88…1E6b` on 1301 is wired to Stack B.** The UR repo's `deploy-addresses/unichain-sepolia.json` "UniversalRouterV2" `0x986dadb8…` is also on Stack B.
2. **UniversalRouter struct layout on 1301.** Confirmed three ways: verified Blockscout source, error selectors in the bytecode, and a live `eth_call` probe.
   - **UR 2.0 `0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d`**: Stack A, **5-field** `ExactInputSingleParams` (no `minHopPriceX36`).
   - **UR 2.1.2 `0xDf38F24fE153761634Be942F9d859f3DBA857E95`**: Stack A, **6-field** (with `uint256 minHopPriceX36` before `hookData`).
   - UR 2.1.1 `0x8B844f88…` is 6-field but on Stack B. Do not use it.
3. **Recommended demo wiring: Stack A + UR 2.0 (5-field).** The interface's installed `@uniswap/universal-router-sdk@5.11.3` returns this router for `UNIVERSAL_ROUTER_ADDRESS(V2_0, 1301)`. The installed `@uniswap/v4-sdk@2.3.0` `V4Planner` also defaults to `URVersion.V2_0`, which is the 5-field layout. UR 2.1.2 is the alternative if you want per-hop price limits. In that case, encode with `URVersion.V2_1_1` (same 6-field layout); the installed SDK has no 2.1.2 entry for 1301.
4. **USDC and WETH.** Circle testnet USDC is `0x31d0220469e10c4E71834a79b1f276d740d3768F` ("USDC", 6 decimals, proxy). WETH is the OP-stack predeploy `0x4200000000000000000000000000000000000006`. The interface uses both (`unichain.ts:86`, `:148`).
5. **Chain basics.** Chain id `0x515` = 1301. Block time is exactly **1.000 s** (average over 1,000 blocks). Head was block 63,508,533 at the time of the check. Gas price was about 0.0015 gwei. The public RPC caps `eth_getLogs` at **10,000 blocks** per call.
6. **The web app has Unichain Sepolia built in**, with the same Stack A PositionManager, StateView and Quoter through sdk-core. **Base Sepolia is not a `UniverseChainId`**, so the web app cannot select it. Ethereum Sepolia is supported but has 12 s blocks.

---

## 1. Official deployment addresses and on-chain bytecode (Unichain Sepolia 1301)

Sources for the addresses:
- **[docs]** is developers.uniswap.org `/docs/protocols/v4/deployments`, section "Unichain Sepolia: 1301". I re-fetched it live on 2026-09-25 via `https://developers.uniswap.org/llms.mdx/docs/protocols/v4/deployments`, and it is byte-identical to scratchpad `v4deployments.md` lines 275-287.
- **[sdk-core]** is `Uniswap_sdks/sdks/sdk-core/src/addresses.ts:393-406` (repo HEAD 7.19.4). It is identical to the interface's installed `node_modules/@uniswap/sdk-core@7.19.1/dist/esm/src/addresses.js:328-340`.
- **[bcast]** is `v4-periphery/broadcast/<script>/1301/run-latest.json` (deploy commit 645fbc2e, blocks 7,092,034-7,095,321, Dec 2024).
- **[ur-sdk]** is `universal-router-sdk/src/utils/constants.ts:423-444` (HEAD 5.13.1). The interface's installed 5.11.3 (`dist/esm/src/utils/constants.js:356-374`) has the same entries without V2_1_2.
- **[UR repo]** is `universal-router/deploy-addresses/unichain-sepolia.json`.
- **[deployments.json]** is `https://developers.uniswap.org/deployments.json` (generatedAt 2026-07-15, source `Uniswap/contracts@3793618`).

### Stack A (recommended)

| Contract | Address | Listed in | Code size (bytes) | Wiring check | Explorer |
|---|---|---|---|---|---|
| PoolManager | `0x00b036b58a818b1bc34d502d3fe730db729e62ac` | docs, sdk-core, bcast, UR deploy script | 24,009 | owner `0x5b73C549…0519` | Blockscout verified "PoolManager" |
| PositionManager | `0xf969aee60879c54baaed9f3ed26147db216fd664` | docs, sdk-core, bcast | 23,877 | `poolManager()`=A, `permit2()`=Permit2, `WETH9()`=0x4200…06, `tokenDescriptor()`=`0x4DF05355…84fA` | verified; ERC-721 "Uniswap v4 Positions NFT" |
| PositionDescriptor | `0x4df053553a53d976f82fbcf2a5c7a343e4eb84fa` | bcast | 24,110 | referenced by PosM | n/a |
| StateView | `0xc199f1072a74d4e905aba1a84d9a45e2546b6222` | docs, sdk-core, bcast | 3,531 | `poolManager()`=A | verified |
| V4Quoter | `0x56dcd40a3f2d466f48e7f48bdbe5cc9b92ae4472` | docs, sdk-core, bcast | 5,820 | `poolManager()`=A; live quote probe reached PoolManager (below) | verified |
| **UniversalRouter 2.0** | `0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d` | docs ("Universal Router"), ur-sdk V2_0 (creationBlock 7,100,543) | 19,540 | `poolManager()`=A | verified 2024-12-12, solc 0.8.26; **5-field** |
| **UniversalRouter 2.1.2** | `0xDf38F24fE153761634Be942F9d859f3DBA857E95` | docs, UR repo, ur-sdk HEAD V2_1_2 (block 62,830,804), deployments.json | 24,380 | `poolManager()`=A | verified 2026-09-17; **6-field** |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | all | 9,152 | n/a | verified |
| PoolSwapTest | `0x9140a78c1a137c7ff1c151ec8231272af78a99a4` | docs, bcast, deployments.json | 6,950 | `manager()`=A | not verified |
| PoolModifyLiquidityTest | `0x5fa728c0a5cfd51bee4b060773f50554c0c8a7ab` | docs, bcast, deployments.json | 6,050 | `manager()`=A | n/a |
| ReservesLens | `0x0000001b173C3bbF3984D417d8614E3eed34865B` | docs | 14,142 | n/a | n/a |
| CREATE2 deployer (for hook address mining) | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | n/a | 69 | present | n/a |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | n/a | 3,808 | present | n/a |

### Stack B (present on chain, do not mix with A)

| Contract | Address | Listed in | Size | `poolManager()` |
|---|---|---|---|---|
| PoolManager | `0x9cB26A7183B2F4515945Dc52CB4195B0d2D06C95` | deployments.json (`v4 PoolManager`, ref 77d52a7) | 24,009 | n/a (owner `0x07D68837…9A04`, CREATE2 via 0x4e59) |
| PositionManager | `0x12A98709BB5D0641D61458f85dcAFbE17AC2d05c` | deployments.json | 23,877 | B |
| StateView | `0x792d13207744F132943CdDE4D37ec89F20ae3b0D` | deployments.json | 3,531 | B |
| V4Quoter | `0xB2b34025a07af3925313b6B46f8046Ee8FfBa30B` | deployments.json | 5,820 | B |
| PositionDescriptor | `0xC4Fe8f6cC445fB3F8921cEe75830F248a1D1da2F` | deployments.json | 1,074 | B |
| UniversalRouter ("UniversalRouter", ref c0b6b96) | `0x7F9B8D606E0F35E5073ABf93695814530b28a37b` | deployments.json | 21,738 | B (5-field by probe; **not verified** on Blockscout) |
| UniversalRouter 2.1.1 | `0x8B844f885672f333Bc0042cB669255f93a4C1E6b` | ur-sdk V2_1_1 (block 46,987,997), UR repo | 24,546 | **B** (6-field, verified 2026-07-09) |
| UniversalRouter "V2" | `0x986dadb82491834f6d17bd3287eb84be0b4d4cc7` | UR repo `deploy-addresses/unichain-sepolia.json` | 19,499 | **B** (5-field, verified 2025-02-10) |
| UniversalRouter 1.2 (legacy) | `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6` | ur-sdk V1_2 | 19,214 | `0xf164fC0E…b92a` (pre-release PM) |

Activity from Blockscout `/api/v2/addresses/<pm>/counters` and `/logs`:
- Stack A PoolManager: `transactions_count` 2,401, `token_transfers_count` 1,206,381. Newest log was at block 63,494,096, about 14.7k blocks or 4 h before the check. The latest page held 17 Swap and 33 Transfer logs.
- Stack B PoolManager: 0 direct txs. The newest log was at block 62,479,395, about 1.03M blocks or 12 days before the check. The page held 32 Swap, 12 ModifyLiquidity and 6 Initialize logs, so it is used, but less.

**Inconsistencies in official sources (keep in mind):**
- The docs page lists "Universal Router" = `0xf70536…` (2.0, A) and "Universal Router 2.1.2" = `0xDf38F2…` (A), and **no 2.1.1** for 1301.
- deployments.json lists the Stack B v4 set, "UniversalRouter" `0x7F9B8D…` (B), and 2.1.2 `0xDf38F2…` (A). That mixes stacks within one file.
- The UR repo lists V2 `0x986dadb…` (B), 2.1.1 `0x8B844f…` (B) and 2.1.2 `0xDf38F2…` (A). Its `script/deployParameters/DeployUnichainSepolia.s.sol` nevertheless hardcodes `v4PoolManager: 0x00B036…` and `v4PositionManager: 0xf969…` (A).
- The same address `0x8B844f…` is "UR 2.1.1" on Base Sepolia too, and there it points to yet another PoolManager, `0xf7F5aB3D…3c67`, not the documented Base Sepolia PM. It looks like a CREATE deployment with the same nonce and per-chain args. The docs omit 2.1.1 for Base Sepolia and Unichain Sepolia, which is consistent with this.

### Chain id, head, block time (`sepolia.unichain.org`)

```
chainId=1301 (0x515)  latestBlock=63508533  latestTs=1790360961 (2026-09-25T18:29:21Z)
  latest-1:    ts=1790360960  avg 1.000s
  latest-10:   ts=1790360951  avg 1.000s
  latest-100:  ts=1790360861  avg 1.000s
  latest-1000: ts=1790359961  avg 1.000s
eth_gasPrice = 0.0015 gwei
eth_getLogs range > 10000 -> {"code":-32602,"message":"block range greater than 10000 max"}
```

- The interface says `blockTimeMs: 1000` and `subblockTimeMs: 200` (Flashblocks), at `packages/uniswap/src/features/chains/evm/info/unichain.ts:123,139`.
- Official network info (`developers.uniswap.org/llms.mdx/docs/unichain/technical-information/network-information`) gives RPC `https://sepolia.unichain.org` ("Not for production use"), explorer `https://sepolia.uniscan.xyz/`, and sequencer us-east-2.
- Alternative RPC `https://unichain-sepolia.drpc.org` returned `0x515`. It is the interface's `RPCType.Default` (unichain.ts:131).
- Blockscout also works without an API key: `https://unichain-sepolia.blockscout.com/api/v2/...`.

---

## 2. UniversalRouter version and `ExactInputSingleParams` layout

The three pieces of evidence all agree.

**(a) Verified source (Blockscout `GET /api/v2/smart-contracts/<addr>`, `lib/v4-periphery/src/interfaces/IV4Router.sol`)**
- `0xf70536…` UniversalRouter, solc 0.8.26, verified 2024-12-12: `{PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; bytes hookData;}` (**5 fields**).
- `0xDf38F2…` UniversalRouter, verified 2026-09-17: `{PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; uint256 minHopPriceX36; bytes hookData;}` (**6 fields**).
- `0x8B844f…` (2.1.1): 6 fields. `0x986dadb…`: 5 fields. `0x7F9B8D…`: no verified source.

**(b) Bytecode selectors.** `V4TooLittleReceivedPerHopSingle(uint256,uint256)` = `0x4713c18b` and `V4TooMuchRequestedPerHopSingle` = `0xefc8d8eb`, which were added with `minHopPriceX36` in v4-periphery PR #516, commit 03b2d09, 2026-03-17.
- Present in `0xDf38F2…` and `0x8B844f…`, and in Sepolia 2.1.1/2.1.2/2.2.0 and Base Sepolia 2.1.2.
- Absent in `0xf70536…`, `0x986dadb…`, `0x7F9B8D…`, and in Sepolia/Base Sepolia 2.0.

**(c) Live `eth_call` probe (decisive).**
- Setup: `execute(0x10 /*V4_SWAP*/, [abi.encode(0x06 /*SWAP_EXACT_IN_SINGLE*/, [params])], 99999999999)` with a dummy uninitialized PoolKey (`currency0=0xEeee…`, `currency1=0xFFff…`, fee 3000, spacing 60, no hook), amountIn 1000, and for 6-field `minHopPriceX36=0xffffffff`.
- Logic: when the layout matches, decoding succeeds, the call reaches `PoolManager.swap`, and it reverts with `PoolNotInitialized()` = `0x486aa307`. When the layout is wrong, it reverts with no data.

```
1301 UR2.0  0xf70536…   5-field -> revert 0x486aa307   6-field -> revert (no data)
1301 UR2.1.2 0xDf38F2…  5-field -> revert (no data)    6-field -> revert 0x486aa307
1301 UR2.1.1 0x8B844f…  5-field -> revert (no data)    6-field -> revert 0x486aa307   (but PM = Stack B)
1301 UR     0x7F9B8D…   5-field -> revert 0x486aa307   6-field -> revert (no data)    (PM = Stack B)
sepolia UR2.0 0x3A9D48…  5 ok / 6 no;  sepolia UR2.1.2 0x7E4f6c…  5 no / 6 ok
basesep UR2.0 0x492e64…  5 ok / 6 no;  basesep UR2.1.2 0x870246…  5 no / 6 ok
```

V4Quoter probe on 1301: `quoteExactInputSingle(((key),true,1000,0x))` to `0x56dcd4…` returned `UnexpectedRevertBytes(0x486aa307)` (`0x6190b2b0…486aa307`). So the quoter reaches Stack A's PoolManager. `QuoteExactSingleParams` is 4 fields (`poolKey, zeroForOne, exactAmount, hookData`) and has not changed.

**How the stock web app picks a UR version.** `packages/uniswap/src/data/apiClients/tradingApi/TradingApiClient.ts:79-92`:
- It sends header `x-universal-router-version: 2.1.1` only if the Statsig flag `UseUniversalRouterVersion211` is on and the chain lists `_2_1_1` in `supportedURVersions`. Unichain Sepolia does (`unichain.ts:140`).
- It sends `2.2.0` for permissioned tokens.
- Otherwise it sends `2.0`.

For Unichain Sepolia, a Trading-API-built 2.1.1 swap would target `0x8B844f…`, which is Stack B (UNVERIFIED: I did not call the Trading API, which needs a key). Our custom-pool path builds its own calldata, so pin the router explicitly to `0xf70536…` (5-field) or `0xDf38F2…` (6-field).

---

## 3. USDC, WETH, faucets

| Token | Address | On-chain `name/symbol/decimals` | Notes |
|---|---|---|---|
| USDC (Circle) | `0x31d0220469e10c4E71834a79b1f276d740d3768F` | "USDC"/"USDC"/6, totalSupply 16,662,435,092.81 | Proxy (impl `0x67ce6DA6…54A1`), Blockscout verified. Confirmed on developers.circle.com/stablecoins/usdc-contract-addresses. Interface `unichain.ts:86`. |
| WETH | `0x4200000000000000000000000000000000000006` | "Wrapped Ether"/"WETH"/18 | OP-stack predeploy. The UR deploy script `weth9` is the same. Interface `unichain.ts:148`. |

Faucets, as listed at `developers.uniswap.org/llms.mdx/docs/unichain/tools/faucets` (fetched 2026-09-25):

**ETH**
- Superchain Faucet https://app.optimism.io/faucet: 0.05 ETH per 24 h, more with onchain identity.
- QuickNode https://faucet.quicknode.com/unichain/sepolia: 1 drip per 12 h.
- thirdweb https://thirdweb.com/unichain-sepolia-testnet: 1 drip per 24 h.
- Also found by web search:
  - Alchemy https://www.alchemy.com/faucets/unichain-sepolia (0.1 ETH/24 h per search snippet; account and mainnet-balance requirements UNVERIFIED).
  - ETHGlobal https://ethglobal.com/faucet/unichain-sepolia-1301.
  - L2Faucet https://www.l2faucet.com/unichain.
  - Bridge from Sepolia via https://superbridge.app/unichain-sepolia.

**USDC**
- Circle https://faucet.circle.com/. The Uniswap docs list it for Unichain Sepolia ("one drip per network every hour"). The Circle page says "20 USDC on testnet every 2 hours, per address, and per blockchain".
- The Unichain Sepolia entry in the faucet dropdown is **UNVERIFIED**: the page is JS-rendered and the fetch did not show the list.
- Fallback: CCTP-bridge from Ethereum Sepolia USDC.

Practical consequence: about 20 USDC per 2 h per address is enough for demo trades, such as Alice spending 10 USDC. It is tight for seeding the ETH/USDC oracle pool and any USDC collateral the hook needs. Options: use several faucet addresses, provide concentrated liquidity in a narrow range, or (last resort) deploy a 6-decimal MockUSDC. MockUSDC loses the interface's built-in "USDC" token and stablecoin pricing, which is keyed on `0x31d0…`.

---

## 4. Does the Uniswap web app list Unichain Sepolia with these addresses?

Checked at interface commit 9023421 (2026-09-23), with `node_modules` present.

- `packages/chains/src/rpc/types.ts:8-34`: `UniverseChainId.UnichainSepolia = UniswapSDKChainId.UNICHAIN_SEPOLIA` (1301). The only testnets in the enum are **Sepolia and UnichainSepolia**. There is no Base Sepolia or Arbitrum Sepolia.
- `packages/uniswap/src/features/chains/evm/info/unichain.ts:84-152` `UNICHAIN_SEPOLIA_CHAIN_INFO`:
  - `testnet: true`, `supportsV4: true`, `supportedURVersions: [_2_0, _2_1_1]`.
  - USDC `0x31d0…768F`, WETH `0x4200…0006`, explorer `https://sepolia.uniscan.xyz/`, urlParam `unichain_sepolia`.
  - Backend chain is `GraphQLApi.Chain.AstrochainSepolia`.
  - RPCs: Public = UniRPC gateway `${entryGateway}/rpc/1301`, Default = `https://unichain-sepolia.drpc.org`, Interface = QuickNode `…unichain-sepolia.quiknode.pro/<token>`.
  - The fork should override these to `https://sepolia.unichain.org`, or keep drpc.
- `chainInfo.ts:111` registers it. It shows only when **testnet mode** is on (`features/chains/hooks/useEnabledChains.ts:14-34`, `utils.ts:272+`).
- v4 addresses come from `CHAIN_TO_ADDRESSES_MAP` in `@uniswap/sdk-core@7.19.1`. For 1301 they are **Stack A**: PM `0x00b036…`, PosM `0xf969…`, StateView `0xc199…`, Quoter `0x56dc…` (`node_modules/@uniswap/sdk-core/dist/esm/src/addresses.js:328-340`). Consumers:
  - `apps/web/src/features/Liquidity/hooks/useV4PoolsInitializedOnChain.ts:39` (v4StateView)
  - `apps/web/src/pages/Positions/usePositionTokenURI.ts:43` (v4PositionManager)
- UR addresses come from `@uniswap/universal-router-sdk@5.11.3`, `dist/esm/src/utils/constants.js:356-374`, for 1301:
  - V1_2 `0x8909…`
  - **V2_0 `0xf70536…` (A)**
  - V2_1_1 `0x8B844f…` (**B**)
  - no V2_1_2 entry
- `@uniswap/v4-sdk@2.3.0` `V4Planner.addAction(type, params, urVersion = URVersion.V2_0)` and `addTrade(..., urVersion = V2_0)` default to the 5-field structs (`dist/esm/src/utils/v4Planner.js:69-87,191,197`).
- Conclusion: in the fork, `UNIVERSAL_ROUTER_ADDRESS(UniversalRouterVersion.V2_0, 1301)` plus default `V4Planner` encoding gives a consistent Stack A, 5-field path. **Do not** use `V2_1_1` on 1301.

---

## 5. Alternatives (brief)

| | Ethereum Sepolia (11155111) | Base Sepolia (84532) |
|---|---|---|
| RPC used | `https://ethereum-sepolia-rpc.publicnode.com` | `https://sepolia.base.org` |
| chainId / head | 11155111 / 11,781,021 | 84532 / 47,296,344 |
| Block time (1,000-block avg) | 12.012 s | 2.000 s |
| Gas price | ~0.98 gwei | 0.006 gwei |
| PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` (24,009 B) | `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` (24,009 B) |
| PositionManager | `0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4` (pm OK, permit2 OK) | `0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80` (pm OK, permit2 OK) |
| StateView | `0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c` (pm OK) | `0x571291b572ed32ce6751a2cb2486ebee8defb9b4` (pm OK) |
| V4Quoter | `0x61b3f2011a92d183c7dbadbda940a7555ccf9227` (pm OK) | `0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba` (pm OK) |
| UR 2.0 (5-field) | `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` (pm OK). deployments.json instead lists `0x470FFC67b1feEEC31D16C46AC7545C98716a194c` (also pm OK, 5-field bytecode) | `0x492e6456d9528771018deb9e87ef7750ef184104` (pm OK) |
| UR 2.1.1 (6-field) | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` (pm OK) | `0x8B844f…` points to PM `0xf7F5aB3D…`, **wrong stack** |
| UR 2.1.2 (6-field) | `0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3` (pm OK) | `0x8702463e73f74d0b6765aBceb314Ef07aCb92650` (pm OK) |
| UR 2.2.0 | `0x5093f1CDED83d99FfEd6602dA6260672ae16787c` (pm OK, 6-field) | none |
| PoolSwapTest | `0x9b6b46e2c869aa39918db7f52f5557fe577b6eee` (manager OK) | `0x8b5bcc363dde2614281ad875bad385e0a785d3b9` (manager OK) |
| Permit2 / CREATE2 0x4e59 | present / present | present / present |
| USDC (Circle) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (USDC, 6) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (USDC, 6) |
| WETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` | `0x4200000000000000000000000000000000000006` |
| In Uniswap web app? | **Yes** (`UniverseChainId.Sepolia`, `mainnet.ts:126` USDC, `:189` UR versions) | **No** (not in `UniverseChainId`; adding it means adding a chain to the fork) |
| Single consistent stack? | Yes, every contract checked points to `0xE03A…` | Yes for 2.0/2.1.2; 2.1.1 is off-stack |

Verdict:
- **Unichain Sepolia is the best fit**: it is in the app, has 1 s blocks, and Stack A is consistent and active.
- **Ethereum Sepolia is the fallback**: it is in the app, all contracts are consistent, but it has 12 s blocks and higher gas.
- Base Sepolia would need a chain added to the web app fork, so it is not worth it for a 3-day demo.

---

## 6. Worked example: "Alice buys YES" on Unichain Sepolia (Stack A, UR 2.0)

The numbers are illustrative. Hook-internal accounting (how the hook sources the YES tokens and holds USDC collateral) depends on our design and is marked *(design)*.

**Market:** "ETH ≥ $4,000 at 2026-09-29 16:00 UTC". Assume the ETH/USDC oracle pool on PM `0x00b036…` reports spot $3,900, σ = 60 %/yr, T = 3 days. Black-Scholes digital price: N(d2) with d2 = (ln(3900/4000) − σ²T/2)/(σ√T) = −0.493, so **YES ≈ 0.311 USDC** and NO ≈ 0.689 USDC.

**One-time setup (deployer):**
1. Deploy `PredictionHook` through CREATE2 `0x4e59b448…956C`, with a salt mined so the address carries the BEFORE_SWAP and BEFORE_SWAP_RETURNS_DELTA flag bits.
2. Deploy YES and NO ERC20s (6 decimals).
3. Call `PoolManager(0x00b036…).initialize(PoolKey{currency0,currency1 = sorted(USDC 0x31d0…, YES), fee 0, tickSpacing, hooks = PredictionHook}, sqrtPriceX96)`, and the same for NO. Initialization is hook-gated. Note: `0x31d0…` sorts below any YES address that starts above `0x31d0…`. The sort order decides `zeroForOne`.

**Alice:**
1. Gets 0.05 ETH from the Superchain faucet and 20 USDC from faucet.circle.com. She now holds 20.000000 USDC at `0x31d0…`.
2. In the forked app (testnet mode, chain `unichain_sepolia`) she picks USDC → YES-ETH4000 and types **10 USDC**.
3. The app sends `eth_call` to `V4Quoter 0x56dcd40a…`: `quoteExactInputSingle({poolKey, zeroForOne, exactAmount: 10_000000, hookData: 0x})`.
   - This calls `PoolManager.swap`, which calls `PredictionHook.beforeSwap`. The hook reads the oracle, computes 0.311, and returns `BeforeSwapDelta(+10_000000 USDC, −32_140349 YES)` with amountToSwap = 0.
   - The quoter reports **≈ 32.14 YES** (before any spread or fee).
4. First-time approval: `USDC.approve(Permit2 0x000000000022D473…, max)` (1 tx). Then either a Permit2 `PermitSingle` signature with spender = **UR `0xf70536…`**, bundled as command `0x0a` PERMIT2_PERMIT, or `Permit2.approve(USDC, UR, amount, expiry)`.
5. Swap tx: `UniversalRouter(0xf70536…).execute(commands=0x0a10, inputs=[permit, v4Swap], deadline)`, where `v4Swap = abi.encode(actions=0x060c0f, [...])`:
   - `0x06` SWAP_EXACT_IN_SINGLE with the **5-field** struct `{poolKey, zeroForOne, amountIn: 10_000000, amountOutMinimum: 31_979647 (0.5 % slippage), hookData: 0x}`.
   - `0x0c` SETTLE_ALL `(USDC, 10_000000)`.
   - `0x0f` TAKE_ALL `(YES, 31_979647)`.
6. On-chain, in one 1 s block:
   - UR calls `PoolManager.unlock`, which calls `UR.unlockCallback`, which calls `PoolManager.swap`.
   - The hook's `beforeSwap` prices the trade and takes/settles its side *(design: e.g. keeps the 10 USDC as collateral and supplies 32.14 YES)*.
   - The v4 AMM math is skipped (zero liquidity, amountToSwap = 0).
   - The router's deltas are −10 USDC / +32.14 YES. SETTLE_ALL does `Permit2.transferFrom(Alice → PoolManager, 10 USDC)`, then TAKE_ALL does `PoolManager.take(YES → Alice, 32.14)`.
   - The tx appears on https://sepolia.uniscan.xyz with a v4 `Swap` event from `0x00b036…` for the YES/USDC poolId.
7. Alice now holds 10 USDC and 32.14 YES.
8. **Bob sells YES** (YES → USDC) later. It is the same path with the swap direction reversed, and it requires approving YES to Permit2. The hook quotes the bid from the current N(d2).
9. **Resolution *(design)*:** after expiry the market settles from the ETH/USDC oracle. If ETH ≥ $4,000, each YES redeems 1 USDC, so Alice gets 32.14 USDC for her 10 USDC. Otherwise YES is worth 0.

The only swap-encoding change if you use UR 2.1.2 (`0xDf38F2…`) is that the struct becomes 6-field: insert `minHopPriceX36` (0 = off) before `hookData`, i.e. `V4Planner` with `URVersion.V2_1_1`.

---

## Commands run (abridged)

```bash
# chain id / head
curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' https://sepolia.unichain.org
# -> {"jsonrpc":"2.0","result":"0x515","id":1}
python3 scratchpad/unisep/rpccheck.py scratchpad/unisep/cfg.json   # eth_getCode + block sampling, 3 chains -> rpccheck.out
CAST=scratchpad/foundry-bin/cast   # cast 1.8.3
$CAST call <UR> 'poolManager()(address)' --rpc-url https://sepolia.unichain.org
$CAST call 0xf969…d664 'permit2()(address)' / 'WETH9()(address)' / 'tokenDescriptor()(address)'
$CAST code <UR> --rpc-url … > ur_*.hex; grep -c 4713c18b ur_*.hex    # per-hop selectors
curl https://unichain-sepolia.blockscout.com/api/v2/smart-contracts/<addr>   # verified sources
curl https://unichain-sepolia.blockscout.com/api/v2/addresses/<pm>/counters  # activity
curl -L https://developers.uniswap.org/deployments.json                      # Stack B listing
curl -L https://developers.uniswap.org/llms.mdx/docs/protocols/v4/deployments
curl -L https://developers.uniswap.org/llms.mdx/docs/unichain/tools/faucets
# 5- vs 6-field probe (calldata in scratchpad/unisep/calldata_{5,6}field.hex)
$CAST abi-encode "f(((address,address,uint24,int24,address),bool,uint128,uint128,bytes))" "(KEY,true,1000,0,0x)"
$CAST abi-encode "f(((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes))" "(KEY,true,1000,0,4294967295,0x)"
$CAST calldata "execute(bytes,bytes[],uint256)" 0x10 "[abi.encode(0x06,[P])]" 99999999999   # then eth_call per router
```

## UNVERIFIED items
- Which UR and stack the hosted Trading API actually returns for 1301 (the API needs a key). This does not matter for our custom calldata path.
- Whether faucet.circle.com's dropdown currently includes Unichain Sepolia. Uniswap docs and Circle's address page say USDC exists there, but the faucet list was not rendered.
- Alchemy faucet drip size and requirements (from a search snippet only).
- Source of `0x7F9B8D…` (Stack B UR). It is not verified on Blockscout; the 5-field layout is inferred from bytecode and the probe.
- Why two v4 stacks exist on 1301. The facts are on-chain; the reason is not known.
