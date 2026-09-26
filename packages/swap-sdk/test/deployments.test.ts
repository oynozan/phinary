import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { getAddress } from 'viem'
import { isPlaceholderAddress, parseDeployment, requireHook, UNICHAIN_SEPOLIA } from '../src/index.ts'
import { loadDeployment } from '../src/node.ts'

const HOOK = '0x5aE3c0de00000000000000000000000000002Aa8'
const SCHEDULER = `0x${'ab'.repeat(19)}01` as const
const LEGACY = `0x${'cd'.repeat(19)}02` as const

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

  it('parses marketScheduler and legacyPredictionHooks', () => {
    const d = parseDeployment({
      chainId: 1301,
      predictionHook: HOOK,
      marketScheduler: SCHEDULER.toLowerCase(),
      legacyPredictionHooks: [LEGACY.toLowerCase()],
    })
    assert.equal(d.marketScheduler, getAddress(SCHEDULER))
    assert.deepEqual(d.legacyPredictionHooks, [getAddress(LEGACY)])
  })

  it('defaults legacyPredictionHooks to [] and marketScheduler to undefined for old files', () => {
    const d = parseDeployment({ chainId: 1301, predictionHook: HOOK })
    assert.equal(d.marketScheduler, undefined)
    assert.deepEqual(d.legacyPredictionHooks, [])
  })

  it('drops placeholder entries from legacyPredictionHooks', () => {
    const d = parseDeployment({
      chainId: 1301,
      legacyPredictionHooks: [LEGACY, '0x0000000000000000000000000000000000000000', 'TBD'],
    })
    assert.deepEqual(d.legacyPredictionHooks, [getAddress(LEGACY)])
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
  })
})
