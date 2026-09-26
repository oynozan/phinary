import type { BuyQuote } from "../onchain/buy.ts";
import { isResolved, payoutPerToken } from "../phase.ts";
import type { Phase, Side } from "../types.ts";

/** Display model only. No wallet cash, accounting reconstruction or execution payloads. */
export interface PortfolioRow {
    id: string;
    marketId: number;
    question: string;
    expiry: number;
    cutoff: number;
    openTime: number;
    phase: Phase;
    tradable: boolean;
    side: Side;
    quantity: bigint;
    avgCost: number | null;
    currentPrice: number | null;
    value: number | null;
    profit: number | null;
    profitPercent: number | null;
    settledAt: number | null;
    disposition: "held" | "claimed" | "refunded";
}
export type PortfolioAvailability = "ready" | "loading" | "disconnected" | "wrong-network" | "unavailable" | "error";
export interface PortfolioDisplay {
    availability: PortfolioAvailability;
    rows: PortfolioRow[];
    realized: number | null;
}
export type PortfolioSection = "open" | "claimable" | "history";
export function sectionOf(row: PortfolioRow): PortfolioSection {
    if (row.disposition !== "held") return "history";
    if (!isResolved(row.phase)) return "open";
    return (payoutPerToken(row.phase, row.side) ?? 0) > 0 ? "claimable" : "history";
}
export function partitionPortfolio(rows: PortfolioRow[]) {
    return {
        open: rows.filter((r) => sectionOf(r) === "open").toSorted((a, b) => a.expiry - b.expiry || a.id.localeCompare(b.id)),
        claimable: rows.filter((r) => sectionOf(r) === "claimable").toSorted((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || a.id.localeCompare(b.id)),
        history: rows.filter((r) => sectionOf(r) === "history").toSorted((a, b) => (b.settledAt ?? -Infinity) - (a.settledAt ?? -Infinity) || a.id.localeCompare(b.id)),
    };
}
export function sumKnown(values: (number | null)[]): number | null {
    return values.some((v) => v === null || !Number.isFinite(v)) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}
export function portfolioTotals(display: PortfolioDisplay) {
    if (display.availability !== "ready") return { total: null, unrealized: null, realized: null, openCount: null, claimable: null };
    const { open, claimable } = partitionPortfolio(display.rows);
    const claimableValue = claimPlan(claimable).amount;
    return { total: sumKnown([...open.map((r) => r.value), claimableValue]), unrealized: sumKnown(open.map((r) => r.profit)), realized: display.realized, openCount: open.length, claimable: claimableValue };
}
export function claimPlan(rows: PortfolioRow[]) {
    const candidates = partitionPortfolio(rows).claimable;
    const invalidTotals = new Map<number, bigint>();
    for (const row of candidates) if (row.phase === "invalid") invalidTotals.set(row.marketId, (invalidTotals.get(row.marketId) ?? 0n) + row.quantity);
    const claimable = candidates.filter(row => row.phase !== "invalid" || (invalidTotals.get(row.marketId) ?? 0n) / 2n > 0n);
    return { positions: claimable.length, marketIds: [...new Set(claimable.map((r) => r.marketId))], amount: sumKnown(claimable.filter(r => r.phase !== "invalid").map(r => r.value).concat([...invalidTotals.values()].map(q => Number(q / 2n) / 1e6))) };
}
export function canSell(row: PortfolioRow, now: number): boolean {
    return row.disposition === "held" && row.phase === "live" && row.tradable && now >= row.openTime && now < row.cutoff && row.quantity > 0n;
}
export function resultLabel(row: PortfolioRow) {
    return row.phase === "invalid" ? "INVALID" : row.phase === "resolved-up" ? "UP WON" : row.phase === "resolved-down" ? "DOWN WON" : "N/A";
}
export function historyStatus(row: PortfolioRow) {
    return row.disposition === "refunded" ? "Refunded" : row.disposition === "claimed" ? "Claimed" : "Lost";
}
export function tokenAmount(raw: string): bigint | null {
    if (!/^\d+(?:\.\d{0,6})?$/.test(raw)) return null;
    const [whole, fraction = ""] = raw.split(".");
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
export function amountText(units: bigint): string {
    return `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`.replace(/\.?0+$/, "") || "0";
}
export interface SellPreview { usdc: number; averagePrice: number; review?: BuyQuote }
export interface PortfolioActions {
    quoteSell(row: PortfolioRow, amount: bigint): Promise<SellPreview>;
    sell(row: PortfolioRow, amount: bigint, quote: SellPreview): Promise<void | number>;
    claimMarket(marketId: number): Promise<number>;
}
export interface ClaimProgress { completed: number; total: number; paid: number; failed: number; stopped?: boolean }
/** Stop on failure so cancellation or an unknown receipt never starts another claim. */
export async function claimSequentially(marketIds: number[], claim: PortfolioActions["claimMarket"], onProgress: (progress: ClaimProgress) => void) {
    const ids = [...new Set(marketIds)];
    const progress: ClaimProgress = { completed: 0, total: ids.length, paid: 0, failed: 0 };
    onProgress({ ...progress });
    for (const id of ids) {
        try { progress.paid += await claim(id); } catch { progress.failed += 1; progress.stopped = true; progress.completed += 1; onProgress({ ...progress }); break; }
        progress.completed += 1;
        onProgress({ ...progress });
    }
    return progress;
}

export function portfolioUnitPrice(value: number | null) { return value === null || !Number.isFinite(value) ? "N/A" : new Intl.NumberFormat("en-US", {style:"currency", currency:"USD", minimumFractionDigits:2, maximumFractionDigits:4}).format(value); }
