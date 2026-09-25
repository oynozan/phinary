import { type Abi, type Address, type Client, decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import { call } from 'viem/actions'
import { v4QuoterAbi } from './abi/index.ts'
import { MAX_UINT128, UNICHAIN_SEPOLIA } from './constants.ts'
import { PredictionSwapError, toSwapError } from './errors.ts'
import type { PoolKey } from './pool.ts'

export interface QuoteRequest {
  poolKey: PoolKey
  zeroForOne: boolean
  /** Exact input amount (exact-in) or exact output amount (exact-out), in the token's smallest unit. */
  amount: bigint
  hookData?: Hex
  quoter?: Address
  /** Sent as `from`; harmless for our hook, and matches what the swap will see as `tx.origin`. */
  account?: Address
  /** Hook error ABIs to decode on top of the built-in set. */
  extraErrors?: Abi
}

export interface QuoteResult {
  exactIn: boolean
  amountIn: bigint
  amountOut: bigint
  /** Gas used inside the quoter (excludes UniversalRouter and Permit2 overhead). */
  gasEstimate: bigint
}

async function quoteSingle(client: Client, req: QuoteRequest & { exactIn: boolean }): Promise<QuoteResult> {
  const { exactIn } = req
  if (req.amount <= 0n) {
    throw new PredictionSwapError({ message: 'Enter a larger amount', code: 'AMOUNT_TOO_LOW' })
  }
  if (req.amount > MAX_UINT128) {
    throw new PredictionSwapError({ message: 'Amount too large', code: 'CAPACITY' })
  }
  const functionName = exactIn ? 'quoteExactInputSingle' : 'quoteExactOutputSingle'
  const data = encodeFunctionData({
    abi: v4QuoterAbi,
    functionName,
    args: [
      {
        poolKey: req.poolKey,
        zeroForOne: req.zeroForOne,
        exactAmount: req.amount,
        hookData: req.hookData ?? '0x',
      },
    ],
  })
  let result: Hex | undefined
  try {
    ;({ data: result } = await call(client, {
      to: req.quoter ?? UNICHAIN_SEPOLIA.v4Quoter,
      data,
      account: req.account,
    }))
  } catch (err) {
    throw toSwapError(err, req.extraErrors)
  }
  if (!result || result === '0x') {
    throw new PredictionSwapError({ message: 'Quoter returned no data', code: 'NO_ROUTE' })
  }
  const [quoted, gasEstimate] = decodeFunctionResult({ abi: v4QuoterAbi, functionName, data: result })
  if (quoted === 0n) {
    throw new PredictionSwapError({ message: 'Enter a larger amount', code: 'AMOUNT_TOO_LOW' })
  }
  return exactIn
    ? { exactIn, amountIn: req.amount, amountOut: quoted, gasEstimate }
    : { exactIn, amountIn: quoted, amountOut: req.amount, gasEstimate }
}

/** `V4Quoter.quoteExactInputSingle` via `eth_call`. Hook reverts become `PredictionSwapError`. */
export function quoteExactIn(client: Client, req: QuoteRequest): Promise<QuoteResult> {
  return quoteSingle(client, { ...req, exactIn: true })
}

/** `V4Quoter.quoteExactOutputSingle` via `eth_call`. Hook reverts become `PredictionSwapError`. */
export function quoteExactOut(client: Client, req: QuoteRequest): Promise<QuoteResult> {
  return quoteSingle(client, { ...req, exactIn: false })
}

/** Minimum output after `slippageBps` (rounded down). */
export function minOutWithSlippage(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - Math.round(slippageBps))) / 10_000n
}

/** Maximum input after `slippageBps` (rounded up). */
export function maxInWithSlippage(amountIn: bigint, slippageBps: number): bigint {
  const num = amountIn * BigInt(10_000 + Math.round(slippageBps))
  return (num + 9_999n) / 10_000n
}

export interface AutoSlippageParams {
  exactIn: boolean
  /** USDC -> outcome token. */
  isBuy: boolean
  amountIn: bigint
  amountOut: bigint
  /** Seconds until the settlement window opens (`expiry - window - now`), the non-averaged part of tau. */
  secondsToWindow: number
  /** Seconds the price can move between the quote and inclusion (wallet confirmation plus a block). */
  confirmSeconds?: number
  /** Standard deviations of that move to tolerate. */
  z?: number
  minBps?: number
  maxBps?: number
}

/**
 * Slippage sized to how far a binary's mid can move before the swap lands. Near the money the mid moves by
 * about phi(d) * sqrt(dt / tauEff) <= 0.4 * sqrt(dt / tauEff), whatever sigma is (SPEC §3.3), so the tolerance is
 * set in price terms and converted to a fraction of this trade's average price: cheap tokens get more.
 */
export function autoSlippageBps(p: AutoSlippageParams): number {
  const { exactIn, isBuy, confirmSeconds = 5, z = 2, minBps = 100, maxBps = 9_000 } = p
  const inN = Number(p.amountIn)
  const outN = Number(p.amountOut)
  if (!(inN > 0) || !(outN > 0)) {
    return maxBps
  }
  const price = isBuy ? inN / outN : outN / inN
  const move = z * 0.4 * Math.sqrt(confirmSeconds / Math.max(p.secondsToWindow, 1))
  const adverse = isBuy ? Math.min(price + move, 1) : Math.max(price - move, 0)
  let frac: number
  if (exactIn) {
    frac = isBuy ? 1 - price / adverse : 1 - adverse / price
  } else {
    frac = isBuy ? adverse / price - 1 : adverse > 0 ? price / adverse - 1 : Infinity
  }
  return Math.min(maxBps, Math.max(minBps, Math.ceil(frac * 10_000)))
}
