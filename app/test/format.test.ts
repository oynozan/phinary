import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatCents, formatCountdown, formatSignedUsd, formatToken, formatUsd, parseAmount } from '../src/format.ts'

describe('format', () => {
  it('parses user amounts into 6-decimal units', () => {
    assert.equal(parseAmount('1'), 1_000_000n)
    assert.equal(parseAmount('2.5'), 2_500_000n)
    assert.equal(parseAmount('.5'), 500_000n)
    assert.equal(parseAmount('1,000'), 1_000_000_000n)
    assert.equal(parseAmount('0.1234567'), 123_456n)
    assert.equal(parseAmount('0'), undefined)
    assert.equal(parseAmount(''), undefined)
    assert.equal(parseAmount('.'), undefined)
    assert.equal(parseAmount('1.2.3'), undefined)
    assert.equal(parseAmount('abc'), undefined)
  })
  it('formats prices, tokens and countdowns', () => {
    assert.equal(formatUsd(2701.345), '$2,701.35')
    assert.equal(formatUsd(undefined), '—')
    assert.equal(formatSignedUsd(-1.5), '−$1.50')
    assert.equal(formatCents(542_300_000_000_000_000n), '54.2¢')
    assert.equal(formatToken(18_420_000n), '18.42')
    assert.equal(formatToken(undefined), '—')
    assert.equal(formatCountdown(32.2), '0:33')
    assert.equal(formatCountdown(-5), '0:00')
    assert.equal(formatCountdown(3725), '1:02:05')
  })
})
