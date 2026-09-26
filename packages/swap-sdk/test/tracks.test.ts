import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type Address, getAddress, zeroAddress } from 'viem'
import {
  classifyBySymbol,
  marketGatekeeperAbi,
  marketSchedulerAbi,
  periodLabel,
  readTracks,
  recentTrackMarketIds,
  schedulerOfMarkets,
  type Track,
  trackAsset,
  UNICHAIN_SEPOLIA,
  WAD,
} from '../src/index.ts'
import { contract, mockClient } from './helpers/mockChain.ts'

const GATEKEEPER = getAddress('0x6a7e000000000000000000000000000000000001')
const ETH_ORACLE = getAddress('0x1F356D9E7d6dBE6d807aCBc5D163a7af265cd080')
const SOL_ORACLE = getAddress('0x0000000000000000000000000000000000202080')
const S = [1, 2, 3, 4].map((i) => getAddress(`0x5c${'0'.repeat(37)}${i}`)) as [Address, Address, Address, Address]
const BROKEN = getAddress('0x5c000000000000000000000000000000000000ff')

// 1_790_001_000 is a multiple of 900, so every track has a market expiring right at QH
const QH = 1_790_001_000n
const s1 = QH / 60n
const s15 = QH / 900n

function config(ticker: string, period: number, window: number) {
  return {
    period,
    tenor: period,
    window,
    cutoffBuffer: 2,
    nSamples: window,
    quote: {
      h0Wad: WAD / 50n,
      gammaSWad: 2n * 10n ** 13n,
      lambdaWad: 10n ** 15n,
      qEpochMax: 100_000_000n,
      pMinWad: WAD / 50n,
    },
    maxBudget: 10_000_000n,
    minBudget: 1_000_000n,
    ticker,
  }
}

const tracksOnChain = [
  {
    scheduler: S[0],
    oracle: ETH_ORACLE,
    config: config('ETH1M', 60, 10),
    slots: [[s1, 101n], [s1 - 1n, 99n], [s1 - 3n, 95n]],
  },
  { scheduler: S[1], oracle: ETH_ORACLE, config: config('ETH15M', 900, 30), slots: [[s15, 102n], [s15 - 1n, 90n]] },
  { scheduler: S[2], oracle: SOL_ORACLE, config: config('SOL1M', 60, 10), slots: [[s1, 103n], [s1 - 1n, 100n]] },
  { scheduler: S[3], oracle: SOL_ORACLE, config: config('SOL15M', 900, 30), slots: [[s15, 104n], [s15 - 1n, 91n]] },
] as const

const schedulerOf = new Map<bigint, Address>(
  tracksOnChain.flatMap((t) => t.slots.map(([, id]) => [id, t.scheduler] as [bigint, Address])),
)

const handlers = Object.fromEntries(
  tracksOnChain.map((t) => {
    const bySlot = new Map<bigint, bigint>(t.slots.map(([slot, id]) => [slot, id]))
    return [
      t.scheduler,
      contract(marketSchedulerAbi, {
        config: () => t.config,
        oracle: () => t.oracle,
        marketOfSlot: (slot: bigint) => bySlot.get(slot) ?? 0n,
      }),
    ]
  }),
)
handlers[BROKEN] = contract(marketSchedulerAbi, { oracle: () => ETH_ORACLE })
handlers[GATEKEEPER] = contract(marketGatekeeperAbi, {
  schedulerOf: (id: bigint) => schedulerOf.get(id) ?? zeroAddress,
})

const { client, calls } = mockClient(handlers, UNICHAIN_SEPOLIA.multicall3)

describe('periodLabel and trackAsset', () => {
  it('labels periods', () => {
    const cases: [number, string][] = [
      [60, '1m'],
      [900, '15m'],
      [300, '5m'],
      [5400, '90m'],
      [3600, '1h'],
      [14_400, '4h'],
      [45, '45s'],
    ]
    for (const [period, label] of cases) assert.equal(periodLabel(period), label, String(period))
  })

  it('strips the window suffix from a ticker', () => {
    const cases: [string, string][] = [
      ['ETH1M', 'ETH'],
      ['ETH15M', 'ETH'],
      ['SOL1M', 'SOL'],
      ['SOL15M', 'SOL'],
      ['BTC4H', 'BTC'],
      ['ETH', 'ETH'],
      ['1M', '1M'],
    ]
    for (const [ticker, asset] of cases) assert.equal(trackAsset(ticker), asset, ticker)
  })
})

