import { useCallback, useEffect, useRef, useState } from 'react'
import { type Address, erc20Abi, type PublicClient } from 'viem'
import { multicall3Abi, oracleAbi } from './abi.ts'
import type { ChainClock } from './chain.ts'
import type { AppConfig } from './config.ts'
import { averagePriceFromCumulatives, lnWadToPrice, windowStartOf } from './market.ts'
import { type HookQuote, listMarkets, type Market, type MarketInfo, predictionHookAbi } from './sdk.ts'

export interface Polled<T> {
  data?: T
  error?: unknown
  updatedAt?: number
  refresh: () => void
}

/** Runs `fetcher` now and again `intervalMs` after each completion; restarts when `key` changes. */
export function usePolling<T>(fetcher: (() => Promise<T>) | undefined, intervalMs: number, key: string): Polled<T> {
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown; updatedAt?: number }>({ key })
  const [nonce, setNonce] = useState(0)
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const run = async () => {
      const f = fetchRef.current
      if (!f) {
        return
      }
      try {
        const data = await f()
        if (!cancelled) {
          setState({ key, data, error: undefined, updatedAt: Date.now() })
        }
      } catch (error) {
        if (!cancelled) {
          setState((s) => ({ ...(s.key === key ? s : { key }), error }))
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(run, intervalMs)
        }
      }
    }
    void run()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [key, nonce, intervalMs])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  const current = state.key === key ? state : { key }
  return { data: current.data, error: current.error, updatedAt: current.updatedAt, refresh }
}

/** Re-renders every `ms` so countdowns tick between polls. */
export function useTicker(ms: number): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return tick
}

export interface MarketsSnapshot {
  markets: Market[]
  usdc: Address
  ethPrice?: number
  blockTs: number
}

const usdcCache = new Map<string, Address>()

