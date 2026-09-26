"use client";

import Link from "next/link";
import { Clock } from "lucide-react";

import { Panel } from "@/components/layout/panel";
import { Button } from "@/components/ui/button";
import { usePriceHistory } from "@/lib/data";
import { formatCents, formatPrice, formatUsd, sideLabel } from "@/lib/format";
import { buyPrice } from "@/lib/trade";
import { DEADLINE_LABEL, isResolved, isTradable, nextDeadline } from "@/lib/phase";
import type { Market, Side } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Chance } from "./chance";
import { Countdown } from "./countdown";
import { MarketQuestion } from "./market-question";
import { ProbabilityBar } from "./probability-bar";
import { Sparkline } from "./sparkline";

const ROW = "flex h-11 items-center justify-between rounded-full border bg-surface-2 px-5 font-secondary text-sm";

function Winner({ market }: { market: Market }) {
    if (market.phase === "invalid") {
        return (
            <span className="flex items-baseline gap-2 font-heading text-4xl leading-none font-medium text-muted-foreground">
                <span className="num">{formatCents(0.5)}</span>
                <span aria-hidden className="font-secondary text-sm font-bold">
                    ▲ ▼
                </span>
            </span>
        );
    }
    const side: Side = market.phase === "resolved-up" ? "up" : "down";
    return (
        <span className={cn("flex items-baseline gap-2 font-heading text-4xl leading-none font-medium", side === "up" ? "text-up" : "text-down")}>
            <span aria-hidden className="text-2xl">
                {side === "up" ? "▲" : "▼"}
            </span>
            {sideLabel(side)}
        </span>
    );
}

function Settlement({ market }: { market: Market }) {
    const avg = market.settlementPrice;
    const diff = avg !== null ? avg - market.strike : null;
    return (
        <div className={ROW}>
            <span className="text-muted-foreground">{market.phase === "invalid" ? "Invalid" : "Settled"}</span>
            <span className="num flex items-baseline gap-2">
                <span className="font-semibold">{avg !== null ? formatPrice(avg) : "-"}</span>
                {diff !== null && (
                    <span className={cn("text-xs font-semibold", diff > 0 ? "text-up" : "text-down")}>{formatUsd(diff, { signed: true })}</span>
                )}
            </span>
        </div>
    );
}

function Waiting({ market }: { market: Market }) {
    const deadline = nextDeadline(market, market.phase);
    return (
        <div className={ROW}>
            <span className="text-muted-foreground">{market.phase === "awaiting" ? "Settling" : DEADLINE_LABEL[market.phase]}</span>
            {deadline !== null && <Countdown to={deadline} className="font-semibold" />}
        </div>
    );
}

/** Market summary card: question, UP chance or winner, then Buy UP / DOWN, a countdown row, or the settlement average. No phase pill: the countdown carries status */
export function MarketCard({ market, onBuy, className }: { market: Market; onBuy?: (side: Side) => void; className?: string }) {
    const history = usePriceHistory(market.id);
    const spark = (history.data ?? []).map((p) => p.mid);
    const deadline = nextDeadline(market, market.phase);
    const resolved = isResolved(market.phase);
    const tradable = isTradable(market.phase) && !!market.quote?.tradable;
    const href = `/market/${market.id}`;

    const buy = (side: Side) => {
        const q = market.quote;
        const price = q ? buyPrice(q, side) : null;
        const label = (
            <>
                Buy {sideLabel(side)}
                {price !== null && <span className="num opacity-80">{formatCents(price)}</span>}
            </>
        );
        const cls = "h-11 w-full text-sm font-semibold";
        if (onBuy) {
            return (
                <Button variant={side} className={cls} onClick={() => onBuy(side)}>
                    {label}
                </Button>
            );
        }
        return (
            <Button variant={side} className={cls} asChild>
                <Link href={`${href}?side=${side}`}>{label}</Link>
            </Button>
        );
    };

    return (
        <Panel className={cn("flex flex-col gap-5 transition-colors hover:border-border-strong", className)}>
            <Link
                href={href}
                className="-mx-2 rounded-xl px-2 transition-colors outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
            >
                <MarketQuestion asset={market.asset} strike={market.strike} expiry={market.expiry} className="text-xl sm:text-2xl" />
            </Link>

            <div className="flex items-end justify-between gap-4">
                {resolved ? <Winner market={market} /> : <Chance value={market.upChance} className="text-4xl" />}
                <Sparkline data={spark} className="h-10 w-28 text-foreground sm:w-32" />
            </div>

            <ProbabilityBar up={market.upChance} />

            {resolved ? (
                <Settlement market={market} />
            ) : tradable ? (
                <div className="grid grid-cols-2 gap-2">
                    {buy("up")}
                    {buy("down")}
                </div>
            ) : (
                <Waiting market={market} />
            )}

            <div className="flex items-center justify-between font-secondary text-xs text-muted-foreground">
                <span className="num">{market.volume === null ? "Volume unavailable" : `${formatUsd(market.volume, { compact: true })} vol`}</span>
                {tradable && deadline !== null && (
                    <span className="flex items-center gap-1.5 text-foreground">
                        <Clock aria-hidden className="size-3.5 text-muted-foreground" />
                        <span className="sr-only">{DEADLINE_LABEL[market.phase]}</span>
                        <Countdown to={deadline} className="font-semibold" />
                    </span>
                )}
                <span className="num">#{market.id}</span>
            </div>
        </Panel>
    );
}
