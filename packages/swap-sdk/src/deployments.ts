import { type Address, getAddress, type Hex, isAddress, zeroAddress } from 'viem'
import { type ChainContracts, FORBIDDEN_ROUTERS, UNICHAIN_SEPOLIA } from './constants.ts'
import { type PoolKey, poolId } from './pool.ts'

/** One `underlyings` entry, a demo token with its oracle hook and the pool that hook sits on */
export interface Underlying {
  /** Upper-case asset symbol such as "ETH" or "SOL" */
  symbol: string
  token: Address
  oracle: Address
  pool: PoolKey
  poolId: Hex
}

/** Our contracts on one chain. Addresses that are missing or placeholders in the JSON are `undefined`. */
export interface PredictionDeployment extends ChainContracts {
  predictionHook?: Address
  underlyingOracle?: Address
  /** The ownerless MarketGatekeeper that owns `predictionHook` and forwards `createMarket` from its schedulers only */
  marketGatekeeper?: Address
  /** One MarketScheduler per track in gatekeeper order, empty for a file with none */
  marketSchedulers: Address[]
  /** Schedulers of earlier hooks, oldest first */
  legacyMarketSchedulers: Address[]
  /** Prior `predictionHook` addresses the vault migrated away from, oldest first */
  legacyPredictionHooks: Address[]
  /** Price sources in file order, empty when the file has no `underlyings` list */
  underlyings: Underlying[]
  deployBlock?: bigint
  /** Keys that were present but held a placeholder value. */
  placeholders: string[]
}

const ALIASES: Record<string, string[]> = {
  predictionHook: ['predictionHook', 'PredictionHook', 'prediction_hook', 'hook'],
  underlyingOracle: ['underlyingOracle', 'UnderlyingOracleHook', 'underlyingOracleHook', 'oracleHook', 'oracle'],
  marketGatekeeper: ['marketGatekeeper', 'MarketGatekeeper'],
  marketSchedulers: ['marketSchedulers', 'MarketSchedulers'],
  usdc: ['usdc', 'USDC', 'collateral'],
  poolManager: ['poolManager', 'PoolManager'],
  v4Quoter: ['v4Quoter', 'V4Quoter', 'quoter'],
  universalRouter: ['universalRouter', 'UniversalRouter', 'router'],
  permit2: ['permit2', 'Permit2'],
  multicall3: ['multicall3', 'Multicall3'],
  deployBlock: ['deployBlock', 'startBlock', 'blockNumber'],
}

/** True for anything that is not a usable address: missing, empty, "TBD", "0x", the zero address, 0x000…/0xfff… fills. */
export function isPlaceholderAddress(value: unknown): boolean {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    return true
  }
  const body = value.slice(2).toLowerCase()
  return value.toLowerCase() === zeroAddress || /^(.)\1*$/.test(body)
}

function flatten(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object') {
    return {}
  }
  const root = json as Record<string, unknown>
  const merged: Record<string, unknown> = {}
  for (const nested of ['contracts', 'addresses', 'deployments']) {
    const v = root[nested]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(merged, v)
    }
  }
  return { ...merged, ...root }
}

function pick(flat: Record<string, unknown>, key: string): { present: boolean; value: unknown } {
  for (const alias of ALIASES[key] ?? [key]) {
    if (alias in flat) {
      return { present: true, value: flat[alias] }
    }
  }
  return { present: false, value: undefined }
}

/** Checksummed addresses of a list key, skipping placeholders, [] when missing or not an array */
function addressList(flat: Record<string, unknown>, key: string): Address[] {
  const { value } = pick(flat, key)
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((v): v is string => !isPlaceholderAddress(v)).map((v) => getAddress(v))
}

function asInteger(v: unknown): number | undefined {
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : undefined
}

function asPoolKey(v: unknown): PoolKey | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return undefined
  }
  const p = v as Record<string, unknown>
  const addr = (x: unknown) => (typeof x === 'string' && isAddress(x, { strict: false }) ? getAddress(x) : undefined)
  const currency0 = addr(p['currency0'])
  const currency1 = addr(p['currency1'])
  const hooks = addr(p['hooks'])
  const fee = asInteger(p['fee'])
  const tickSpacing = asInteger(p['tickSpacing'])
  if (!currency0 || !currency1 || !hooks || fee === undefined || tickSpacing === undefined) {
    return undefined
  }
  return { currency0, currency1, fee, tickSpacing, hooks }
}

