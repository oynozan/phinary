import type { HookQuote, MarketInfo as ChainMarketInfo } from "@phinary/swap-sdk";
import { phaseOf } from "../phase.ts";
import type { Market, Quote } from "../types.ts";

/** What the market's track or oracle says about it, the hook itself stores none of this */
export interface MarketMeta {
    asset?: string;
    /** On-chain ticker such as "ETH1M", the outcome symbols are `${ticker}UP` and `${ticker}DOWN` */
    ticker?: string;
    track?: string | null;
    oracleSpot?: number | null;
}

/** Display-only conversion. Amounts used in future transactions must remain bigint. */
export function toMarket(id: number, info: ChainMarketInfo, nSamples: number, raw: HookQuote | undefined, now: number, meta: MarketMeta = {}): Market {
    const asset = meta.asset ?? "";
    const ticker = meta.ticker ?? asset;
    const status = (["none", "trading", "settled", "invalid"] as const)[info.status];
    if (!status || status === "none") throw new Error(`Market ${id} has an invalid status`);
    const strike = Math.exp(Number(info.lnStrikeWad) / 1e18);
    const timing = {
        openTime: Number(info.openTime), expiry: Number(info.expiry), window: info.window,
        cutoffBuffer: info.cutoffBuffer, status, upWon: info.yesWon,
    };
    const phase = phaseOf(timing, now);
    // Past the trading cutoff, hook.quote may return an empty sentinel. It is not a 0% probability.
    const validQuote = raw && status === "trading" && now < timing.expiry - timing.window - timing.cutoffBuffer &&
        raw.varE36 > 0n;
    const quote: Quote | null = validQuote ? {
        tradable: raw.tradable && phase === "live", tau: Number(raw.tau), variance: Number(raw.varE36) / 1e36,
        x: Number(raw.xWad) / 1e18,
        midUp: Number(raw.midYes) / 1e18, askUp: Number(raw.askYes) / 1e18,
        bidUp: Number(raw.bidYes) / 1e18, askDown: Number(raw.askNo) / 1e18, bidDown: Number(raw.bidNo) / 1e18,
        spot: strike * Math.exp(Number(raw.xWad) / 1e18), sigma: Math.sqrt(Number(raw.varE36) / 1e36 * 31557600),
    } : null;
    return {
        id, ...timing, up: info.yes, down: info.no, oracle: info.oracle, strike, nSamples,
        bucket: Number(info.bucket) / 1e6, outUp: Number(info.outYes) / 1e6, outDown: Number(info.outNo) / 1e6,
        phase, cutoff: timing.expiry - timing.window - timing.cutoffBuffer, windowStart: timing.expiry - timing.window,
        createdAt: null, tokenName: `${ticker} > ${strike.toFixed(2)}`, upTicker: `${ticker}UP`, downTicker: `${ticker}DOWN`,
        asset, track: meta.track ?? null, oracleSpot: meta.oracleSpot ?? null,
        quote, upChance: status === "settled" ? (info.yesWon ? 1 : 0) : status === "invalid" ? 0.5 : quote?.midUp ?? null,
        volume: null, tradeCount: null, settlementPrice: null, settledAt: null,
    };
}

