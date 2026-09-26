import { createConfig, factory } from 'ponder'
import { parseAbiItem } from 'viem'

import { erc20Abi, predictionHookAbi } from '../packages/swap-sdk/src/abi/index.ts'
import { loadIndexerDeployment } from './src/deployment.ts'

const deployment = loadIndexerDeployment(process.env)

// Mirrors PredictionHook's MarketCreated event (packages/swap-sdk/src/abi/predictionHook.generated.ts);
// used here only to locate each market's UP/DOWN token addresses via the factory pattern.
const marketCreatedEvent = parseAbiItem(
  'event MarketCreated(uint256 indexed marketId, address yes, address no, bytes32 yesPoolId, bytes32 noPoolId, int256 lnStrikeWad, uint64 expiry)',
)

export default createConfig({
  chains: {
    unichainSepolia: {
      id: deployment.chainId,
      rpc: deployment.rpcUrls,
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
