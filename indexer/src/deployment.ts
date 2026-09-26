import { readFileSync } from 'node:fs'
import path from 'node:path'
import { type Address, isAddress } from 'viem'

export type IndexerNetwork = 'unichain-sepolia' | 'local'

export type IndexerUnderlying = { symbol: string; oracle: Address }

export type IndexerDeployment = {
  chainId: number
  rpcUrl: string
  /** `rpcUrl` split on commas; Ponder spreads requests across them and backs off any that rate-limit. */
  rpcUrls: string[]
  hook: Address
  oracle: Address
  poolManager: Address
  multicall3: Address
  deployBlock: number
  snapshotStartBlock: number
  /** The MarketGatekeeper that owns `hook`, if the file has been migrated to tracks */
  marketGatekeeper?: Address
  /** One MarketScheduler per track, in gatekeeper order. Empty for a file with none. */
  marketSchedulers: Address[]
  /** Schedulers of prior hooks, oldest first, never indexed */
  legacyMarketSchedulers: Address[]
  /** Prior `hook` addresses, oldest first. Empty for a file with none. */
  legacyPredictionHooks: Address[]
  /** Price sources by asset symbol, the flat ETH oracle when the file has no `underlyings` list */
  underlyings: IndexerUnderlying[]
}

type DeploymentFile = {
  chainId: number
  rpcUrl: string
  predictionHook: Address
  underlyingOracle: Address
  poolManager: Address
  multicall3?: Address
  deployBlock: number
  marketGatekeeper?: Address
  marketSchedulers?: unknown
  legacyMarketSchedulers?: unknown
  legacyPredictionHooks?: unknown
  underlyings?: unknown
}

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address

// `import.meta.dirname` is undefined under Ponder's own esbuild-based config bundler (it evaluates
// ponder.config.ts outside a plain Node ESM loader), so it can't be used here. Ponder always runs
// with `indexer/` as the working directory, so the repo root is one level up from `process.cwd()`.
const repoRoot = path.resolve(process.cwd(), '..')

function resolveNetwork(env: Record<string, string | undefined>): IndexerNetwork {
  return env.PONDER_NETWORK === 'local' ? 'local' : 'unichain-sepolia'
}

function addressList(value: unknown): Address[] {
  return Array.isArray(value) ? value.filter((a): a is Address => typeof a === 'string' && isAddress(a)) : []
}

function underlyingList(value: unknown, fallbackOracle: Address): IndexerUnderlying[] {
  const entries = Array.isArray(value)
    ? value.flatMap((u) =>
        u && typeof u === 'object' && typeof u.symbol === 'string' && typeof u.oracle === 'string' && isAddress(u.oracle)
          ? [{ symbol: u.symbol as string, oracle: u.oracle as Address }]
          : [],
      )
    : []
  return entries.length > 0 ? entries : [{ symbol: 'ETH', oracle: fallbackOracle }]
}

/**
 * Reads the deployment JSON selected by `PONDER_NETWORK` (default: `unichain-sepolia`) and derives
 * the values Ponder's config needs. `deployments/local.json` is git-ignored, so only the file
 * selected by `PONDER_NETWORK` is ever read.
 */
export function loadIndexerDeployment(env: Record<string, string | undefined>): IndexerDeployment {
  const network = resolveNetwork(env)
  const deploymentPath = path.join(repoRoot, 'deployments', `${network}.json`)
  const file = JSON.parse(readFileSync(deploymentPath, 'utf8')) as DeploymentFile

  const rpcUrl = env.PONDER_RPC_URL_1301 ?? file.rpcUrl
  const rpcUrls = rpcUrl.split(',').map((url) => url.trim()).filter(Boolean)
  if (rpcUrls.length === 0 || rpcUrls.some((url) => !/^https?:\/\//.test(url))) {
    throw new Error('PONDER_RPC_URL_1301 must be one or more comma-separated http(s) URLs')
  }
  const deployBlock = file.deployBlock
  const snapshotStartBlock = env.SNAPSHOT_START_BLOCK ? Number(env.SNAPSHOT_START_BLOCK) : deployBlock
  if (!Number.isSafeInteger(snapshotStartBlock) || snapshotStartBlock < deployBlock) {
    throw new Error(`SNAPSHOT_START_BLOCK must be an integer >= ${deployBlock}`)
  }

  return {
    chainId: file.chainId,
    rpcUrl,
    rpcUrls,
    hook: file.predictionHook,
    oracle: file.underlyingOracle,
    poolManager: file.poolManager,
    multicall3: file.multicall3 && isAddress(file.multicall3) ? file.multicall3 : MULTICALL3,
    deployBlock,
    snapshotStartBlock,
    marketGatekeeper: file.marketGatekeeper,
    marketSchedulers: addressList(file.marketSchedulers),
    legacyMarketSchedulers: addressList(file.legacyMarketSchedulers),
    legacyPredictionHooks: addressList(file.legacyPredictionHooks),
    underlyings: underlyingList(file.underlyings, file.underlyingOracle),
  }
}
