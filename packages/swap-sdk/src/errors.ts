import { type Abi, type Address, decodeErrorResult, type Hex, isHex, slice } from 'viem'
import {
  hookErrorsAbi,
  outcomeTokenAbi,
  permit2Abi,
  poolManagerErrorsAbi,
  universalRouterAbi,
  v4QuoterAbi,
} from './abi/index.ts'

export type RevertCode =
  | 'NO_ROUTE'
  | 'MARKET_CLOSED'
  | 'OUT_OF_BAND'
  | 'CAPACITY'
  | 'AMOUNT_TOO_LOW'
  | 'ORACLE'
  | 'SLIPPAGE'
  | 'DEADLINE'
  | 'ALLOWANCE'
  | 'SIGNATURE'
  | 'BALANCE'
  | 'UNKNOWN'

export interface DecodedRevert {
  code: RevertCode
  /** Short, user-facing explanation. */
  message: string
  /** Innermost decoded error name, if its ABI is known. */
  name?: string
  args?: readonly unknown[]
  /** Innermost 4-byte selector. */
  selector?: Hex
  /** Target of the innermost `WrappedError`, i.e. the hook that reverted. */
  hook?: Address
  /** Wrapper chain from outermost to innermost, e.g. ["UnexpectedRevertBytes", "WrappedError", "Band"]. */
  path: string[]
  raw: Hex
}

export class PredictionSwapError extends Error {
  readonly code: RevertCode
  readonly revert?: DecodedRevert

  constructor(p: { message: string; code: RevertCode; revert?: DecodedRevert; cause?: unknown }) {
    super(p.message, { cause: p.cause })
    this.name = 'PredictionSwapError'
    this.code = p.code
    this.revert = p.revert
  }
}

const KNOWN_ERRORS = [
  ...v4QuoterAbi,
  ...universalRouterAbi,
  ...permit2Abi,
  ...poolManagerErrorsAbi,
  ...hookErrorsAbi,
  ...outcomeTokenAbi,
].filter((x) => x.type === 'error') as Abi

const CORE_ERROR_NAMES = new Set(
  [...v4QuoterAbi, ...universalRouterAbi, ...permit2Abi, ...poolManagerErrorsAbi, ...outcomeTokenAbi]
    .filter((x) => x.type === 'error')
    .map((x) => (x as { name: string }).name),
)

