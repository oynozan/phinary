/**
 * End-to-end rehearsal of the sealed-oracle design on a plain anvil, not a fork. Run `forge build` first, then
 * `node script/rehearsal/sealed-e2e.ts` with Node 24 and `npm ci` done in bot/ and script/rehearsal/. SEED replays the
 * random swaps and ANVIL_BIN picks the anvil binary.
 *
 * The script starts its own anvil and pins every block to exactly 1 s after its parent with
 * anvil_setBlockTimestampInterval, since SealedPoolOracle requires it. It deploys in automine, then mines one block per
 * second as `anvil --block-time 1` does. It deploys a PoolManager, a demo USDC and a hookless native ETH/USDC pool with
 * full-range liquidity (fee 500, spacing 10), SealedPoolOracle on that pool with the parameters of
 * test/integration/SealedUnichainFork.t.sol, and the MarketScheduler that owns a PredictionHook reading that oracle,
 * whose CREATE2 salt is mined for flags 0x2AA8. The hook's vault gets 200 USDC.
 *
 * The sealed bot of bot/src/sealed.ts runs in-process, poking each new block and proving every block no seal covers. A
 * trader swaps random sizes through PoolSwapTest every one to three blocks, so many seals break and leave gaps to
 * prove. The keeper of bot/src/keeper.ts opens two markets through `scheduler.open()`, and in each Alice buys UP and
 * Bob buys DOWN through PoolSwapTest.
 *
 * In market 1 the bot stops just before the settlement window while the swaps go on. Past expiry `settle` must revert
 * with ObservationUnavailable(expiry), keep reverting after each small proof batch until the frontier covers
 * [T - window, T), and then succeed.
 *
 * Market 2 runs the recovery path of an outage longer than 8191 blocks. EIP-2935 is replaced by code that returns zero
 * and the bot stays down from before the window until 300 blocks have passed, so neither BLOCKHASH nor the history
 * contract knows the missing blocks. A restarted bot must store their hashes with checkpointHeaders, then prove them.
 *
 * For both markets the settled tick sum and yesWon must match a brute-force sum of the end-of-block pool ticks recorded
 * for every block with a timestamp in [T - window, T), and redeem must pay the winner 1 USDC per token. At the end
 * every Sealed and Proven event must equal the pool's end-of-block tick, the applied blocks must be contiguous up to
 * the frontier, and every block must be 1 s after its parent. Any failure exits non-zero.
 */
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import {
  type Abi,
  type Address,
  BaseError,
  concatHex,
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  type Hex,
  http,
  keccak256,
  maxUint256,
  numberToHex,
  parseAbi,
  parseEventLogs,
  type TransactionReceipt,
  zeroAddress,
  zeroHash,
} from 'viem'
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import { makeClients } from '../../bot/src/chain.ts'
import { invalidAfterFor, Keeper } from '../../bot/src/keeper.ts'
import { createLogger, errMsg } from '../../bot/src/log.ts'
import { varE36FromAnnualVol } from '../../bot/src/market.ts'
import {
  decodeSlot0,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  type PoolKey,
  poolId,
  poolStateSlot,
  Q96,
  sqrtPriceX96FromPrice,
} from '../../bot/src/pricing.ts'
import { HISTORY_ADDRESS } from '../../bot/src/proof.ts'
import { SealedBot, type SealedTick } from '../../bot/src/sealed.ts'
import { ANVIL_KEY, findAnvil, freePort, waitForRpc } from '../../bot/test/helpers/anvil.ts'
import { type Artifact, loadArtifact } from '../../bot/test/helpers/artifacts.ts'
import { fmtTokens, fmtUsdc, fmtWad, sigmaFromVarE36, twapUsd, usdFromLnWad, WAD } from './lib.ts'

const CHAIN_ID = 31337
const CREATE2_FACTORY: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const PREDICTION_FLAGS = 0x2aa8n
const ALL_HOOK_MASK = 0x3fffn
/** Runtime code that returns 32 zero bytes, as EIP-2935 answers for a block past its 8191-block window */
const RETURNS_ZERO: Hex = '0x60206000f3'
const USDC = 1_000_000n
const ETH_PRICE = 2700
const LIQUIDITY = 10n ** 17n
const FULL_RANGE = 887270
const DECIMALS_SHIFT = 12
/** The Task 3 demo scheduler values, with a 10 s period and 40 s tenor so a market runs its course in about 40 blocks */
const CONFIG = {
  period: 10,
  tenor: 40,
  window: 10,
  cutoffBuffer: 2,
  nSamples: 10,
  quote: { h0Wad: 2n * 10n ** 16n, gammaSWad: 2n * 10n ** 13n, lambdaWad: 10n ** 15n, qEpochMax: 100n * USDC, pMinWad: 2n * 10n ** 16n },
  maxBudget: 10n * USDC,
  minBudget: USDC,
  ticker: 'ETH',
}
const VAULT_USDC = 200n * USDC
const TRADE_USDC = 5n * USDC
const NOISE_BLOCKS = 30n
/** The outage must leave the first missing block past BLOCKHASH's 256 plus the bot's 32-block margin */
const OUTAGE_BLOCKS = 300n
/** Swaps lean this much toward one side while a market runs, up in market 1 and down in market 2 */
const DRIFT = 0.25
/** Most blocks the frontier may trail the head while the bot runs */
const MAX_LAG = 16n

const ARTIFACTS = {
  poolManager: ['PoolManager.sol', 'PoolManager'],
  token: ['DemoToken.sol', 'DemoToken'],
  swapRouter: ['PoolSwapTest.sol', 'PoolSwapTest'],
  lpRouter: ['PoolModifyLiquidityTest.sol', 'PoolModifyLiquidityTest'],
  oracle: ['SealedPoolOracle.sol', 'SealedPoolOracle'],
  scheduler: ['MarketScheduler.sol', 'MarketScheduler'],
  hook: ['PredictionHook.sol', 'PredictionHook'],
} as const

const extsloadAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)'])
const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function name() view returns (string)',
])
/** The oracle's revert inside `settle`, which the hook lets through */
const oracleErrors = parseAbi(['error ObservationUnavailable(uint32 t)'])

interface MarketInfo {
  yes: Address
  no: Address
  lnStrikeWad: bigint
  openTime: bigint
  expiry: bigint
  window: number
  status: number
  yesWon: boolean
  bucket: bigint
  outYes: bigint
  outNo: bigint
}

interface Quote {
  tradable: boolean
  tau: bigint
  varE36: bigint
  xWad: bigint
  midYes: bigint
  askYes: bigint
  bidYes: bigint
  askNo: bigint
  bidNo: bigint
}

interface Market {
  id: bigint
  openBlock: bigint
  expiry: bigint
  window: number
  lnStrikeWad: bigint
  strikeCents: bigint
  name: string
  yes: Address
  no: Address
  yesKey: PoolKey
  noKey: PoolKey
}

interface Actor {
  name: string
  key: Hex
  account: PrivateKeyAccount
  address: Address
  wallet: ReturnType<typeof createWalletClient>
}

/* Seeded randomness, so a failing run can be replayed with SEED */

const SEED = Number(process.env['SEED'] ?? Math.floor(Math.random() * 2 ** 31))
let seedState = SEED
function rand(): number {
  seedState = (seedState + 0x6d2b79f5) | 0
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A background loop that can be stopped and restarted, stop() resolves once the running iteration has finished */
class Loop {
  readonly errors: string[] = []
  private readonly body: () => Promise<void>
  private readonly idleMs: () => number
  private running = false
  private done: Promise<void> = Promise.resolve()
  private wake: () => void = () => {}

  constructor(body: () => Promise<void>, idleMs: () => number) {
    this.body = body
    this.idleMs = idleMs
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.done = (async () => {
      while (this.running) {
        try {
          await this.body()
        } catch (e) {
          this.errors.push(errMsg(e))
        }
        if (!this.running) break
        await new Promise<void>((r) => {
          const t = setTimeout(r, this.idleMs())
          this.wake = () => {
            clearTimeout(t)
            r()
          }
        })
      }
    })()
  }

  async stop(): Promise<void> {
    this.running = false
    this.wake()
    await this.done
  }
}

/* Anvil */

let anvilProc: ChildProcess | undefined
/** The sealed bot's log, printed when the run fails */
const botLines: string[] = []

async function startAnvil(): Promise<string> {
  const bin = findAnvil()
  if (!bin) throw new Error('anvil not found: install Foundry or set ANVIL_BIN')
  const port = await freePort()
  anvilProc = spawn(bin, ['--port', String(port), '--silent'], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  await waitForRpc(url)
  return url
}

function stopAnvil(): void {
  anvilProc?.kill()
  anvilProc = undefined
}

function loadArtifacts(): Record<keyof typeof ARTIFACTS, Artifact> {
  const out = {} as Record<keyof typeof ARTIFACTS, Artifact>
  for (const [k, [file, name]] of Object.entries(ARTIFACTS) as [keyof typeof ARTIFACTS, readonly [string, string]][]) {
    const a = loadArtifact(file, name)
    if (!a) throw new Error(`missing out/${file}/${name}.json: run forge build first`)
    out[k] = a
  }
  return out
}

function revertOf(e: unknown): { name: string; args: readonly unknown[] } | undefined {
  if (!(e instanceof BaseError)) return undefined
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError)
  if (!(r instanceof ContractFunctionRevertedError)) return undefined
  return { name: r.data?.errorName ?? r.signature ?? r.reason ?? 'unknown', args: r.data?.args ?? [] }
}

/** The settlement threshold of src/hook/StrikeMath.sol, YES iff tickSum * 1e18 > threshold */
function thresholdOf(lnStrikeWad: bigint, decimalsShift: number, window: number): bigint {
  const LN10_E36 = 2302585092994045684017991454684364208n
  const LN_1_0001_E36 = 99995000333308335333166680951131n
  const strikeTickWad = ((lnStrikeWad * WAD - BigInt(decimalsShift) * LN10_E36) * WAD) / LN_1_0001_E36
  return BigInt(window) * (strikeTickWad - WAD / 2n)
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function main(): Promise<void> {
  const arts = loadArtifacts()
  const url = await startAnvil()
  const chain = defineChain({
    id: CHAIN_ID,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  })
  const transport = http(url)
  const pub = createPublicClient({ chain, transport, pollingInterval: 100 })
  const test = createTestClient({ chain, mode: 'anvil', transport })
  const hookAbi = [...arts.hook.abi, ...oracleErrors] as Abi
  const oracleAbi = arts.oracle.abi as Abi

  const head = () => pub.getBlockNumber({ cacheTime: 0 })
  const latestTime = async () => (await pub.getBlock({ blockTag: 'latest' })).timestamp
  async function say(tag: string, msg: string): Promise<void> {
    console.log(`block ${String(await head()).padStart(4)}  ${tag.padEnd(7)} ${msg}`)
  }
  const section = (title: string) => console.log(`\n== ${title}`)

  function actor(name: string, key: Hex): Actor {
    const account = privateKeyToAccount(key)
    return { name, key, account, address: account.address, wallet: createWalletClient({ chain, transport, account }) }
  }

  function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<T> {
    return pub.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>
  }

  /** Sends with 1.5x the estimate plus 100k, since state can move between the estimate and the block */
  async function send(a: Actor, to: Address, abi: Abi, functionName: string, args: readonly unknown[], value = 0n): Promise<TransactionReceipt> {
    const call = { address: to, abi, functionName, args, value, account: a.account }
    const gas = await pub.estimateContractGas(call as never)
    const hash = await a.wallet.writeContract({ ...call, chain, gas: (gas * 3n) / 2n + 100_000n } as never)
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 })
    if (receipt.status !== 'success') throw new Error(`${a.name}: ${functionName} reverted in block ${receipt.blockNumber} (${hash})`)
    return receipt
  }

  async function deploy(a: Actor, art: Artifact, args: readonly unknown[]): Promise<Address> {
    const hash = await a.wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, chain } as never)
    const receipt = await pub.waitForTransactionReceipt({ hash })
    assert.equal(receipt.status, 'success', 'deployment')
    assert.ok(receipt.contractAddress)
    return getAddress(receipt.contractAddress)
  }

  async function waitUntil(what: string, cond: () => Promise<boolean>, timeoutMs: number, onPoll?: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await cond()) return
      if (onPoll) await onPoll()
      if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting until ${what}`)
      await sleep(150)
    }
  }

  async function untilTime(t: bigint, what: string, onPoll?: () => Promise<void>): Promise<void> {
    const left = Number(t - (await latestTime()))
    await waitUntil(what, async () => (await latestTime()) >= t, (Math.max(left, 0) + 30) * 1000, onPoll)
  }

  console.log(`Sealed oracle end to end on a plain anvil (seed ${SEED})`)

  /* Setup */

  section('Setup')
  await test.setBlockTimestampInterval({ interval: 1 })
  const deployer = actor('deployer', ANVIL_KEY)
  const [bot, keeperActor, trader, alice, bob] = ['bot', 'keeper', 'trader', 'Alice', 'Bob'].map((n) => actor(n, generatePrivateKey())) as [
    Actor,
    Actor,
    Actor,
    Actor,
    Actor,
  ]
  await test.setBalance({ address: deployer.address, value: 10n ** 24n })
  await test.setBalance({ address: trader.address, value: 10n ** 24n })
  for (const a of [bot, keeperActor, alice, bob]) await test.setBalance({ address: a.address, value: 100n * WAD })
  await say('anvil', `${url}, plain chain ${CHAIN_ID} (not a fork), every block exactly 1 s after its parent`)

  const pm = await deploy(deployer, arts.poolManager, [deployer.address])
  const usdc = await deploy(deployer, arts.token, ['USD Coin', 'USDC', 6, 0n, 0n, deployer.address])
  const swapRouter = await deploy(deployer, arts.swapRouter, [pm])
  const lpRouter = await deploy(deployer, arts.lpRouter, [pm])
  const ethUsdc: PoolKey = { currency0: zeroAddress, currency1: usdc, fee: 500, tickSpacing: 10, hooks: zeroAddress }
  const slot = poolStateSlot(poolId(ethUsdc))
  const sqrtP0 = sqrtPriceX96FromPrice({ num: BigInt(ETH_PRICE), den: 1n }, { baseIsToken0: true, baseDecimals: 18, quoteDecimals: 6 })
  await send(deployer, pm, arts.poolManager.abi, 'initialize', [ethUsdc, sqrtP0])
  await send(deployer, usdc, arts.token.abi, 'mint', [deployer.address, 10_000_000n * USDC])
  await send(deployer, usdc, erc20Abi, 'approve', [lpRouter, maxUint256])
  const ethIn = (LIQUIDITY * Q96) / sqrtP0 + WAD
  await send(
    deployer,
    lpRouter,
    arts.lpRouter.abi,
    'modifyLiquidity',
    [ethUsdc, { tickLower: -FULL_RANGE, tickUpper: FULL_RANGE, liquidityDelta: LIQUIDITY, salt: zeroHash }, '0x'],
    ethIn,
  )
  const poolEth = await pub.getBalance({ address: pm })
  const poolUsdc = await read<bigint>(usdc, erc20Abi, 'balanceOf', [pm])
  await say(
    'pool',
    `hookless native ETH/USDC ${poolId(ethUsdc).slice(0, 10)}… (fee 500, spacing 10) at $${ETH_PRICE}, full range ` +
      `${fmtWad(poolEth, 2)} ETH + ${fmtUsdc(poolUsdc)} USDC`,
  )

  const oracle = await deploy(deployer, arts.oracle, [
    pm,
    ethUsdc,
    1, // sign, ETH is currency0
    DECIMALS_SHIFT,
    1, // blockTime
    3, // maxStaleBlocks
    10, // gridSeconds
    180, // nWindows
    30, // minWindows
    100, // winsorTicks
    varE36FromAnnualVol('0.2'),
    varE36FromAnnualVol('2.5'),
    varE36FromAnnualVol('0.6'),
    4096, // cardinality
  ])
  const anchorBlock = await read<bigint>(oracle, oracleAbi, 'anchorBlock')
  const anchorTime = await read<bigint>(oracle, oracleAbi, 'anchorTimestamp')
  await say('oracle', `SealedPoolOracle ${oracle} anchored at block ${anchorBlock} (maxStaleBlocks 3, parameters of the Unichain fork test)`)

  // As in SchedulerPair.sol, the scheduler takes the deployer's next nonce and the hook comes from the CREATE2 factory
  const nonce = await pub.getTransactionCount({ address: deployer.address })
  const predicted = getContractAddress({ from: deployer.address, nonce: BigInt(nonce) })
  const init = concatHex([
    arts.hook.bytecode,
    encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [pm, usdc, predicted]),
  ])
  const initHash = keccak256(init)
  let salt: Hex = zeroHash
  let hook: Address = zeroAddress
  let tries = 0
  for (let i = 0n; ; i++) {
    salt = numberToHex(i, { size: 32 })
    hook = getContractAddress({ from: CREATE2_FACTORY, salt, bytecodeHash: initHash, opcode: 'CREATE2' })
    tries++
    if ((BigInt(hook) & ALL_HOOK_MASK) === PREDICTION_FLAGS) break
  }
  const scheduler = await deploy(deployer, arts.scheduler, [hook, oracle, CONFIG])
  assert.equal(scheduler, predicted, 'the scheduler landed at the predicted nonce address')
  const hookTx = await deployer.wallet.sendTransaction({ to: CREATE2_FACTORY, data: concatHex([salt, init]), chain } as never)
  assert.equal((await pub.waitForTransactionReceipt({ hash: hookTx })).status, 'success', 'hook deployment')
  assert.ok(await pub.getCode({ address: hook }), 'hook has code')
  assert.equal(await read<Address>(hook, hookAbi, 'owner'), scheduler, 'the scheduler owns the hook')
  assert.equal(await read<Address>(scheduler, arts.scheduler.abi, 'hook'), hook)
  assert.equal(await read<Address>(scheduler, arts.scheduler.abi, 'oracle'), oracle, 'the scheduler reads the sealed oracle')
  await say('market', `MarketScheduler ${scheduler} owns PredictionHook ${hook} (flags 0x2aa8, salt found in ${tries} tries)`)

  await send(deployer, usdc, erc20Abi, 'approve', [hook, maxUint256])
  await send(deployer, hook, hookAbi, 'deposit', [VAULT_USDC])
  await send(deployer, usdc, arts.token.abi, 'mint', [trader.address, 100_000_000n * USDC])
  for (const a of [alice, bob]) await send(deployer, usdc, arts.token.abi, 'mint', [a.address, 50n * USDC])
  for (const a of [trader, alice, bob]) await send(a, usdc, erc20Abi, 'approve', [swapRouter, maxUint256])
  await say('vault', `${fmtUsdc(VAULT_USDC)} USDC deposited; Alice and Bob hold 50 USDC each, the trader swaps from ${trader.address}`)

  await test.setIntervalMining({ interval: 1 })
  await say('chain', 'one block per second from here on')

  /* Bots and the random swapper */

  const botLog = createLogger('sealed', 'debug', (l) => botLines.push(l))
  const botClients = makeClients({ rpcUrl: url, chainId: CHAIN_ID, privateKey: { key: bot.key, source: 'sealed-e2e' } })
  const newBot = (batch: number, maxBatchesPerTick: number, log = botLog) =>
    new SealedBot({ clients: botClients, oracle, batch, maxBatchesPerTick, dryRun: false, txTimeoutMs: 30_000, log })
  const runnerBot = newBot(16, 4)
  const runner = new Loop(async () => void (await runnerBot.tick()), () => 100)

  const keeperClients = makeClients({ rpcUrl: url, chainId: CHAIN_ID, privateKey: { key: keeperActor.key, source: 'sealed-e2e' } })
  const keeper = new Keeper({
    clients: keeperClients,
    hook,
    scheduler,
    periodSec: CONFIG.period,
    alignToPeriod: false,
    scanBack: 10,
    invalidAfterSec: await invalidAfterFor(keeperClients.publicClient, hook, 60),
    dryRun: false,
    txTimeoutMs: 30_000,
    log: createLogger('keeper', 'info', (l) => console.log(`            ${l.replace(/^\S+ /, '')}`)),
  })

  const swaps: { block: bigint; up: boolean }[] = []
  let drift = 0
  async function randomSwap(): Promise<void> {
    const up = rand() < 0.5 + drift
    const eth = 0.05 * 40 ** rand()
    const amountIn = up ? BigInt(Math.round(eth * ETH_PRICE * 1e6)) : BigInt(Math.round(eth * 1e6)) * 10n ** 12n
    const r = await send(
      trader,
      swapRouter,
      arts.swapRouter.abi,
      'swap',
      [
        ethUsdc,
        { zeroForOne: !up, amountSpecified: -amountIn, sqrtPriceLimitX96: up ? MAX_SQRT_PRICE - 1n : MIN_SQRT_PRICE + 1n },
        { takeClaims: false, settleUsingBurn: false },
        '0x',
      ],
      up ? 0n : amountIn,
    )
    swaps.push({ block: r.blockNumber, up })
  }
  const swapper = new Loop(randomSwap, () => 400 + Math.floor(rand() * 2000))

  const frontier = () => read<bigint>(oracle, oracleAbi, 'frontier')
  const snapshotBlock = async () => (await read<readonly [bigint, ...unknown[]]>(oracle, oracleAbi, 'snapshot'))[0]
  const blockAt = (t: bigint) => anchorBlock + (t - anchorTime)
  const oracleEvents = async (eventName: 'Sealed' | 'Proven' | 'Queued' | 'HeadersCheckpointed', fromBlock: bigint, toBlock?: bigint) =>
    (await pub.getContractEvents({ address: oracle, abi: oracleAbi, eventName, fromBlock, toBlock } as never)) as unknown as {
      blockNumber: bigint
      args: Record<string, bigint | number>
    }[]

  const endTicks = new Map<bigint, number>()
  /** The pool's tick in block n's final state, which is the normalised tick since ETH is currency0 */
  async function endTick(n: bigint): Promise<number> {
    let tick = endTicks.get(n)
    if (tick === undefined) {
      tick = decodeSlot0(await read<Hex>(pm, extsloadAbi, 'extsload', [slot], n)).tick
      endTicks.set(n, tick)
    }
    return tick
  }

  /** Leaves the bot stopped on a snapshot of the idle pool, so every spot read takes the sealed view until it restarts */
  async function quiet(): Promise<void> {
    await swapper.stop()
    const lastSwap = swaps.at(-1)?.block ?? 0n
    await waitUntil('the bot snapshots the idle pool', async () => (await snapshotBlock()) > lastSwap, 20_000)
    await runner.stop()
    const snap = await snapshotBlock()
    await waitUntil('two blocks pass', async () => (await head()) >= snap + 2n, 10_000)
  }

  function resume(d: number): void {
    drift = d
    runner.start()
    swapper.start()
  }

  /* Markets */

  async function openAndTrade(): Promise<Market> {
    const id = await keeper.createMarket(await latestTime())
    assert.ok(id !== undefined, 'the keeper opened a market through scheduler.open()')
    const info = await read<MarketInfo>(hook, hookAbi, 'marketInfo', [id])
    const [yesKey, noKey] = await read<readonly [PoolKey, PoolKey]>(hook, hookAbi, 'poolKeys', [id])
    const [opened] = (await pub.getContractEvents({
      address: scheduler,
      abi: arts.scheduler.abi,
      eventName: 'MarketOpened',
      args: { marketId: id },
      fromBlock: 0n,
    } as never)) as unknown as { blockNumber: bigint; args: { strikeCents: bigint } }[]
    assert.ok(opened, 'MarketOpened event')
    const m: Market = {
      id,
      openBlock: opened.blockNumber,
      expiry: info.expiry,
      window: info.window,
      lnStrikeWad: info.lnStrikeWad,
      strikeCents: opened.args.strikeCents,
      name: await read<string>(info.yes, erc20Abi, 'name'),
      yes: info.yes,
      no: info.no,
      yesKey,
      noKey,
    }
    const q = await read<Quote>(hook, hookAbi, 'quote', [id])
    await say(
      'market',
      `#${id} "${m.name}": strike $${(Number(m.strikeCents) / 100).toFixed(2)} from the oracle's start-of-block price, ` +
        `expiry t=${m.expiry} (block ${blockAt(m.expiry)}), window ${m.window} s, trading stops at T-${m.window + CONFIG.cutoffBuffer} s`,
    )
    await say(
      'quote',
      `YES mid ${fmtWad(q.midYes)} ask ${fmtWad(q.askYes)}, NO ask ${fmtWad(q.askNo)}, sigma ${(sigmaFromVarE36(q.varE36) * 100).toFixed(1)}%, tau ${q.tau} s`,
    )
    await Promise.all([buy(alice, m, true), buy(bob, m, false)])
    return m
  }

  async function buy(a: Actor, m: Market, up: boolean): Promise<void> {
    const key = up ? m.yesKey : m.noKey
    const zeroForOne = key.currency0.toLowerCase() === usdc.toLowerCase()
    const r = await send(a, swapRouter, arts.swapRouter.abi, 'swap', [
      key,
      { zeroForOne, amountSpecified: -TRADE_USDC, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n },
      { takeClaims: false, settleUsingBurn: false },
      '0x',
    ])
    const trades = parseEventLogs({ abi: hookAbi, eventName: 'Trade', logs: r.logs }) as unknown as {
      args: { marketId: bigint; isYes: boolean; isBuy: boolean; qty: bigint; usdcAmount: bigint; avgPriceWad: bigint }
    }[]
    assert.equal(trades.length, 1, 'one Trade event')
    const t = trades[0]!.args
    assert.ok(t.marketId === m.id && t.isYes === up && t.isBuy && t.usdcAmount === TRADE_USDC)
    assert.equal(await read<bigint>(up ? m.yes : m.no, erc20Abi, 'balanceOf', [a.address]), t.qty, `${a.name} holds the tokens`)
    await say(
      a.name,
      `buys ${fmtTokens(t.qty)} ${up ? 'UP' : 'DOWN'} for ${fmtUsdc(TRADE_USDC)} USDC at ${fmtWad(t.avgPriceWad)} through PoolSwapTest (block ${r.blockNumber})`,
    )
  }

  type SettleProbe = { ok: true } | { ok: false; name: string; args: readonly unknown[] }
  async function probeSettle(id: bigint): Promise<SettleProbe> {
    try {
      await pub.simulateContract({ address: hook, abi: hookAbi, functionName: 'settle', args: [id], account: keeperActor.address } as never)
      return { ok: true }
    } catch (e) {
      const r = revertOf(e)
      if (!r) throw e
      return { ok: false, ...r }
    }
  }
  const probeText = (p: SettleProbe) => (p.ok ? 'succeeds' : `reverts ${p.name}(${p.args.join(', ')})`)

  /** settle reverts ObservationUnavailable(expiry) exactly while the frontier is below the last block before expiry */
  async function checkProbe(m: Market): Promise<boolean> {
    const f = await frontier()
    const lastBefore = blockAt(m.expiry) - 1n
    const p = await probeSettle(m.id)
    if (f < lastBefore) {
      assert.ok(
        !p.ok && p.name === 'ObservationUnavailable' && p.args[0] === Number(m.expiry),
        `settle(${m.id}) must revert ObservationUnavailable(${m.expiry}) while the frontier ${f} < ${lastBefore}, it ${probeText(p)}`,
      )
      return false
    }
    assert.ok(p.ok, `settle(${m.id}) must succeed once the frontier ${f} >= ${lastBefore}, it ${probeText(p)}`)
    return true
  }

  /** Swaps landed after the bot stopped and inside the window, so no seal and no sealed view can cover the window */
  async function assertWindowMoved(m: Market, stoppedAt: bigint): Promise<void> {
    const from = blockAt(m.expiry - BigInt(m.window))
    const inWindow = swaps.filter((s) => s.block >= from && s.block < blockAt(m.expiry)).length
    const afterStop = swaps.filter((s) => s.block > stoppedAt).length
    assert.ok(afterStop > 0 && inWindow > 0, `swaps after the bot stopped (${afterStop}) and inside the window (${inWindow})`)
  }

  async function settleAndVerify(m: Market): Promise<boolean> {
    await keeper.refresh()
    await keeper.settleAndSweep(await latestTime())
    const info = await read<MarketInfo>(hook, hookAbi, 'marketInfo', [m.id])
    assert.equal(info.status, 2, `the keeper settled market ${m.id}`)
    const [settled] = (await pub.getContractEvents({
      address: hook,
      abi: hookAbi,
      eventName: 'MarketSettled',
      args: { marketId: m.id },
      fromBlock: m.openBlock,
    } as never)) as unknown as { blockNumber: bigint; args: { yesWon: boolean; avgNormTickTimesWindow: bigint; invalid: boolean } }[]
    assert.ok(settled && !settled.args.invalid, 'MarketSettled, not invalid')

    // Brute force over every block whose own timestamp is in [T - window, T)
    const start = m.expiry - BigInt(m.window)
    const guess = blockAt(start)
    const candidates = Array.from({ length: m.window + 2 }, (_, i) => guess - 1n + BigInt(i))
    const stamps = await mapLimit(candidates, 8, async (n) => (await pub.getBlock({ blockNumber: n })).timestamp)
    const blocks = candidates.filter((_, i) => stamps[i]! >= start && stamps[i]! < m.expiry)
    assert.equal(blocks.length, m.window, `${m.window} one-second blocks in [T - window, T)`)
    const ticks = await mapLimit(blocks, 8, endTick)
    const sum = ticks.reduce((s, k) => s + BigInt(k), 0n)
    const threshold = await read<bigint>(hook, hookAbi, 'settleThresholdOf', [m.id])
    assert.equal(threshold, thresholdOf(m.lnStrikeWad, DECIMALS_SHIFT, m.window), 'hook threshold equals the half-tick rule recomputed here')
    const yesBrute = sum * WAD > threshold
    assert.equal(settled.args.avgNormTickTimesWindow, sum, 'the settled tick sum equals the brute-force sum of end-of-block ticks')
    assert.equal(info.yesWon, yesBrute, 'yesWon equals the brute-force rule')
    assert.equal(settled.args.yesWon, yesBrute)

    const strikeTick = Number(thresholdOf(m.lnStrikeWad, DECIMALS_SHIFT, 1) + WAD / 2n) / 1e18
    await say('settle', `market #${m.id} settled in block ${settled.blockNumber}: ${yesBrute ? 'YES (UP)' : 'NO (DOWN)'} won`)
    console.log(`            end-of-block ticks of blocks ${blocks[0]}..${blocks.at(-1)} (t = ${start}..${m.expiry - 1n}): ${ticks.join(', ')}`)
    console.log(
      `            brute force: sum ${sum}, average ${(Number(sum) / m.window).toFixed(1)} vs strike tick ${strikeTick.toFixed(2)} ` +
        `(TWAP $${twapUsd(sum, m.window, DECIMALS_SHIFT).toFixed(2)} vs $${usdFromLnWad(m.lnStrikeWad).toFixed(2)}), ` +
        `sum * 1e18 ${yesBrute ? '>' : '<='} threshold ${threshold}: matches the hook`,
    )
    return yesBrute
  }

  async function redeemWinner(m: Market, yesWon: boolean): Promise<void> {
    const [winner, loser] = yesWon ? [alice, bob] : [bob, alice]
    const [winTok, loseTok] = yesWon ? [m.yes, m.no] : [m.no, m.yes]
    const held = await read<bigint>(winTok, erc20Abi, 'balanceOf', [winner.address])
    assert.ok(held > 0n, `${winner.name} holds winning tokens`)
    const before = await read<bigint>(usdc, erc20Abi, 'balanceOf', [winner.address])
    const r = await send(winner, hook, hookAbi, 'redeem', [m.id, held])
    const after = await read<bigint>(usdc, erc20Abi, 'balanceOf', [winner.address])
    assert.equal(after - before, held, 'redeem pays 1 USDC per winning token')
    assert.equal(await read<bigint>(winTok, erc20Abi, 'balanceOf', [winner.address]), 0n, 'the redeemed tokens are burned')
    const lost = await read<bigint>(loseTok, erc20Abi, 'balanceOf', [loser.address])
    await assert.rejects(
      pub.simulateContract({ address: hook, abi: hookAbi, functionName: 'redeem', args: [m.id, lost], account: loser.account } as never),
      `${loser.name}'s losing tokens do not redeem`,
    )
    await say(
      winner.name,
      `redeems ${fmtTokens(held)} ${yesWon ? 'UP' : 'DOWN'} for ${fmtUsdc(after - before)} USDC (block ${r.blockNumber}); ` +
        `${loser.name}'s ${fmtTokens(lost)} ${yesWon ? 'DOWN' : 'UP'} redeem for nothing`,
    )
  }

  /* The bot starts the oracle, then random swaps */

  section('Sealed bot and random swaps')
  runner.start()
  await waitUntil('the first seal starts the oracle', async () => (await frontier()) > 0n, 30_000)
  const [firstSeal] = await oracleEvents('Sealed', 0n)
  assert.ok(firstSeal, 'the oracle started with a seal')
  await say('bot', `the first idle seal started the oracle at block ${firstSeal.args['fromBlock']} (frontier ${firstSeal.args['toBlock']})`)

  const noiseFrom = await head()
  resume(0)
  let maxLag = 0n
  const sampleLag = async () => {
    const [h, f] = await Promise.all([head(), frontier()])
    if (h - 1n - f > maxLag) maxLag = h - 1n - f
  }
  await waitUntil('the random swaps run for a while', async () => (await head()) >= noiseFrom + NOISE_BLOCKS, 90_000, sampleLag)
  const noiseTo = await head()
  const noiseSwaps = swaps.filter((s) => s.block > noiseFrom).length
  const [noiseSealed, noiseProven] = await Promise.all([oracleEvents('Sealed', noiseFrom, noiseTo), oracleEvents('Proven', noiseFrom, noiseTo)])
  assert.ok(noiseSwaps > 0 && noiseProven.length > 0, 'swaps broke seals and the bot proved the gaps')
  assert.ok(maxLag <= MAX_LAG, `the frontier trailed the head by at most ${MAX_LAG} blocks (worst ${maxLag})`)
  await say(
    'noise',
    `${noiseSwaps} swaps in ${noiseTo - noiseFrom} blocks: ${noiseSealed.length} seals and ${noiseProven.length} blocks proven, ` +
      `frontier ${await frontier()}, worst lag ${maxLag} blocks behind head - 1`,
  )

  /* Market 1 */

  section('Market 1: settle is refused until the proofs reach expiry')
  await quiet()
  const m1 = await openAndTrade()
  resume(DRIFT)
  await untilTime(m1.expiry - BigInt(m1.window) - 3n, 'shortly before the settlement window', sampleLag)
  await runner.stop()
  const stop1 = await head()
  const front1 = await frontier()
  await say('bot', `stops at frontier ${front1}, 3 s before the window; the swaps go on`)
  await untilTime(m1.expiry + 2n, 'past expiry')
  drift = 0
  await assertWindowMoved(m1, stop1)
  assert.equal(await checkProbe(m1), false)
  await say('settle', `past expiry, frontier ${await frontier()} < block ${blockAt(m1.expiry) - 1n}: settle(${m1.id}) ${probeText(await probeSettle(m1.id))}`)

  const probeBot = newBot(4, 1)
  const probes: string[] = []
  for (let i = 0; ; i++) {
    const r = await probeBot.tick()
    const covered = await checkProbe(m1)
    probes.push(`${r.frontier}:${covered ? 'ok' : 'revert'}`)
    if (covered) break
    assert.ok(i < 40, 'the proofs reach expiry within 40 ticks')
  }
  const reverts1 = probes.filter((p) => p.endsWith('revert')).length
  assert.ok(reverts1 >= 1, 'settle kept reverting after at least one proof batch below expiry')
  await say('bot', `restarts with 4-block proof batches, settle probed after each (frontier:result) ${probes.join(' ')}`)
  const yes1 = await settleAndVerify(m1)
  runner.start()
  await redeemWinner(m1, yes1)

  /* Market 2 */

  section('Market 2: outage past BLOCKHASH and EIP-2935, recovered with checkpointHeaders')
  await waitUntil('the scheduler can open the next slot', () => read<boolean>(scheduler, arts.scheduler.abi, 'canOpen'), 30_000)
  await quiet()
  const m2 = await openAndTrade()
  // anvil_setCode rewrites the latest block's state in place, so only a seal of the idle pool can cover that block
  const etchFrom = await head()
  await test.setCode({ address: HISTORY_ADDRESS, bytecode: RETURNS_ZERO })
  const etchTo = await head()
  runner.start()
  await waitUntil('a seal covers the etched block', async () => (await frontier()) >= etchTo, 20_000)
  const etchSeal = (await oracleEvents('Sealed', etchFrom)).find((l) => BigInt(l.args['fromBlock']!) <= etchFrom && BigInt(l.args['toBlock']!) >= etchTo)
  assert.ok(etchSeal, `a seal covers the etched block ${etchTo}`)
  await say(
    'chain',
    `EIP-2935 now answers zero for every block (etched at block ${etchTo}, covered by the seal of blocks ` +
      `${etchSeal.args['fromBlock']}..${etchSeal.args['toBlock']})`,
  )
  swapper.start()
  drift = -DRIFT
  await untilTime(m2.expiry - BigInt(m2.window) - 3n, 'shortly before the settlement window', sampleLag)
  await runner.stop()
  const stop2 = await head()
  const missing = (await frontier()) + 1n
  await say('bot', `goes down with frontier ${missing - 1n}, 3 s before the window; the swaps go on`)
  await untilTime(m2.expiry + 1n, 'past expiry')
  await swapper.stop()
  drift = 0
  await assertWindowMoved(m2, stop2)
  while ((await head()) - missing < OUTAGE_BLOCKS) {
    await randomSwap()
    await test.mine({ blocks: 24 })
  }
  const outageHead = await head()
  assert.equal(await read<Hex>(oracle, oracleAbi, 'blockHashOf', [missing]), zeroHash, `no hash window knows block ${missing}`)
  const history = await pub.call({ to: HISTORY_ADDRESS, data: numberToHex(missing, { size: 32 }) })
  assert.equal(BigInt(history.data ?? '0x0'), 0n, 'the history contract serves nothing')
  assert.equal(await checkProbe(m2), false)
  await say(
    'outage',
    `${outageHead - missing} blocks since block ${missing} (swaps every 25 blocks), blockHashOf(${missing}) = 0: ` +
      `settle(${m2.id}) ${probeText(await probeSettle(m2.id))}`,
  )

  const recoveryLines: string[] = []
  const recovery = newBot(16, 4, createLogger('sealed', 'info', (l) => recoveryLines.push(l)))
  swapper.start()
  const recoveryTicks: SealedTick[] = []
  let settleable: bigint | undefined
  for (;;) {
    const r = await recovery.tick()
    recoveryTicks.push(r)
    if ((await checkProbe(m2)) && settleable === undefined) settleable = r.frontier
    if (r.caughtUp) break
    assert.ok(recoveryTicks.length < 40, 'the restarted bot catches up within 40 ticks')
  }
  const checkpointed = recoveryTicks.reduce((s, r) => s + r.checkpointed, 0)
  const proven2 = recoveryTicks.reduce((s, r) => s + r.proven, 0)
  assert.ok(checkpointed > 0, 'the restarted bot stored headers with checkpointHeaders')
  const cps = await oracleEvents('HeadersCheckpointed', outageHead)
  assert.ok(cps.some((l) => BigInt(l.args['oldest']!) <= missing), `the checkpointed chain reaches block ${missing}`)
  const [provenMissing] = (await oracleEvents('Proven', outageHead)).filter((l) => BigInt(l.args['blockNumber']!) === missing)
  assert.ok(provenMissing, `block ${missing} was proven`)
  assert.ok(provenMissing.blockNumber - missing > 256n, `block ${missing} was proven past BLOCKHASH's reach, from a checkpointed hash`)
  for (const l of recoveryLines.filter((x) => x.includes('] checkpointed '))) console.log(`            ${l.replace(/^\S+ /, '')}`)
  await say(
    'bot',
    `restarted: ${recoveryTicks.length} ticks, ${checkpointed} headers checkpointed, ${proven2} blocks proven ` +
      `(block ${missing} in block ${provenMissing.blockNumber}, ${provenMissing.blockNumber - missing} blocks later); ` +
      `settle(${m2.id}) succeeds from frontier ${settleable}`,
  )
  const yes2 = await settleAndVerify(m2)
  runner.start()
  await redeemWinner(m2, yes2)

  /* Whole-run checks */

  section('Whole run')
  await swapper.stop()
  await runner.stop()
  await waitUntil(
    'an idle poke seals the head',
    async () => {
      const r = await runnerBot.tick()
      return r.caughtUp && r.poked && r.frontier === r.head - 1n
    },
    30_000,
  )
  const end = await head()
  const f = await frontier()
  const [sealedLogs, provenLogs, queuedLogs] = await Promise.all([
    oracleEvents('Sealed', 0n),
    oracleEvents('Proven', 0n),
    oracleEvents('Queued', 0n),
  ])
  const covered = new Set<bigint>()
  const needed = new Set<bigint>()
  for (const l of provenLogs) needed.add(BigInt(l.args['blockNumber']!))
  for (const l of sealedLogs) for (let j = BigInt(l.args['fromBlock']!); j <= BigInt(l.args['toBlock']!); j++) needed.add(j)
  await mapLimit([...needed], 16, endTick)
  for (const l of provenLogs) {
    const n = BigInt(l.args['blockNumber']!)
    assert.equal(Number(l.args['normTick']), await endTick(n), `proven block ${n} carries its end-of-block tick`)
    covered.add(n)
  }
  for (const l of sealedLogs) {
    for (let j = BigInt(l.args['fromBlock']!); j <= BigInt(l.args['toBlock']!); j++) {
      assert.equal(Number(l.args['normTick']), await endTick(j), `sealed block ${j} carries its end-of-block tick`)
      covered.add(j)
    }
  }
  assert.ok(sealedLogs.length > 0 && provenLogs.length > 0, 'both seals and proofs were applied')
  const first = [...covered].reduce((a, b) => (b < a ? b : a), f)
  for (let j = first; j <= f; j++) assert.ok(covered.has(j), `block ${j} was applied`)
  const numbers = Array.from({ length: Number(end - anchorBlock) + 1 }, (_, i) => anchorBlock + BigInt(i))
  const stamps = await mapLimit(numbers, 16, async (n) => (await pub.getBlock({ blockNumber: n })).timestamp)
  stamps.forEach((t, i) => i > 0 && assert.equal(t, stamps[i - 1]! + 1n, `block ${numbers[i]} is 1 s after its parent`))
  const botTroubles = botLines.filter((l) => / (WARN|ERROR) /.test(l))
  assert.deepEqual([...runner.errors, ...swapper.errors, ...botTroubles], [], 'the bot and the swapper ran without errors')
  const queueLength = await read<bigint>(oracle, oracleAbi, 'queueLength')
  await say(
    'oracle',
    `frontier ${f} = head - 1; blocks ${first}..${f} all applied: ${covered.size - provenLogs.length} by ${sealedLogs.length} seal events, ` +
      `${provenLogs.length} by proofs, ${queuedLogs.length} runs queued behind gaps (${queueLength} left); ` +
      `each equals the pool's end-of-block tick`,
  )
  await say('chain', `${stamps.length} blocks from the anchor, each exactly 1 s after its parent; ${swaps.length} random swaps`)
  console.log('\nsealed e2e passed: gaps proven, settle gated on the frontier, outcomes match the brute force, winners redeemed, recovery via checkpointHeaders')
}

process.on('SIGINT', () => {
  stopAnvil()
  process.exit(130)
})

main().then(
  () => {
    stopAnvil()
    process.exit(0)
  },
  (e: unknown) => {
    stopAnvil()
    if (botLines.length) console.error(`\nlast sealed bot log lines:\n${botLines.slice(-25).join('\n')}`)
    console.error(`\nSEALED E2E FAILED (seed ${SEED}): ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  },
)
