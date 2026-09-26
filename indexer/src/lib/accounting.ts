/**
 * Pure accounting: average-cost positions, realized gains/losses, and payouts.
 * No Ponder runtime, no async — just bigint math.
 */

export interface Bucket {
  qty: bigint
  cost: bigint
  realized: bigint
}

export const EMPTY: Bucket = { qty: 0n, cost: 0n, realized: 0n }

/**
 * Add qty at average cost.
 */
export function buy(b: Bucket, qty: bigint, usdc: bigint): Bucket {
  return {
    qty: b.qty + qty,
    cost: b.cost + usdc,
    realized: b.realized,
  }
}

/**
 * Remove qty with realized gain/loss.
 * Cost removed is `cost * qty / b.qty` (floor division).
 * Realized gain/loss is `usdcOut - costOut`.
 * A 0n debit is a no-op: returns the bucket unchanged.
 * Guard: qty must not exceed b.qty. Throws if qty > 0n but b.qty === 0n.
 * Guard: if qty === 0n but usdcOut > 0n, throws (money without tokens is a bug).
 */
export function sell(b: Bucket, qty: bigint, usdcOut: bigint): Bucket {
  // Zero-quantity debit: only valid if usdcOut is also 0n
  if (qty === 0n) {
    if (usdcOut > 0n) {
      throw new Error('Cannot receive USDC without selling tokens')
    }
    return b
  }

  if (b.qty === 0n) {
    throw new Error('Cannot sell from an empty bucket')
  }
  if (qty > b.qty) {
    throw new Error('Cannot sell more than bucket quantity')
  }

  const costOut = (b.cost * qty) / b.qty
  const newRealized = b.realized + (usdcOut - costOut)

  return {
    qty: b.qty - qty,
    cost: b.cost - costOut,
    realized: newRealized,
  }
}

/**
 * Transfer out qty at proportional cost (same as sell, but realizes nothing).
 * A 0n debit is a no-op: returns the bucket unchanged.
 * Guard: qty must not exceed b.qty. Throws if qty > 0n but b.qty === 0n.
 */
export function transferOut(b: Bucket, qty: bigint): Bucket {
  // Zero-quantity debit: no-op
  if (qty === 0n) {
    return b
  }

  if (b.qty === 0n) {
    throw new Error('Cannot transfer out from an empty bucket')
  }
  if (qty > b.qty) {
    throw new Error('Cannot transfer out more than bucket quantity')
  }

  const costOut = (b.cost * qty) / b.qty

  return {
    qty: b.qty - qty,
    cost: b.cost - costOut,
    realized: b.realized,
  }
}

/**
 * Transfer in qty at zero cost.
 */
export function transferIn(b: Bucket, qty: bigint): Bucket {
  return {
    qty: b.qty + qty,
    cost: b.cost,
    realized: b.realized,
  }
}

/**
 * Split a debit across two buckets: trade first, then received.
 */
export function splitDebit(
  trade: Bucket,
  received: Bucket,
  qty: bigint,
): { fromTrade: bigint; fromReceived: bigint } {
  const fromTrade = trade.qty < qty ? trade.qty : qty
  const fromReceived = qty - fromTrade

  return { fromTrade, fromReceived }
}

/**
 * Split a debit across the trade and received buckets, never more than each bucket actually holds.
 * Any remainder after both buckets are drained is `excess`: tokens of unknown origin (e.g. credited
 * outside the two tracked buckets) that callers must drop rather than force through `sell`/
 * `transferOut`, which throw on an over-debit.
 *
 * `usdc` (the sale proceeds, or a redeem's payout) is split proportionally to `qty` across
 * (fromTrade, fromReceived, excess), floored, with the excess's share silently dropped. `usdcTrade`
 * and `usdcReceived` still sum exactly to each other's shared total: `usdcReceived` is what's left of
 * the non-excess proceeds after `usdcTrade`, not an independent floor, so no unit is lost to double
 * rounding between the two known buckets.
 */
export function allocateDebit(
  trade: Bucket,
  received: Bucket,
  qty: bigint,
  usdc: bigint,
): { fromTrade: bigint; fromReceived: bigint; excess: bigint; usdcTrade: bigint; usdcReceived: bigint } {
  if (qty === 0n) {
    return { fromTrade: 0n, fromReceived: 0n, excess: 0n, usdcTrade: 0n, usdcReceived: 0n }
  }

  const fromTrade = trade.qty < qty ? trade.qty : qty
  const remaining = qty - fromTrade
  const fromReceived = received.qty < remaining ? received.qty : remaining
  const excess = remaining - fromReceived

  const nonExcessQty = fromTrade + fromReceived
  const nonExcessUsdc = (usdc * nonExcessQty) / qty
  const usdcTrade = (usdc * fromTrade) / qty
  const usdcReceived = nonExcessUsdc - usdcTrade

  return { fromTrade, fromReceived, excess, usdcTrade, usdcReceived }
}

/**
 * Calculate payout based on settlement status.
 * - settled + winner: qty
 * - settled + loser: 0n
 * - invalid (regardless of isWinner): qty / 2 (floor)
 */
export function payoutFor(status: 'settled' | 'invalid', isWinner: boolean, qty: bigint): bigint {
  if (status === 'invalid') {
    return qty / 2n
  }

  if (status === 'settled') {
    return isWinner ? qty : 0n
  }

  // Should not reach here due to type guard, but TypeScript needs it
  return 0n
}