describe('readTracks', () => {
  it('reads every scheduler config and oracle in deployment order', async () => {
    const tracks = await readTracks(client, { marketSchedulers: [...S] })
    assert.deepEqual(
      tracks.map((t) => [t.scheduler, t.oracle, t.ticker, t.asset, t.label, t.period, t.tenor, t.window, t.nSamples]),
      [
        [S[0], ETH_ORACLE, 'ETH1M', 'ETH', '1m', 60, 60, 10, 10],
        [S[1], ETH_ORACLE, 'ETH15M', 'ETH', '15m', 900, 900, 30, 30],
        [S[2], SOL_ORACLE, 'SOL1M', 'SOL', '1m', 60, 60, 10, 10],
        [S[3], SOL_ORACLE, 'SOL15M', 'SOL', '15m', 900, 900, 30, 30],
      ],
    )
    for (const t of tracks) {
      assert.equal(t.cutoffBuffer, 2)
      assert.equal(t.maxBudget, 10_000_000n)
      assert.equal(t.minBudget, 1_000_000n)
    }
  })

  it('returns [] without a call for no schedulers and throws on a scheduler that does not answer', async () => {
    const before = calls.length
    assert.deepEqual(await readTracks(client, { marketSchedulers: [] }), [])
    assert.equal(calls.length, before)
    await assert.rejects(
      readTracks(client, { marketSchedulers: [S[0], BROKEN] }),
      /MarketScheduler 0x5c0+ff did not answer/i,
    )
  })
})

describe('recentTrackMarketIds', () => {
  const tracks = tracksOnChain.map((t) => ({ scheduler: t.scheduler, period: t.config.period }))

  it('reads the newest slots of each track, skipping slots without a market', async () => {
    type T = Pick<Track, 'scheduler' | 'period'>
    const [eth1m, eth15m, sol1m, sol15m] = tracks as [T, T, T, T]
    assert.deepEqual(await recentTrackMarketIds(client, eth1m, QH + 5n, 4), [101n, 99n, 95n])
    assert.deepEqual(await recentTrackMarketIds(client, eth15m, Number(QH) + 5.7, 3), [102n, 90n])
    assert.deepEqual(await recentTrackMarketIds(client, sol1m, QH + 59n, 2), [103n, 100n])
    assert.deepEqual(await recentTrackMarketIds(client, sol15m, QH - 1n, 5), [91n])
  })

  it('stops at slot 0 and reads nothing for k <= 0', async () => {
    const before = calls.length
    assert.deepEqual(await recentTrackMarketIds(client, { scheduler: S[0], period: 60 }, 5, 0), [])
    assert.deepEqual(await recentTrackMarketIds(client, { scheduler: S[0], period: 0 }, 5, 3), [])
    assert.equal(calls.length, before)
    assert.deepEqual(await recentTrackMarketIds(client, { scheduler: S[0], period: 60 }, 125, 10), [])
  })
})

describe('classifying markets that share an expiry', () => {
  const tracks = tracksOnChain.map((t) => ({ scheduler: t.scheduler, ticker: t.config.ticker }))
  // Every one of these expires at QH, so only the symbol or schedulerOf tells them apart
  const expiringAtQH: [bigint, string, Address, boolean][] = [
    [99n, 'ETH1MUP', S[0], true],
    [90n, 'ETH15MDOWN', S[1], false],
    [100n, 'SOL1MDOWN', S[2], false],
    [91n, 'SOL15MUP', S[3], true],
  ]

  it('classifyBySymbol matches the exact ticker', () => {
    for (const [, symbol, scheduler, isYes] of expiringAtQH) {
      const hit = classifyBySymbol(symbol, tracks)
      assert.equal(hit?.track.scheduler, scheduler, symbol)
      assert.equal(hit?.isYes, isYes, symbol)
    }
    assert.equal(classifyBySymbol('ETH15MUP', tracks)?.track.ticker, 'ETH15M')
    assert.equal(classifyBySymbol('ETH1MDOWN', tracks)?.track.ticker, 'ETH1M')
    for (const s of ['ETHUP', 'ETH1M', 'eth1mup', 'ETH1MUP ', 'ETH15MUPX', 'SOLDOWN', 'YES', '']) {
      assert.equal(classifyBySymbol(s, tracks), undefined, s)
    }
  })

  it('never lets a ticker match another as a prefix, whatever the track order', () => {
    const legacy = [{ ticker: 'ETH' }, { ticker: 'ETH15M' }]
    for (const list of [legacy, [...legacy].reverse()]) {
      assert.equal(classifyBySymbol('ETHUP', list)?.track.ticker, 'ETH')
      assert.equal(classifyBySymbol('ETH15MUP', list)?.track.ticker, 'ETH15M')
      assert.equal(classifyBySymbol('ETH15MDOWN', list)?.track.ticker, 'ETH15M')
    }
  })

  it('schedulerOfMarkets agrees with the symbols and is undefined for unknown ids', async () => {
    const ids = [...expiringAtQH.map(([id]) => id), 7n]
    const owners = await schedulerOfMarkets(client, GATEKEEPER, ids)
    assert.deepEqual(owners, [...expiringAtQH.map(([, , s]) => s), undefined])
    assert.deepEqual(await schedulerOfMarkets(client, GATEKEEPER, []), [])
  })
})
