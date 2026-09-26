import { type Address, getAddress, isAddress, zeroAddress } from 'viem'
import { type ChainContracts, FORBIDDEN_ROUTERS, UNICHAIN_SEPOLIA } from './constants.ts'

/** Our contracts on one chain. Addresses that are missing or placeholders in the JSON are `undefined`. */
export interface PredictionDeployment extends ChainContracts {
  predictionHook?: Address
  underlyingOracle?: Address
  /** The ownerless MarketScheduler that owns `predictionHook` and is the only account able to open markets. */
  marketScheduler?: Address
  /** Prior `predictionHook` addresses the scheduler migrated away from, oldest first. Empty for a file with none. */
  legacyPredictionHooks: Address[]
  deployBlock?: bigint
  /** Keys that were present but held a placeholder value. */
  placeholders: string[]
}

const ALIASES: Record<string, string[]> = {
  predictionHook: ['predictionHook', 'PredictionHook', 'prediction_hook', 'hook'],
  underlyingOracle: ['underlyingOracle', 'UnderlyingOracleHook', 'underlyingOracleHook', 'oracleHook', 'oracle'],
  marketScheduler: ['marketScheduler', 'MarketScheduler'],
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

/** `legacyPredictionHooks`, if present: an array of addresses, dropping placeholders. Missing or malformed yields []. */
function legacyPredictionHooks(flat: Record<string, unknown>): Address[] {
  const { value } = pick(flat, 'legacyPredictionHooks')
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((v): v is string => !isPlaceholderAddress(v)).map((v) => getAddress(v))
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
    marketScheduler: address('marketScheduler'),
    legacyPredictionHooks: legacyPredictionHooks(flat),
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
