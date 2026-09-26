import { ponder } from 'ponder:registry'
import { vaultEvent, vaultSnapshot } from 'ponder:schema'
import type { Address } from 'viem'

import { predictionHookAbi } from '../../packages/swap-sdk/src/abi/index.ts'
import { loadIndexerDeployment } from './deployment.ts'

const deployment = loadIndexerDeployment(process.env)

ponder.on('VaultSnapshot:block', async ({ event, context }) => {
  const hook = deployment.hook
  const [navPlus, navMinus, totalShares, idle] = await Promise.all([
    context.client.readContract({ address: hook, abi: predictionHookAbi, functionName: 'navPlus' }),
    context.client.readContract({ address: hook, abi: predictionHookAbi, functionName: 'navMinus' }),
    context.client.readContract({ address: hook, abi: predictionHookAbi, functionName: 'totalShares' }),
    context.client.readContract({ address: hook, abi: predictionHookAbi, functionName: 'vaultIdle' }),
  ])

  await context.db.insert(vaultSnapshot).values({
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
    navPlus,
    navMinus,
    totalShares,
    idle,
  })
})

ponder.on('PredictionHook:Deposit', async ({ event, context }) => {
  await context.db.insert(vaultEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    account: (event.args.account as Address).toLowerCase() as Address,
    kind: 'deposit',
    assets: event.args.assets,
    shares: event.args.shares,
    timestamp: Number(event.block.timestamp),
    txHash: event.transaction.hash,
  })
})

ponder.on('PredictionHook:Withdraw', async ({ event, context }) => {
  await context.db.insert(vaultEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    account: (event.args.account as Address).toLowerCase() as Address,
    kind: 'withdraw',
    assets: event.args.assets,
    shares: event.args.shares,
    timestamp: Number(event.block.timestamp),
    txHash: event.transaction.hash,
  })
})
