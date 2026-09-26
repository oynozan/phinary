import { tabOf, type MarketTab } from "../phase.ts";
import type { Market } from "../types.ts";

export interface Underlying {
  symbol: string;
  name: string;
}
export type UnderlyingRegistry = Record<string, Underlying>;
export type MarketSort = "deadline" | "volume";
export interface ExplorerFilters {
  tab: MarketTab;
  underlying: string;
  search: string;
  sort: MarketSort;
}
export function underlyingOf(
  market: Pick<Market, "oracle">,
  registry: UnderlyingRegistry,
): Underlying {
  return (
    registry[market.oracle.toLowerCase()] ?? {
      symbol: "Unknown",
      name: "Unknown underlying",
    }
  );
}
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const time = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});
export function questionOf(m: Market, registry: UnderlyingRegistry): string {
  return `${underlyingOf(m, registry).symbol} > ${usd.format(m.strike)} at ${time.format(m.expiry * 1000)}?`;
}
export function hasVolume(markets: Market[]): boolean {
  return markets.some((m) => m.volume !== null && Number.isFinite(m.volume));
}
export function selectMarkets(
  markets: Market[],
  filters: ExplorerFilters,
  registry: UnderlyingRegistry,
): Market[] {
  const query = filters.search.trim().toLowerCase();
  return markets
    .filter(
      (m) =>
        tabOf(m.phase) === filters.tab &&
        (filters.underlying === "all" ||
          underlyingOf(m, registry).symbol === filters.underlying) &&
        (!query ||
          `${m.id} ${questionOf(m, registry)} ${underlyingOf(m, registry).name}`
            .toLowerCase()
            .includes(query)),
    )
    .sort((a, b) => {
      if (filters.sort === "volume") {
        const av =
          a.volume !== null && Number.isFinite(a.volume) ? a.volume : -Infinity;
        const bv =
          b.volume !== null && Number.isFinite(b.volume) ? b.volume : -Infinity;
        if (av !== bv) return bv > av ? 1 : -1;
      }
      const order =
        filters.tab === "resolved"
          ? b.expiry - a.expiry
          : filters.tab === "upcoming"
            ? a.openTime - b.openTime
            : a.cutoff - b.cutoff;
      return order || a.id - b.id;
    });
}
