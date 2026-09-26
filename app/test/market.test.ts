import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  averagePriceFromCumulatives,
  cutoffOf,
  defaultMarketId,
  groupMarkets,
  marketPhase,
  questionText,
  sameTrack,
  sigmaAnnual,
  strikeOf,
  trackName,
  windowStartOf,
  withInfo,
} from '../src/market.ts'
import type { Market, MarketInfo } from '../src/sdk.ts'

const ZERO = '0x0000000000000000000000000000000000000000' as const

function info(p: Partial<MarketInfo> = {}): MarketInfo {
  return {
    yes: '0x00000000000000000000000000000000000000a1',
    no: '0x00000000000000000000000000000000000000b1',
    oracle: ZERO,
    lnStrikeWad: BigInt(Math.round(Math.log(2701.35) * 1e18)),
    openTime: 1000n,
    expiry: 1060n,
    window: 10,
    cutoffBuffer: 2,
    status: 1,
    yesWon: false,
    bucket: 0n,
    outYes: 0n,
    outNo: 0n,
    invYes: 0n,
    invNo: 0n,
    ...p,
  }
}

function market(id: bigint, p: Partial<MarketInfo> = {}): Market {
  const i = info(p)
  const token = (isYes: boolean) => ({
    address: isYes ? i.yes : i.no,
    symbol: isYes ? 'YES' : 'NO',
    name: '',
    decimals: 6,
    isYes,
    marketId: id,
    poolKey: { currency0: i.yes, currency1: i.no, fee: 0, tickSpacing: 60, hooks: ZERO },
  })
  return withInfo(
    { id, hook: ZERO, info: i, status: 'Trading', yes: token(true), no: token(false), strikeUsd: 0, cutoff: 0n },
    i,
  )
}

describe('market phases (SPEC §3.3 trading window)', () => {
  const m = info()
  it('computes cutoff and window start', () => {
    assert.equal(cutoffOf(m), 1048)
    assert.equal(windowStartOf(m), 1050)
  })
  it('walks upcoming -> trading -> closing -> awaiting', () => {
    assert.equal(marketPhase(m, 999), 'upcoming')
    assert.equal(marketPhase(m, 1000), 'trading')
    assert.equal(marketPhase(m, 1047.9), 'trading')
    assert.equal(marketPhase(m, 1048), 'closing')
    assert.equal(marketPhase(m, 1059), 'closing')
    assert.equal(marketPhase(m, 1060), 'awaiting')
  })
  it('status wins over time', () => {
    assert.equal(marketPhase(info({ status: 2 }), 1010), 'settled')
    assert.equal(marketPhase(info({ status: 3 }), 1010), 'invalid')
  })
})

describe('grouping and default selection', () => {
  const list = [
    market(1n, { openTime: 880n, expiry: 940n, status: 2, yesWon: true }),
    market(2n, { openTime: 940n, expiry: 1000n }),
    market(3n, { openTime: 1000n, expiry: 1060n }),
    market(4n, { openTime: 1060n, expiry: 1120n }),
  ]
  it('groups open, closed and settled, newest first', () => {
    const g = groupMarkets(list, 1010)
    assert.deepEqual(g.open.map((m) => m.id), [4n, 3n])
    assert.deepEqual(g.closed.map((m) => m.id), [2n])
    assert.deepEqual(g.settled.map((m) => m.id), [1n])
  })
  it('prefers the newest market that is trading now', () => {
    assert.equal(defaultMarketId(list, 1010), 3n)
    assert.equal(defaultMarketId(list, 1070), 4n)
    assert.equal(defaultMarketId([list[0] as Market], 1070), 1n)
    assert.equal(defaultMarketId([], 1070), undefined)
  })
  it('withInfo maps the status name', () => {
    assert.equal(withInfo(list[0] as Market, info({ status: 3 })).status, 'Invalid')
  })
})

describe('display math', () => {
  it('recovers a whole-cent strike and formats the question', () => {
    assert.equal(strikeOf(info()), 2701.35)
    assert.equal(questionText(2701.35, '14:31:00'), 'ETH above $2,701.35 at 14:31:00?')
    assert.equal(questionText(151.2, '14:45:00', 'SOL'), 'SOL above $151.20 at 14:45:00?')
  })
  it('names a market by its asset and track', () => {
    const t1 = { scheduler: '0x8f1b371e41FeCBb825d0baAB19f906E645C760e0', label: '1m' }
    const t15 = { scheduler: '0x02f0B250120c817A45C6ba580FE68eB461E0A10e', label: '15m' }
    const m1 = { asset: 'ETH', track: t1 as never }
    const m15 = { asset: 'ETH', track: t15 as never }
    assert.equal(trackName(m15), 'ETH 15m')
    assert.equal(trackName({ asset: 'SOL' }), 'SOL')
    assert.equal(sameTrack(m1, m15), false)
    assert.equal(sameTrack(m1, { ...m1 }), true)
    assert.equal(sameTrack({ asset: 'ETH' }, { asset: 'ETH' }), true)
    assert.equal(sameTrack({ asset: 'ETH' }, m1), false)
  })
  it('annualises per-second variance at 1e36', () => {
    const varE36 = (36n * 10n ** 34n) / 31_557_600n
    const s = sigmaAnnual(varE36)
    assert.ok(s !== undefined && Math.abs(s - 0.6) < 1e-9)
    assert.equal(sigmaAnnual(0n), undefined)
  })
  it('turns normalised tick cumulatives into a USD price', () => {
    const tick = Math.log(2700 / 1e12) / Math.log(1.0001)
    const seconds = 10
    const p = averagePriceFromCumulatives(0n, BigInt(Math.round(tick * seconds)), seconds, 12)
    assert.ok(p !== undefined && Math.abs(p - 2700) < 0.5)
    assert.equal(averagePriceFromCumulatives(0n, 1n, 0, 12), undefined)
  })
})
