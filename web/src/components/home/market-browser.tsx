"use client";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  selectMarkets,
  hasVolume,
  type ExplorerFilters,
  type TrackFilter,
  type UnderlyingRegistry,
} from "@/lib/markets/explorer";
import type { Market } from "@/lib/types";
import type { MarketSnapshot } from "@/lib/onchain/read-markets";
import { MarketControls, TrackFilter as TrackFilterControls } from "./market-controls";
import { MarketTable } from "./market-table";
const PAGE = 12;
export function MarketBrowser({
  markets,
  filter,
  tracks,
  onFilter,
  registry,
  error,
}: {
  markets: Market[] | undefined;
  filter: TrackFilter;
  tracks: MarketSnapshot["tracks"] | undefined;
  onFilter?: (next: TrackFilter) => void;
  registry: UnderlyingRegistry;
  error: boolean;
}) {
  const [state, setFilters] = useState<ExplorerFilters>({
    tab: "live",
    underlying: "all",
    track: "all",
    search: "",
    sort: "deadline",
  });
  const filters = { ...state, ...filter };
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
  const assets = [...new Set(tracks?.map((track) => track.asset) ?? [])];
  const durations = [...new Set(tracks ? [...tracks].sort((a, b) => a.period - b.period).map((track) => track.label) : [])];
  const change = (next: ExplorerFilters) => {
    setFilters(next);
    setLimit(PAGE);
  };
  return (
    <section aria-label="Market explorer">
      <div className="market-toolbar">
        <TrackFilterControls
          value={filter}
          assets={assets}
          durations={durations}
          onChange={(next) => { onFilter?.(next); setLimit(PAGE); }}
        />
        <MarketControls
          filters={filters}
          volumeAvailable={volumeAvailable}
          onChange={change}
        />
      </div>
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
