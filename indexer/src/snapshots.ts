import { and, gt, lte } from 'ponder'
import { ponder } from 'ponder:registry'
import { market, priceSnapshot } from 'ponder:schema'
import { parseAbi } from 'viem'

import { predictionHookAbi } from '../../packages/swap-sdk/src/abi/index.ts'
import { loadIndexerDeployment } from './deployment.ts'

const deployment = loadIndexerDeployment(process.env)

/** Minimal read of `IUnderlyingOracle.lnSpotSoBWad` (bot/src/abi.ts, app/src/abi.ts define the same signature). */
const oracleAbi = parseAbi(['function lnSpotSoBWad() view returns (int256)'])

ponder.on('PriceSnapshot:block', async ({ event, context }) => {
  const ts = Number(event.block.timestamp)

  const openMarkets = await context.db.sql
    .select()
    .from(market)
    .where(and(lte(market.openTime, ts), gt(market.expiry, ts)))

  if (openMarkets.length === 0) {
    return
  }

  const ethLnWad = await context.client.readContract({
    address: deployment.oracle,
    abi: oracleAbi,
    functionName: 'lnSpotSoBWad',
  })

  for (const m of openMarkets) {
    const quote = await context.client.readContract({
      address: deployment.hook,
      abi: predictionHookAbi,
      functionName: 'quote',
      args: [m.id],
    })

    await context.db.insert(priceSnapshot).values({
      id: `${m.id}-${event.block.number}`,
      marketId: m.id,
      blockNumber: event.block.number,
      timestamp: ts,
      midUp: quote.midYes,
      askUp: quote.askYes,
      bidUp: quote.bidYes,
      ethLnWad,
      varE36: quote.varE36,
      tau: quote.tau,
    })
  }
})
