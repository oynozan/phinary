import type { Market, Phase, PricePoint } from "../types.ts";

export const DETAIL_PHASE: Record<Phase, string> = {
    upcoming: "Upcoming", live: "Live", closed: "Trading closed", averaging: "Settling",
    awaiting: "Awaiting settlement", "resolved-up": "Resolved UP", "resolved-down": "Resolved DOWN", invalid: "Invalid · 50/50",
};
export type ChartRange = "15m" | "1h" | "6h" | "Max";
export function historyInRange(points: PricePoint[], range: ChartRange): PricePoint[] {
    const sorted = points.filter((p) => Number.isFinite(p.t)).toSorted((a, b) => a.t - b.t);
    if (range === "Max" || sorted.length === 0) return sorted;
    const seconds = { "15m": 900, "1h": 3600, "6h": 21600 }[range];
    const start = sorted[sorted.length - 1].t - seconds;
    return sorted.filter((p) => p.t >= start);
}
/** Display only; both onchain amounts have six decimals. Never feeds a transaction. */
export function purchaseSummary(amountIn: bigint, amountOut: bigint) {
    if (amountIn <= 0n || amountOut <= 0n) return null;
    return { average: Number(amountIn) / Number(amountOut), payout: Number(amountOut) / 1e6, profit: Number(amountOut - amountIn) / 1e6 };
}
export function detailCanBuy(market: Pick<Market, "phase" | "cutoff" | "quote">, now: number | null) {
    return market.phase === "live" && now !== null && now < market.cutoff && Boolean(market.quote?.tradable);
}
