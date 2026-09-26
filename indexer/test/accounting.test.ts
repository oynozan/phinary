import { describe, expect, test } from 'vitest'

import { EMPTY, buy, sell, transferOut, transferIn, splitDebit, payoutFor } from '../src/lib/accounting.ts'

const U = 1_000_000n

describe('accounting', () => {
  test('spec §6 worked example', () => {
    let b = buy(EMPTY, 10n * U, 6_200_000n)
    expect(b).toEqual({ qty: 10n * U, cost: 6_200_000n, realized: 0n })
    b = buy(b, 10n * U, 7_000_000n)
    expect(b).toEqual({ qty: 20n * U, cost: 13_200_000n, realized: 0n })
    b = sell(b, 5n * U, 3_500_000n)
    expect(b).toEqual({ qty: 15n * U, cost: 9_900_000n, realized: 200_000n })
    b = transferOut(b, 5n * U)
    expect(b).toEqual({ qty: 10n * U, cost: 6_600_000n, realized: 200_000n })
    b = sell(b, 10n * U, payoutFor('settled', true, 10n * U))
    expect(b).toEqual({ qty: 0n, cost: 0n, realized: 3_600_000n })
    expect(transferIn(EMPTY, 5n * U)).toEqual({ qty: 5n * U, cost: 0n, realized: 0n })
  })

  test('splitDebit takes trade bucket first', () => {
    expect(splitDebit({ ...EMPTY, qty: 3n }, { ...EMPTY, qty: 5n }, 4n)).toEqual({ fromTrade: 3n, fromReceived: 1n })
  })

  test('invalid pays half', () => expect(payoutFor('invalid', false, 7n)).toBe(3n))

  test('zero-quantity debits are no-ops', () => {
    expect(sell(EMPTY, 0n, 0n)).toEqual(EMPTY)
    expect(transferOut(EMPTY, 0n)).toEqual(EMPTY)
  })

  test('sell throws on insufficient qty', () => {
    expect(() => sell(EMPTY, 1n, 1n)).toThrow()
    expect(() => sell({ qty: 5n, cost: 5n, realized: 0n }, 6n, 6n)).toThrow()
  })

  test('transferOut throws on insufficient qty', () => {
    expect(() => transferOut(EMPTY, 1n)).toThrow()
  })

  test('sell throws when receiving USDC without selling tokens', () => {
    expect(() => sell(EMPTY, 0n, 1n)).toThrow()
  })
})
