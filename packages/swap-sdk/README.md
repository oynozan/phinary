# @phinary/swap-sdk

This package quotes and trades PredictionHook YES/NO markets on Unichain Sepolia (chain 1301) through the official Uniswap
contracts: **V4Quoter** for prices and **UniversalRouter 2.0** (`0xf70536b3…6be5d`, 5-field `ExactInputSingleParams`) for
swaps, with Permit2.
- It is TypeScript and depends only on viem 2.49, so it runs in Node 22.18+ and in the browser.
- The Uniswap web-app fork uses a vendored copy (`scripts/vendor-interface.mjs`), and the bot or a custom page can import it
  directly.

## Usage

```ts
import { createPublicClient, http } from 'viem'
import { unichainSepolia } from 'viem/chains'
import {
  buildPermitSingle, buildSwap, estimateSwapGas, findPredictionRoute, listMarkets, minOutWithSlippage, permitTypedData,
  quoteExactIn, readAllowances, erc20ApproveTx, requireHook, UNICHAIN_SEPOLIA, UNICHAIN_SEPOLIA_RPC_URL,
} from '@phinary/swap-sdk'
import { loadDeployment } from '@phinary/swap-sdk/node' // Node only: reads <repo>/deployments/unichain-sepolia.json

// `account` is the trader's address and `wallet` a viem WalletClient for it.
const client = createPublicClient({ chain: unichainSepolia, transport: http(UNICHAIN_SEPOLIA_RPC_URL) })
const hook = requireHook(loadDeployment())
const markets = await listMarkets(client, { hook, limit: 20 })            // marketCount / marketInfo / poolKeys / quote
const route = findPredictionRoute(markets, { tokenIn: UNICHAIN_SEPOLIA.usdc, tokenOut: markets[0].yes.address })!

const q = await quoteExactIn(client, { poolKey: route.poolKey, zeroForOne: route.zeroForOne, amount: 10_000_000n, account })
const allowance = await readAllowances(client, { owner: account, token: UNICHAIN_SEPOLIA.usdc, amount: q.amountIn })
if (allowance.needsErc20Approval) await wallet.sendTransaction(erc20ApproveTx({ token: UNICHAIN_SEPOLIA.usdc }))
const permit = allowance.needsPermit ? buildPermitSingle({ token: UNICHAIN_SEPOLIA.usdc, nonce: allowance.permit2Nonce }) : undefined
const signature = permit && (await wallet.signTypedData(permitTypedData(permit)))

const tx = buildSwap({
  poolKey: route.poolKey, zeroForOne: route.zeroForOne, tradeType: 'EXACT_INPUT',
  amount: q.amountIn, limit: minOutWithSlippage(q.amountOut, 100), deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  permit: permit && { permit, signature: signature! },
})
await estimateSwapGas(client, { tx, account })   // throws PredictionSwapError (code SLIPPAGE, MARKET_CLOSED, …) on revert
await wallet.sendTransaction(tx)
```

`minOutWithSlippage(q.amountOut, 100)` (1%) suits long-dated markets only. The hook reprices every block from time to
expiry, and near the money a binary's mid moves by about `0.4 * sqrt(dt / (tau - window))` whatever sigma is (SPEC §3.3):
10-16 cents over the 2-5 s of a wallet confirmation in a 60 s market. `autoSlippageBps({ exactIn, isBuy, amountIn,
amountOut, secondsToWindow })` sizes the tolerance to a 2-sigma move over 5 s at this trade's price (1-90%), with
`secondsToWindow = expiry - window - now` from `marketInfo`.

Every quote or simulation failure becomes a `PredictionSwapError`:
- `code` is one of `NO_ROUTE`, `MARKET_CLOSED`, `OUT_OF_BAND`, `CAPACITY`, `AMOUNT_TOO_LOW`, `ORACLE`, `SLIPPAGE`,
  `DEADLINE`, `ALLOWANCE`, `SIGNATURE`, `BALANCE` or `UNKNOWN`;
- `revert` holds the decoded chain, for example `UnexpectedRevertBytes -> WrappedError(hook) -> Band`;
- `decodeRevert(data, extraErrors)` accepts extra hook error ABIs.

## Deployment file

`parseDeployment` and `loadDeployment` accept a flat layout or one nested under `contracts`/`addresses`. They recognise
common key spellings:
- `predictionHook` (also `PredictionHook`, `hook`);
- `underlyingOracle` (also `UnderlyingOracleHook`, `oracle`);
- `usdc`, `poolManager`, `v4Quoter`, `universalRouter`, `permit2`, `deployBlock`.

Placeholders are tolerated: missing values, `""`, `"TBD"`, `0x0…0` and `0xf…f`. Uniswap addresses fall back to the
Stack A defaults, and our own addresses become `undefined`. The Stack B router `0x8B84…1E6b` is rejected.

```json
{ "chainId": 1301, "predictionHook": "0x…", "underlyingOracle": "0x…", "usdc": "0x31d0220469e10c4E71834a79b1f276d740d3768F", "deployBlock": 63600000 }
```

## Scripts

| Command | What it does |
|---|---|
| `bun install` (or `npm install`) | Installs viem, typescript and @types/node locally |
| `npm test` | 42 unit tests (`node --test`); see the table below |
| `npm run test:fork` | Starts anvil forking 1301 (needs network and `anvil`), then runs 4 end-to-end tests against the real contracts: hookless pool, first-time ERC20 approve + signed `PERMIT2_PERMIT + V4_SWAP` exact-in (output equals the quote), exact-out without a permit, slippage and deadline reverts decoded, uninitialised pool -> `NO_ROUTE` |
| `SWAP_SDK_HOOK_OUT=<forge out/> npm run test:hook` | Anvil fork of 1301 with a real `PredictionHook` build: CREATE2-mines the hook to its flag address, deploys `MockUSDC` and `MockOracle` from the same `out/`, funds the vault and creates a market, then runs 9 tests through the deployed V4Quoter and UR 2.0: registry reads, first-time buy exact-in (approve + signed permit), buy exact-out, OutcomeToken sell with only a signed permit, sell exact-out, hook reverts decoded by name, `NotTradable` at the cutoff, redemption sell after `settle` and a refused losing-token sell. Prints gas used per swap |
| `npm run typecheck` | `tsc --noEmit` (strict, with `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature`, as in the fork) |
| `npm run gen:abi` | Regenerates `src/abi/*.generated.ts` from `../../out`. Run it after `forge build` once `PredictionHook.sol` exists, so its custom errors decode by name |
| `node scripts/vendor-interface.mjs` | Copies `src/` into `interface/packages/uniswap/src/features/predictionMarkets/sdk` and writes the fork's `deployment.generated.ts` |

What the unit tests cover:

| Test file | Checks |
|---|---|
| `encoding.test.ts` | UR 2.0 calldata equals `RoutePlanner` + `V4Planner(URVersion.V2_0)` from the interface's `node_modules`, byte for byte, for exact-in/out, both token orders, with and without permit. Also the PermitSingle EIP-712 hash vs `AllowanceTransfer.getPermitData` and `poolId` vs `Pool.getPoolId` |
| `errors.test.ts` | Revert decoding; core PoolManager/router errors are never read as a market state |
| `slippage.test.ts` | `autoSlippageBps`: time-to-window and price-level scaling, floors and caps, all four trade shapes |
| `markets.test.ts` | `listMarkets`, `resolveOutcomeToken`, quoting and allowances over a mocked chain |
| `deployments.test.ts` | Deployment parsing |
| `abi.test.ts` | ABI drift vs the Foundry build |
