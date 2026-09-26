import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadIndexerDeployment } from '../src/deployment.ts'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const localDeploymentPath = path.join(repoRoot, 'deployments', 'local.json')

describe('loadIndexerDeployment', () => {
  it('defaults to unichain-sepolia with deployBlock as the snapshot start', () => {
    const deployment = loadIndexerDeployment({})

    expect(deployment.chainId).toBe(1301)
    expect(deployment.deployBlock).toBe(63521900)
    expect(deployment.snapshotStartBlock).toBe(deployment.deployBlock)
  })

  it('honors SNAPSHOT_START_BLOCK when set', () => {
    const deployment = loadIndexerDeployment({ SNAPSHOT_START_BLOCK: '63600000' })

    expect(deployment.snapshotStartBlock).toBe(63600000)
  })

  it.skipIf(!existsSync(localDeploymentPath))('reads deployments/local.json for PONDER_NETWORK=local', () => {
    const deployment = loadIndexerDeployment({ PONDER_NETWORK: 'local' })

    expect(deployment.rpcUrl).toBe('http://127.0.0.1:8545')
    expect(deployment.deployBlock).toBe(63521677)
    expect(deployment.snapshotStartBlock).toBe(63521677)
  })

  it('overrides the RPC URL with PONDER_RPC_URL_1301', () => {
    const deployment = loadIndexerDeployment({ PONDER_RPC_URL_1301: 'http://example.invalid' })

    expect(deployment.rpcUrl).toBe('http://example.invalid')
  })
})
