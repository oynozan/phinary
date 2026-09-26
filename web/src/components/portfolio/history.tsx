"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowDownLeft, ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, CircleDollarSign, type LucideIcon } from "lucide-react";

import { Panel } from "@/components/layout/panel";
import { MarketQuestion, PriceTag } from "@/components/market";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCents, formatDay, formatTimeSeconds, formatTokens, formatUsd, tokenTicker } from "@/lib/format";
import type { Market, Side, Trade } from "@/lib/types";
import { cn } from "@/lib/utils";

import { TxLink } from "./bits";

const PAGE = 20;

type Kind = "buy" | "sell" | "claim" | "received" | "sent";

const KIND: Record<Kind, { label: string; icon: LucideIcon }> = {
    buy: { label: "Buy", icon: ArrowDownLeft },
    sell: { label: "Sell", icon: ArrowUpRight },
    claim: { label: "Claim", icon: CircleDollarSign },
    received: { label: "Received", icon: ArrowDownToLine },
    sent: { label: "Sent", icon: ArrowUpFromLine },
};

/** One history line. Transfers ("received" / "sent") move tokens without USDC. */
export interface HistoryRow {
    id: string;
    kind: Kind;
    marketId: number;
    side: Side;
    /** signed token delta */
    tokens: number;
    /** signed USDC delta, null for transfers */
    usdc: number | null;
    price: number | null;
    time: number;
    txHash: string;
}

export function toHistoryRows(trades: Trade[]): HistoryRow[] {
    return trades.map((t) => ({
        id: t.id,
        kind: t.kind === "claim" ? "claim" : t.isBuy ? "buy" : "sell",
        marketId: t.marketId,
        side: t.side,
        tokens: t.isBuy ? t.qty : -t.qty,
        usdc: t.isBuy ? -t.usdc : t.usdc,
        price: t.price,
        time: t.time,
        txHash: t.txHash,
    }));
}

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${formatTokens(Math.abs(n))}`;

function KindLabel({ kind }: { kind: Kind }) {
    const { label, icon: Icon } = KIND[kind];
    return (
        <span className="inline-flex items-center gap-2 font-medium">
            <span className="grid size-7 place-items-center rounded-full bg-primary-soft text-primary">
                <Icon aria-hidden className="size-3.5" />
            </span>
            {label}
        </span>
    );
}

function Question({ market, className }: { market: Market | undefined; className?: string }) {
    if (!market) return <span className="text-muted-foreground">-</span>;
    return (
        <Link
            href={`/market/${market.id}`}
            className={cn(
                "rounded-sm outline-none transition-colors hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-ring",
                className,
            )}
        >
            <MarketQuestion strike={market.strike} expiry={market.expiry} as="span" />
        </Link>
    );
}

function Usdc({ value, className }: { value: number | null; className?: string }) {
    if (value === null) return <span className={cn("text-muted-foreground", className)}>-</span>;
    return (
        <span className={cn("num", value > 0 && "text-foreground", value < 0 && "text-muted-foreground", className)}>{formatUsd(value, { signed: true })}</span>
    );
}

function Time({ unix, className }: { unix: number; className?: string }) {
    return (
        <time
            dateTime={new Date(unix * 1000).toISOString()}
            title={`${formatDay(unix)} ${formatTimeSeconds(unix)} UTC`}
            className={cn("num font-secondary", className)}
        >
            {formatTimeSeconds(unix)}
        </time>
    );
}

/** Trades, claims and transfers, newest first. */
export function HistoryTable({ rows, markets }: { rows: HistoryRow[]; markets: Map<number, Market> }) {
    const [shown, setShown] = useState(PAGE);
    const visible = rows.slice(0, shown);
    const more = rows.length > shown;
    const num = "num font-secondary text-sm";

    return (
        <>
            <Panel flush className="hidden overflow-hidden lg:block">
                <Table>
                    <TableHeader>
                        <TableRow className="bg-surface-2 hover:bg-surface-2">
                            {["Time", "Action", "Market", "Side", "Tokens", "Price", "USDC", "Transaction"].map((h, i) => (
                                <TableHead
                                    key={h}
                                    scope="col"
                                    className={cn(
                                        "h-11 px-4 font-secondary text-xs font-medium text-muted-foreground",
                                        i === 0 && "pl-6",
                                        i === 7 && "pr-6",
                                        i > 3 && "text-right",
                                    )}
                                >
                                    {h}
                                </TableHead>
                            ))}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {visible.map((r) => (
                            <TableRow key={r.id} className="hover:bg-surface-2">
                                <TableCell className="py-3.5 pl-6 text-sm text-muted-foreground">
                                    <Time unix={r.time} />
                                </TableCell>
                                <TableCell className="px-4 text-sm">
                                    <KindLabel kind={r.kind} />
                                </TableCell>
                                <TableCell className="px-4 text-sm">
                                    <Question market={markets.get(r.marketId)} />
                                </TableCell>
                                <TableCell className="px-4">
                                    <PriceTag side={r.side} className="h-6 px-2.5 text-[11px]" />
                                </TableCell>
                                <TableCell className={cn(num, "px-4 text-right")}>
                                    {signed(r.tokens)} <span className="text-xs text-muted-foreground">{tokenTicker(r.side)}</span>
                                </TableCell>
                                <TableCell className={cn(num, "px-4 text-right text-muted-foreground")}>
                                    {r.price === null ? "-" : r.kind === "claim" ? formatUsd(r.price) : formatCents(r.price, 1)}
                                </TableCell>
                                <TableCell className={cn(num, "px-4 text-right font-semibold")}>
                                    <Usdc value={r.usdc} />
                                </TableCell>
                                <TableCell className="pr-6 text-right">
                                    <TxLink hash={r.txHash} />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </Panel>
            <ul className="grid gap-3 md:grid-cols-2 lg:hidden">
                {visible.map((r) => (
                    <li key={r.id} className="rounded-3xl border bg-surface p-4">
                        <div className="flex items-center justify-between gap-3 text-sm">
                            <KindLabel kind={r.kind} />
                            <Usdc value={r.usdc} className="font-secondary text-base font-semibold" />
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-3">
                            <Question market={markets.get(r.marketId)} className="min-w-0 text-sm" />
                            <PriceTag side={r.side} className="h-6 shrink-0 px-2.5 text-[11px]" />
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
                            <span className="num flex items-center gap-2 font-secondary">
                                <Time unix={r.time} />
                                <span aria-hidden>·</span>
                                <span>
                                    {signed(r.tokens)} {tokenTicker(r.side)}
                                </span>
                            </span>
                            <TxLink hash={r.txHash} />
                        </div>
                    </li>
                ))}
            </ul>

            {more && (
                <div className="mt-5 flex justify-center">
                    <Button variant="outline" onClick={() => setShown((n) => n + PAGE)}>
                        Load more
                    </Button>
                </div>
            )}
        </>
    );
}
