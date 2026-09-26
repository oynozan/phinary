/**
 * Pure trade attribution: classify transfer types and attribute trades to accounts.
 * No Ponder runtime, no async — just event log parsing.
 */

import { Address, Log, erc20Abi, parseEventLogs } from 'viem'

export type TransferKind = 'trade-leg' | 'redeem' | 'peer' | 'ignore'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Classify a transfer by its source and destination relative to the PoolManager.
 * Rules in order:
 * 1. from == 0x0 → ignore (mint to the PoolManager)
 * 2. to == 0x0 → redeem
 * 3. from or to is the PoolManager → trade-leg
 * 4. anything else → peer
 *
 * Address comparisons are case-insensitive.
 */
export function classifyTransfer(p: {
  from: Address
  to: Address
  poolManager: Address
}): TransferKind {
  const from = p.from.toLowerCase()
  const to = p.to.toLowerCase()
  const pm = p.poolManager.toLowerCase()

  if (from === ZERO_ADDRESS.toLowerCase()) {
    return 'ignore'
  }

  if (to === ZERO_ADDRESS.toLowerCase()) {
    return 'redeem'
  }

  if (from === pm || to === pm) {
    return 'trade-leg'
  }

  return 'peer'
}

/**
 * Attribute a trade to an account by finding the matching ERC-20 Transfer log.
 *
 * On a buy:
 * - Looks for a Transfer from PoolManager with value == qty
 * - The recipient is the account
 *
 * On a sell:
 * - Looks for a Transfer to PoolManager with value == qty
 * - The sender is the account
 *
 * If no matching log is found, falls back to txFrom.
 *
 * Decoded transfers are filtered by log.address == token (case-insensitive).
 */
export function attributeTrade(p: {
  logs: readonly Log[]
  token: Address
  poolManager: Address
  isBuy: boolean
  qty: bigint
  txFrom: Address
}): { account: Address; by: 'transfer' | 'txFrom' } {
  const tokenAddr = p.token.toLowerCase()
  const pmAddr = p.poolManager.toLowerCase()

  try {
    const parsed = parseEventLogs({
      abi: erc20Abi,
      eventName: 'Transfer',
      logs: [...p.logs],
    })

    for (const log of parsed) {
      // Filter by token address (case-insensitive)
      if (log.address.toLowerCase() !== tokenAddr) {
        continue
      }

      // Filter by value (must match qty)
      if (log.args.value !== p.qty) {
        continue
      }

      if (p.isBuy) {
        // On buy: from == PoolManager, take the recipient (to)
        if (log.args.from?.toLowerCase() === pmAddr) {
          return {
            account: log.args.to!,
            by: 'transfer',
          }
        }
      } else {
        // On sell: to == PoolManager, take the sender (from)
        if (log.args.to?.toLowerCase() === pmAddr) {
          return {
            account: log.args.from!,
            by: 'transfer',
          }
        }
      }
    }
  } catch {
    // Parsing failed; fall back to txFrom
  }

  // No matching log found, fall back to txFrom
  return {
    account: p.txFrom,
    by: 'txFrom',
  }
}
