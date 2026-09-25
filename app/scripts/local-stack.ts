/**
 * Local test stack for the backup page, on an anvil fork of Unichain Sepolia (chain 1301).
 *
 * Deploys the real contracts from ../out (run `forge build` first): demo WETH/USDC DemoTokens, PriceSteerer,
 * UnderlyingOracleHook and PredictionHook (both CREATE2-mined to their flag addresses), initialises and seeds the
 * underlying ETH/USDC v4 pool, funds the LP vault with Circle testnet USDC dealt on the fork, and writes
 * deployments/local.json plus deployments/local.env (throwaway mirror and keeper keys for the bots).
 *
 * Flags: --anvil starts anvil (fork, --block-time 1) on the RPC port; --bots runs ../bot mirror and keeper against it.
 * With either flag the script keeps running until Ctrl-C and stops what it started.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Abi,
  type Address,
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  erc20Abi,
  getContractAddress,
  type Hex,
  http,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { dealErc20 } from '../src/devtools.ts'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = resolve(appDir, '..')
const outDir = process.env['FORGE_OUT'] ?? join(repoDir, 'out')
const rpcUrl = process.env['RPC_URL'] ?? 'http://127.0.0.1:8746'
const forkUrl = process.env['FORK_URL'] ?? 'https://unichain-sepolia.drpc.org'
const args = new Set(process.argv.slice(2))

const POOL_MANAGER: Address = '0x00B036B58a818B1BC34d502D3fE730Db729e62AC'
const CIRCLE_USDC: Address = '0x31d0220469e10c4E71834a79b1f276d740d3768F'
const CREATE2_DEPLOYER: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const ALL_HOOK_FLAGS = (1n << 14n) - 1n
const ORACLE_FLAGS = (1n << 12n) | (1n << 7n)
const PREDICTION_FLAGS = 0x2aa8n
const YEAR = 31_557_600n
const E6 = 1_000_000n

const chain = defineChain({
  id: 1301,
  name: 'Unichain Sepolia (local fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
})

interface Artifact {
  abi: Abi
  bytecode: { object: Hex }
}

function artifact(file: string, name = file.replace(/\.sol$/, '')): Artifact {
  const path = join(outDir, file, `${name}.json`)
  if (!existsSync(path)) {
    throw new Error(`${path} is missing; run \`forge build\` in the repo root`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Artifact
}

function anvilBin(): string {
  const local = join(homedir(), '.foundry/bin/anvil')
  return existsSync(local) ? local : 'anvil'
}

async function waitForRpc(url: string, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (r.ok) {
        return
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`no RPC at ${url}`)
}

function isqrt(n: bigint): bigint {
  if (n < 2n) {
    return n
  }
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

async function spotEthUsd(): Promise<number> {
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(4000) })
    const j = (await r.json()) as { data?: { amount?: string } }
    const v = Number(j.data?.amount)
    if (Number.isFinite(v) && v > 100) {
      return v
    }
  } catch {
    /* offline */
  }
  return 2700
}

const children: ChildProcess[] = []
function stopChildren() {
  for (const c of children) {
    c.kill('SIGTERM')
  }
}
process.on('SIGINT', () => {
  stopChildren()
  process.exit(0)
})
process.on('SIGTERM', () => {
  stopChildren()
  process.exit(0)
})

