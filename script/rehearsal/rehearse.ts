/**
 * Demo rehearsal on the local anvil fork started by script/local-env.sh (node >= 22.18, run with `make rehearse`).
 *
 * Two fresh EOAs, Alice and Bob, get ETH and Circle USDC through anvil cheats. On the newest keeper market with enough
 * time left, Alice buys YES and Bob buys NO for REHEARSAL_USDC each and Alice sells half her YES. Every trade is an
 * exact-in swap quoted by the deployed V4Quoter and sent through UniversalRouter 2.0 with the Permit2 flow the web app
 * uses (ERC-20 approve of Permit2 once, then a signed PermitSingle), all built by packages/swap-sdk. The script then
 * waits for expiry, checks that the keeper bot settles the market, recomputes the outcome from the oracle's
 * tick-cumulative TWAP, and has the winner redeem by swapping the winning token for exactly 1 USDC each.
 *
 * After every step it asserts the SPEC §3.2 ledger (claims, supplies, outstanding, solvency, the global
 * sum(bucket) + vaultIdle identity, all read at one block) and at the end that USDC is conserved between the traders
 * and the hook. Settings: PREDICTION_DEPLOYMENT (deployments/local.json), RPC_URL, REHEARSAL_USDC (10),
 * REHEARSAL_MIN_SECONDS (25 s of trading left), REHEARSAL_SELF_SETTLE (1 settles if the keeper has not after 45 s).
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Abi,
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  pad,
  parseAbi,
  parseEventLogs,
  parseUnits,
  toHex,
  type TransactionReceipt,
} from 'viem'
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import { unichainSepolia } from 'viem/chains'
import {
  autoSlippageBps,
  buildPermitSingle,
  buildSwap,
  erc20ApproveTx,
  estimateSwapGas,
  gasWithHeadroom,
  findPredictionRoute,
  isPlaceholderAddress,
  listMarkets,
  type Market,
  minOutWithSlippage,
  parseDeployment,
  PredictionSwapError,
  permitTypedData,
  predictionHookAbi,
  quoteExactIn,
  readAllowances,
  requireHook,
} from '../../packages/swap-sdk/src/index.ts'
import {
  avgPriceWad,
  E6,
  fiatTokenBalanceSlot,
  fmtTokens,
  fmtUsdc,
  fmtWad,
  globalViolation,
  ledgerViolations,
  sigmaFromVarE36,
  twapUsd,
  usdFromLnWad,
} from './lib.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEPLOYMENT_FILE = resolve(process.env['PREDICTION_DEPLOYMENT'] ?? join(ROOT, 'deployments/local.json'))
const TRADE_USDC = parseUnits(process.env['REHEARSAL_USDC'] ?? '10', 6)
const MIN_TRADING_SECONDS = Number(process.env['REHEARSAL_MIN_SECONDS'] ?? 25)
const MARKET_WAIT_SECONDS = 150
const SETTLE_WAIT_SECONDS = 45
const SELF_SETTLE = process.env['REHEARSAL_SELF_SETTLE'] === '1'

const oracleAbi = parseAbi([
  'function lnSpotSoBWad() view returns (int256)',
  'function cumulativeAt(uint32 t) view returns (int56)',
  'function decimalsShift() view returns (int16)',
])
const hookExtraAbi = parseAbi(['function settleThresholdOf(uint256 marketId) view returns (int256)'])
const erc6909Abi = parseAbi(['function balanceOf(address owner, uint256 id) view returns (uint256)'])

if (!existsSync(DEPLOYMENT_FILE)) {
  console.error(`missing ${DEPLOYMENT_FILE}: start the local environment first (make local-env)`)
  process.exit(1)
}
const rawDeployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8')) as Record<string, unknown>
const deployment = parseDeployment(rawDeployment)
const hook = requireHook(deployment)
const usdc = deployment.usdc
const poolManager = deployment.poolManager
const oracle = getAddress(String(rawDeployment['underlyingOracle']))
const rpc = process.env['RPC_URL'] ?? String(rawDeployment['rpcUrl'] ?? 'http://127.0.0.1:8545')

const chain = defineChain({ ...unichainSepolia, rpcUrls: { default: { http: [rpc] } } })
const transport = http(rpc)
const pub = createPublicClient({ chain, transport, pollingInterval: 250 })
const testClient = createTestClient({ chain, mode: 'anvil', transport })
const wallet = createWalletClient({ chain, transport })

const hookErrors = loadHookErrors()

interface Actor {
  name: string
  account: PrivateKeyAccount
  usdcStart: bigint
}

let market: Market
let budget = 0n
/** USDC the traders paid into this market minus what they took out, while it trades. */
let netIntoMarket = 0n
let lastChainTime = 0

