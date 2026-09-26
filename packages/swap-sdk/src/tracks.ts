import { type Address, type Client, type ContractFunctionReturnType, zeroAddress } from 'viem'
import { multicall } from 'viem/actions'
import { marketGatekeeperAbi, marketSchedulerAbi } from './abi/index.ts'
import { UNICHAIN_SEPOLIA } from './constants.ts'
import type { PredictionDeployment } from './deployments.ts'
import { sameAddress } from './pool.ts'

/** `IMarketScheduler.Config` as viem decodes it */
export type SchedulerConfig = ContractFunctionReturnType<typeof marketSchedulerAbi, 'view', 'config'>

/** One MarketScheduler and its frozen config, the unit the UI groups markets by */
export interface Track {
  scheduler: Address
  oracle: Address
  /** On-chain ticker such as "ETH1M", outcome symbols are `${ticker}UP` and `${ticker}DOWN` */
  ticker: string
  /** Ticker without its window suffix, "SOL1M" gives "SOL" */
  asset: string
  /** Short period label such as "1m" or "15m" */
  label: string
  period: number
  tenor: number
  window: number
  cutoffBuffer: number
  nSamples: number
  maxBudget: bigint
  minBudget: bigint
}

export interface TrackReadOptions {
  blockNumber?: bigint
  multicallAddress?: Address
}

/** "1m" for 60, "15m" for 900, "<n>h" for whole hours, "<n>m" for whole minutes, else "<n>s" */
export function periodLabel(period: number): string {
  if (period > 0 && period % 3600 === 0) {
    return `${period / 3600}h`
  }
  if (period > 0 && period % 60 === 0) {
    return `${period / 60}m`
  }
  return `${period}s`
}

/** The asset part of a ticker, dropping a trailing window suffix like "1M", "15M" or "4H" */
export function trackAsset(ticker: string): string {
  const m = /^(.*\D)\d+[SMHD]$/i.exec(ticker)
  return m?.[1] ?? ticker
}

export function trackFromConfig(scheduler: Address, oracle: Address, c: SchedulerConfig): Track {
  return {
    scheduler,
    oracle,
    ticker: c.ticker,
    asset: trackAsset(c.ticker),
    label: periodLabel(c.period),
    period: c.period,
    tenor: c.tenor,
    window: c.window,
    cutoffBuffer: c.cutoffBuffer,
    nSamples: c.nSamples,
    maxBudget: c.maxBudget,
    minBudget: c.minBudget,
  }
}

/** Reads `config()` and `oracle()` of every listed scheduler in one multicall, in deployment order */
export async function readTracks(
  client: Client,
  d: Pick<PredictionDeployment, 'marketSchedulers'> & { multicall3?: Address },
  opts: TrackReadOptions = {},
): Promise<Track[]> {
  const schedulers = d.marketSchedulers
  if (!schedulers.length) {
    return []
  }
  const results = await multicall(client, {
    contracts: schedulers.flatMap((address) => [
      { address, abi: marketSchedulerAbi, functionName: 'config' } as const,
      { address, abi: marketSchedulerAbi, functionName: 'oracle' } as const,
    ]),
    allowFailure: true,
    multicallAddress: opts.multicallAddress ?? d.multicall3 ?? UNICHAIN_SEPOLIA.multicall3,
    blockNumber: opts.blockNumber,
  })
  return schedulers.map((scheduler, i) => {
    const config = results[i * 2]
    const oracle = results[i * 2 + 1]
    if (config?.status !== 'success' || oracle?.status !== 'success') {
      throw new Error(`MarketScheduler ${scheduler} did not answer config() and oracle()`)
    }
    return trackFromConfig(scheduler, oracle.result as Address, config.result as SchedulerConfig)
  })
}

/** Market ids of the track's last `k` slots up to the one holding `nowSec`, newest first, skipping unopened slots */
export async function recentTrackMarketIds(
  client: Client,
  track: Pick<Track, 'scheduler' | 'period'>,
  nowSec: number | bigint,
  k: number,
  opts: TrackReadOptions = {},
): Promise<bigint[]> {
  if (track.period <= 0 || k <= 0) {
    return []
  }
  const now = typeof nowSec === 'bigint' ? nowSec : BigInt(Math.floor(nowSec))
  const current = now / BigInt(track.period)
  const slots: bigint[] = []
  for (let slot = current; slot >= 0n && slots.length < k; slot--) {
    slots.push(slot)
  }
  const ids = await multicall(client, {
    contracts: slots.map(
      (slot) =>
        ({ address: track.scheduler, abi: marketSchedulerAbi, functionName: 'marketOfSlot', args: [slot] }) as const,
    ),
    allowFailure: false,
    multicallAddress: opts.multicallAddress ?? UNICHAIN_SEPOLIA.multicall3,
    blockNumber: opts.blockNumber,
  })
  return ids.filter((id) => id !== 0n)
}

/** `gatekeeper.schedulerOf(id)` for each id, aligned with `ids`, undefined for ids the gatekeeper never created */
export async function schedulerOfMarkets(
  client: Client,
  gatekeeper: Address,
  ids: readonly bigint[],
  opts: TrackReadOptions = {},
): Promise<(Address | undefined)[]> {
  if (!ids.length) {
    return []
  }
  const owners = await multicall(client, {
    contracts: ids.map(
      (id) => ({ address: gatekeeper, abi: marketGatekeeperAbi, functionName: 'schedulerOf', args: [id] }) as const,
    ),
    allowFailure: false,
    multicallAddress: opts.multicallAddress ?? UNICHAIN_SEPOLIA.multicall3,
    blockNumber: opts.blockNumber,
  })
  return owners.map((s) => (sameAddress(s, zeroAddress) ? undefined : s))
}

/** Matches an outcome symbol to its track by exact `${ticker}UP` or `${ticker}DOWN`, never by prefix or expiry */
export function classifyBySymbol<T extends Pick<Track, 'ticker'>>(
  symbol: string,
  tracks: readonly T[],
): { track: T; isYes: boolean } | undefined {
  for (const track of tracks) {
    if (symbol === `${track.ticker}UP`) {
      return { track, isYes: true }
    }
    if (symbol === `${track.ticker}DOWN`) {
      return { track, isYes: false }
    }
  }
  return undefined
}
