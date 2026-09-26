import type { Address } from 'viem'

import { type SchedulerConfig, trackFromConfig } from '../../../packages/swap-sdk/src/tracks.ts'

const lower = (a: Address) => a.toLowerCase() as Address

export type TrackRow = {
  id: Address
  gatekeeper: Address
  oracle: Address
  ticker: string
  asset: string
  label: string
  period: number
  tenor: number
  window: number
  cutoffBuffer: number
  nSamples: number
  maxBudget: bigint
  minBudget: bigint
}

export function trackRow(scheduler: Address, gatekeeper: Address, oracle: Address, config: SchedulerConfig): TrackRow {
  const t = trackFromConfig(lower(scheduler), lower(oracle), config)
  return {
    id: t.scheduler,
    gatekeeper: lower(gatekeeper),
    oracle: t.oracle,
    ticker: t.ticker,
    asset: t.asset,
    label: t.label,
    period: t.period,
    tenor: t.tenor,
    window: t.window,
    cutoffBuffer: t.cutoffBuffer,
    nSamples: t.nSamples,
    maxBudget: t.maxBudget,
    minBudget: t.minBudget,
  }
}

export type MarketOpenedArgs = { marketId: bigint; slot: bigint; caller: Address; budget: bigint; strikeCents: bigint }

/** The track columns a `MarketOpened` adds to its market row, throwing when the expiry breaks `slot*period + tenor` */
export function openedMarketFields(track: TrackRow, args: MarketOpenedArgs, expiry: number) {
  const expected = args.slot * BigInt(track.period) + BigInt(track.tenor)
  if (BigInt(expiry) !== expected) {
    throw new Error(`market ${args.marketId} expiry ${expiry} != slot ${args.slot} * ${track.period} + ${track.tenor}`)
  }
  return {
    scheduler: track.id,
    ticker: track.ticker,
    asset: track.asset,
    oracle: track.oracle,
    slot: args.slot,
    budget: args.budget,
    strikeCents: args.strikeCents,
    openedBy: lower(args.caller),
    period: track.period,
    tenor: track.tenor,
  }
}

/** Symbol of the underlying whose oracle is `oracle`, or null for an unknown oracle */
export function assetOfOracle(underlyings: readonly { symbol: string; oracle: Address }[], oracle: Address): string | null {
  return underlyings.find((u) => u.oracle.toLowerCase() === oracle.toLowerCase())?.symbol ?? null
}

/** The market's own oracle, `fallback` for a row indexed without one */
export function oracleOf(m: { oracle: Address | null }, fallback: Address): Address {
  return lower(m.oracle ?? fallback)
}

/** Distinct oracles of the markets in first-seen order */
export function oraclesOf(markets: readonly { oracle: Address | null }[], fallback: Address): Address[] {
  return [...new Set(markets.map((m) => oracleOf(m, fallback)))]
}
