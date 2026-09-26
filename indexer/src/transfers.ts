import { eq, or } from 'ponder'
import { ponder, type Context, type Event } from 'ponder:registry'
import { accountStats, market, position, transfer } from 'ponder:schema'
import type { Address } from 'viem'

import { loadIndexerDeployment } from './deployment.ts'
import { allocateDebit, payoutFor, sell, transferIn, transferOut, type Bucket } from './lib/accounting.ts'
import { classifyTransfer } from './lib/attribution.ts'

const deployment = loadIndexerDeployment(process.env)

type Side = 'UP' | 'DOWN'
type Origin = 'trade' | 'received'
// `UpToken:Transfer` and `DownToken:Transfer` share this handler and are structurally identical
// (both are plain ERC-20 `Transfer` sources on the same chain), so either name's type works for both.
type PonderContext = Context<'UpToken:Transfer'>
type TransferEvent = Event<'UpToken:Transfer'>

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

async function findMarketByToken(context: PonderContext, token: Address) {
  const rows = await context.db.sql
    .select()
    .from(market)
    .where(or(eq(market.up, token), eq(market.down, token)))
    .limit(1)
  return rows[0]
}

async function handleTransfer({ event, context }: { event: TransferEvent; context: PonderContext }) {
  const token = event.log.address.toLowerCase() as Address
  const from = event.args.from.toLowerCase() as Address
  const to = event.args.to.toLowerCase() as Address
  const amount = event.args.value

  const kind = classifyTransfer({ from: event.args.from, to: event.args.to, poolManager: deployment.poolManager })
  if (kind === 'ignore' || kind === 'trade-leg') {
    return
  }

  const marketRow = await findMarketByToken(context, token)
  if (!marketRow) {
    throw new Error(`transfers: no market found for token ${token}`)
  }
  const side: Side = (marketRow.up as Address).toLowerCase() === token ? 'UP' : 'DOWN'

  if (kind === 'redeem') {
    let tradeBucket = await loadPosition(context, from, marketRow.id, side, 'trade')
    let receivedBucket = await loadPosition(context, from, marketRow.id, side, 'received')

    const isWinner = side === 'UP' ? marketRow.upWon === true : marketRow.upWon === false
    const status = marketRow.status === 'invalid' ? ('invalid' as const) : ('settled' as const)
    const payoutTotal = payoutFor(status, isWinner, amount)
    const { fromTrade, fromReceived, excess, usdcTrade: payoutTrade, usdcReceived: payoutReceived } = allocateDebit(
      tradeBucket,
      receivedBucket,
      amount,
      payoutTotal,
    )
    if (excess > 0n) {
      console.warn('transfers: redeem exceeds known positions, dropping unknown-origin excess', {
        txHash: event.transaction.hash,
        account: from,
        marketId: marketRow.id,
        excess,
      })
    }

    const realizedBefore = tradeBucket.realized
    tradeBucket = { ...tradeBucket, ...sell(tradeBucket, fromTrade, payoutTrade) }
    receivedBucket = { ...receivedBucket, ...sell(receivedBucket, fromReceived, payoutReceived) }
    const realizedDelta = tradeBucket.realized - realizedBefore

    await savePosition(context, tradeBucket)
    await savePosition(context, receivedBucket)

    const stats = (await context.db.find(accountStats, { account: from })) ?? {
      account: from,
      volumeUsdc: 0n,
      realizedTrade: 0n,
      marketsTraded: 0,
    }
    const realizedTrade = stats.realizedTrade + realizedDelta
    await context.db
      .insert(accountStats)
      .values({ ...stats, realizedTrade })
      .onConflictDoUpdate({ realizedTrade })

    await context.db.insert(transfer).values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      token,
      marketId: marketRow.id,
      side,
      from,
      to,
      amount,
      kind: 'redeem',
      timestamp: Number(event.block.timestamp),
      txHash: event.transaction.hash,
    })
    return
  }

  // peer: sender debits both buckets proportionally (no realization), receiver's `received`
  // bucket gets the whole amount at zero added cost.
  let senderTrade = await loadPosition(context, from, marketRow.id, side, 'trade')
  let senderReceived = await loadPosition(context, from, marketRow.id, side, 'received')
  const { fromTrade, fromReceived, excess } = allocateDebit(senderTrade, senderReceived, amount, 0n)
  if (excess > 0n) {
    console.warn('transfers: peer transfer exceeds known positions, dropping unknown-origin excess', {
      txHash: event.transaction.hash,
      account: from,
      marketId: marketRow.id,
      excess,
    })
  }
  senderTrade = { ...senderTrade, ...transferOut(senderTrade, fromTrade) }
  senderReceived = { ...senderReceived, ...transferOut(senderReceived, fromReceived) }
  await savePosition(context, senderTrade)
  await savePosition(context, senderReceived)

  let receiverReceived = await loadPosition(context, to, marketRow.id, side, 'received')
  receiverReceived = { ...receiverReceived, ...transferIn(receiverReceived, amount) }
  await savePosition(context, receiverReceived)

  await context.db.insert(transfer).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    token,
    marketId: marketRow.id,
    side,
    from,
    to,
    amount,
    kind: 'peer',
    timestamp: Number(event.block.timestamp),
    txHash: event.transaction.hash,
  })
}

ponder.on('UpToken:Transfer', handleTransfer)
ponder.on('DownToken:Transfer', handleTransfer)
