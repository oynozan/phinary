"use client";
import { LockKeyhole, Droplets, Zap } from "lucide-react";
import { MarketRefreshNotice, QueryError } from "@/components/market/query-error";
import { useMarkets, useTracks } from "@/lib/data";
import type { UnderlyingRegistry } from "@/lib/markets/explorer";
import { FeaturedMarket, pickFeatured } from "./featured-market";
import { MarketBrowser } from "./market-browser";

export function MarketsHome() {
  const { data: markets, error } = useMarkets();
  const { data: tracks } = useTracks();
  // Every market carries its own asset, so no oracle needs a fallback name
  const registry: UnderlyingRegistry = {};
  return (
    <div className="markets-page">
      <div className="markets-container">
        <div className="markets-hero">
          <div className="markets-intro">
            <p className="hero-eyebrow">Binary options. Fully onchain.</p>
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
              market={markets ? pickFeatured(markets) : undefined}
              registry={registry}
            />
          )}
        </div>
        <div className="markets-section-heading">
          <div>
            <h2>Markets</h2>
            <p>Explore onchain markets.</p>
          </div>
          <div><span className="network-note">
            <i />
            Unichain Sepolia
          </span><MarketRefreshNotice stale={!!error && !!markets} /></div>
        </div>
        <MarketBrowser
          markets={markets}
          tracks={tracks}
          registry={registry}
          error={!!error && !markets}
        />
      </div>
    </div>
  );
}
