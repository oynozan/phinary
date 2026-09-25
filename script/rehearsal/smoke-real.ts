/**
 * Smoke test on the REAL Unichain Sepolia deployment (node >= 22.18): the deployer buys YES with SMOKE_USDC (default 1)
 * on the newest keeper market through UniversalRouter 2.0 + Permit2, then sells half of it back, printing quotes,
 * executed prices and uniscan links. Spends real testnet funds; the key comes from the repo .env and is never printed.
 * Settings: PREDICTION_DEPLOYMENT (deployments/unichain-sepolia.json), RPC_URL (drpc), SMOKE_USDC.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Address, createPublicClient, createWalletClient, erc20Abi, type Hex, http, parseEventLogs, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { unichainSepolia } from 'viem/chains'
import {
  buildPermitSingle,
  buildSwap,
  erc20ApproveTx,
  estimateSwapGas,
  findPredictionRoute,
  gasWithHeadroom,
  listMarkets,
  type Market,
  minOutWithSlippage,
  parseDeployment,
  permitTypedData,
  predictionHookAbi,
  quoteExactIn,
  readAllowances,
  requireHook,
} from '../../packages/swap-sdk/src/index.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const deployment = parseDeployment(
  JSON.parse(readFileSync(resolve(process.env['PREDICTION_DEPLOYMENT'] ?? join(ROOT, 'deployments/unichain-sepolia.json')), 'utf8')),
)
const hook = requireHook(deployment)
const rpc = process.env['RPC_URL'] ?? 'https://unichain-sepolia.drpc.org'
const account = privateKeyToAccount(env['DEPLOYER_PRIVATE_KEY'] as Hex)
const pub = createPublicClient({ chain: unichainSepolia, transport: http(rpc) })
const wallet = createWalletClient({ chain: unichainSepolia, transport: http(rpc), account })
const usdc = deployment.usdc as Address
const tx = (h: Hex) => `https://sepolia.uniscan.xyz/tx/${h}`
const fmt6 = (x: bigint) => (Number(x) / 1e6).toFixed(4)

async function send(t: { to: Address; data: Hex; value?: bigint; gas?: bigint }) {
  const hash = await wallet.sendTransaction({ to: t.to, data: t.data, value: t.value ?? 0n, gas: t.gas })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`reverted ${tx(hash)}`)
  return r
}

async function swapExactIn(market: Market, tokenIn: Address, tokenOut: Address, amountIn: bigint, label: string) {
  const route = findPredictionRoute([market], { tokenIn, tokenOut })
  if (!route) throw new Error('no route')
  const now = Math.floor(Date.now() / 1000)
  const al = await readAllowances(pub, { owner: account.address, token: tokenIn, amount: amountIn, now })
  if (al.needsErc20Approval) console.log(`  approve Permit2: ${tx((await send(erc20ApproveTx({ token: tokenIn }))).transactionHash)}`)
  let permit
  if (al.needsPermit) {
    const single = buildPermitSingle({ token: tokenIn, nonce: al.permit2Nonce, now })
    permit = { permit: single, signature: await account.signTypedData(permitTypedData(single)) }
  }
  const q = await quoteExactIn(pub, { poolKey: route.poolKey, zeroForOne: route.zeroForOne, amount: amountIn, account: account.address })
  const minOut = minOutWithSlippage(q.amountOut, 3000)
  const t = buildSwap({
    poolKey: route.poolKey,
    zeroForOne: route.zeroForOne,
    tradeType: 'EXACT_INPUT',
    amount: amountIn,
    limit: minOut,
    deadline: BigInt(now + 120),
    permit,
  })
  const gas = gasWithHeadroom(await estimateSwapGas(pub, { tx: t, account: account.address }))
  const r = await send({ ...t, gas })
  const trade = parseEventLogs({ abi: predictionHookAbi, eventName: 'Trade', logs: r.logs })[0]!.args
  console.log(
    `  ${label}: qty ${fmt6(trade.qty)} tokens, ${fmt6(trade.usdcAmount)} USDC, avg ${(Number(trade.avgPriceWad) / 1e18).toFixed(4)} ` +
      `(quoted out ${fmt6(q.amountOut)}), gas ${r.gasUsed}\n    ${tx(r.transactionHash)}`,
  )
  return route.isBuy ? trade.qty : trade.usdcAmount
}

const amount = parseUnits(process.env['SMOKE_USDC'] ?? '1', 6)
console.log(`deployer ${account.address}, USDC ${fmt6(await pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }))}`)
let market: Market | undefined
for (let i = 0; i < 90 && !market; i++) {
  const now = Math.floor(Date.now() / 1000)
  const ms = await listMarkets(pub, { hook, limit: 3 })
  market = ms.find((m) => m.status === 'Trading' && Number(m.info.expiry) - m.info.window - m.info.cutoffBuffer - now >= 25)
  if (!market) await new Promise((r) => setTimeout(r, 2000))
}
if (!market) throw new Error('no market with enough trading time')
const q = await pub.readContract({ address: hook, abi: predictionHookAbi, functionName: 'quote', args: [market.id] })
console.log(`market #${market.id} ${market.yes.symbol}: YES mid ${(Number(q.midYes) / 1e18).toFixed(4)} ask ${(Number(q.askYes) / 1e18).toFixed(4)} bid ${(Number(q.bidYes) / 1e18).toFixed(4)}`)
const bought = await swapExactIn(market, usdc, market.yes.address, amount, 'buy YES ')
await swapExactIn(market, market.yes.address, usdc, bought / 2n, 'sell YES')
console.log('smoke test passed')
