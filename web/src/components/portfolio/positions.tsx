"use client";

import Link from "next/link";
import { Clock, LoaderCircle } from "lucide-react";

import { Panel } from "@/components/layout/panel";
import { Countdown, isFlat, MarketQuestion, PriceTag, Profit, SideMark } from "@/components/market";
import type { Claims } from "@/components/trade/use-claims";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCents, formatPercent, formatTokens, formatUsd, marketQuestion, sideLabel } from "@/lib/format";
import { isTradable, nextDeadline } from "@/lib/phase";
import type { Position } from "@/lib/types";
import { cn } from "@/lib/utils";

export const positionKey = (p: Pick<Position, "marketId" | "side">) => `${p.marketId}:${p.side}`;

const num = "num font-secondary text-sm";

/** Resolved markets pay a whole-dollar amount, live ones trade in cents. */
function formatMark(p: Position) {
    return p.state === "claimable" || p.state === "lost" ? formatUsd(p.mark) : formatCents(p.mark);
}

function Action({ position: p, claims, onSell }: { position: Position; claims: Claims; onSell: (p: Position) => void }) {
    const what = `${sideLabel(p.side)} in ${marketQuestion(p.market.strike, p.market.expiry)}`;

    if (p.state === "claimable") {
        const mine = claims.claiming === p.marketId;
        return (
            <Button
                size="sm"
                className="min-w-20 font-semibold"
                disabled={claims.busy}
                aria-label={`Claim ${what}`}
                onClick={() => claims.claimOne(p.marketId)}
            >
                {mine && <LoaderCircle aria-hidden className="animate-spin" />}
                Claim
            </Button>
        );
    }
    if (p.state === "open" && isTradable(p.market.phase)) {
        return (
            <Button variant="outline" size="sm" className="min-w-20" aria-label={`Sell ${what}`} onClick={() => onSell(p)}>
                Sell
            </Button>
        );
    }
    const deadline = nextDeadline(p.market, p.market.phase);
    if ((p.state === "pending" || p.state === "open") && deadline !== null) {
        return (
            <span className="inline-flex h-8 items-center gap-1.5 px-1 text-sm text-muted-foreground">
                <Clock aria-hidden className="size-3.5" />
                <span className="sr-only">Next phase in</span>
                <Countdown to={deadline} />
            </span>
        );
    }
    return null;
}

function MarketCell({ position: p, withSide = false }: { position: Position; withSide?: boolean }) {
    const m = p.market;
    const deadline = nextDeadline(m, m.phase);
    const live = m.phase === "live" && deadline !== null;
    return (
        <div className="min-w-0">
            <Link
                href={`/market/${m.id}`}
                className="rounded-sm outline-none transition-colors hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
                <MarketQuestion strike={m.strike} expiry={m.expiry} as="span" className="text-base" />
            </Link>
            {(withSide || live) && (
                <div className="mt-1 flex flex-wrap items-center gap-3 font-secondary text-xs">
                    {withSide && <SideMark side={p.side} />}
                    {live && (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Clock aria-hidden className="size-3" />
                            <span className="sr-only">Trading closes in</span>
                            <Countdown to={deadline} />
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

function ProfitCell({ position: p, align = "end" }: { position: Position; align?: "start" | "end" }) {
    const pct = !isFlat(p.cost) ? p.pnl / p.cost : 0;
    return (
        <div className={cn("flex flex-col gap-0.5", align === "end" ? "items-end" : "items-start")}>
            <Profit value={p.pnl} className="font-secondary text-sm font-semibold" />
            <span className="num font-secondary text-[11px] text-muted-foreground">
                {pct > 0 ? "+" : ""}
                {formatPercent(pct)}
            </span>
        </div>
    );
}

/** Table from lg, stacked cards below. */
export function PositionsTable({ positions, claims, onSell }: { positions: Position[]; claims: Claims; onSell: (p: Position) => void }) {
    return (
        <>
            <Panel flush className="hidden overflow-hidden lg:block">
                <Table>
                    <TableHeader>
                        <TableRow className="bg-surface-2 hover:bg-surface-2">
                            {["Market", "Side", "Tokens", "Avg cost", "Bid", "Value", "Profit"].map((h, i) => (
                                <TableHead
                                    key={h}
                                    scope="col"
                                    className={cn(
                                        "h-11 font-secondary text-xs font-medium text-muted-foreground",
                                        i === 0 ? "pl-6" : "px-4",
                                        i > 1 && "text-right",
                                    )}
                                >
                                    {h}
                                </TableHead>
                            ))}
                            <TableHead scope="col" className="h-11 pr-6 text-right">
                                <span className="sr-only">Action</span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {positions.map((p) => (
                            <TableRow key={positionKey(p)} className={cn("hover:bg-surface-2", p.state === "lost" && "opacity-55")}>
                                <TableCell className="py-4 pl-6">
                                    <MarketCell position={p} />
                                </TableCell>
                                <TableCell className="px-4">
                                    <PriceTag side={p.side} />
                                </TableCell>
                                <TableCell className={cn(num, "px-4 text-right")}>{formatTokens(p.qty)}</TableCell>
                                <TableCell className={cn(num, "px-4 text-right text-muted-foreground")}>{formatCents(p.avgPrice)}</TableCell>
                                <TableCell className={cn(num, "px-4 text-right")}>{formatMark(p)}</TableCell>
                                <TableCell className={cn(num, "px-4 text-right font-semibold")}>{formatUsd(p.value)}</TableCell>
                                <TableCell className="px-4 text-right">
                                    <ProfitCell position={p} />
                                </TableCell>
                                <TableCell className="w-32 pr-6 text-right">
                                    <Action position={p} claims={claims} onSell={onSell} />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </Panel>

            <ul className="grid gap-3 md:grid-cols-2 lg:hidden">
                {positions.map((p) => (
                    <li key={positionKey(p)} className={cn("rounded-3xl border bg-surface p-4 sm:p-5", p.state === "lost" && "opacity-60")}>
                        <MarketCell position={p} withSide />
                        <dl className="mt-4 grid grid-cols-4 gap-2 rounded-2xl border bg-surface-2 px-3 py-2.5">
                            {[
                                ["Tokens", formatTokens(p.qty)],
                                ["Avg", formatCents(p.avgPrice)],
                                ["Bid", formatMark(p)],
                                ["Value", formatUsd(p.value)],
                            ].map(([k, v]) => (
                                <div key={k} className="min-w-0">
                                    <dt className="font-secondary text-[11px] text-muted-foreground">{k}</dt>
                                    <dd className="num mt-0.5 truncate font-secondary text-sm font-semibold">{v}</dd>
                                </div>
                            ))}
                        </dl>
                        <div className="mt-4 flex items-center justify-between gap-3">
                            <ProfitCell position={p} align="start" />
                            <Action position={p} claims={claims} onSell={onSell} />
                        </div>
                    </li>
                ))}
            </ul>
        </>
    );
}

export function PositionsSkeleton() {
    return (
        <Panel flush aria-hidden className="overflow-hidden">
            <div className="h-11 border-b bg-surface-2" />
            {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-4 border-b px-6 py-5 last:border-0">
                    <Skeleton className="size-10 rounded-full" />
                    <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-56 max-w-full" />
                        <Skeleton className="h-3 w-24" />
                    </div>
                    <Skeleton className="hidden h-4 w-64 sm:block" />
                    <Skeleton className="h-8 w-20 rounded-full" />
                </div>
            ))}
        </Panel>
    );
}
