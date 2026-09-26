import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Address } from 'viem'

export type IndexerNetwork = 'unichain-sepolia' | 'local'

export type IndexerDeployment = {
  chainId: number
  rpcUrl: string
  hook: Address
  oracle: Address
  poolManager: Address
  deployBlock: number
  snapshotStartBlock: number
}

type DeploymentFile = {
  chainId: number
  rpcUrl: string
  predictionHook: Address
  underlyingOracle: Address
  poolManager: Address
  deployBlock: number
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function resolveNetwork(env: Record<string, string | undefined>): IndexerNetwork {
  return env.PONDER_NETWORK === 'local' ? 'local' : 'unichain-sepolia'
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
  const deployBlock = file.deployBlock
  const snapshotStartBlock = env.SNAPSHOT_START_BLOCK ? Number(env.SNAPSHOT_START_BLOCK) : deployBlock

  return {
    chainId: file.chainId,
    rpcUrl,
    hook: file.predictionHook,
    oracle: file.underlyingOracle,
    poolManager: file.poolManager,
    deployBlock,
    snapshotStartBlock,
  }
}