export async function fetchMarkets(pub: PublicClient, cfg: AppConfig, hook: Address, clock: ChainClock): Promise<MarketsSnapshot> {
  let usdc = usdcCache.get(hook)
  if (!usdc) {
    usdc = await pub.readContract({ address: hook, abi: predictionHookAbi, functionName: 'usdc' })
    usdcCache.set(hook, usdc)
  }
  const markets = await listMarkets(pub, {
    hook,
    limit: cfg.marketLimit,
    quotes: true,
    metadata: false,
    multicallAddress: cfg.contracts.multicall3,
  })
  const oracle = cfg.underlyingOracle ?? markets[markets.length - 1]?.info.oracle
  const [ts, ln] = (await pub.multicall({
    contracts: [
      { address: cfg.contracts.multicall3, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' },
      ...(oracle ? [{ address: oracle, abi: oracleAbi, functionName: 'lnSpotSoBWad' }] : []),
    ] as never,
    allowFailure: true,
    multicallAddress: cfg.contracts.multicall3,
  })) as { status: 'success' | 'failure'; result?: unknown }[]
  const blockTs = ts?.status === 'success' ? Number(ts.result as bigint) : Math.floor(Date.now() / 1000)
  clock.sync(blockTs)
  return {
    markets,
    usdc,
    ethPrice: ln?.status === 'success' ? lnWadToPrice(ln.result as bigint) : undefined,
    blockTs,
  }
}

/** Balance of `owner` for every token, keyed by lowercase address. */
export async function fetchBalances(
  pub: PublicClient,
  cfg: AppConfig,
  owner: Address,
  tokens: Address[],
): Promise<Map<string, bigint>> {
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))] as Address[]
  const res = await pub.multicall({
    contracts: unique.map((address) => ({ address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as const),
    allowFailure: true,
    multicallAddress: cfg.contracts.multicall3,
  })
  const out = new Map<string, bigint>()
  unique.forEach((t, i) => {
    const r = res[i]
    out.set(t, r?.status === 'success' ? (r.result as bigint) : 0n)
  })
  return out
}

export interface LiveState {
  marketId: bigint
  blockTs: number
  quote?: HookQuote
  info: MarketInfo
  ethPrice?: number
  balances?: { usdc: bigint; yes: bigint; no: bigint; eth: bigint }
  /** Running geometric average over the settlement window, once it has started. */
  windowAvg?: { price: number; seconds: number }
}

export interface HistoryPoint {
  t: number
  mid?: number
  eth?: number
}

const shiftCache = new Map<string, number>()

async function decimalsShift(pub: PublicClient, oracle: Address): Promise<number | undefined> {
  const hit = shiftCache.get(oracle)
  if (hit !== undefined) {
    return hit
  }
  try {
    const s = Number(await pub.readContract({ address: oracle, abi: oracleAbi, functionName: 'decimalsShift' }))
    shiftCache.set(oracle, s)
    return s
  } catch {
    return undefined
  }
}

export async function fetchLive(
  pub: PublicClient,
  cfg: AppConfig,
  market: Market,
  usdc: Address,
  account: Address | undefined,
  clock: ChainClock,
): Promise<LiveState> {
  const { hook, id } = market
  const oracle = market.info.oracle
  const start = windowStartOf(market.info)
  const expiry = Number(market.info.expiry)
  const approxNow = Math.floor(clock.estimate()) - 1
  const windowEnd = Math.min(approxNow, expiry)
  const inWindow = windowEnd > start
  const contracts = [
    { address: cfg.contracts.multicall3, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' },
    { address: hook, abi: predictionHookAbi, functionName: 'quote', args: [id] },
    { address: hook, abi: predictionHookAbi, functionName: 'marketInfo', args: [id] },
    { address: oracle, abi: oracleAbi, functionName: 'lnSpotSoBWad' },
    ...(account
      ? ([
          { address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] },
          { address: market.yes.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] },
          { address: market.no.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] },
          { address: cfg.contracts.multicall3, abi: multicall3Abi, functionName: 'getEthBalance', args: [account] },
        ] as const)
      : []),
    ...(inWindow
      ? ([
          { address: oracle, abi: oracleAbi, functionName: 'cumulativeAt', args: [start] },
          { address: oracle, abi: oracleAbi, functionName: 'cumulativeAt', args: [windowEnd] },
        ] as const)
      : []),
  ] as const
  const res = await pub.multicall({
    contracts: contracts as never,
    allowFailure: true,
    multicallAddress: cfg.contracts.multicall3,
  }) as { status: 'success' | 'failure'; result?: unknown }[]
  const ok = <T,>(i: number): T | undefined => (res[i]?.status === 'success' ? (res[i]?.result as T) : undefined)

  const blockTs = Number(ok<bigint>(0) ?? BigInt(Math.floor(Date.now() / 1000)))
  clock.sync(blockTs)
  const info = ok<MarketInfo>(2) ?? market.info
  const ln = ok<bigint>(3)
  let i = 4
  let balances: LiveState['balances']
  if (account) {
    balances = {
      usdc: ok<bigint>(i) ?? 0n,
      yes: ok<bigint>(i + 1) ?? 0n,
      no: ok<bigint>(i + 2) ?? 0n,
      eth: ok<bigint>(i + 3) ?? 0n,
    }
    i += 4
  }
  let windowAvg: LiveState['windowAvg']
  if (inWindow) {
    const c0 = ok<bigint>(i)
    const c1 = ok<bigint>(i + 1)
    const shift = await decimalsShift(pub, oracle)
    if (c0 !== undefined && c1 !== undefined && shift !== undefined) {
      const seconds = windowEnd - start
      const price = averagePriceFromCumulatives(c0, c1, seconds, shift)
      windowAvg = price === undefined ? undefined : { price, seconds }
    }
  }
  return {
    marketId: id,
    blockTs,
    quote: ok<HookQuote>(1),
    info,
    ethPrice: ln === undefined ? undefined : lnWadToPrice(ln),
    balances,
    windowAvg,
  }
}

