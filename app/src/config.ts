import { type Address, getAddress, isAddress } from 'viem'
import {
  type ChainContracts,
  isPlaceholderAddress,
  parseDeployment,
  sameAddress,
  UNICHAIN_SEPOLIA,
  UNICHAIN_SEPOLIA_EXPLORER,
  UNICHAIN_SEPOLIA_RPC_URL,
} from './sdk.ts'

export type HookSource = 'url' | 'env' | 'deployment' | 'saved' | 'none'

export interface AppConfig {
  chainId: number
  rpcUrl: string
  isLocalRpc: boolean
  explorer: string
  contracts: ChainContracts
  hook?: Address
  hookSource: HookSource
  underlyingOracle?: Address
  /** The deployment's track schedulers, empty unless `hook` is the deployment's own hook */
  marketSchedulers: Address[]
  /** Oracle of each price source, to name the asset of a market no track claims */
  underlyings: { symbol: string; oracle: Address }[]
  /** Anvil helpers (burner wallet, funding) are shown. */
  devTools: boolean
  marketLimit: number
  warnings: string[]
}

export interface ConfigInputs {
  search?: string
  env?: Record<string, string | undefined>
  deployment?: unknown
  savedHook?: string | null
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1', 'host.docker.internal'])

export function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.local')
  } catch {
    return false
  }
}

function addressOrUndefined(value: string | null | undefined): Address | undefined {
  if (!value || !isAddress(value, { strict: false }) || isPlaceholderAddress(value)) {
    return undefined
  }
  return getAddress(value)
}

function truthy(value: string | null | undefined): boolean {
  return !!value && !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

/** URL parameters win over VITE_* variables, which win over the deployment file baked in at build time. */
export function resolveConfig({ search = '', env = {}, deployment = {}, savedHook }: ConfigInputs): AppConfig {
  const params = new URLSearchParams(search)
  const warnings: string[] = []

  const chainIdRaw = params.get('chainId') ?? env['VITE_CHAIN_ID']
  const chainId = chainIdRaw && /^\d+$/.test(chainIdRaw) ? Number(chainIdRaw) : UNICHAIN_SEPOLIA.chainId
  const defaults: ChainContracts = { ...UNICHAIN_SEPOLIA, chainId }

  let parsed
  try {
    parsed = parseDeployment(deployment, defaults)
  } catch (err) {
    warnings.push(`Deployment file ignored: ${err instanceof Error ? err.message : String(err)}`)
    parsed = parseDeployment({}, defaults)
  }

  const rpcParam = params.get('rpc')
  const rpcUrl = rpcParam || env['VITE_RPC_URL'] || UNICHAIN_SEPOLIA_RPC_URL
  const isLocalRpc = isLocalUrl(rpcUrl)

  const override = (name: string, fallback: Address): Address => {
    const raw = params.get(name)
    if (raw === null) {
      return fallback
    }
    const a = addressOrUndefined(raw)
    if (!a) {
      warnings.push(`Ignored invalid ?${name}=${raw}`)
    }
    return a ?? fallback
  }

  const contracts: ChainContracts = {
    chainId,
    poolManager: override('poolManager', parsed.poolManager),
    v4Quoter: override('quoter', parsed.v4Quoter),
    universalRouter: override('router', parsed.universalRouter),
    permit2: override('permit2', parsed.permit2),
    usdc: override('usdc', parsed.usdc),
    multicall3: override('multicall', parsed.multicall3),
  }

  let hook: Address | undefined
  let hookSource: HookSource = 'none'
  const candidates: [HookSource, string | null | undefined][] = [
    ['url', params.get('hook')],
    ['env', env['VITE_PREDICTION_HOOK']],
    ['deployment', parsed.predictionHook],
    ['saved', savedHook],
  ]
  for (const [source, value] of candidates) {
    const a = addressOrUndefined(value)
    if (a) {
      hook = a
      hookSource = source
      break
    }
    if (source === 'url' && value) {
      warnings.push(`Ignored invalid ?hook=${value}`)
    }
  }

  const oracleParam = addressOrUndefined(params.get('oracle'))
  const limitRaw = Number(params.get('markets') ?? '')
  const marketLimit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 24
  const devParam = params.get('dev')
  const devTools = devParam !== null ? truthy(devParam) : isLocalRpc || truthy(env['VITE_DEV_TOOLS'])

  return {
    chainId,
    rpcUrl,
    isLocalRpc,
    explorer: UNICHAIN_SEPOLIA_EXPLORER,
    contracts,
    hook,
    hookSource,
    underlyingOracle: oracleParam ?? parsed.underlyingOracle,
    marketSchedulers: hook && parsed.predictionHook && sameAddress(hook, parsed.predictionHook) ? parsed.marketSchedulers : [],
    underlyings: parsed.underlyings.map(({ symbol, oracle }) => ({ symbol, oracle })),
    devTools,
    marketLimit,
    warnings,
  }
}

export const SAVED_HOOK_KEY = 'prediction.backup.hook'

export function readSaved(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeSaved(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    /* storage unavailable */
  }
}

export function loadConfig(): AppConfig {
  return resolveConfig({
    search: window.location.search,
    env: import.meta.env as unknown as Record<string, string | undefined>,
    deployment: typeof __DEPLOYMENT__ === 'undefined' ? {} : __DEPLOYMENT__,
    savedHook: readSaved(SAVED_HOOK_KEY),
  })
}

export function txUrl(cfg: Pick<AppConfig, 'explorer'>, hash: string): string {
  return `${cfg.explorer}/tx/${hash}`
}

export function addressUrl(cfg: Pick<AppConfig, 'explorer'>, address: string): string {
  return `${cfg.explorer}/address/${address}`
}
