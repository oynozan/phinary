import { type Chain, createPublicClient, createTestClient, defineChain, http, type PublicClient, type TestClient } from 'viem'
import type { AppConfig } from './config.ts'

export function makeChain(cfg: AppConfig): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.isLocalRpc ? 'Unichain Sepolia (local fork)' : 'Unichain Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: { default: { name: 'Uniscan', url: cfg.explorer } },
    contracts: { multicall3: { address: cfg.contracts.multicall3 } },
    testnet: true,
  })
}

export interface ChainClients {
  chain: Chain
  pub: PublicClient
  test?: TestClient<'anvil'>
}

export function makeClients(cfg: AppConfig): ChainClients {
  const chain = makeChain(cfg)
  const transport = http(cfg.rpcUrl, { retryCount: 1, timeout: 10_000 })
  const pub = createPublicClient({ chain, transport, pollingInterval: 500 }) as PublicClient
  const test = cfg.devTools ? createTestClient({ chain, mode: 'anvil', transport }) : undefined
  return { chain, pub, test }
}

/** Chain time that advances with the wall clock between block reads. */
export class ChainClock {
  private blockTs = 0
  private syncedAt = 0

  sync(blockTimestamp: number, nowMs: number = Date.now()): void {
    const estimate = this.estimate(nowMs)
    // Only move forward, so integer block times lagging the wall clock do not make countdowns jitter
    if (this.blockTs === 0 || blockTimestamp > estimate || estimate - blockTimestamp > 3) {
      this.blockTs = blockTimestamp
      this.syncedAt = nowMs
    }
  }

  estimate(nowMs: number = Date.now()): number {
    if (this.blockTs === 0) {
      return nowMs / 1000
    }
    return this.blockTs + (nowMs - this.syncedAt) / 1000
  }

  get synced(): boolean {
    return this.blockTs !== 0
  }
}
