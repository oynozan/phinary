"use client";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePriceHistory } from "@/lib/data";
import {
  formatDay,
  formatTime,
  formatPercent,
  formatUsd,
  formatPrice,
} from "@/lib/format";
import { isTradable, type MarketTab } from "@/lib/phase";
import type { UnderlyingRegistry } from "@/lib/markets/explorer";
import type { Market } from "@/lib/types";
import { LiveSparkline } from "./live-sparkline";
import {
  MarketDeadline,
  MarketIdentity,
  PriceLink,
  SpotPrice,
} from "./market-presentation";

const COLUMNS: Record<MarketTab, string[]> = {
  live: [
    "Market",
    "Spot Price",
    "Chance UP",
    "UP Price",
    "DOWN Price",
    "Volume",
    "Ends In",
    "Action",
  ],
  upcoming: [
    "Market",
    "Spot Price",
    "Opens In",
    "Expires At",
    "Status",
    "Action",
  ],
  resolved: ["Market", "Result", "Settlement", "Volume", "Resolved", "Action"],
};
function Result({ market: m }: { market: Market }) {
  return (
    <span
      className={
        m.phase === "resolved-up"
          ? "up"
          : m.phase === "resolved-down"
            ? "down"
            : "market-muted"
      }
    >
      {m.phase === "resolved-up"
        ? "UP WON"
        : m.phase === "resolved-down"
          ? "DOWN WON"
          : "INVALID"}
    </span>
  );
}
function ChanceHistory({ market: m }: { market: Market }) {
  const history = usePriceHistory(m.id);
  return (
    <span className="chance-history">
      <strong>{m.upChance === null ? "N/A" : formatPercent(m.upChance)}</strong>
      {history.data && history.data.length > 1 ? (
        <LiveSparkline
          points={history.data}
          from={m.openTime}
          to={m.cutoff}
          live={m.phase === "live"}
          className="h-6 w-16"
        />
      ) : null}
    </span>
  );
}
function DateTime({ value }: { value: number | null }) {
  return value === null ? (
    <>N/A</>
  ) : (
    <time dateTime={new Date(value * 1000).toISOString()}>
      {formatDay(value)} · {formatTime(value)} UTC
    </time>
  );
}
function Action({ market: m }: { market: Market }) {
  return (
    <Link
      className="market-row-action"
      href={`/market/${m.id}`}
      aria-label={`${isTradable(m.phase) && m.quote?.tradable ? "Trade" : "View"} market ${m.id}`}
    >
      {isTradable(m.phase) && m.quote?.tradable ? "Trade" : "View"}
    </Link>
  );
}
export function MarketTable({
  markets,
  tab,
  registry,
}: {
  markets: Market[];
  tab: MarketTab;
  registry: UnderlyingRegistry;
}) {
  return (
    <>
      <div className="market-table-desktop">
        <Table className="market-table">
          <caption className="sr-only">{tab} markets, all times UTC</caption>
          <TableHeader>
            <TableRow>
              {COLUMNS[tab].map((c) => (
                <TableHead key={c} scope="col">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {markets.map((m) => (
              <TableRow key={m.id} className="market-row">
                <TableCell>
                  <Link className="market-row-cover" href={`/market/${m.id}`}>
                    <MarketIdentity market={m} registry={registry} />
                  </Link>
                </TableCell>
                {tab === "live" ? (
                  <>
                    <TableCell>
                      <SpotPrice market={m} />
                    </TableCell>
                    <TableCell>
                      <ChanceHistory market={m} />
                    </TableCell>
                    <TableCell>
                      <PriceLink market={m} side="up" />
                    </TableCell>
                    <TableCell>
                      <PriceLink market={m} side="down" />
                    </TableCell>
                    <TableCell>
                      {m.volume === null
                        ? "N/A"
                        : formatUsd(m.volume, { compact: true })}
                    </TableCell>
                    <TableCell>
                      <MarketDeadline market={m} />
                    </TableCell>
                  </>
                ) : tab === "upcoming" ? (
                  <>
                    <TableCell>
                      <SpotPrice market={m} />
                    </TableCell>
                    <TableCell>
                      <MarketDeadline market={m} />
                    </TableCell>
                    <TableCell>
                      <DateTime value={m.expiry} />
                    </TableCell>
                    <TableCell>
                      <span className="market-muted">Upcoming</span>
                    </TableCell>
                  </>
                ) : (
                  <>
                    <TableCell>
                      <Result market={m} />
                    </TableCell>
                    <TableCell>
                      {m.settlementPrice === null
                        ? "N/A"
                        : formatPrice(m.settlementPrice)}
                    </TableCell>
                    <TableCell>
                      {m.volume === null
                        ? "N/A"
                        : formatUsd(m.volume, { compact: true })}
                    </TableCell>
                    <TableCell>
                      <DateTime value={m.settledAt} />
                    </TableCell>
                  </>
                )}
                <TableCell>
                  <Action market={m} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="market-list-mobile" aria-label={`${tab} markets`}>
        {markets.map((m) => (
          <li key={m.id} className="market-mobile-row">
            <Link className="market-row-cover" href={`/market/${m.id}`}>
              <MarketIdentity market={m} registry={registry} />
            </Link>
            <div className="mobile-row-details">
              {tab === "live" ? (
                <>
                  <span>
                    <small>Chance UP</small>
                    <ChanceHistory market={m} />
                  </span>
                  <span>
                    <small>UP Price</small>
                    <PriceLink market={m} side="up" />
                  </span>
                  <span>
                    <small>DOWN Price</small>
                    <PriceLink market={m} side="down" />
                  </span>
                </>
              ) : tab === "resolved" ? (
                <>
                  <span>
                    <small>Result</small>
                    <Result market={m} />
                  </span>
                  <span>
                    <small>Settlement</small>
                    {m.settlementPrice === null
                      ? "N/A"
                      : formatPrice(m.settlementPrice)}
                  </span>
                  <span>
                    <small>Volume</small>
                    {m.volume === null
                      ? "N/A"
                      : formatUsd(m.volume, { compact: true })}
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <small>Spot Price</small>
                    <SpotPrice market={m} />
                  </span>
                  <span>
                    <small>Expires At</small>
                    <DateTime value={m.expiry} />
                  </span>
                </>
              )}
            </div>
            <div className="mobile-row-footer">
              {tab === "resolved" ? (
                <span className="market-muted">
                  Resolved <DateTime value={m.settledAt} />
                </span>
              ) : (
                <MarketDeadline market={m} />
              )}
              <Action market={m} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
