import { and, eq } from 'ponder'
import { ponder, type Context } from 'ponder:registry'
import { accountStats, market, position, trade } from 'ponder:schema'
import type { Address } from 'viem'

import { loadIndexerDeployment } from './deployment.ts'
import { buy, sell, splitDebit, type Bucket } from './lib/accounting.ts'
import { attributeTrade } from './lib/attribution.ts'

const deployment = loadIndexerDeployment(process.env)

type Side = 'UP' | 'DOWN'
type Origin = 'trade' | 'received'
type PonderContext = Context<'PredictionHook:Trade'>

type PositionRow = Bucket & { id: string; account: Address; marketId: bigint; side: Side; origin: Origin }

function positionId(account: Address, marketId: bigint, side: Side, origin: Origin): string {
  return `${account}-${marketId}-${side}-${origin}`
}

async function loadPosition(
  context: PonderContext,
  account: Address,
  marketId: bigint,
  side: Side,
  origin: Origin,
): Promise<PositionRow> {
  const id = positionId(account, marketId, side, origin)
  const existing = await context.db.find(position, { id })
  return existing ?? { id, account, marketId, side, origin, qty: 0n, cost: 0n, realized: 0n }
}

async function savePosition(context: PonderContext, p: PositionRow): Promise<void> {
  await context.db
    .insert(position)
    .values(p)
    .onConflictDoUpdate({ qty: p.qty, cost: p.cost, realized: p.realized })
}

ponder.on('PredictionHook:Trade', async ({ event, context }) => {
  const { marketId, isYes, isBuy, qty, usdcAmount, avgPriceWad } = event.args

  const marketRow = await context.db.find(market, { id: marketId })
  if (!marketRow) {
    throw new Error(`trades: no market found for marketId ${marketId}`)
  }

  const side: Side = isYes ? 'UP' : 'DOWN'
  const token = (isYes ? marketRow.up : marketRow.down) as Address

  // Ponder's own `event.transactionReceipt` (from `includeTransactionReceipts`) omits `logs`; the
  // full receipt (with logs) comes from the client instead.
  const receipt = await context.client.getTransactionReceipt({ hash: event.transaction.hash })
  const { account, by } = attributeTrade({
    logs: receipt.logs,
    token,
    poolManager: deployment.poolManager,
    isBuy,
    qty,
    txFrom: event.transaction.from,
  })
  const acct = account.toLowerCase() as Address

  // Whether this account has ever traded (either side) in this market before this event.
  const priorTradeRows = await context.db.sql
    .select({ id: position.id })
    .from(position)
    .where(and(eq(position.account, acct), eq(position.marketId, marketId), eq(position.origin, 'trade')))
  const isFirstTradeInMarket = priorTradeRows.length === 0

  let tradeBucket = await loadPosition(context, acct, marketId, side, 'trade')
  let receivedBucket = await loadPosition(context, acct, marketId, side, 'received')

  const realizedBefore = tradeBucket.realized
  if (isBuy) {
    tradeBucket = { ...tradeBucket, ...buy(tradeBucket, qty, usdcAmount) }
  } else {
    const { fromTrade, fromReceived } = splitDebit(tradeBucket, receivedBucket, qty)
    // Split the sale proceeds proportionally to the quantity debited from each bucket, floor on
    // the trade part so the two parts always sum back to `usdcAmount` exactly.
    const usdcOutTrade = qty > 0n ? (usdcAmount * fromTrade) / qty : 0n
    const usdcOutReceived = usdcAmount - usdcOutTrade
    tradeBucket = { ...tradeBucket, ...sell(tradeBucket, fromTrade, usdcOutTrade) }
    receivedBucket = { ...receivedBucket, ...sell(receivedBucket, fromReceived, usdcOutReceived) }
  }
  const realizedDelta = tradeBucket.realized - realizedBefore

  await savePosition(context, tradeBucket)
  await savePosition(context, receivedBucket)

  await context.db.insert(trade).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    marketId,
    account: acct,
    side,
    isBuy,
    qty,
    usdc: usdcAmount,
    avgPriceWad,
    timestamp: Number(event.block.timestamp),
    txHash: event.transaction.hash,
    attributedBy: by,
  })

  await context.db.update(market, { id: marketId }).set((row) => ({
    volumeUsdc: row.volumeUsdc + usdcAmount,
    tradeCount: row.tradeCount + 1,
  }))

  const stats = (await context.db.find(accountStats, { account: acct })) ?? {
    account: acct,
    volumeUsdc: 0n,
    realizedTrade: 0n,
    marketsTraded: 0,
  }
  const nextStats = {
    volumeUsdc: stats.volumeUsdc + usdcAmount,
    realizedTrade: stats.realizedTrade + realizedDelta,
    marketsTraded: stats.marketsTraded + (isFirstTradeInMarket ? 1 : 0),
  }
  await context.db
    .insert(accountStats)
    .values({ account: acct, ...nextStats })
    .onConflictDoUpdate(nextStats)
})
