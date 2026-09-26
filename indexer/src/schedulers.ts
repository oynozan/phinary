import { ponder } from 'ponder:registry'
import { market, track } from 'ponder:schema'

import { marketSchedulerAbi } from '../../packages/swap-sdk/src/abi/index.ts'
import { loadIndexerDeployment } from './deployment.ts'
import { openedMarketFields, trackRow } from './lib/tracks.ts'

const deployment = loadIndexerDeployment(process.env)

// Ponder rejects a handler for a source the config left out
if (deployment.marketSchedulers.length > 0) {
  ponder.on('MarketScheduler:MarketOpened', async ({ event, context }) => {
    const scheduler = event.log.address.toLowerCase() as `0x${string}`
    let row = await context.db.find(track, { id: scheduler })
    if (!row) {
      const base = { address: scheduler, abi: marketSchedulerAbi, cache: 'immutable' } as const
      const [config, oracle, gatekeeper] = await Promise.all([
        context.client.readContract({ ...base, functionName: 'config' }),
        context.client.readContract({ ...base, functionName: 'oracle' }),
        context.client.readContract({ ...base, functionName: 'gatekeeper' }),
      ])
      row = trackRow(scheduler, gatekeeper, oracle, config)
      await context.db.insert(track).values(row)
    }

    const opened = await context.db.find(market, { id: event.args.marketId })
    if (!opened) {
      throw new Error(`MarketOpened for market ${event.args.marketId} before its MarketCreated`)
    }
    await context.db.update(market, { id: event.args.marketId }).set(openedMarketFields(row, event.args, opened.expiry))
  })
}
