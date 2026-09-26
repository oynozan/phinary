import { type Address, type Client, erc20Abi, zeroAddress } from 'viem'
import { multicall, readContract } from 'viem/actions'
import { outcomeTokenAbi, predictionHookAbi } from './abi/index.ts'
import { OUTCOME_DECIMALS, UNICHAIN_SEPOLIA, WAD } from './constants.ts'
import { type PoolKey, sameAddress } from './pool.ts'

/** `IPredictionHook.Status`. */
export const MarketStatus = { None: 0, Trading: 1, Settled: 2, Invalid: 3 } as const
export type MarketStatusName = 'None' | 'Trading' | 'Settled' | 'Invalid'
const STATUS_NAMES: MarketStatusName[] = ['None', 'Trading', 'Settled', 'Invalid']

export interface MarketInfo {
  yes: Address
  no: Address
  oracle: Address
  lnStrikeWad: bigint
  openTime: bigint
  expiry: bigint
  window: number
  cutoffBuffer: number
  status: number
  yesWon: boolean
  bucket: bigint
  outYes: bigint
  outNo: bigint
  invYes: bigint
  invNo: bigint
}

export interface HookQuote {
  tradable: boolean
  tau: bigint
  varE36: bigint
  xWad: bigint
  midYes: bigint
  askYes: bigint
  bidYes: bigint
  askNo: bigint
  bidNo: bigint
}

export interface OutcomeTokenInfo {
  address: Address
  symbol: string
  name: string
  decimals: number
  isYes: boolean
  marketId: bigint
  poolKey: PoolKey
}

export interface Market {
  id: bigint
  hook: Address
  info: MarketInfo
  status: MarketStatusName
  yes: OutcomeTokenInfo
  no: OutcomeTokenInfo
  /** USD strike, exp(lnStrikeWad / 1e18). Display only. */
  strikeUsd: number
  /** Trading stops at `expiry - window - cutoffBuffer` (SPEC §3.3). */
  cutoff: bigint
  quote?: HookQuote
}

export interface ListMarketsOptions {
  hook: Address
  /** First id to read; defaults to the newest `limit` markets. */
  fromId?: bigint
  limit?: number
  /** Exact ids to read in this order, such as a track's `recentTrackMarketIds`; `fromId` and `limit` are then ignored */
  ids?: readonly bigint[]
  /** Also read `hook.quote(id)` (default true). */
  quotes?: boolean
  /** Also read YES/NO `symbol()` and `name()` (default true). */
  metadata?: boolean
  multicallAddress?: Address
}

export function wadToNumber(x: bigint): number {
  return Number(x) / Number(WAD)
}

export function strikeUsdFromLn(lnStrikeWad: bigint): number {
  return Math.exp(wadToNumber(lnStrikeWad))
}

export async function getMarketCount(client: Client, hook: Address): Promise<bigint> {
  return readContract(client, { address: hook, abi: predictionHookAbi, functionName: 'marketCount' })
}

/**
 * Reads markets from the hook registry with two multicalls. Ids `[fromId, marketCount]` are read so that both
 * 0-based and 1-based numbering work; ids whose `marketInfo` fails or has status `None` are skipped.
 */
