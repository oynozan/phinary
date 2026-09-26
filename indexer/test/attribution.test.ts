import { describe, expect, test } from 'vitest'
import { encodeEventTopics, encodeAbiParameters, erc20Abi, type Log } from 'viem'

import { classifyTransfer, attributeTrade } from '../src/lib/attribution.ts'

const ALICE = '0x1111111111111111111111111111111111111111' as const
const BOB = '0x2222222222222222222222222222222222222222' as const
const RELAYER = '0x3333333333333333333333333333333333333333' as const
const UP = '0x4444444444444444444444444444444444444444' as const
const PM = '0x00B036B58a818B1BC34d502D3fE730Db729e62AC' as const
const Z = '0x0000000000000000000000000000000000000000' as const

function transferLog(token: string, from: string, to: string, value: bigint): Log {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: 'Transfer',
    args: { from: from as `0x${string}`, to: to as `0x${string}` },
  })
  const data = encodeAbiParameters([{ type: 'uint256' }], [value])

  return {
    address: token as `0x${string}`,
    topics: topics as [`0x${string}`, ...`0x${string}`[]],
    data: data as `0x${string}`,
    blockNumber: 1n,
    transactionHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
    transactionIndex: 0,
    blockHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
    logIndex: 0,
    removed: false,
  } as Log
}

describe('attribution', () => {
  test.each([
    [{ from: Z, to: PM }, 'ignore'],
    [{ from: ALICE, to: Z }, 'redeem'],
    [{ from: PM, to: ALICE }, 'trade-leg'],
    [{ from: ALICE, to: PM }, 'trade-leg'],
    [{ from: ALICE, to: BOB }, 'peer'],
  ])('classify %o', (t, k) => {
    expect(classifyTransfer({ ...t, poolManager: PM })).toBe(k)
  })

  test('buy attributed to PoolManager recipient', () => {
    const logs = [transferLog(UP, Z, PM, 7n), transferLog(UP, PM, ALICE, 7n)]
    expect(attributeTrade({ logs, token: UP, poolManager: PM, isBuy: true, qty: 7n, txFrom: RELAYER })).toEqual({
      account: ALICE,
      by: 'transfer',
    })
  })

  test('falls back to tx.from', () => {
    expect(attributeTrade({ logs: [], token: UP, poolManager: PM, isBuy: false, qty: 7n, txFrom: RELAYER })).toEqual({
      account: RELAYER,
      by: 'txFrom',
    })
  })
})