/** Skips malformed or placeholder entries but throws on a `poolId` that contradicts its pool key */
function underlyings(flat: Record<string, unknown>): Underlying[] {
  const list = flat['underlyings']
  if (!Array.isArray(list)) {
    return []
  }
  const out: Underlying[] = []
  list.forEach((entry: unknown, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return
    }
    const e = entry as Record<string, unknown>
    const symbol = typeof e['symbol'] === 'string' ? e['symbol'].trim().toUpperCase() : ''
    const pool = asPoolKey(e['pool'])
    if (!symbol || !pool || isPlaceholderAddress(e['token']) || isPlaceholderAddress(e['oracle'])) {
      return
    }
    const id = poolId(pool)
    const given = e['poolId']
    if (given !== undefined && (typeof given !== 'string' || given.toLowerCase() !== id)) {
      throw new Error(`underlyings[${i}] (${symbol}) poolId ${String(given)} does not match its pool key (${id})`)
    }
    const token = getAddress(e['token'] as string)
    out.push({ symbol, token, oracle: getAddress(e['oracle'] as string), pool, poolId: id })
  })
  return out
}

/**
 * Parses `deployments/unichain-sepolia.json`. Accepts flat or `{contracts: {...}}` layouts and common key spellings.
 * Placeholders fall back to the chain defaults for Uniswap contracts and to `undefined` for ours.
 */
export function parseDeployment(json: unknown, defaults: ChainContracts = UNICHAIN_SEPOLIA): PredictionDeployment {
  const flat = flatten(json)
  const placeholders: string[] = []
  const address = (key: string): Address | undefined => {
    const { present, value } = pick(flat, key)
    if (!present) {
      return undefined
    }
    if (isPlaceholderAddress(value)) {
      placeholders.push(key)
      return undefined
    }
    return getAddress(value as string)
  }
  const chainIdRaw = flat['chainId']
  const chainId =
    typeof chainIdRaw === 'number' || typeof chainIdRaw === 'string' ? Number(chainIdRaw) : defaults.chainId
  if (!Number.isInteger(chainId) || chainId !== defaults.chainId) {
    throw new Error(`deployment chainId ${String(chainIdRaw)} does not match ${defaults.chainId}`)
  }
  const blockRaw = pick(flat, 'deployBlock').value
  let deployBlock: bigint | undefined
  if (typeof blockRaw === 'number' || (typeof blockRaw === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(blockRaw))) {
    deployBlock = BigInt(blockRaw)
  }
  const universalRouter = address('universalRouter') ?? defaults.universalRouter
  if (FORBIDDEN_ROUTERS.some((r) => r.toLowerCase() === universalRouter.toLowerCase())) {
    throw new Error(`UniversalRouter ${universalRouter} is wired to a different PoolManager on ${chainId}`)
  }
  return {
    chainId,
    predictionHook: address('predictionHook'),
    underlyingOracle: address('underlyingOracle'),
    marketGatekeeper: address('marketGatekeeper'),
    marketSchedulers: addressList(flat, 'marketSchedulers'),
    legacyMarketSchedulers: addressList(flat, 'legacyMarketSchedulers'),
    legacyPredictionHooks: addressList(flat, 'legacyPredictionHooks'),
    underlyings: underlyings(flat),
    usdc: address('usdc') ?? defaults.usdc,
    poolManager: address('poolManager') ?? defaults.poolManager,
    v4Quoter: address('v4Quoter') ?? defaults.v4Quoter,
    universalRouter,
    permit2: address('permit2') ?? defaults.permit2,
    multicall3: address('multicall3') ?? defaults.multicall3,
    deployBlock,
    placeholders,
  }
}

/** Throws a readable error when the hook address is not deployed yet. */
export function requireHook(d: PredictionDeployment): Address {
  if (!d.predictionHook) {
    throw new Error('PredictionHook address is missing or a placeholder in the deployment file')
  }
  return d.predictionHook
}

/** Throws a readable error when the gatekeeper address is not deployed yet */
export function requireGatekeeper(d: PredictionDeployment): Address {
  if (!d.marketGatekeeper) {
    throw new Error('MarketGatekeeper address is missing or a placeholder in the deployment file')
  }
  return d.marketGatekeeper
}

/** Throws a readable error when the deployment file lists no market schedulers */
export function requireSchedulers(d: PredictionDeployment): Address[] {
  if (!d.marketSchedulers.length) {
    throw new Error('marketSchedulers is missing or empty in the deployment file')
  }
  return d.marketSchedulers
}