/* Output */

function say(who: string, msg: string): void {
  const left = market ? Number(market.info.expiry) - lastChainTime : undefined
  const clock = left === undefined ? '      ' : left >= 0 ? `T-${String(left).padStart(3)}s` : `T+${String(-left).padStart(3)}s`
  console.log(`${clock}  ${who.padEnd(7)} ${msg}`)
}

function section(title: string): void {
  console.log(`\n== ${title}`)
}

const short = (h: string): string => `${h.slice(0, 10)}…`

/* Chain helpers */

function loadHookErrors(): Abi {
  const artifact = join(ROOT, 'out/PredictionHook.sol/PredictionHook.json')
  if (!existsSync(artifact)) return []
  const abi = (JSON.parse(readFileSync(artifact, 'utf8')) as { abi: Abi }).abi
  return abi.filter((x) => x.type === 'error')
}

async function chainTime(): Promise<number> {
  lastChainTime = Number((await pub.getBlock()).timestamp)
  return lastChainTime
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function send(actor: Actor, tx: { to: Address; data: Hex; value?: bigint; gas?: bigint }): Promise<TransactionReceipt> {
  const hash = await wallet.sendTransaction({ account: actor.account, chain, to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: tx.gas })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  assert.equal(receipt.status, 'success', `${actor.name} transaction ${hash} reverted`)
  return receipt
}

const balanceOf = (token: Address, owner: Address, blockNumber?: bigint) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner], blockNumber })

function symbolOf(token: Address): string {
  if (token.toLowerCase() === usdc.toLowerCase()) return 'USDC'
  return token.toLowerCase() === market.yes.address.toLowerCase() ? 'YES' : 'NO'
}

async function fund(actor: Actor, usdcAmount: bigint): Promise<void> {
  const a = actor.account.address
  await testClient.setBalance({ address: a, value: 10n ** 18n })
  await testClient.setStorageAt({ address: usdc, index: fiatTokenBalanceSlot(a), value: pad(toHex(usdcAmount)) })
  actor.usdcStart = await balanceOf(usdc, a)
  assert.equal(actor.usdcStart, usdcAmount, 'USDC funding through the FiatToken balance slot failed')
}

/* Market views */

async function readInfo(blockNumber?: bigint) {
  return pub.readContract({ address: hook, abi: predictionHookAbi, functionName: 'marketInfo', args: [market.id], blockNumber })
}

async function marketLine(): Promise<string> {
  const [q, lnSpot] = await Promise.all([
    pub.readContract({ address: hook, abi: predictionHookAbi, functionName: 'quote', args: [market.id] }),
    pub.readContract({ address: oracle, abi: oracleAbi, functionName: 'lnSpotSoBWad' }),
  ])
  if (q.midYes === 0n) return `ETH $${usdFromLnWad(lnSpot).toFixed(2)} | quotes off (tau ${q.tau}s)`
  return (
    `ETH $${usdFromLnWad(lnSpot).toFixed(2)} vs K $${market.strikeUsd.toFixed(2)} | ` +
    `YES mid ${fmtWad(q.midYes)} ask ${fmtWad(q.askYes)} bid ${fmtWad(q.bidYes)} | ` +
    `NO ask ${fmtWad(q.askNo)} bid ${fmtWad(q.bidNo)} | sigma ${(sigmaFromVarE36(q.varE36) * 100).toFixed(1)}% | ` +
    `tau ${q.tau}s${q.tradable ? '' : ' | closed'}`
  )
}

async function pickMarket(): Promise<Market> {
  const deadline = Date.now() + MARKET_WAIT_SECONDS * 1000
  let waited = false
  for (;;) {
    const now = await chainTime()
    const markets = await listMarkets(pub, { hook, limit: 4 })
    const fresh = markets
      .filter((m) => m.status === 'Trading' && m.quote?.tradable)
      .filter((m) => m.info.outYes === 0n && m.info.outNo === 0n && m.info.invYes === 0n && m.info.invNo === 0n)
      .filter((m) => Number(m.cutoff) - now >= MIN_TRADING_SECONDS)
      .sort((a, b) => Number(b.id - a.id))
    if (fresh[0]) return fresh[0]
    if (Date.now() > deadline) {
      throw new Error('no fresh market with enough trading time: is the keeper running? (script/bots.sh status local)')
    }
    if (!waited) {
      say('script', `waiting for a keeper market with at least ${MIN_TRADING_SECONDS}s of trading left`)
      waited = true
    }
    await sleep(1000)
  }
}

