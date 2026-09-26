"use client";
import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { LockKeyhole, Droplets, Zap } from "lucide-react";
import { DotGrid } from "@/components/backgrounds/dot-grid";
import { MarketRefreshNotice, QueryError } from "@/components/market/query-error";
import { useMarkets, useTracks } from "@/lib/data";
import {
  ALL_TRACKS,
  matchesTrack,
  trackFilterFrom,
  trackFilterHref,
  type TrackFilter as TrackFilterValue,
  type UnderlyingRegistry,
} from "@/lib/markets/explorer";
import { rememberMarketsHref } from "@/lib/markets/home-href";
import { FeaturedMarket, pickFeatured } from "./featured-market";
import { MarketBrowser } from "./market-browser";
import { TrackFilter } from "./market-controls";

// Every market carries its own asset, so no oracle needs a fallback name
const registry: UnderlyingRegistry = {};

export function MarketsHome() {
  return (
    <div className="markets-page">
      <DotGrid />
      <div className="markets-container">
        <div className="markets-hero">
          <h1>
            Trade what’s next
            <br />
            <span>on Uniswap v4.</span>
          </h1>
          <p className="hero-description">
            Binary options on assets priced directly from Uniswap markets.
          </p>
          <div className="hero-proofs">
            <div>
              <Zap />
              <span>No external oracle</span>
            </div>
            <div>
              <Droplets />
              <span>Only on Uniswap v4</span>
            </div>
            <div>
              <LockKeyhole />
              <span>Fully onchain</span>
            </div>
          </div>
        </div>
        <Suspense fallback={<MarketsBoard filter={ALL_TRACKS} />}>
          <MarketsBoardFromUrl />
        </Suspense>
      </div>
    </div>
  );
}

/** ?asset=eth|sol&track=1m|15m drives the featured market and the list */
function MarketsBoardFromUrl() {
  const filter = trackFilterFrom(useSearchParams());
  const href = trackFilterHref(filter);
  useEffect(() => rememberMarketsHref(href), [href]);
  return (
    <MarketsBoard
      filter={filter}
      onFilter={(next) => window.history.replaceState(null, "", trackFilterHref(next))}
    />
  );
}

function MarketsBoard({
  filter,
  onFilter,
}: {
  filter: TrackFilterValue;
  onFilter?: (next: TrackFilterValue) => void;
}) {
  const { data: markets, error } = useMarkets();
  const { data: tracks } = useTracks();
  const assets = [...new Set(tracks?.map((t) => t.asset) ?? [])];
  const durations = [
    ...new Set(
      tracks
        ? [...tracks].sort((a, b) => a.period - b.period).map((t) => t.label)
        : [],
    ),
  ];
  const featured = markets
    ? pickFeatured(markets.filter((m) => matchesTrack(m, filter, registry)))
    : undefined;
  return (
    <>
      <div className="markets-feature">
        <TrackFilter
          value={filter}
          assets={assets}
          durations={durations}
          onChange={(next) => onFilter?.(next)}
        />
        {error && !markets ? (
          <div className="featured-market">
            <QueryError />
          </div>
        ) : (
          <FeaturedMarket market={featured} registry={registry} />
        )}
      </div>
      <div className="markets-section-heading">
        <h2>Markets</h2>
        <MarketRefreshNotice stale={!!error && !!markets} />
      </div>
      <MarketBrowser
        markets={markets}
        filter={filter}
        registry={registry}
        error={!!error && !markets}
      />
    </>
  );
}
