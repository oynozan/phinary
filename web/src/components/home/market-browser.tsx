"use client";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  selectMarkets,
  hasVolume,
  type ExplorerFilters,
  type UnderlyingRegistry,
} from "@/lib/markets/explorer";
import type { MarketSnapshot } from "@/lib/onchain/read-markets";
import type { Market } from "@/lib/types";
import { MarketControls, TrackFilter } from "./market-controls";
import { MarketTable } from "./market-table";
const PAGE = 12;
export function MarketBrowser({
  markets,
  tracks,
  registry,
  error,
}: {
  markets: Market[] | undefined;
  tracks: MarketSnapshot["tracks"] | undefined;
  registry: UnderlyingRegistry;
  error: boolean;
}) {
  const [filters, setFilters] = useState<ExplorerFilters>({
    tab: "live",
    underlying: "ETH",
    track: "1m",
    search: "",
    sort: "deadline",
  });
  const [limit, setLimit] = useState(PAGE);
  const candidates = markets
    ? selectMarkets(markets, { ...filters, sort: "deadline" }, registry)
    : [];
  const volumeAvailable = hasVolume(candidates);
  const list = markets
    ? selectMarkets(
        markets,
        { ...filters, sort: volumeAvailable ? filters.sort : "deadline" },
        registry,
      )
    : undefined;
  const assets = [...new Set(tracks?.map((t) => t.asset) ?? [filters.underlying])];
  const durations = [
    ...new Set(
      tracks
        ? [...tracks].sort((a, b) => a.period - b.period).map((t) => t.label)
        : [filters.track ?? "1m"],
    ),
  ];
  const change = (next: ExplorerFilters) => {
    setFilters(next);
    setLimit(PAGE);
  };
  return (
    <section aria-label="Market explorer">
      <TrackFilter
        filters={filters}
        assets={assets}
        durations={durations}
        onChange={change}
      />
      <MarketControls
        filters={filters}
        volumeAvailable={volumeAvailable}
        onChange={change}
      />
      {error ? (
        <div className="market-empty" role="status">
          Markets unavailable. Retry using the button above.
        </div>
      ) : !list ? (
        <div
          className="market-loading"
          aria-busy="true"
          aria-label="Loading markets"
        >
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="market-empty" role="status">
          <p>
            {filters.search
              ? "No markets match your search."
              : `No ${filters.tab} markets${filters.tab === "resolved" ? " yet" : ""}.`}
          </p>
          {filters.search && (
            <button
              type="button"
              onClick={() => change({ ...filters, search: "" })}
            >
              Clear search
            </button>
          )}
        </div>
      ) : (
        <MarketTable
          markets={list.slice(0, limit)}
          tab={filters.tab}
          registry={registry}
        />
      )}
      {list && list.length > 0 && (
        <div className="market-list-footer">
          <span>
            Showing {Math.min(limit, list.length)} of {list.length} markets
          </span>
          {list.length > limit && (
            <button type="button" onClick={() => setLimit((n) => n + PAGE)}>
              Show more
            </button>
          )}
        </div>
      )}
    </section>
  );
}