/* Consistency checks */

interface Totals {
  block: bigint
  hookUsdcClaims: bigint
}

async function checkLedger(label: string, actors: Actor[]): Promise<Totals> {
  const block = await pub.getBlockNumber()
  const [info, yesSupply, noSupply, hookYesClaims, hookNoClaims, count, idle, hookUsdcClaims] = await Promise.all([
    readInfo(block),
    pub.readContract({ address: market.yes.address, abi: erc20Abi, functionName: 'totalSupply', blockNumber: block }),
    pub.readContract({ address: market.no.address, abi: erc20Abi, functionName: 'totalSupply', blockNumber: block }),
    pub.readContract({ address: poolManager, abi: erc6909Abi, functionName: 'balanceOf', args: [hook, BigInt(market.yes.address)], blockNumber: block }),
    pub.readContract({ address: poolManager, abi: erc6909Abi, functionName: 'balanceOf', args: [hook, BigInt(market.no.address)], blockNumber: block }),
    pub.readContract({ address: hook, abi: predictionHookAbi, functionName: 'marketCount', blockNumber: block }),
    pub.readContract({ address: hook, abi: predictionHookAbi, functionName: 'vaultIdle', blockNumber: block }),
    pub.readContract({ address: poolManager, abi: erc6909Abi, functionName: 'balanceOf', args: [hook, BigInt(usdc)], blockNumber: block }),
  ])
  let holdersYes = 0n
  let holdersNo = 0n
  for (const a of actors) {
    holdersYes += await balanceOf(market.yes.address, a.account.address, block)
    holdersNo += await balanceOf(market.no.address, a.account.address, block)
  }
  const violations = ledgerViolations({
    status: info.status,
    yesWon: info.yesWon,
    bucket: info.bucket,
    outYes: info.outYes,
    outNo: info.outNo,
    invYes: info.invYes,
    invNo: info.invNo,
    yesSupply,
    noSupply,
    hookYesClaims,
    hookNoClaims,
    holdersYes,
    holdersNo,
  })
  if (info.status === 1 && info.bucket !== budget + netIntoMarket) {
    violations.push(`bucket ${info.bucket} != budget ${budget} + net trader USDC ${netIntoMarket}`)
  }
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1))
  const all = await pub.multicall({
    contracts: ids.map((id) => ({ address: hook, abi: predictionHookAbi, functionName: 'marketInfo', args: [id] }) as const),
    allowFailure: false,
    blockNumber: block,
    multicallAddress: deployment.multicall3,
  })
  const global = globalViolation(
    all.map((m) => m.bucket),
    idle,
    hookUsdcClaims,
  )
  if (global) violations.push(global)
  if (violations.length) throw new Error(`ledger check "${label}" failed at block ${block}:\n  ${violations.join('\n  ')}`)
  const required = info.status === 1 ? (info.outYes > info.outNo ? info.outYes : info.outNo) : info.yesWon ? info.outYes : info.outNo
  say(
    'ledger',
    `ok after ${label}: bucket ${fmtUsdc(info.bucket)} >= required ${fmtUsdc(required)} ` +
      `(outYes ${fmtTokens(info.outYes)}, outNo ${fmtTokens(info.outNo)}, inventory ${fmtTokens(info.invYes)}/${fmtTokens(info.invNo)}); ` +
      `sum(bucket) + idle = hook USDC claims = ${fmtUsdc(hookUsdcClaims)} over ${count} markets`,
  )
  return { block, hookUsdcClaims }
}

/* Trading */

interface Fill {
  out: bigint
  quoted: bigint
  minOut: bigint
  receipt: TransactionReceipt
}

