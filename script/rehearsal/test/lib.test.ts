import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keccak256, pad, concat, numberToHex } from 'viem'
import {
  avgPriceWad,
  fiatTokenBalanceSlot,
  fmtUnits,
  fmtUsdc,
  globalViolation,
  type LedgerSnapshot,
  ledgerViolations,
  sigmaFromVarE36,
  twapUsd,
  usdFromLnWad,
  WAD,
} from '../lib.ts'

describe('formatting', () => {
  it('rounds half up and keeps signs', () => {
    assert.equal(fmtUsdc(10_000_000n), '10.00')
    assert.equal(fmtUsdc(1_234_567n), '1.23')
    assert.equal(fmtUsdc(1_235_000n), '1.24')
    assert.equal(fmtUsdc(-2_500_000n), '-2.50')
    assert.equal(fmtUsdc(4n), '0.00')
    assert.equal(fmtUnits(523_456_789_000_000_000n, 18, 4), '0.5235')
    assert.equal(fmtUnits(7n, 0, 0), '7')
  })

  it('average price in WAD', () => {
    assert.equal(avgPriceWad(10_000_000n, 20_000_000n), WAD / 2n)
    assert.equal(avgPriceWad(1n, 0n), 0n)
  })
})

describe('model conversions', () => {
  it('sigma from per-second variance at 1e36', () => {
    const varE36 = (6n * 6n * 10n ** 34n) / 31_557_600n
    assert.ok(Math.abs(sigmaFromVarE36(varE36) - 0.6) < 1e-9)
  })

  it('USD from a WAD log price and from a tick-seconds TWAP', () => {
    assert.ok(Math.abs(usdFromLnWad(BigInt(Math.round(Math.log(2680.5) * 1e18))) - 2680.5) < 1e-6)
    // normalised tick for $2680 with an 18/6 decimal shift of 12
    const tick = Math.floor(Math.log(2680 / 1e12) / Math.log(1.0001))
    const p = twapUsd(BigInt(tick * 10), 10, 12)
    assert.ok(p <= 2680 && p > 2680 * 0.9999)
  })
})

describe('FiatToken balance slot', () => {
  it('is keccak256(pad(account) . pad(9))', () => {
    const a = '0x000000000000000000000000000000000000bEEF'
    const expected = keccak256(concat([pad(a), pad(numberToHex(9))]))
    assert.equal(fiatTokenBalanceSlot(a), expected)
  })
})

describe('ledger identities', () => {
  const base: LedgerSnapshot = {
    status: 1,
    yesWon: false,
    bucket: 120_000_000n,
    outYes: 18_000_000n,
    outNo: 19_000_000n,
    invYes: 5_000_000n,
    invNo: 0n,
    yesSupply: 23_000_000n,
    noSupply: 19_000_000n,
    hookYesClaims: 5_000_000n,
    hookNoClaims: 0n,
    holdersYes: 18_000_000n,
    holdersNo: 19_000_000n,
  }

  it('accepts a consistent trading market', () => {
    assert.deepEqual(ledgerViolations(base), [])
  })

  it('flags claim, supply and holder mismatches', () => {
    const v = ledgerViolations({ ...base, hookYesClaims: 4_000_000n, noSupply: 20_000_000n, holdersYes: 1n })
    assert.equal(v.length, 3)
  })

  it('uses max(out) while trading, the winner once settled and half the total when invalid', () => {
    assert.equal(ledgerViolations({ ...base, bucket: 18_999_999n }).length, 1)
    assert.deepEqual(ledgerViolations({ ...base, status: 2, yesWon: true, bucket: 18_000_000n }), [])
    assert.equal(ledgerViolations({ ...base, status: 2, yesWon: false, bucket: 18_000_000n }).length, 1)
    assert.deepEqual(ledgerViolations({ ...base, status: 3, bucket: 18_500_000n }), [])
    assert.equal(ledgerViolations({ ...base, status: 3, bucket: 18_499_999n }).length, 1)
  })

  it('global identity', () => {
    assert.equal(globalViolation([1n, 2n], 3n, 6n), undefined)
    assert.match(globalViolation([1n, 2n], 3n, 7n) ?? '', /claims = 7/)
  })
})