export async function listMarkets(client: Client, opts: ListMarketsOptions): Promise<Market[]> {
  const { hook } = opts
  const limit = BigInt(opts.limit ?? 50)
  const multicallAddress = opts.multicallAddress ?? UNICHAIN_SEPOLIA.multicall3
  const ids: bigint[] = opts.ids ? [...opts.ids] : []
  if (!opts.ids) {
    const count = await getMarketCount(client, hook)
    const from = opts.fromId ?? (count >= limit ? count - limit + 1n : 0n)
    for (let id = from; id <= count && ids.length < Number(limit) + 1; id++) {
      ids.push(id)
    }
  }
  if (!ids.length) {
    return []
  }

  const withQuotes = opts.quotes !== false
  const calls = ids.flatMap((id) => [
    { address: hook, abi: predictionHookAbi, functionName: 'marketInfo', args: [id] } as const,
    { address: hook, abi: predictionHookAbi, functionName: 'poolKeys', args: [id] } as const,
    ...(withQuotes ? [{ address: hook, abi: predictionHookAbi, functionName: 'quote', args: [id] } as const] : []),
  ])
  const results = await multicall(client, { contracts: calls, allowFailure: true, multicallAddress })
  const stride = withQuotes ? 3 : 2

  const partial: Omit<Market, 'yes' | 'no'>[] = []
  const keys: [PoolKey, PoolKey][] = []
  ids.forEach((id, i) => {
    const info = results[i * stride]
    const pk = results[i * stride + 1]
    const q = withQuotes ? results[i * stride + 2] : undefined
    if (info?.status !== 'success' || pk?.status !== 'success') {
      return
    }
    const mi = info.result as MarketInfo
    if (mi.status === MarketStatus.None || sameAddress(mi.yes, zeroAddress)) {
      return
    }
    const [yesKey, noKey] = pk.result as readonly [PoolKey, PoolKey]
    keys.push([yesKey, noKey])
    partial.push({
      id,
      hook,
      info: mi,
      status: STATUS_NAMES[mi.status] ?? 'None',
      strikeUsd: strikeUsdFromLn(mi.lnStrikeWad),
      cutoff: mi.expiry - BigInt(mi.window) - BigInt(mi.cutoffBuffer),
      quote: q?.status === 'success' ? (q.result as HookQuote) : undefined,
    })
  })

  let symbols: (string | undefined)[] = []
  if (opts.metadata !== false && partial.length) {
    const meta = await multicall(client, {
      contracts: partial.flatMap((m) =>
        [m.info.yes, m.info.no].flatMap((address) => [
          { address, abi: erc20Abi, functionName: 'symbol' } as const,
          { address, abi: erc20Abi, functionName: 'name' } as const,
        ]),
      ),
      allowFailure: true,
      multicallAddress,
    })
    symbols = meta.map((r) => (r.status === 'success' ? (r.result as string) : undefined))
  }

  return partial.map((m, i) => {
    const [yesKey, noKey] = keys[i] as [PoolKey, PoolKey]
    const token = (isYes: boolean, j: number): OutcomeTokenInfo => ({
      address: isYes ? m.info.yes : m.info.no,
      symbol: symbols[i * 4 + j * 2] ?? `${isYes ? 'YES' : 'NO'}-${m.id}`,
      name: symbols[i * 4 + j * 2 + 1] ?? `${isYes ? 'Yes' : 'No'} #${m.id}`,
      decimals: OUTCOME_DECIMALS,
      isYes,
      marketId: m.id,
      poolKey: isYes ? yesKey : noKey,
    })
    return { ...m, yes: token(true, 0), no: token(false, 1) }
  })
}

/**
 * Identifies an arbitrary token as one of the hook's outcome tokens (`OutcomeToken.hook() == hook`), for
 * deep links to markets older than the listed window. Returns undefined for foreign tokens.
 */
export async function resolveOutcomeToken(
  client: Client,
  p: { token: Address; hook: Address; multicallAddress?: Address },
): Promise<OutcomeTokenInfo | undefined> {
  const t = p.token
  const [owner, marketId, isYes, symbol, name] = await multicall(client, {
    contracts: [
      { address: t, abi: outcomeTokenAbi, functionName: 'hook' },
      { address: t, abi: outcomeTokenAbi, functionName: 'marketId' },
      { address: t, abi: outcomeTokenAbi, functionName: 'isYes' },
      { address: t, abi: outcomeTokenAbi, functionName: 'symbol' },
      { address: t, abi: outcomeTokenAbi, functionName: 'name' },
    ],
    allowFailure: true,
    multicallAddress: p.multicallAddress ?? UNICHAIN_SEPOLIA.multicall3,
  })
  if (owner.status !== 'success' || !sameAddress(owner.result, p.hook)) {
    return undefined
  }
  if (marketId.status !== 'success' || isYes.status !== 'success') {
    return undefined
  }
  const [yesKey, noKey] = await readContract(client, {
    address: p.hook,
    abi: predictionHookAbi,
    functionName: 'poolKeys',
    args: [marketId.result],
  })
  return {
    address: t,
    symbol: symbol.status === 'success' ? symbol.result : isYes.result ? 'YES' : 'NO',
    name: name.status === 'success' ? name.result : `${isYes.result ? 'Yes' : 'No'} #${marketId.result}`,
    decimals: OUTCOME_DECIMALS,
    isYes: isYes.result,
    marketId: marketId.result,
    poolKey: isYes.result ? yesKey : noKey,
  }
}

/** The pool and direction for swapping `tokenIn` -> `tokenOut` if one side is USDC and the other an outcome token. */
export function findPredictionRoute(
  markets: readonly Market[],
  { tokenIn, tokenOut }: { tokenIn: Address; tokenOut: Address },
): { market: Market; token: OutcomeTokenInfo; poolKey: PoolKey; zeroForOne: boolean; isBuy: boolean } | undefined {
  for (const market of markets) {
    for (const token of [market.yes, market.no]) {
      const buy = sameAddress(tokenOut, token.address)
      const sell = sameAddress(tokenIn, token.address)
      if (!buy && !sell) {
        continue
      }
      const other = buy ? tokenIn : tokenOut
      const { poolKey } = token
      const usdcIs0 = sameAddress(poolKey.currency0, other)
      if (!usdcIs0 && !sameAddress(poolKey.currency1, other)) {
        continue
      }
      const zeroForOne = sameAddress(poolKey.currency0, tokenIn)
      return { market, token, poolKey, zeroForOne, isBuy: buy }
    }
  }
  return undefined
}