async function main() {
  if (args.has('--anvil')) {
    const port = new URL(rpcUrl).port || '8746'
    console.log(`starting anvil on ${port}, forking ${forkUrl}`)
    const anvil = spawn(
      anvilBin(),
      ['--fork-url', forkUrl, '--chain-id', '1301', '--port', port, '--block-time', '1', '--silent'],
      { stdio: 'inherit' },
    )
    children.push(anvil)
  }
  await waitForRpc(rpcUrl, 60_000)

  const key = (process.env['LOCAL_PRIVATE_KEY'] as Hex | undefined) ?? generatePrivateKey()
  const account = privateKeyToAccount(key)
  const transport = http(rpcUrl)
  const pub = createPublicClient({ chain, transport, pollingInterval: 250 })
  const wallet = createWalletClient({ chain, transport, account })
  const test = createTestClient({ chain, mode: 'anvil', transport })
  await test.setBalance({ address: account.address, value: 10n ** 21n })
  if (!(await pub.getCode({ address: CREATE2_DEPLOYER }))) {
    throw new Error('deterministic CREATE2 deployer missing; is this a fork of chain 1301?')
  }
  const me = account.address

  const wait = async (hash: Hex, label: string) => {
    const r = await pub.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') {
      throw new Error(`${label} reverted (${hash})`)
    }
    return r
  }
  const deploy = async (a: Artifact, ctorArgs: readonly unknown[], label: string): Promise<Address> => {
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: ctorArgs } as never)
    const r = await wait(hash, label)
    if (!r.contractAddress) {
      throw new Error(`${label}: no contract address`)
    }
    return r.contractAddress
  }
  const write = async (address: Address, abi: Abi, functionName: string, fnArgs: readonly unknown[]) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args: fnArgs } as never)
    await wait(hash, functionName)
  }
  const deployMined = async (a: Artifact, ctorArgs: readonly unknown[], flags: bigint, label: string) => {
    const init = encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args: ctorArgs } as never)
    const bytecodeHash = keccak256(init)
    for (let i = BigInt(Date.now() % 1_000_000) * 1_000_000n; ; i++) {
      const salt = pad(numberToHex(i), { size: 32 })
      const at = getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt, bytecodeHash })
      if ((BigInt(at) & ALL_HOOK_FLAGS) === flags) {
        await wait(await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, init]) }), label)
        if (!(await pub.getCode({ address: at }))) {
          throw new Error(`${label} not deployed`)
        }
        return at
      }
    }
  }

  /* Underlying ETH/USDC pool */

  const token = artifact('DemoToken.sol')
  const weth = await deploy(token, ['Demo Wrapped Ether', 'dWETH', 18, 10n ** 18n, 5n * 10n ** 18n, me], 'dWETH')
  const dusdc = await deploy(token, ['Demo USD Coin', 'dUSDC', 6, 10_000n * E6, 50_000n * E6, me], 'dUSDC')
  const steerer = await deploy(artifact('PriceSteerer.sol'), [POOL_MANAGER, me], 'PriceSteerer')
  await write(weth, token.abi, 'setMinter', [steerer, true])
  await write(dusdc, token.abi, 'setMinter', [steerer, true])

  const annual = (sigmaPct: bigint) => (sigmaPct * sigmaPct * 10n ** 32n) / YEAR
  const oracleArt = artifact('UnderlyingOracleHook.sol')
  const oracle = await deployMined(
    oracleArt,
    [POOL_MANAGER, dusdc, weth, 10, 60, 3, 400, annual(20n), annual(250n), annual(60n), 4096, me],
    ORACLE_FLAGS,
    'UnderlyingOracleHook',
  )
  const [c0, c1] = BigInt(weth) < BigInt(dusdc) ? [weth, dusdc] : [dusdc, weth]
  const poolKey = { currency0: c0, currency1: c1, fee: 500, tickSpacing: 10, hooks: oracle }
  const spot = await spotEthUsd()
  const cents = BigInt(Math.round(spot * 100))
  const q192 = 1n << 192n
  const sqrtPriceX96 = c0 === weth ? isqrt((cents * q192) / 10n ** 14n) : isqrt((10n ** 14n * q192) / cents)
  const pmAbi = parseAbi([
    'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
    'function initialize(PoolKey key, uint160 sqrtPriceX96) returns (int24 tick)',
  ])
  await write(POOL_MANAGER, pmAbi as Abi, 'initialize', [poolKey, sqrtPriceX96])
  await write(steerer, artifact('PriceSteerer.sol').abi, 'addLiquidityFullRange', [poolKey, 10n ** 17n])

  /* PredictionHook and LP vault */

  const hookArt = artifact('PredictionHook.sol')
  const hook = await deployMined(hookArt, [POOL_MANAGER, CIRCLE_USDC, me], PREDICTION_FLAGS, 'PredictionHook')
  const vault = BigInt(process.env['VAULT_USDC'] ?? '1000') * E6
  await dealErc20(pub as never, test as never, CIRCLE_USDC, me, vault)
  await write(CIRCLE_USDC, erc20Abi as Abi, 'approve', [hook, vault])
  await write(hook, hookArt.abi, 'deposit', [vault])
  // Separate keeper key, so the two bots never race for one nonce
  const keeperKey = (process.env['LOCAL_KEEPER_KEY'] as Hex | undefined) ?? generatePrivateKey()
  const keeper = privateKeyToAccount(keeperKey).address
  await test.setBalance({ address: keeper, value: 10n ** 21n })
  await write(hook, hookArt.abi, 'setKeeper', [keeper])

  const deployment = {
    chainId: 1301,
    rpcUrl,
    poolManager: POOL_MANAGER,
    usdc: CIRCLE_USDC,
    predictionHook: hook,
    underlyingOracle: oracle,
    priceSteerer: steerer,
    demoWeth: weth,
    demoUsdc: dusdc,
    deployBlock: Number(await pub.getBlockNumber()),
  }
  const depDir = join(appDir, 'deployments')
  mkdirSync(depDir, { recursive: true })
  const jsonPath = join(depDir, 'local.json')
  const envPath = join(depDir, 'local.env')
  writeFileSync(jsonPath, `${JSON.stringify(deployment, null, 2)}\n`)
  writeFileSync(
    envPath,
    [
      '# Throwaway keys generated for the local fork only',
      `MIRROR_PRIVATE_KEY=${key}`,
      `KEEPER_PRIVATE_KEY=${keeperKey}`,
      `RPC_URL=${rpcUrl}`,
      `DEPLOYMENTS_FILE=${jsonPath}`,
      '',
    ].join('\n'),
  )
  console.log(JSON.stringify(deployment, null, 2))
  console.log(`wrote ${jsonPath} and ${envPath}`)
  console.log(`ETH seeded at $${(Number(cents) / 100).toFixed(2)}`)
  console.log(`\nopen the page with:\n  DEPLOYMENT_FILE=deployments/local.json VITE_RPC_URL=${rpcUrl} npm run dev`)

  if (args.has('--bots')) {
    const botDir = join(repoDir, 'bot')
    const env = {
      ...process.env,
      DEPLOYER_PRIVATE_KEY: key,
      MIRROR_PRIVATE_KEY: key,
      KEEPER_PRIVATE_KEY: keeperKey,
      RPC_URL: rpcUrl,
      CHAIN_ID: '1301',
      DEPLOYMENTS_FILE: jsonPath,
    }
    for (const bot of ['mirror', 'keeper']) {
      console.log(`starting bot ${bot}`)
      children.push(spawn(process.execPath, [`src/${bot}.ts`], { cwd: botDir, env, stdio: 'inherit' }))
    }
  }
  if (children.length) {
    console.log('\nrunning; Ctrl-C stops anvil and the bots')
    await new Promise(() => undefined)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  stopChildren()
  process.exit(1)
})
