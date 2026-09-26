import { and, gt, lte } from 'ponder'
import { ponder } from 'ponder:registry'
import { market, priceSnapshot } from 'ponder:schema'
import { parseAbi } from 'viem'

import { predictionHookAbi } from '../../packages/swap-sdk/src/abi/index.ts'
import { loadIndexerDeployment } from './deployment.ts'
import { oracleOf, oraclesOf } from './lib/tracks.ts'

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

  // Batched reads keep the backfill fast with several tracks open at once
  const oracles = oraclesOf(openMarkets, deployment.oracle)
  const [spots, quotes] = await Promise.all([
    context.client.multicall({
      multicallAddress: deployment.multicall3,
      allowFailure: true,
      contracts: oracles.map((address) => ({ address, abi: oracleAbi, functionName: 'lnSpotSoBWad' }) as const),
    }),
    context.client.multicall({
      multicallAddress: deployment.multicall3,
      allowFailure: true,
      contracts: openMarkets.map(
        (m) => ({ address: deployment.hook, abi: predictionHookAbi, functionName: 'quote', args: [m.id] }) as const,
      ),
    }),
  ])
  const lnSpot = new Map(oracles.map((oracle, i) => [oracle, spots[i]]))

  for (const [i, m] of openMarkets.entries()) {
    const spot = lnSpot.get(oracleOf(m, deployment.oracle))
    const quote = quotes[i]
    if (spot?.status !== 'success' || quote?.status !== 'success') {
      continue
    }

    await context.db.insert(priceSnapshot).values({
      id: `${m.id}-${event.block.number}`,
      marketId: m.id,
      blockNumber: event.block.number,
      timestamp: ts,
      midUp: quote.result.midYes,
      askUp: quote.result.askYes,
      bidUp: quote.result.bidYes,
      ethLnWad: spot.result,
      varE36: quote.result.varE36,
      tau: quote.result.tau,
    })
  }
})
