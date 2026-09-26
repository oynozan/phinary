"use client";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { usePriceHistory } from "@/lib/data";
import { formatPercent, formatPrice } from "@/lib/format";
import { isResolved, PHASE_LABEL } from "@/lib/phase";
import type { Market } from "@/lib/types";
import type { UnderlyingRegistry } from "@/lib/markets/explorer";
import { underlyingOf } from "@/lib/markets/explorer";
import { LiveSparkline } from "./live-sparkline";
import {
  MarketDeadline,
  MarketIdentity,
  PriceLink,
  SpotPrice,
} from "./market-presentation";

/** The newest live market, next upcoming, pending, then latest resolved market. */
export function pickFeatured(markets: Market[]): Market | null {
  const newest = [...markets].sort((a, b) => b.openTime - a.openTime);
  return (
    newest.find((m) => m.phase === "live") ??
    newest.findLast((m) => m.phase === "upcoming") ??
    newest.find((m) => !isResolved(m.phase)) ??
    newest[0] ??
    null
  );
}
export function FeaturedMarket({
  market,
  registry,
}: {
  market: Market | null | undefined;
  registry: UnderlyingRegistry;
}) {
  if (market === undefined)
    return (
      <div
        className="featured-market"
        aria-busy="true"
        aria-label="Loading featured market"
      >
        <Skeleton className="h-5 w-32" />
        <Skeleton className="mt-6 h-12 w-4/5" />
        <Skeleton className="mt-8 h-20 w-full" />
        <Skeleton className="mt-8 h-12 w-full" />
      </div>
    );
  if (market === null)
    return (
      <div className="featured-market featured-empty">No markets available</div>
    );
  return <FeaturedCard market={market} registry={registry} />;
}
function FeaturedCard({
  market: m,
  registry,
}: {
  market: Market;
  registry: UnderlyingRegistry;
}) {
  const history = usePriceHistory(m.id);
  const asset = underlyingOf(m, registry);
  return (
    <section className="featured-market" aria-label="Featured market">
      <Link
        className="featured-cover"
        href={`/market/${m.id}`}
        aria-label={`View featured market ${m.id}`}
      />
      <h2>
        <MarketIdentity market={m} registry={registry} />
      </h2>
      <div className="featured-chart">
        <div className="featured-history">
          {history.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : history.data && history.data.length > 1 ? (
            <LiveSparkline
              points={history.data}
              from={m.openTime}
              to={m.cutoff}
              live={m.phase === "live"}
              className="h-20 w-full"
            />
          ) : (
            <span className="history-unavailable">History unavailable</span>
          )}
        </div>
        <div className="featured-chance">
          <span>Chance UP</span>
          <strong>
            {m.upChance === null ? "N/A" : formatPercent(m.upChance)}
          </strong>
        </div>
      </div>
      <div className="featured-stats">
        <div>
          <span>{asset.symbol} Spot</span>
          <strong>
            <SpotPrice market={m} />
          </strong>
        </div>
        <div>
          <span>Strike</span>
          <strong>{formatPrice(m.strike)}</strong>
        </div>
        <div>
          <span>
            {m.phase === "live" ? "Trading closes in" : PHASE_LABEL[m.phase]}
          </span>
          <strong>
            <MarketDeadline market={m} />
          </strong>
        </div>
      </div>
      <div className="featured-actions">
        <PriceLink market={m} side="up" featured />
        <PriceLink market={m} side="down" featured />
      </div>
    </section>
  );
}
