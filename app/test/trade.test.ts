import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ChainClock } from '../src/chain.ts'
import { mergeHistory } from '../src/data.ts'
import type { Market } from '../src/sdk.ts'
import { autoSlippageBps } from '../src/sdk.ts'
import { otherCurrency, slippageFor, swapRoute } from '../src/trade.ts'

const USDC = '0x31d0220469e10c4E71834a79b1f276d740d3768F'
const YES = '0x00000000000000000000000000000000000000a1'
const NO = '0xffffffffffffffffffffffffffffffffffffff01'
const HOOK = '0x0000000000000000000000000000000000002aa8'

function key(token: string) {
  const [currency0, currency1] = BigInt(token) < BigInt(USDC) ? [token, USDC] : [USDC, token]
  return { currency0, currency1, fee: 0, tickSpacing: 60, hooks: HOOK } as Market['yes']['poolKey']
}

const market = {
  id: 1n,
  hook: HOOK,
  status: 'Trading',
  info: { openTime: 1000n, expiry: 1060n, window: 10, cutoffBuffer: 2, status: 1 },
  yes: { address: YES, poolKey: key(YES), isYes: true },
  no: { address: NO, poolKey: key(NO), isYes: false },
} as unknown as Market

describe('swap routing', () => {
  it('finds USDC as the other currency of either ordering', () => {
    assert.equal(otherCurrency(key(YES), YES), USDC)
    assert.equal(otherCurrency(key(NO), NO), USDC)
  })
  it('buys pay USDC in and sells pay the outcome token in, with the right zeroForOne', () => {
    const buyYes = swapRoute(market, true, true)
    assert.equal(buyYes.tokenIn, USDC)
    assert.equal(buyYes.tokenOut, YES)
    assert.equal(buyYes.zeroForOne, false)
    const sellYes = swapRoute(market, true, false)
    assert.equal(sellYes.tokenIn, YES)
    assert.equal(sellYes.zeroForOne, true)
    const buyNo = swapRoute(market, false, true)
    assert.equal(buyNo.tokenIn, USDC)
    assert.equal(buyNo.zeroForOne, true)
  })
})

describe('slippage', () => {
  const base = { market, isBuy: true, amountIn: 2_000_000n, amountOut: 3_300_000n, now: 1020, confirm: 5 }
  it('uses the SDK auto slippage sized to the time left before the window', () => {
    const expected = autoSlippageBps({
      exactIn: true,
      isBuy: true,
      amountIn: 2_000_000n,
      amountOut: 3_300_000n,
      secondsToWindow: 30,
      confirmSeconds: 5,
    })
    assert.equal(slippageFor(base), expected)
  })
  it('honours a fixed choice and needs none after settlement', () => {
    assert.equal(slippageFor({ ...base, fixedBps: 100 }), 100)
    assert.equal(slippageFor({ ...base, market: { ...market, status: 'Settled' } as Market }), 0)
  })
})

describe('chain clock', () => {
  it('advances with the wall clock and never jumps back for a lagging block', () => {
    const c = new ChainClock()
    c.sync(1000, 0)
    assert.equal(c.estimate(500), 1000.5)
    c.sync(1000, 500)
    assert.equal(c.estimate(500), 1000.5)
    c.sync(1002, 600)
    assert.equal(c.estimate(600), 1002)
    c.sync(900, 700)
    assert.equal(c.estimate(700), 900)
  })
})

describe('history merge', () => {
  it('merges by timestamp without erasing values with undefined', () => {
    const merged = mergeHistory([{ t: 1, mid: 0.5, eth: 2700 }], [{ t: 1, eth: 2701 }, { t: 0, mid: 0.4 }])
    assert.deepEqual(merged, [
      { t: 0, mid: 0.4 },
      { t: 1, mid: 0.5, eth: 2701 },
    ])
  })
})