const BY_NAME: Record<string, [RevertCode, string]> = {
  PoolNotInitialized: ['NO_ROUTE', 'This market pool does not exist'],
  NotEnoughLiquidity: ['NO_ROUTE', 'The hook did not fill the full amount'],
  HookAddressNotValid: ['NO_ROUTE', 'Invalid hook address'],
  InvalidHookResponse: ['NO_ROUTE', 'Invalid hook response'],
  UnknownPool: ['NO_ROUTE', 'Unknown prediction pool'],
  UnknownMarket: ['NO_ROUTE', 'Unknown prediction market'],
  InvalidPool: ['NO_ROUTE', 'Unknown prediction pool'],
  Band: ['OUT_OF_BAND', 'Price is outside the tradable band'],
  OutOfBand: ['OUT_OF_BAND', 'Price is outside the tradable band'],
  TooLate: ['MARKET_CLOSED', 'Trading has closed for this market'],
  NotTradable: ['MARKET_CLOSED', 'This market is not open for trading'],
  MarketClosed: ['MARKET_CLOSED', 'Trading has closed for this market'],
  NotSettled: ['MARKET_CLOSED', 'Trading has closed; wait for settlement'],
  EpochCapExceeded: ['CAPACITY', 'Trade is larger than the market can take right now'],
  Insolvent: ['CAPACITY', 'Trade is larger than the market can take right now'],
  InsufficientIdle: ['CAPACITY', 'Trade is larger than the market can take right now'],
  ZeroAmount: ['AMOUNT_TOO_LOW', 'Enter a larger amount'],
  Unreachable: ['UNKNOWN', 'Quote solver failed'],
  ZeroVariance: ['ORACLE', 'Volatility is unavailable'],
  ObservationUnavailable: ['ORACLE', 'Oracle history is unavailable'],
  SwapAmountCannotBeZero: ['AMOUNT_TOO_LOW', 'Enter a larger amount'],
  V4TooLittleReceived: ['SLIPPAGE', 'Price moved beyond your slippage tolerance'],
  V4TooMuchRequested: ['SLIPPAGE', 'Price moved beyond your slippage tolerance'],
  TransactionDeadlinePassed: ['DEADLINE', 'Transaction deadline passed'],
  SignatureExpired: ['DEADLINE', 'Permit signature expired'],
  AllowanceExpired: ['ALLOWANCE', 'Permit2 allowance expired'],
  InsufficientAllowance: ['ALLOWANCE', 'Token allowance is too low'],
  InvalidSignature: ['SIGNATURE', 'Invalid permit signature'],
  InvalidSigner: ['SIGNATURE', 'Invalid permit signer'],
  InvalidNonce: ['SIGNATURE', 'Permit nonce already used'],
  InvalidSignatureLength: ['SIGNATURE', 'Invalid permit signature'],
  InvalidContractSignature: ['SIGNATURE', 'Invalid permit signature'],
  InsufficientBalance: ['BALANCE', 'Insufficient balance'],
  BalanceTooLow: ['BALANCE', 'Insufficient balance'],
  PermitExpired: ['DEADLINE', 'Permit signature expired'],
  InvalidPermit: ['SIGNATURE', 'Invalid permit signature'],
  AllowanceUnderflow: ['ALLOWANCE', 'Token allowance is too low'],
  CurrencyNotSettled: ['UNKNOWN', 'Hook settlement error (CurrencyNotSettled)'],
  HookDeltaExceedsSwapAmount: ['UNKNOWN', 'Hook settlement error (HookDeltaExceedsSwapAmount)'],
  DeltaNotNegative: ['UNKNOWN', 'Router settlement error (DeltaNotNegative)'],
  DeltaNotPositive: ['UNKNOWN', 'Router settlement error (DeltaNotPositive)'],
  PriceLimitAlreadyExceeded: ['UNKNOWN', 'Invalid swap price limit (PriceLimitAlreadyExceeded)'],
  PriceLimitOutOfBounds: ['UNKNOWN', 'Invalid swap price limit (PriceLimitOutOfBounds)'],
}

/**
 * Name patterns for hook errors whose exact ABI we may not have (the hook defines its own). Never applied to the
 * core Uniswap, Permit2 and OutcomeToken errors, so a hook accounting bug does not read as a normal market state.
 */
const BY_PATTERN: [RegExp, RevertCode, string][] = [
  [
    /closed|cutoff|expired|toolate|nottrading|notopen|settled|halt/i,
    'MARKET_CLOSED',
    'Trading has closed for this market',
  ],
  [/band|price(out|range)/i, 'OUT_OF_BAND', 'Price is outside the tradable band'],
  [
    /cap|insolv|capacity|inventory|exceed|budget|epoch/i,
    'CAPACITY',
    'Trade is larger than the market can take right now',
  ],
  [/zero|dust|toosmall|amount/i, 'AMOUNT_TOO_LOW', 'Enter a larger amount'],
  [/unknown(pool|market)|nomarket|notfound/i, 'NO_ROUTE', 'Unknown prediction market'],
  [/oracle|observation|variance/i, 'ORACLE', 'Price oracle is unavailable'],
]

function classify(name: string | undefined, args: readonly unknown[] | undefined): [RevertCode, string] {
  if (!name) {
    return ['UNKNOWN', 'Transaction reverted']
  }
  if (name === 'Error' && typeof args?.[0] === 'string') {
    const reason = args[0]
    if (/TRANSFER_FROM_FAILED|allowance/i.test(reason)) {
      return ['ALLOWANCE', 'Token allowance is too low']
    }
    if (/balance/i.test(reason)) {
      return ['BALANCE', 'Insufficient balance']
    }
    return ['UNKNOWN', reason]
  }
  if (name === 'Panic') {
    return ['UNKNOWN', `Arithmetic error (panic ${String(args?.[0])})`]
  }
  const exact = BY_NAME[name]
  if (exact) {
    return exact
  }
  if (!CORE_ERROR_NAMES.has(name)) {
    for (const [re, code, msg] of BY_PATTERN) {
      if (re.test(name)) {
        return [code, msg]
      }
    }
  }
  return ['UNKNOWN', `Reverted with ${name}`]
}

