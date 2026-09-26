import { describe, expect, test } from 'vitest'

import type { SchedulerConfig } from '../../packages/swap-sdk/src/tracks.ts'
import { assetOfOracle, openedMarketFields, oracleOf, oraclesOf, trackRow } from '../src/lib/tracks.ts'

const SCHEDULER = '0x02f0B250120c817A45C6ba580FE68eB461E0A10e' as const
const GATEKEEPER = '0x755dBc10AB4b9BFDB8c46939702dC08B8F3e607A' as const
const ETH_ORACLE = '0x1F356D9E7d6dBE6d807aCBc5D163a7af265cd080' as const
const SOL_ORACLE = '0xc7dDbB6648BE0DFCF3eF2a68D40d66374184D080' as const
const CALLER = '0x7B7600000000000000000000000000000000AbCd' as const

const config15m: SchedulerConfig = {
  period: 900,
  tenor: 900,
  window: 30,
  cutoffBuffer: 2,
  nSamples: 30,
  quote: { h0Wad: 0n, gammaSWad: 0n, lambdaWad: 0n, qEpochMax: 0n, pMinWad: 0n },
  maxBudget: 10_000_000n,
  minBudget: 1_000_000n,
  ticker: 'ETH15M',
}

describe('trackRow', () => {
  test('keeps the config, lowercases addresses and derives asset and label from the ticker', () => {
    expect(trackRow(SCHEDULER, GATEKEEPER, ETH_ORACLE, config15m)).toEqual({
      id: SCHEDULER.toLowerCase(),
      gatekeeper: GATEKEEPER.toLowerCase(),
      oracle: ETH_ORACLE.toLowerCase(),
      ticker: 'ETH15M',
      asset: 'ETH',
      label: '15m',
      period: 900,
      tenor: 900,
      window: 30,
      cutoffBuffer: 2,
      nSamples: 30,
      maxBudget: 10_000_000n,
      minBudget: 1_000_000n,
    })
  })

  test('a 1m track keeps the plain asset ticker', () => {
    const row = trackRow(SCHEDULER, GATEKEEPER, SOL_ORACLE, { ...config15m, period: 60, tenor: 60, ticker: 'SOL' })

    expect(row.asset).toBe('SOL')
    expect(row.label).toBe('1m')
  })
})

describe('openedMarketFields', () => {
  const track = trackRow(SCHEDULER, GATEKEEPER, ETH_ORACLE, config15m)
  const args = { marketId: 7n, slot: 1_990_000n, caller: CALLER, budget: 10_000_000n, strikeCents: 269_013n }

  test('fills the track columns when expiry == slot * period + tenor', () => {
    expect(openedMarketFields(track, args, 1_990_000 * 900 + 900)).toEqual({
      scheduler: SCHEDULER.toLowerCase(),
      ticker: 'ETH15M',
      asset: 'ETH',
      oracle: ETH_ORACLE.toLowerCase(),
      slot: 1_990_000n,
      budget: 10_000_000n,
      strikeCents: 269_013n,
      openedBy: CALLER.toLowerCase(),
      period: 900,
      tenor: 900,
    })
  })

  test('throws when the market expiry does not match its slot', () => {
    expect(() => openedMarketFields(track, args, 1_990_000 * 900 + 960)).toThrow(/expiry/)
  })
})

describe('oracles', () => {
  const underlyings = [
    { symbol: 'ETH', oracle: ETH_ORACLE },
    { symbol: 'SOL', oracle: SOL_ORACLE },
  ]

  test('assetOfOracle matches case-insensitively and returns null for an unknown oracle', () => {
    expect(assetOfOracle(underlyings, SOL_ORACLE.toLowerCase() as `0x${string}`)).toBe('SOL')
    expect(assetOfOracle(underlyings, GATEKEEPER)).toBeNull()
  })

  test('oraclesOf lists each open market oracle once and falls back for rows without one', () => {
    const open = [{ oracle: ETH_ORACLE }, { oracle: SOL_ORACLE }, { oracle: ETH_ORACLE.toLowerCase() as `0x${string}` }, { oracle: null }]

    expect(oraclesOf(open, ETH_ORACLE)).toEqual([ETH_ORACLE.toLowerCase(), SOL_ORACLE.toLowerCase()])
    expect(oracleOf({ oracle: null }, SOL_ORACLE)).toBe(SOL_ORACLE.toLowerCase())
  })
})
