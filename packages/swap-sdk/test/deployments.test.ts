import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'
import {
  isPlaceholderAddress,
  parseDeployment,
  poolId,
  requireGatekeeper,
  requireHook,
  requireSchedulers,
  UNICHAIN_SEPOLIA,
} from '../src/index.ts'
import { loadDeployment } from '../src/node.ts'

const HOOK = '0x5aE3c0de00000000000000000000000000002Aa8'
const SCHEDULER = `0x${'ab'.repeat(19)}01` as const
const LEGACY = `0x${'cd'.repeat(19)}02` as const
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deployments-tracks.json')
const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>

describe('parseDeployment', () => {
  it('reads a flat file and fills Uniswap defaults', () => {
    const d = parseDeployment({ chainId: 1301, predictionHook: HOOK.toLowerCase(), deployBlock: 63_600_000 })
    assert.equal(d.predictionHook?.toLowerCase(), HOOK.toLowerCase())
    assert.equal(d.universalRouter, UNICHAIN_SEPOLIA.universalRouter)
    assert.equal(d.usdc, UNICHAIN_SEPOLIA.usdc)
    assert.equal(d.deployBlock, 63_600_000n)
    assert.deepEqual(d.placeholders, [])
  })

  it('reads nested contracts and alternate key spellings', () => {
    const d = parseDeployment({
      chainId: '1301',
      contracts: {
        PredictionHook: HOOK,
        UnderlyingOracleHook: '0x00000000000000000000000000000000000000a1',
        USDC: UNICHAIN_SEPOLIA.usdc,
      },
    })
    assert.equal(d.predictionHook?.toLowerCase(), HOOK.toLowerCase())
    assert.equal(d.underlyingOracle?.toLowerCase(), '0x00000000000000000000000000000000000000a1')
  })

  it('tolerates placeholders', () => {
    for (const v of [
      '',
      'TBD',
      '0x',
      '0x0000000000000000000000000000000000000000',
      '0xffffffffffffffffffffffffffffffffffffffff',
      null,
      42,
    ]) {
      assert.equal(isPlaceholderAddress(v), true, String(v))
    }
    const d = parseDeployment({
      chainId: 1301,
      predictionHook: 'TBD',
      usdc: '0x0000000000000000000000000000000000000000',
      universalRouter: '',
    })
    assert.equal(d.predictionHook, undefined)
    assert.equal(d.usdc, UNICHAIN_SEPOLIA.usdc)
    assert.equal(d.universalRouter, UNICHAIN_SEPOLIA.universalRouter)
    assert.deepEqual(d.placeholders.sort(), ['predictionHook', 'universalRouter', 'usdc'])
    assert.throws(() => requireHook(d), /placeholder/)
    assert.equal(parseDeployment({}).predictionHook, undefined)
  })

  it('rejects a wrong chain and the Stack B router', () => {
    assert.throws(() => parseDeployment({ chainId: 1 }), /chainId/)
    assert.throws(
      () => parseDeployment({ universalRouter: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b' }),
      /different PoolManager/,
    )
  })

  it('parses the gatekeeper, schedulers, legacy lists and underlyings of a tracks file', () => {
    const d = parseDeployment(fixture())
    assert.equal(d.predictionHook, getAddress('0x5ae3c0de00000000000000000000000000002aa8'))
    assert.equal(d.marketGatekeeper, getAddress('0x6a7e000000000000000000000000000000000001'))
    assert.deepEqual(d.marketSchedulers, [1, 2, 3, 4].map((i) => getAddress(`0x5c${'0'.repeat(37)}${i}`)))
    assert.deepEqual(d.legacyMarketSchedulers, ['0x511fFFb9fE5d393B10bF185A9c580A732Eff44Dd'])
    assert.deepEqual(d.legacyPredictionHooks, [
      '0x62bBCbA51cbFC8D0C932e482bD8F62590fEeeAa8',
      '0xE6780bBeAee4183Ffd8EBe0d2862dEd221B96aA8',
    ])
    assert.deepEqual(
      d.underlyings.map((u) => [u.symbol, u.token, u.oracle, u.pool.fee, u.pool.tickSpacing]),
      [
        ['ETH', '0x7fcf39acb2934d1A93D6469AE8DE0EcF33eb26E5', '0x1F356D9E7d6dBE6d807aCBc5D163a7af265cd080', 500, 10],
        ['SOL', '0x0500000000000000000000000000000000000503', '0x0000000000000000000000000000000000202080', 500, 10],
      ],
    )
    assert.equal(d.underlyings[0]?.poolId, '0xb2b89f12e31fa12e75c4e85bd234fa5fdc5ee19d65e11a12c4f57dfe0e437331')
    for (const u of d.underlyings) assert.equal(u.poolId, poolId(u.pool))
    assert.equal(requireGatekeeper(d), d.marketGatekeeper)
    assert.deepEqual(requireSchedulers(d), d.marketSchedulers)
    assert.deepEqual(d.placeholders, [])
  })

  it('reads a single-scheduler file as having no tracks', () => {
    const d = parseDeployment({
      chainId: 1301,
      predictionHook: HOOK,
      marketScheduler: SCHEDULER,
      legacyPredictionHooks: [LEGACY.toLowerCase()],
    })
    assert.equal('marketScheduler' in d, false)
    assert.equal(d.marketGatekeeper, undefined)
    assert.deepEqual(d.marketSchedulers, [])
    assert.deepEqual(d.legacyMarketSchedulers, [])
    assert.deepEqual(d.underlyings, [])
    assert.deepEqual(d.legacyPredictionHooks, [getAddress(LEGACY)])
    assert.throws(() => requireGatekeeper(d), /MarketGatekeeper/)
    assert.throws(() => requireSchedulers(d), /marketSchedulers/)
  })

  it('drops placeholders from the scheduler lists and reads a non-array as []', () => {
    const zero = '0x0000000000000000000000000000000000000000'
    const d = parseDeployment({
      chainId: 1301,
      marketGatekeeper: 'TBD',
      marketSchedulers: [SCHEDULER.toLowerCase(), zero, 'TBD', 7, null],
      legacyMarketSchedulers: LEGACY,
    })
    assert.equal(d.marketGatekeeper, undefined)
    assert.deepEqual(d.placeholders, ['marketGatekeeper'])
    assert.deepEqual(d.marketSchedulers, [getAddress(SCHEDULER)])
    assert.deepEqual(d.legacyMarketSchedulers, [])
    assert.deepEqual(parseDeployment({ chainId: 1301, marketSchedulers: {} }).marketSchedulers, [])
  })

  it('skips malformed underlyings and refuses a poolId that contradicts its pool', () => {
    const [eth, sol] = fixture()['underlyings'] as Record<string, unknown>[]
    const d = parseDeployment({
      chainId: 1301,
      underlyings: [
        null,
        'ETH',
        [eth],
        { ...eth, symbol: 7 },
        { ...eth, symbol: ' ' },
        { ...eth, token: 'TBD' },
        { ...eth, oracle: '0x0000000000000000000000000000000000000000' },
        { ...eth, pool: { ...(eth?.['pool'] as object), fee: 'x' } },
        { ...sol, symbol: ' sol ', poolId: undefined },
      ],
    })
    assert.deepEqual(
      d.underlyings.map((u) => u.symbol),
      ['SOL'],
    )
    assert.equal(d.underlyings[0]?.poolId, (sol as { poolId: string }).poolId)
    assert.deepEqual(parseDeployment({ chainId: 1301, underlyings: { ETH: eth } }).underlyings, [])
    assert.throws(
      () => parseDeployment({ chainId: 1301, underlyings: [{ ...sol, poolId: (eth as { poolId: string }).poolId }] }),
      /underlyings\[0\] \(SOL\) poolId .* does not match/,
    )
  })

  it('drops placeholder entries from legacyPredictionHooks', () => {
    const d = parseDeployment({
      chainId: 1301,
      legacyPredictionHooks: [LEGACY, '0x0000000000000000000000000000000000000000', 'TBD'],
    })
    assert.deepEqual(d.legacyPredictionHooks, [getAddress(LEGACY)])
  })

  it('skips malformed legacyPredictionHooks entries instead of throwing', () => {
    const malformed = [
      123,
      null,
      {},
      [LEGACY],
      'nope',
      '0x1234',
      `${LEGACY}00`,
      `0x${'zz'.repeat(20)}`,
      ` ${LEGACY}`,
      LEGACY.slice(2),
    ]
    const d = parseDeployment({ chainId: 1301, legacyPredictionHooks: [...malformed, LEGACY.toLowerCase()] })
    assert.deepEqual(d.legacyPredictionHooks, [getAddress(LEGACY)])
    assert.deepEqual(parseDeployment({ chainId: 1301, legacyPredictionHooks: malformed }).legacyPredictionHooks, [])
    assert.deepEqual(parseDeployment({ chainId: 1301, legacyPredictionHooks: LEGACY }).legacyPredictionHooks, [], 'not an array')
  })
})

describe('loadDeployment', () => {
  it('returns defaults when the file is missing and parses it when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swap-sdk-'))
    const missing = loadDeployment(join(dir, 'nope.json'))
    assert.equal(missing.found, false)
    assert.equal(missing.predictionHook, undefined)
    const file = join(dir, 'unichain-sepolia.json')
    writeFileSync(file, JSON.stringify({ chainId: 1301, predictionHook: HOOK }))
    const d = loadDeployment(file)
    assert.equal(d.found, true)
    assert.equal(d.predictionHook?.toLowerCase(), HOOK.toLowerCase())
    const tracks = loadDeployment(FIXTURE)
    assert.equal(tracks.marketSchedulers.length, 4)
    assert.deepEqual(
      tracks.underlyings.map((u) => u.symbol),
      ['ETH', 'SOL'],
    )
  })
})
