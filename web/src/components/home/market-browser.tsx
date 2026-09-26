"use client";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  selectMarkets,
  hasVolume,
  type ExplorerFilters,
  type UnderlyingRegistry,
} from "@/lib/markets/explorer";
import type { Market } from "@/lib/types";
import { MarketControls } from "./market-controls";
import { MarketTable } from "./market-table";
const PAGE = 12;
export function MarketBrowser({
  markets,
  registry,
  ethSpot,
  error,
}: {
  markets: Market[] | undefined;
  registry: UnderlyingRegistry;
  ethSpot?: number;
  error: boolean;
}) {
  const [filters, setFilters] = useState<ExplorerFilters>({
    tab: "live",
    underlying: "all",
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
  const assets = [...new Set(Object.values(registry).map((a) => a.symbol))];
  return (
    <section aria-label="Market explorer">
      <MarketControls
        filters={filters}
        assets={assets}
        volumeAvailable={volumeAvailable}
        onChange={(next) => {
          setFilters(next);
          setLimit(PAGE);
        }}
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
            {filters.search || filters.underlying !== "all"
              ? "No markets match your filters."
              : `No ${filters.tab} markets${filters.tab === "resolved" ? " yet" : ""}.`}
          </p>
          {(filters.search || filters.underlying !== "all") && (
            <button
              type="button"
              onClick={() => {
                setFilters({ ...filters, search: "", underlying: "all" });
                setLimit(PAGE);
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <MarketTable
          markets={list.slice(0, limit)}
          tab={filters.tab}
          registry={registry}
          ethSpot={ethSpot}
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
