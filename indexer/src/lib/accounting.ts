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
 * Guard: qty must not exceed b.qty, and b.qty must not be 0n.
 */
export function sell(b: Bucket, qty: bigint, usdcOut: bigint): Bucket {
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
 */
export function transferOut(b: Bucket, qty: bigint): Bucket {
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
