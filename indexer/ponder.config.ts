import { createConfig, factory } from 'ponder'
import { parseAbiItem } from 'viem'

import { erc20Abi, marketSchedulerAbi, predictionHookAbi } from '../packages/swap-sdk/src/abi/index.ts'
import { loadIndexerDeployment } from './src/deployment.ts'

const deployment = loadIndexerDeployment(process.env)

// Mirrors PredictionHook's MarketCreated event (packages/swap-sdk/src/abi/predictionHook.generated.ts);
// used here only to locate each market's UP/DOWN token addresses via the factory pattern.
const marketCreatedEvent = parseAbiItem(
  'event MarketCreated(uint256 indexed marketId, address yes, address no, bytes32 yesPoolId, bytes32 noPoolId, int256 lnStrikeWad, uint64 expiry)',
)

const marketScheduler = {
  abi: marketSchedulerAbi,
  chain: 'unichainSepolia' as const,
  address: deployment.marketSchedulers,
  startBlock: deployment.deployBlock,
}

// Ponder rejects an empty address list, so a file without tracks has no MarketScheduler source
const schedulerSources = (deployment.marketSchedulers.length > 0 ? { MarketScheduler: marketScheduler } : {}) as {
  MarketScheduler: typeof marketScheduler
}

export default createConfig({
  // A long-running instance gets its own PGlite directory so `ponder dev` never opens it
  ...(process.env.PONDER_PGLITE_DIR ? { database: { kind: 'pglite' as const, directory: process.env.PONDER_PGLITE_DIR } } : {}),
  chains: {
    unichainSepolia: {
      id: deployment.chainId,
      rpc: deployment.rpcUrls,
      // drpc's free plan rejects eth_getLogs spans over 100 blocks with an error Ponder cannot parse
      ethGetLogsBlockRange: Number(process.env.PONDER_GETLOGS_BLOCK_RANGE ?? 100),
    },
  },
  contracts: {
    PredictionHook: {
      abi: predictionHookAbi,
      chain: 'unichainSepolia',
      address: deployment.hook,
      startBlock: deployment.deployBlock,
      includeTransactionReceipts: true,
    },
    UpToken: {
      abi: erc20Abi,
      chain: 'unichainSepolia',
      address: factory({
        address: deployment.hook,
        event: marketCreatedEvent,
        parameter: 'yes',
      }),
      startBlock: deployment.deployBlock,
    },
    DownToken: {
      abi: erc20Abi,
      chain: 'unichainSepolia',
      address: factory({
        address: deployment.hook,
        event: marketCreatedEvent,
        parameter: 'no',
      }),
      startBlock: deployment.deployBlock,
    },
    ...schedulerSources,
  },
  blocks: {
    PriceSnapshot: {
      chain: 'unichainSepolia',
      startBlock: deployment.snapshotStartBlock,
      interval: 2,
    },
    VaultSnapshot: {
      chain: 'unichainSepolia',
      startBlock: deployment.snapshotStartBlock,
      interval: 30,
    },
  },
})