/** Samples hook.quote and the oracle at past blocks so a chart opened mid-market is not empty. */
export async function backfillHistory(
  pub: PublicClient,
  cfg: AppConfig,
  market: Market,
  samples = 16,
): Promise<HistoryPoint[]> {
  const latest = await pub.getBlock({ blockTag: 'latest' })
  const nowTs = Number(latest.timestamp)
  const from = Math.max(Number(market.info.openTime), nowTs - 300)
  const until = Math.min(nowTs, windowStartOf(market.info))
  if (until - from < 4) {
    return []
  }
  const lookback = 50n
  let secondsPerBlock = 1
  if (latest.number > lookback) {
    const older = await pub.getBlock({ blockNumber: latest.number - lookback })
    const dt = Number(latest.timestamp - older.timestamp)
    secondsPerBlock = dt > 0 ? dt / Number(lookback) : 1
  }
  const step = (until - from) / samples
  const targets: bigint[] = []
  for (let k = 0; k < samples; k++) {
    const t = from + step * (k + 0.5)
    const back = BigInt(Math.max(0, Math.round((nowTs - t) / secondsPerBlock)))
    if (back < latest.number) {
      targets.push(latest.number - back)
    }
  }
  const unique = [...new Set(targets)]
  const points: HistoryPoint[] = []
  const work = unique.map((blockNumber) => async () => {
    try {
      const r = (await pub.multicall({
        contracts: [
          { address: cfg.contracts.multicall3, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' },
          { address: market.hook, abi: predictionHookAbi, functionName: 'quote', args: [market.id] },
          { address: market.info.oracle, abi: oracleAbi, functionName: 'lnSpotSoBWad' },
        ] as never,
        allowFailure: true,
        multicallAddress: cfg.contracts.multicall3,
        blockNumber,
      })) as { status: string; result?: unknown }[]
      if (r[0]?.status !== 'success') {
        return
      }
      const q = r[1]?.status === 'success' ? (r[1].result as HookQuote) : undefined
      const ln = r[2]?.status === 'success' ? (r[2].result as bigint) : undefined
      points.push({
        t: Number(r[0].result as bigint),
        mid: q && q.midYes > 0n ? Number(q.midYes) / 1e18 : undefined,
        eth: ln === undefined ? undefined : lnWadToPrice(ln),
      })
    } catch {
      /* history is best effort */
    }
  })
  for (let k = 0; k < work.length; k += 4) {
    await Promise.all(work.slice(k, k + 4).map((w) => w()))
  }
  return points.sort((a, b) => a.t - b.t)
}

/** Merges points by timestamp; a later defined value wins. */
export function mergeHistory(a: readonly HistoryPoint[], b: readonly HistoryPoint[], cap = 600): HistoryPoint[] {
  const byT = new Map<number, HistoryPoint>()
  for (const p of [...a, ...b]) {
    const merged: HistoryPoint = { ...byT.get(p.t), t: p.t }
    if (p.mid !== undefined) {
      merged.mid = p.mid
    }
    if (p.eth !== undefined) {
      merged.eth = p.eth
    }
    byT.set(p.t, merged)
  }
  return [...byT.values()].sort((x, y) => x.t - y.t).slice(-cap)
}

export interface MarketParamsLite {
  sigmaMode: number
  nSamples: number
  budget: bigint
  h0Wad: bigint
}

const paramsCache = new Map<string, MarketParamsLite>()

export async function fetchParams(pub: PublicClient, market: Market): Promise<MarketParamsLite> {
  const key = `${market.hook}:${market.id}`
  const hit = paramsCache.get(key)
  if (hit) {
    return hit
  }
  const p = await pub.readContract({
    address: market.hook,
    abi: predictionHookAbi,
    functionName: 'marketParams',
    args: [market.id],
  })
  const lite = { sigmaMode: p.sigmaMode, nSamples: p.nSamples, budget: p.budget, h0Wad: p.quote.h0Wad }
  paramsCache.set(key, lite)
  return lite
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return v
}