async function swapExactIn(
  actor: Actor,
  p: { tokenIn: Address; tokenOut: Address; amountIn: bigint; exactPrice?: boolean },
): Promise<Fill> {
  const route = findPredictionRoute([market], { tokenIn: p.tokenIn, tokenOut: p.tokenOut })
  assert.ok(route, 'no prediction route')
  const inSym = symbolOf(p.tokenIn)
  const outSym = symbolOf(p.tokenOut)
  const owner = actor.account.address

  let now = await chainTime()
  const allowance = await readAllowances(pub, { owner, token: p.tokenIn, amount: p.amountIn, now })
  if (allowance.needsErc20Approval) {
    const r = await send(actor, erc20ApproveTx({ token: p.tokenIn }))
    say(actor.name, `approves Permit2 for ${inSym} (one-time ERC-20 approval, tx ${short(r.transactionHash)})`)
  }
  let permit
  if (allowance.needsPermit) {
    now = await chainTime()
    const single = buildPermitSingle({ token: p.tokenIn, nonce: allowance.permit2Nonce, now })
    const signature = await actor.account.signTypedData(permitTypedData(single))
    permit = { permit: single, signature }
    say(actor.name, `signs a Permit2 PermitSingle for ${inSym} -> UniversalRouter 2.0 (no transaction)`)
  }

  now = await chainTime()
  const q = await quoteExactIn(pub, {
    poolKey: route.poolKey,
    zeroForOne: route.zeroForOne,
    amount: p.amountIn,
    account: owner,
    extraErrors: hookErrors,
  })
  const secondsToWindow = Number(market.info.expiry) - market.info.window - now
  const bps = p.exactPrice
    ? 0
    : autoSlippageBps({ exactIn: true, isBuy: route.isBuy, amountIn: p.amountIn, amountOut: q.amountOut, secondsToWindow })
  const minOut = minOutWithSlippage(q.amountOut, bps)
  const tx = buildSwap({
    poolKey: route.poolKey,
    zeroForOne: route.zeroForOne,
    tradeType: 'EXACT_INPUT',
    amount: p.amountIn,
    limit: minOut,
    deadline: BigInt(now + 300),
    permit,
  })
  const gas = gasWithHeadroom(await estimateSwapGas(pub, { tx, account: owner, extraErrors: hookErrors }))
  const [in0, out0] = await Promise.all([balanceOf(p.tokenIn, owner), balanceOf(p.tokenOut, owner)])
  const receipt = await send(actor, { ...tx, gas })
  const [in1, out1] = await Promise.all([balanceOf(p.tokenIn, owner), balanceOf(p.tokenOut, owner)])
  await chainTime()

  const out = out1 - out0
  assert.equal(in0 - in1, p.amountIn, `${actor.name} paid a different ${inSym} amount`)
  assert.ok(out >= minOut, `${actor.name} received ${out} < min ${minOut}`)
  const trades = parseEventLogs({ abi: predictionHookAbi, eventName: 'Trade', logs: receipt.logs })
  assert.equal(trades.length, 1, 'one Trade event')
  const t = trades[0]!.args
  assert.equal(t.marketId, market.id)
  assert.equal(t.isBuy, route.isBuy)
  assert.equal(t.qty, route.isBuy ? out : p.amountIn, 'Trade.qty matches the token amount')
  assert.equal(t.usdcAmount, route.isBuy ? p.amountIn : out, 'Trade.usdcAmount matches the USDC amount')

  const usdcAmt = route.isBuy ? p.amountIn : out
  const tokAmt = route.isBuy ? out : p.amountIn
  const verb = route.isBuy ? 'buys' : 'sells'
  say(
    actor.name,
    `${verb} ${fmtTokens(tokAmt)} ${route.isBuy ? outSym : inSym} for ${fmtUsdc(usdcAmt)} USDC at ${fmtWad(avgPriceWad(usdcAmt, tokAmt))} avg ` +
      `(quoted ${route.isBuy ? fmtTokens(q.amountOut) : fmtUsdc(q.amountOut)}, bound ${(bps / 100).toFixed(1)}%, ` +
      `UR commands ${tx.commands}, gas ${receipt.gasUsed}, tx ${short(receipt.transactionHash)})`,
  )
  netIntoMarket += route.isBuy ? p.amountIn : -out
  return { out, quoted: q.amountOut, minOut, receipt }
}

async function expectClosed(actor: Actor, tokenIn: Address, tokenOut: Address, amount: bigint, why: string) {
  const route = findPredictionRoute([market], { tokenIn, tokenOut })
  assert.ok(route)
  try {
    await quoteExactIn(pub, { poolKey: route.poolKey, zeroForOne: route.zeroForOne, amount, extraErrors: hookErrors })
  } catch (e) {
    assert.ok(e instanceof PredictionSwapError, `unexpected error ${String(e)}`)
    assert.equal(e.code, 'MARKET_CLOSED', `expected MARKET_CLOSED, got ${e.code} (${e.revert?.path.join(' -> ')})`)
    say(actor.name, `${why}: V4Quoter refuses (${e.revert?.path.join(' -> ')})`)
    return
  }
  throw new Error(`${why}: the quote unexpectedly succeeded`)
}

