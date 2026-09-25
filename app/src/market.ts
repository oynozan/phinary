import type { HookQuote, Market, MarketInfo } from './sdk.ts'
import { MarketStatus, strikeUsdFromLn } from './sdk.ts'

export type Phase = 'upcoming' | 'trading' | 'closing' | 'awaiting' | 'settled' | 'invalid'
export type Group = 'open' | 'closed' | 'settled'

type Timing = Pick<MarketInfo, 'openTime' | 'expiry' | 'window' | 'cutoffBuffer' | 'status'>

export const SECONDS_PER_YEAR = 31_557_600

export function cutoffOf(info: Timing): number {
  return Number(info.expiry) - info.window - info.cutoffBuffer
}

export function windowStartOf(info: Timing): number {
  return Number(info.expiry) - info.window
}

/** Trading needs openTime <= now < expiry - window - cutoffBuffer (SPEC §3.3). */
export function marketPhase(info: Timing, now: number): Phase {
  if (info.status === MarketStatus.Settled) {
    return 'settled'
  }
  if (info.status === MarketStatus.Invalid) {
    return 'invalid'
  }
  if (now >= Number(info.expiry)) {
    return 'awaiting'
  }
  if (now >= cutoffOf(info)) {
    return 'closing'
  }
  return now < Number(info.openTime) ? 'upcoming' : 'trading'
}

export function groupOf(phase: Phase): Group {
  if (phase === 'upcoming' || phase === 'trading') {
    return 'open'
  }
  return phase === 'closing' || phase === 'awaiting' ? 'closed' : 'settled'
}

/** The keeper strikes at a whole cent, so rounding the exp() recovers it exactly. */
export function strikeOf(info: Pick<MarketInfo, 'lnStrikeWad'>): number {
  return Math.round(strikeUsdFromLn(info.lnStrikeWad) * 100) / 100
}

export function sigmaAnnual(varE36: bigint): number | undefined {
  if (varE36 <= 0n) {
    return undefined
  }
  return Math.sqrt((Number(varE36) / 1e36) * SECONDS_PER_YEAR)
}

export function lnWadToPrice(lnWad: bigint): number {
  return Math.exp(Number(lnWad) / 1e18)
}

/** Geometric-average USD price over [from, to] from normalised tick cumulatives: 1.0001^avgTick * 10^shift. */
export function averagePriceFromCumulatives(cumFrom: bigint, cumTo: bigint, seconds: number, decimalsShift: number): number | undefined {
  if (seconds <= 0) {
    return undefined
  }
  const avgTick = Number(cumTo - cumFrom) / seconds
  return Math.exp(avgTick * Math.log(1.0001)) * 10 ** decimalsShift
}

export function hasPrices(q: HookQuote | undefined): q is HookQuote {
  return !!q && q.midYes > 0n
}

export function winnerIsYes(m: Pick<Market, 'info'>): boolean | undefined {
  return m.info.status === MarketStatus.Settled ? m.info.yesWon : undefined
}

export interface MarketGroups {
  open: Market[]
  closed: Market[]
  settled: Market[]
}

/** Newest first within each group. */
export function groupMarkets(markets: readonly Market[], now: number): MarketGroups {
  const groups: MarketGroups = { open: [], closed: [], settled: [] }
  const sorted = [...markets].sort((a, b) => (a.id === b.id ? 0 : a.id > b.id ? -1 : 1))
  for (const m of sorted) {
    groups[groupOf(marketPhase(m.info, now))].push(m)
  }
  return groups
}

/** The market a first-time visitor should see: the newest one still trading, else the newest overall. */
export function defaultMarketId(markets: readonly Market[], now: number): bigint | undefined {
  const g = groupMarkets(markets, now)
  return (g.open.find((m) => marketPhase(m.info, now) === 'trading') ?? g.open[0] ?? g.closed[0] ?? g.settled[0])?.id
}

const STATUS_NAMES = ['None', 'Trading', 'Settled', 'Invalid'] as const

export function withInfo(m: Market, info: MarketInfo): Market {
  return { ...m, info, status: STATUS_NAMES[info.status] ?? 'None' }
}

/** "ETH above $2,701.35 at 14:31:00?" */
export function questionText(strike: number, expiryClock: string): string {
  const usd = strike.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
  return `ETH above ${usd} at ${expiryClock}?`
}
