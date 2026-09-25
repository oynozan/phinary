import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { autoSlippageBps, maxInWithSlippage, minOutWithSlippage } from '../src/index.ts'

const usdc = (x: number): bigint => BigInt(Math.round(x * 1e6))

describe('autoSlippageBps', () => {
  it('widens as the settlement window approaches (60 s market, 10 s window)', () => {
    const at = (secondsToWindow: number): number =>
      autoSlippageBps({ exactIn: true, isBuy: true, amountIn: usdc(5), amountOut: usdc(10), secondsToWindow })
    assert.ok(at(45) < at(30))
    assert.ok(at(30) < at(5))
    // price 0.5, move 2 * 0.4 * sqrt(5 / 30) = 0.3266: minOut factor 0.5 / 0.8266 = 0.6049
    assert.equal(at(30), 3952)
  })

  it('is tight for long-dated markets and floored at minBps', () => {
    const bps = autoSlippageBps({
      exactIn: true,
      isBuy: true,
      amountIn: usdc(5),
      amountOut: usdc(10),
      secondsToWindow: 7 * 86_400,
    })
    assert.equal(bps, 100)
  })

  it('gives cheap tokens a wider tolerance and caps at maxBps', () => {
    const sell = (amountOut: number): number =>
      autoSlippageBps({
        exactIn: true,
        isBuy: false,
        amountIn: usdc(10),
        amountOut: usdc(amountOut),
        secondsToWindow: 30,
      })
    assert.ok(sell(1) > sell(5))
    assert.equal(sell(1), 9000)
    assert.equal(
      autoSlippageBps({ exactIn: false, isBuy: false, amountIn: usdc(10), amountOut: usdc(1), secondsToWindow: 30 }),
      9000,
    )
  })

  it('covers the adverse price for all four trade shapes', () => {
    const p = 0.5
    const move = 2 * 0.4 * Math.sqrt(5 / 100)
    const base = { amountIn: usdc(5), amountOut: usdc(10), secondsToWindow: 100 }
    const buyIn = autoSlippageBps({ ...base, exactIn: true, isBuy: true })
    assert.ok(minOutWithSlippage(10_000_000n, buyIn) <= BigInt(Math.floor((5 / (p + move)) * 1e6)))
    const buyOut = autoSlippageBps({ ...base, exactIn: false, isBuy: true })
    assert.ok(maxInWithSlippage(5_000_000n, buyOut) >= BigInt(Math.ceil(10 * (p + move) * 1e6)))
    const sellBase = { amountIn: usdc(10), amountOut: usdc(5), secondsToWindow: 100 }
    const sellIn = autoSlippageBps({ ...sellBase, exactIn: true, isBuy: false })
    assert.ok(minOutWithSlippage(5_000_000n, sellIn) <= BigInt(Math.floor(10 * (p - move) * 1e6)))
    const sellOut = autoSlippageBps({ ...sellBase, exactIn: false, isBuy: false })
    assert.ok(maxInWithSlippage(10_000_000n, sellOut) >= BigInt(Math.ceil((5 / (p - move)) * 1e6)))
  })

  it('falls back to maxBps for empty quotes', () => {
    assert.equal(
      autoSlippageBps({ exactIn: true, isBuy: true, amountIn: 0n, amountOut: 1n, secondsToWindow: 30 }),
      9000,
    )
  })
})
