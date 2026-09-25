import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type Address, encodeErrorResult, erc20Abi, getAddress, parseAbi, zeroAddress } from 'viem'
import {
  decodeRevert,
  findPredictionRoute,
  hookErrorsAbi,
  listMarkets,
  MarketStatus,
  outcomeTokenAbi,
  PredictionSwapError,
  permit2Abi,
  poolManagerErrorsAbi,
  predictionHookAbi,
  predictionPoolKey,
  quoteExactIn,
  quoteExactOut,
  readAllowances,
  resolveOutcomeToken,
  UNICHAIN_SEPOLIA,
  v4QuoterAbi,
  WAD,
} from '../src/index.ts'
import { contract, mockClient, Revert } from './helpers/mockChain.ts'

const HOOK = getAddress('0x00000000000000000000000000000000c0de2aa8')
const USDC = UNICHAIN_SEPOLIA.usdc
const ALICE = getAddress('0xa11ce00000000000000000000000000000000001')
const tokens = {
  y1: getAddress('0x1000000000000000000000000000000000000001'),
  n1: getAddress('0xf000000000000000000000000000000000000001'),
  y2: getAddress('0x1000000000000000000000000000000000000002'),
  n2: getAddress('0xf000000000000000000000000000000000000002'),
}

function info(yes: Address, no: Address, status: number, expiry: bigint) {
  return {
    yes,
    no,
    oracle: zeroAddress,
    lnStrikeWad: 8_294_049_640_102_028_000n, // ln(4000)
    openTime: expiry > 60n ? expiry - 60n : 0n,
    expiry,
    window: 10,
    cutoffBuffer: 2,
    status,
    yesWon: false,
    bucket: 100_000_000n,
    outYes: 1n,
    outNo: 2n,
    invYes: 0n,
    invNo: 0n,
  }
}

const markets: Record<string, ReturnType<typeof info>> = {
  '1': info(tokens.y1, tokens.n1, MarketStatus.Trading, 1_790_000_060n),
  '2': info(tokens.y2, tokens.n2, MarketStatus.Settled, 1_790_000_120n),
}

const q = {
  tradable: true,
  tau: 30n,
  varE36: 11_408_000_000_000_000_000_000_000_000n,
  xWad: 0n,
  midYes: WAD / 2n,
  askYes: 52n * 10n ** 16n,
  bidYes: 48n * 10n ** 16n,
  askNo: 52n * 10n ** 16n,
  bidNo: 48n * 10n ** 16n,
}

const hook = contract(predictionHookAbi, {
  marketCount: () => 2n,
  marketInfo: (id: bigint) => {
    const m = markets[id.toString()]
    if (!m) return info(zeroAddress, zeroAddress, MarketStatus.None, 0n)
    return m
  },
  poolKeys: (id: bigint) => {
    const m = markets[id.toString()]
    if (!m) throw new Revert('0x')
    return [
      predictionPoolKey({ token: m.yes, usdc: USDC, hook: HOOK }),
      predictionPoolKey({ token: m.no, usdc: USDC, hook: HOOK }),
    ]
  },
  quote: (id: bigint) => {
    if (id === 2n) throw new Revert(encodeErrorResult({ abi: hookErrorsAbi, errorName: 'TooLate' }))
    return q
  },
})

function token(symbol: string, isYes: boolean, marketId: bigint, owner: Address = HOOK) {
  return contract(outcomeTokenAbi, {
    symbol: () => symbol,
    name: () => `${symbol} name`,
    hook: () => owner,
    marketId: () => marketId,
    isYes: () => isYes,
    allowance: () => 2n ** 256n - 1n,
  })
}

const BAND = encodeErrorResult({ abi: hookErrorsAbi, errorName: 'Band' })
const HOOK_CALL_FAILED = encodeErrorResult({ abi: poolManagerErrorsAbi, errorName: 'HookCallFailed' })

const quoter = contract(v4QuoterAbi, {
  quoteExactInputSingle: (p: { exactAmount: bigint; zeroForOne: boolean; poolKey: { hooks: Address } }) => {
    if (p.exactAmount > 1_000_000_000n) {
      const wrapped = encodeErrorResult({
        abi: poolManagerErrorsAbi,
        errorName: 'WrappedError',
        args: [p.poolKey.hooks, '0x575e24b4', BAND, HOOK_CALL_FAILED],
      })
      throw new Revert(encodeErrorResult({ abi: v4QuoterAbi, errorName: 'UnexpectedRevertBytes', args: [wrapped] }))
    }
    return [(p.exactAmount * 100n) / 52n, 123_456n]
  },
  quoteExactOutputSingle: (p: { exactAmount: bigint }) => [(p.exactAmount * 52n + 99n) / 100n, 111_111n],
})

const permit2 = contract(permit2Abi, {
  allowance: (_o: Address, t: Address) => (t === USDC ? [0n, 0, 0] : [2n ** 160n - 1n, 2_000_000_000, 4]),
})

const usdc = contract(erc20Abi, { allowance: () => 5_000_000n })

const { client } = mockClient(
  {
    [HOOK]: hook,
    [tokens.y1]: token('YES-1', true, 1n),
    [tokens.n1]: token('NO-1', false, 1n),
    [tokens.y2]: token('YES-2', true, 2n),
    [tokens.n2]: token('NO-2', false, 2n),
    [UNICHAIN_SEPOLIA.v4Quoter]: quoter,
    [UNICHAIN_SEPOLIA.permit2]: permit2,
    [USDC]: usdc,
  },
  UNICHAIN_SEPOLIA.multicall3,
)

