import Link from "next/link";
import { Countdown } from "@/components/market/countdown";
import { formatCents, formatDay, formatTime, formatPrice } from "@/lib/format";
import { buyPrice } from "@/lib/trade";
import {
  DEADLINE_LABEL,
  nextDeadline,
  PHASE_LABEL,
  isTradable,
} from "@/lib/phase";
import {
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
  return (
    <span className="market-identity">
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
  const price = market.quote ? buyPrice(market.quote, side) : null;
  const tradable =
    isTradable(market.phase) && !!market.quote?.tradable && price !== null;
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
