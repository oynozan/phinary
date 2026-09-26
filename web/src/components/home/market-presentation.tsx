import Link from "next/link";
import { Countdown } from "@/components/market/countdown";
import { formatCents, formatDay, formatTime, formatPrice } from "@/lib/format";
import {
  DEADLINE_LABEL,
  nextDeadline,
  PHASE_LABEL,
  isTradable,
} from "@/lib/phase";
import {
  underlyingOf,
  questionOf,
  type UnderlyingRegistry,
} from "@/lib/markets/explorer";
import type { Market, Side } from "@/lib/types";

export function MarketIdentity({
  market,
  registry,
}: {
  market: Market;
  registry: UnderlyingRegistry;
}) {
  const asset = underlyingOf(market, registry);
  return (
    <span className="market-identity">
      <span className="asset-symbol" aria-hidden>
        {asset.symbol === "ETH" ? (
          <svg viewBox="0 0 24 32" fill="none">
            <path
              d="m12 1 11 17-11 6L1 18 12 1Z"
              fill="currentColor"
              opacity=".9"
            />
            <path d="M12 1v23l11-6L12 1Z" fill="#a49bfa" />
            <path d="m1 20 11 11 11-11-11 6-11-6Z" fill="currentColor" />
          </svg>
        ) : asset.symbol === "SOL" ? (
          <svg viewBox="0 0 24 20" fill="currentColor">
            <path d="M5 1h18l-4 4H1l4-4Z" />
            <path d="M1 8h18l4 4H5L1 8Z" fill="#a49bfa" />
            <path d="M5 15h18l-4 4H1l4-4Z" />
          </svg>
        ) : (
          "?"
        )}
      </span>
      <span>
        <span className="market-question">{questionOf(market, registry)}</span>
        <span className="market-date">
          {formatDay(market.expiry)}{" "}
          {new Date(market.expiry * 1000).getUTCFullYear()} ·{" "}
          {formatTime(market.expiry)} UTC
        </span>
      </span>
    </span>
  );
}
export function PriceLink({
  market,
  side,
  featured = false,
}: {
  market: Market;
  side: Side;
  featured?: boolean;
}) {
  const tradable = isTradable(market.phase) && !!market.quote?.tradable;
  const price = market.quote
    ? side === "up"
      ? market.quote.askUp
      : market.quote.askDown
    : null;
  const label = (
    <>
      {featured && <span>{side.toUpperCase()} </span>}
      {price === null ? "N/A" : formatCents(price)}
    </>
  );
  const className = `${featured ? "featured-price" : "market-price"} ${side}`;
  return tradable ? (
    <Link
      className={className}
      href={`/market/${market.id}?side=${side}`}
      aria-label={`${side.toUpperCase()} ${price === null ? "" : formatCents(price)}, market ${market.id}`}
    >
      {label}
    </Link>
  ) : (
    <span className={`${className} unavailable`} aria-disabled="true">
      {label}
    </span>
  );
}
export function MarketDeadline({ market }: { market: Market }) {
  const deadline = nextDeadline(market, market.phase);
  return (
    <span className="market-deadline">
      {deadline !== null ? (
        <>
          <Countdown to={deadline} />
          <small>{DEADLINE_LABEL[market.phase]}</small>
        </>
      ) : (
        PHASE_LABEL[market.phase]
      )}
    </span>
  );
}
export function SpotPrice({ market }: { market: Market }) {
  const price = market.quote?.spot ?? market.oracleSpot;
  return <>{price === null ? "N/A" : formatPrice(price)}</>;
}