describe('listMarkets', () => {
  it('reads the registry, skips empty ids and tolerates failing quotes', async () => {
    const list = await listMarkets(client, { hook: HOOK })
    assert.deepEqual(
      list.map((m) => m.id),
      [1n, 2n],
    )
    const [m1, m2] = list as [(typeof list)[0], (typeof list)[0]]
    assert.equal(m1.status, 'Trading')
    assert.equal(m1.yes.symbol, 'YES-1')
    assert.equal(m1.no.name, 'NO-1 name')
    assert.equal(m1.yes.decimals, 6)
    assert.deepEqual(m1.yes.poolKey, predictionPoolKey({ token: tokens.y1, usdc: USDC, hook: HOOK }))
    assert.equal(m1.cutoff, 1_790_000_060n - 12n)
    assert.ok(Math.abs(m1.strikeUsd - 4000) < 1e-6)
    assert.equal(m1.quote?.askYes, q.askYes)
    assert.equal(m2.status, 'Settled')
    assert.equal(m2.quote, undefined)
  })

  it('honours limit and quotes=false', async () => {
    const list = await listMarkets(client, { hook: HOOK, limit: 1, quotes: false, metadata: false })
    assert.deepEqual(
      list.map((m) => m.id),
      [2n],
    )
    assert.equal(list[0]?.yes.symbol, 'YES-2')
  })

  it('finds the pool and direction for buys and sells', async () => {
    const list = await listMarkets(client, { hook: HOOK })
    const buy = findPredictionRoute(list, { tokenIn: USDC, tokenOut: tokens.y1 })
    assert.ok(buy)
    assert.equal(buy.isBuy, true)
    assert.equal(buy.zeroForOne, buy.poolKey.currency0 === USDC)
    const sell = findPredictionRoute(list, { tokenIn: tokens.n2, tokenOut: USDC })
    assert.equal(sell?.isBuy, false)
    assert.equal(sell?.market.id, 2n)
    assert.equal(findPredictionRoute(list, { tokenIn: tokens.y1, tokenOut: tokens.n1 }), undefined)
    assert.equal(findPredictionRoute(list, { tokenIn: USDC, tokenOut: ALICE }), undefined)
  })

  it('resolves an outcome token by address and rejects foreign tokens', async () => {
    const t = await resolveOutcomeToken(client, { token: tokens.n1, hook: HOOK })
    assert.equal(t?.symbol, 'NO-1')
    assert.equal(t?.isYes, false)
    assert.deepEqual(t?.poolKey, predictionPoolKey({ token: tokens.n1, usdc: USDC, hook: HOOK }))
    assert.equal(await resolveOutcomeToken(client, { token: USDC, hook: HOOK }), undefined)
  })
})

describe('quote', () => {
  const key = predictionPoolKey({ token: tokens.y1, usdc: USDC, hook: HOOK })
  const zeroForOne = key.currency0 === USDC

  it('quotes exact-in and exact-out through V4Quoter', async () => {
    const a = await quoteExactIn(client, { poolKey: key, zeroForOne, amount: 10_000_000n, account: ALICE })
    assert.deepEqual(a, { exactIn: true, amountIn: 10_000_000n, amountOut: 19_230_769n, gasEstimate: 123_456n })
    const b = await quoteExactOut(client, { poolKey: key, zeroForOne, amount: 19_230_769n })
    assert.equal(b.amountIn, 10_000_000n)
    assert.equal(b.amountOut, 19_230_769n)
  })

  it('turns hook reverts into PredictionSwapError', async () => {
    await assert.rejects(quoteExactIn(client, { poolKey: key, zeroForOne, amount: 2_000_000_000n }), (e: unknown) => {
      assert.ok(e instanceof PredictionSwapError)
      assert.equal(e.code, 'OUT_OF_BAND')
      assert.equal(e.revert?.hook, HOOK)
      return true
    })
    await assert.rejects(quoteExactIn(client, { poolKey: key, zeroForOne, amount: 0n }), /larger amount/)
  })
})

describe('readAllowances', () => {
  it('flags a missing ERC20 approval and a missing permit', async () => {
    const s = await readAllowances(client, { owner: ALICE, token: USDC, amount: 10_000_000n, now: 1_790_000_000 })
    assert.equal(s.needsErc20Approval, true)
    assert.equal(s.needsPermit, true)
    assert.equal(s.permit2Nonce, 0)
  })

  it('accepts the OutcomeToken infinite Permit2 allowance and a live permit', async () => {
    const s = await readAllowances(client, { owner: ALICE, token: tokens.y1, amount: 10_000_000n, now: 1_790_000_000 })
    assert.equal(s.needsErc20Approval, false)
    assert.equal(s.needsPermit, false)
    assert.equal(s.permit2Nonce, 4)
    const expiring = await readAllowances(client, { owner: ALICE, token: tokens.y1, amount: 1n, now: 1_999_999_990 })
    assert.equal(expiring.needsPermit, true)
  })
})

describe('extra hook errors', () => {
  it('decodes hook-specific errors supplied by the caller', () => {
    const extra = parseAbi(['error MarketClosed()'])
    const d = decodeRevert(encodeErrorResult({ abi: extra, errorName: 'MarketClosed' }), extra)
    assert.equal(d.code, 'MARKET_CLOSED')
  })
})