/* Main */

async function main(): Promise<void> {
  const version = await pub.request({ method: 'web3_clientVersion' })
  if (!String(version).toLowerCase().includes('anvil')) {
    throw new Error(`${rpc} is ${version}, not anvil: the rehearsal funds actors with anvil cheats and runs only on the local fork`)
  }
  assert.equal(await pub.getChainId(), 1301, 'the local fork must keep chain id 1301')
  // The hook has no keeper role (an ownerless MarketScheduler owns it, and open()/settle() are permissionless), so
  // "the keeper bot" is identified by the account script/local-env.sh started it with, not by an on-chain role.
  const keeperRaw = rawDeployment['keeper']
  if (typeof keeperRaw !== 'string' || isPlaceholderAddress(keeperRaw)) {
    throw new Error(`${DEPLOYMENT_FILE} has no "keeper" address: start the local environment first (make local-env)`)
  }
  const keeper = getAddress(keeperRaw)

  section('Setup')
  say('script', `deployment ${DEPLOYMENT_FILE}`)
  say('script', `PredictionHook ${hook}, oracle ${oracle}, keeper ${keeper}, RPC ${rpc}`)
  const alice: Actor = { name: 'Alice', account: privateKeyToAccount(generatePrivateKey()), usdcStart: 0n }
  const bob: Actor = { name: 'Bob', account: privateKeyToAccount(generatePrivateKey()), usdcStart: 0n }
  const actors = [alice, bob]
  for (const a of actors) {
    await fund(a, 5n * TRADE_USDC)
    say(a.name, `fresh EOA ${a.account.address} with 1 ETH and ${fmtUsdc(a.usdcStart)} Circle USDC`)
  }

  market = await pickMarket()
  await chainTime()
  const params = await pub.readContract({ address: hook, abi: predictionHookAbi, functionName: 'marketParams', args: [market.id] })
  budget = params.budget
  section(`Market #${market.id}: ${market.yes.name}`)
  say(
    'market',
    `strike $${market.strikeUsd.toFixed(2)}, expiry ${new Date(Number(market.info.expiry) * 1000).toISOString()}, ` +
      `settles on the ${market.info.window}s TWAP, trading stops at T-${market.info.window + market.info.cutoffBuffer}s, ` +
      `LP budget ${fmtUsdc(budget)} USDC`,
  )
  say('market', `YES ${market.yes.address} (${market.yes.symbol}), NO ${market.no.address} (${market.no.symbol})`)
  say('market', await marketLine())
  const start = await checkLedger('selection', actors)

  section('Trading through UniversalRouter 2.0')
  const aliceBuy = await swapExactIn(alice, { tokenIn: usdc, tokenOut: market.yes.address, amountIn: TRADE_USDC })
  say('market', await marketLine())
  await checkLedger('Alice buys YES', actors)

  await swapExactIn(bob, { tokenIn: usdc, tokenOut: market.no.address, amountIn: TRADE_USDC })
  say('market', await marketLine())
  await checkLedger('Bob buys NO', actors)

  await swapExactIn(alice, { tokenIn: market.yes.address, tokenOut: usdc, amountIn: aliceBuy.out / 2n })
  say('market', await marketLine())
  await checkLedger('Alice sells half her YES', actors)

  section('Cutoff and expiry')
  const cutoff = Number(market.cutoff)
  let lastLine = 0
  while ((await chainTime()) < cutoff) {
    if (lastChainTime - lastLine >= 10) {
      say('market', await marketLine())
      lastLine = lastChainTime
    }
    await sleep(1000)
  }
  await expectClosed(alice, usdc, market.yes.address, E6, 'trading is closed at the cutoff')
  const expiry = Number(market.info.expiry)
  while ((await chainTime()) < expiry) await sleep(1000)
  say('market', 'expired, waiting for the keeper to settle')

  section('Settlement')
  const fromBlock = start.block
  let info = await readInfo()
  while (info.status === 1) {
    if ((await chainTime()) > expiry + SETTLE_WAIT_SECONDS) {
      if (!SELF_SETTLE) throw new Error('the keeper did not settle within 45 s (script/bots.sh status local), or rerun with REHEARSAL_SELF_SETTLE=1')
      say('script', 'keeper is late, settling directly (settle is permissionless)')
      await send(alice, { to: hook, data: encodeFunctionData({ abi: predictionHookAbi, functionName: 'settle', args: [market.id] }) })
    }
    await sleep(1000)
    info = await readInfo()
  }
  assert.equal(info.status, 2, 'market settled (not invalid)')
  const [settledLog] = await pub.getContractEvents({
    address: hook,
    abi: predictionHookAbi,
    eventName: 'MarketSettled',
    args: { marketId: market.id },
    fromBlock,
  })
  assert.ok(settledLog, 'MarketSettled event')
  const settleTx = await pub.getTransaction({ hash: settledLog.transactionHash })
  const byKeeper = settleTx.from.toLowerCase() === keeper.toLowerCase()
  const settleBlock = await pub.getBlock({ blockNumber: settledLog.blockNumber })
  say(
    byKeeper ? 'keeper' : 'script',
    `settled market #${market.id} ${Number(settleBlock.timestamp) - expiry}s after expiry (tx ${short(settledLog.transactionHash)}, from ${settleTx.from})`,
  )
  if (!SELF_SETTLE) assert.ok(byKeeper, 'the keeper bot settled the market')

  const window = market.info.window
  const [cumT, cumTw, shift, threshold] = await Promise.all([
    pub.readContract({ address: oracle, abi: oracleAbi, functionName: 'cumulativeAt', args: [expiry] }),
    pub.readContract({ address: oracle, abi: oracleAbi, functionName: 'cumulativeAt', args: [expiry - window] }),
    pub.readContract({ address: oracle, abi: oracleAbi, functionName: 'decimalsShift' }),
    pub.readContract({ address: hook, abi: hookExtraAbi, functionName: 'settleThresholdOf', args: [market.id] }),
  ])
  const tickSeconds = BigInt(cumT) - BigInt(cumTw)
  assert.equal(settledLog.args.avgNormTickTimesWindow, tickSeconds, 'event carries the oracle tick-seconds sum')
  const yesWon = tickSeconds * 10n ** 18n > threshold
  assert.equal(info.yesWon, yesWon, 'outcome matches the integer rule D * 1e18 > threshold')
  say(
    'oracle',
    `TWAP over [T-${window}s, T] = $${twapUsd(tickSeconds, window, shift).toFixed(4)} vs strike $${market.strikeUsd.toFixed(2)} ` +
      `(tick-seconds ${tickSeconds}, threshold ${threshold}) -> ${yesWon ? 'YES' : 'NO'} wins`,
  )
  await checkLedger('settlement', actors)

  section('Redemption through the same swap path')
  const winner = yesWon ? alice : bob
  const loser = yesWon ? bob : alice
  const winTok = yesWon ? market.yes.address : market.no.address
  const loseTok = yesWon ? market.no.address : market.yes.address
  const held = await balanceOf(winTok, winner.account.address)
  assert.ok(held > 0n, `${winner.name} holds winning tokens`)
  const redeem = await swapExactIn(winner, { tokenIn: winTok, tokenOut: usdc, amountIn: held, exactPrice: true })
  assert.equal(redeem.quoted, held, 'V4Quoter prices the winning token at exactly 1.0')
  assert.equal(redeem.out, held, 'winner receives exactly 1 USDC per token')
  const loserHeld = await balanceOf(loseTok, loser.account.address)
  if (loserHeld > 0n) await expectClosed(loser, loseTok, usdc, loserHeld, `${loser.name}'s losing ${symbolOf(loseTok)} cannot be sold`)
  const end = await checkLedger('redemption', actors)

  section('Summary')
  let tradersNet = 0n
  for (const a of actors) {
    const endUsdc = await balanceOf(usdc, a.account.address)
    const [y, n] = await Promise.all([balanceOf(market.yes.address, a.account.address), balanceOf(market.no.address, a.account.address)])
    const net = endUsdc - a.usdcStart
    tradersNet += net
    say(a.name, `USDC ${fmtUsdc(a.usdcStart)} -> ${fmtUsdc(endUsdc)} (P&L ${net >= 0n ? '+' : ''}${fmtUsdc(net)}), holds ${fmtTokens(y)} YES, ${fmtTokens(n)} NO`)
  }
  const lpNet = end.hookUsdcClaims - start.hookUsdcClaims
  say('LP', `vault side of market #${market.id}: ${lpNet >= 0n ? '+' : ''}${fmtUsdc(lpNet)} USDC`)
  assert.equal(lpNet, -tradersNet, 'USDC is conserved between the traders and the hook')
  say('script', 'rehearsal passed: quotes, Permit2 swaps, ledger identities, keeper settlement and redemption at 1.0')
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(`\nREHEARSAL FAILED: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  },
)
