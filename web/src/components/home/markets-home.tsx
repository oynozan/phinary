"use client";
import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { ALL_TRACKS, matchesTrack, trackFilterFrom, trackFilterHref, type TrackFilter } from "@/lib/markets/explorer";
import { rememberMarketsHref } from "@/lib/markets/home-href";
import { LockKeyhole, Droplets, Zap } from "lucide-react";
import { MarketRefreshNotice, QueryError } from "@/components/market/query-error";
import { useMarkets, useTracks } from "@/lib/data";
import type { UnderlyingRegistry } from "@/lib/markets/explorer";
import { FeaturedMarket, pickFeatured } from "./featured-market";
import { MarketBrowser } from "./market-browser";

export function MarketsHome() {
  return <Suspense fallback={<MarketsBoard filter={ALL_TRACKS} />}><MarketsBoardFromUrl /></Suspense>;
}

function MarketsBoardFromUrl() {
  const filter = trackFilterFrom(useSearchParams());
  const href = trackFilterHref(filter);
  useEffect(() => rememberMarketsHref(href), [href]);
  return <MarketsBoard filter={filter} onFilter={(next) => window.history.replaceState(null, "", trackFilterHref(next))} />;
}

function MarketsBoard({ filter, onFilter }: { filter: TrackFilter; onFilter?: (next: TrackFilter) => void }) {
  const { data: markets, error } = useMarkets();
  const { data: tracks } = useTracks();
  // Every market carries its own asset, so no oracle needs a fallback name
  const registry: UnderlyingRegistry = {};
  return (
    <div className="markets-page">
      <div className="markets-container">
        <div className="markets-hero">
          <div className="markets-intro">
            <h1>
              Trade what’s next
              <br />
              <span>on Uniswap v4.</span>
            </h1>
            <p className="hero-description">
              Binary options on assets priced directly
              <br className="hidden xl:block" /> from Uniswap markets.
            </p>
            <div className="hero-proofs">
              <div>
                <Zap />
                <span>No external oracle</span>
              </div>
              <div>
                <Droplets />
                <span>Built on Uniswap v4</span>
              </div>
              <div>
                <LockKeyhole />
                <span>Fully onchain</span>
              </div>
            </div>
          </div>
          {error && !markets ? (
            <div className="featured-market">
              <QueryError />
            </div>
          ) : (
            <FeaturedMarket
              market={markets ? pickFeatured(markets.filter((market) => matchesTrack(market, filter, registry))) : undefined}
              registry={registry}
            />
          )}
        </div>
        <div className="markets-section-heading">
          <h2>Markets</h2>
          <MarketRefreshNotice stale={!!error && !!markets} />
        </div>
        <MarketBrowser
          markets={markets}
          tracks={tracks}
          filter={filter}
          onFilter={onFilter}
          registry={registry}
          error={!!error && !markets}
        />
      </div>
    </div>
  );
}