/**
 * Decodes revert data from V4Quoter, UniversalRouter, Permit2 or PoolManager. Unwraps
 * `UnexpectedRevertBytes`, `ExecutionFailed` and ERC-7751 `WrappedError` down to the innermost reason.
 */
export function decodeRevert(raw: Hex, extraErrors: Abi = []): DecodedRevert {
  const abi = extraErrors.length ? ([...extraErrors, ...KNOWN_ERRORS] as Abi) : KNOWN_ERRORS
  const path: string[] = []
  let data: Hex = raw
  let hook: Address | undefined
  let command: bigint | undefined
  for (let depth = 0; depth < 8; depth++) {
    if (!isHex(data) || data.length < 10) {
      const message =
        command === undefined
          ? 'Transaction reverted without a reason'
          : `UniversalRouter command ${command} reverted without a reason`
      return { code: 'UNKNOWN', message, path, hook, raw }
    }
    const selector = slice(data, 0, 4)
    let decoded: { errorName: string; args?: readonly unknown[] }
    try {
      decoded = decodeErrorResult({ abi, data }) as { errorName: string; args?: readonly unknown[] }
    } catch {
      const fromHook = hook !== undefined
      return {
        code: fromHook ? 'NO_ROUTE' : 'UNKNOWN',
        message: fromHook ? `The hook rejected this trade (${selector})` : `Transaction reverted (${selector})`,
        selector,
        hook,
        path,
        raw,
      }
    }
    const { errorName: name, args } = decoded
    path.push(name)
    if (name === 'UnexpectedRevertBytes') {
      data = args?.[0] as Hex
      continue
    }
    if (name === 'ExecutionFailed') {
      command = args?.[0] as bigint
      data = args?.[1] as Hex
      continue
    }
    if (name === 'WrappedError') {
      hook = args?.[0] as Address
      data = args?.[2] as Hex
      continue
    }
    const [code, message] = classify(name, args)
    return { code, message, name, args, selector, hook, path, raw }
  }
  return { code: 'UNKNOWN', message: 'Revert data nested too deeply', path, hook, raw }
}

/** Finds revert bytes anywhere in a viem (or JSON-RPC) error's cause chain. */
export function extractRevertData(err: unknown): Hex | undefined {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const e = cur as { raw?: unknown; data?: unknown; cause?: unknown; error?: unknown }
    if (isHex(e.raw) && e.raw.length >= 10) {
      return e.raw
    }
    if (isHex(e.data) && e.data.length >= 10) {
      return e.data
    }
    if (e.data && typeof e.data === 'object') {
      const inner = (e.data as { data?: unknown }).data
      if (isHex(inner) && inner.length >= 10) {
        return inner
      }
    }
    cur = e.cause ?? e.error
  }
  return undefined
}

/** Normalises any quote/simulation failure into a `PredictionSwapError`; rethrows transport errors unchanged. */
export function toSwapError(err: unknown, extraErrors: Abi = []): PredictionSwapError {
  if (err instanceof PredictionSwapError) {
    return err
  }
  const raw = extractRevertData(err)
  if (raw) {
    const d = decodeRevert(raw, extraErrors)
    return new PredictionSwapError({ message: d.message, code: d.code, revert: d, cause: err })
  }
  const text = err instanceof Error ? err.message : String(err)
  if (/execution reverted|revert/i.test(text)) {
    return new PredictionSwapError({ message: 'Transaction reverted without a reason', code: 'UNKNOWN', cause: err })
  }
  throw err
}
