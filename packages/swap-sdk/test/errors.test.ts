import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type Abi, encodeErrorResult, getAddress, type Hex, parseAbi, toFunctionSelector } from 'viem'
import {
  decodeRevert,
  extractRevertData,
  hookErrorsAbi,
  outcomeTokenAbi,
  PredictionSwapError,
  poolManagerErrorsAbi,
  toSwapError,
  universalRouterAbi,
  v4QuoterAbi,
} from '../src/index.ts'

const HOOK = getAddress('0x00000000000000000000000000000000c0de2aa8')
const BEFORE_SWAP = toFunctionSelector(
  'beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)',
)
const HOOK_CALL_FAILED = encodeErrorResult({ abi: poolManagerErrorsAbi, errorName: 'HookCallFailed' })

/** What V4Quoter returns when the hook's beforeSwap reverts with `inner`. */
function quoterHookRevert(inner: Hex): Hex {
  const wrapped = encodeErrorResult({
    abi: poolManagerErrorsAbi,
    errorName: 'WrappedError',
    args: [HOOK, BEFORE_SWAP, inner, HOOK_CALL_FAILED],
  })
  return encodeErrorResult({ abi: v4QuoterAbi, errorName: 'UnexpectedRevertBytes', args: [wrapped] })
}

describe('decodeRevert', () => {
  it('unwraps UnexpectedRevertBytes -> WrappedError -> hook error', () => {
    const band = encodeErrorResult({ abi: hookErrorsAbi, errorName: 'Band' })
    const d = decodeRevert(quoterHookRevert(band))
    assert.equal(d.code, 'OUT_OF_BAND')
    assert.equal(d.name, 'Band')
    assert.equal(d.hook, HOOK)
    assert.deepEqual(d.path, ['UnexpectedRevertBytes', 'WrappedError', 'Band'])
  })

  it('classifies TooLate as market closed and PoolNotInitialized as no route', () => {
    const tooLate = encodeErrorResult({ abi: hookErrorsAbi, errorName: 'TooLate' })
    assert.equal(decodeRevert(quoterHookRevert(tooLate)).code, 'MARKET_CLOSED')
    const pni = encodeErrorResult({ abi: poolManagerErrorsAbi, errorName: 'PoolNotInitialized' })
    const d = decodeRevert(encodeErrorResult({ abi: v4QuoterAbi, errorName: 'UnexpectedRevertBytes', args: [pni] }))
    assert.equal(d.code, 'NO_ROUTE')
    assert.equal(d.hook, undefined)
  })

  it('maps unknown hook errors by name and by selector', () => {
    const custom = parseAbi([
      'error MarketClosed()',
      'error EpochCapExceeded(uint256 flow, uint256 cap)',
      'error UnknownPool()',
    ])
    const closed = encodeErrorResult({ abi: custom, errorName: 'MarketClosed' })
    assert.equal(decodeRevert(quoterHookRevert(closed), custom).code, 'MARKET_CLOSED')
    const cap = encodeErrorResult({ abi: custom, errorName: 'EpochCapExceeded', args: [5n, 4n] })
    const dc = decodeRevert(quoterHookRevert(cap), custom)
    assert.equal(dc.code, 'CAPACITY')
    assert.deepEqual(dc.args, [5n, 4n])
    assert.equal(
      decodeRevert(quoterHookRevert(encodeErrorResult({ abi: custom, errorName: 'UnknownPool' })), custom).code,
      'NO_ROUTE',
    )
    const unknown = decodeRevert(quoterHookRevert('0x12345678'))
    assert.equal(unknown.code, 'NO_ROUTE')
    assert.equal(unknown.selector, '0x12345678')
    assert.match(unknown.message, /hook rejected/)
  })

  it('names the PredictionHook errors explicitly', () => {
    const hookAbi = parseAbi([
      'error NotTradable()',
      'error NotSettled()',
      'error OutOfBand()',
      'error InsufficientIdle()',
      'error ZeroAmount()',
    ])
    const expected = {
      NotTradable: 'MARKET_CLOSED',
      NotSettled: 'MARKET_CLOSED',
      OutOfBand: 'OUT_OF_BAND',
      InsufficientIdle: 'CAPACITY',
      ZeroAmount: 'AMOUNT_TOO_LOW',
    } as const
    for (const [errorName, code] of Object.entries(expected)) {
      const inner = encodeErrorResult({ abi: hookAbi, errorName: errorName as keyof typeof expected })
      const d = decodeRevert(quoterHookRevert(inner), hookAbi)
      assert.equal(d.code, code, errorName)
    }
  })

  it('never reads core settlement errors as a market state, even inside a hook', () => {
    const core: [Abi, string, readonly unknown[]][] = [
      [poolManagerErrorsAbi, 'CurrencyNotSettled', []],
      [poolManagerErrorsAbi, 'HookDeltaExceedsSwapAmount', []],
      [poolManagerErrorsAbi, 'PriceLimitAlreadyExceeded', [1n, 2n]],
      [poolManagerErrorsAbi, 'NonzeroNativeValue', []],
      [universalRouterAbi, 'DeltaNotNegative', [HOOK]],
    ]
    for (const [abi, errorName, args] of core) {
      const inner = encodeErrorResult({ abi, errorName, args })
      for (const d of [decodeRevert(inner), decodeRevert(quoterHookRevert(inner))]) {
        assert.equal(d.name, errorName)
        assert.equal(d.code, 'UNKNOWN', errorName)
        assert.match(d.message, new RegExp(errorName === 'NonzeroNativeValue' ? 'Reverted with' : errorName))
      }
    }
    const expired = encodeErrorResult({ abi: outcomeTokenAbi, errorName: 'PermitExpired' })
    assert.equal(decodeRevert(quoterHookRevert(expired)).code, 'DEADLINE')
  })

  it('unwraps UniversalRouter ExecutionFailed and decodes slippage', () => {
    const inner = encodeErrorResult({ abi: universalRouterAbi, errorName: 'V4TooLittleReceived', args: [100n, 99n] })
    const d = decodeRevert(
      encodeErrorResult({ abi: universalRouterAbi, errorName: 'ExecutionFailed', args: [1n, inner] }),
    )
    assert.equal(d.code, 'SLIPPAGE')
    assert.deepEqual(d.path, ['ExecutionFailed', 'V4TooLittleReceived'])
    const empty = decodeRevert(
      encodeErrorResult({ abi: universalRouterAbi, errorName: 'ExecutionFailed', args: [0n, '0x'] }),
    )
    assert.match(empty.message, /command 0/)
  })

  it('decodes Error(string), Panic and empty reverts', () => {
    const err = encodeErrorResult({
      abi: parseAbi(['error Error(string)']),
      errorName: 'Error',
      args: ['TRANSFER_FROM_FAILED'],
    })
    assert.equal(decodeRevert(err).code, 'ALLOWANCE')
    const panic = encodeErrorResult({ abi: parseAbi(['error Panic(uint256)']), errorName: 'Panic', args: [0x11n] })
    assert.match(decodeRevert(panic).message, /panic 17/)
    assert.equal(decodeRevert('0x').code, 'UNKNOWN')
  })
})

describe('extractRevertData / toSwapError', () => {
  const data = quoterHookRevert(encodeErrorResult({ abi: hookErrorsAbi, errorName: 'Band' }))

  it('finds revert bytes in nested causes', () => {
    const rpc = { code: 3, message: 'execution reverted', data }
    const wrapped = new Error('outer', { cause: new Error('mid', { cause: rpc }) })
    assert.equal(extractRevertData(wrapped), data)
    assert.equal(extractRevertData({ error: { data: { data } } }), data)
    assert.equal(extractRevertData(new Error('network down')), undefined)
  })

  it('returns a typed error for reverts and rethrows transport errors', () => {
    const e = toSwapError(new Error('x', { cause: { data } }))
    assert.ok(e instanceof PredictionSwapError)
    assert.equal(e.code, 'OUT_OF_BAND')
    assert.throws(() => toSwapError(new Error('fetch failed')), /fetch failed/)
    assert.equal(toSwapError(new Error('execution reverted')).code, 'UNKNOWN')
  })
})
