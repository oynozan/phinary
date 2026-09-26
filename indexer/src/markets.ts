import { ponder } from 'ponder:registry'
import { market } from 'ponder:schema'
import type { Address } from 'viem'

import { predictionHookAbi } from '../../packages/swap-sdk/src/abi/index.ts'

ponder.on('PredictionHook:MarketCreated', async ({ event, context }) => {
  const { marketId, yes, no, yesPoolId, noPoolId, lnStrikeWad, expiry } = event.args

  const info = await context.client.readContract({
    address: event.log.address,
    abi: predictionHookAbi,
    functionName: 'marketInfo',
    args: [marketId],
  })

  await context.db.insert(market).values({
    id: marketId,
    up: (yes as Address).toLowerCase() as Address,
    down: (no as Address).toLowerCase() as Address,
    upPoolId: yesPoolId,
    downPoolId: noPoolId,
    lnStrikeWad,
    openTime: Number(info.openTime),
    expiry: Number(expiry),
    window: info.window,
    cutoffBuffer: info.cutoffBuffer,
    status: 'trading',
    upWon: null,
    avgNormTickTimesWindow: null,
    settleTx: null,
    volumeUsdc: 0n,
    tradeCount: 0,
    createdAt: Number(event.block.timestamp),
  })
})

ponder.on('PredictionHook:MarketSettled', async ({ event, context }) => {
  const { marketId, yesWon, avgNormTickTimesWindow, invalid } = event.args

  await context.db.update(market, { id: marketId }).set({
    status: invalid ? 'invalid' : 'settled',
    upWon: yesWon,
    avgNormTickTimesWindow,
    settleTx: event.transaction.hash,
  })
})
