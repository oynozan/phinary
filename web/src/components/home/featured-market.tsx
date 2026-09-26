"use client";

import Link from "next/link";
import { motion } from "motion/react";

import { Chance, MarketQuestion, ProbabilityBar } from "@/components/market";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useEthPrice, usePriceHistory } from "@/lib/data";
import { formatCents, formatPrice } from "@/lib/format";
import { isResolved, isTradable, PHASE_LABEL } from "@/lib/phase";
import type { Market, Side } from "@/lib/types";
import { cn } from "@/lib/utils";

import { CountdownRing } from "./countdown-ring";
import { LiveSparkline } from "./live-sparkline";

/** The newest live market, else the next to open, else the newest still settling, else the newest. */
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

const CARD = "relative mx-auto w-full max-w-[36rem] overflow-hidden rounded-3xl border bg-surface";
const TOP = "px-5 pt-6 pb-9 text-center sm:px-7 sm:pt-7";
const BOTTOM = "relative border-t bg-surface-2 px-5 pt-11 pb-5 sm:px-7 sm:pb-7";
const BUY =
    "h-14 w-full gap-2.5 border-0 text-base font-semibold text-background hover:brightness-110 disabled:bg-surface-3 disabled:text-muted-foreground disabled:opacity-100 sm:text-lg";
const BUY_FILL: Record<Side, string> = { up: "bg-up hover:bg-up", down: "bg-down hover:bg-down" };

export function FeaturedMarket({ market }: { market: Market | null | undefined }) {
    if (market === undefined) return <FeaturedSkeleton />;
    if (market === null) return null;
    return <FeaturedCard market={market} />;
}

function FeaturedCard({ market: m }: { market: Market }) {
    const history = usePriceHistory(m.id);
    const tradable = isTradable(m.phase) && !!m.quote?.tradable;
    const href = `/market/${m.id}`;

    return (
        <section aria-label="Featured market" className={CARD}>
            <motion.div
                key={m.id}
                initial={{ y: 6 }}
                animate={{ y: 0 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
            >
                <div className={TOP}>
                    <Link
                        href={href}
                        className="-mx-2 block rounded-xl px-2 transition-colors outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                        <MarketQuestion as="h2" strike={m.strike} expiry={m.expiry} className="text-2xl sm:text-3xl" />
                    </Link>
                    <EthSpot strike={m.strike} />
                    {isResolved(m.phase) && <p className="mt-2 text-muted-foreground">{PHASE_LABEL[m.phase]}</p>}

                    <div className="mt-6 flex items-end gap-5 sm:gap-8">
                        <Chance value={m.upChance} className="text-6xl sm:text-7xl" />
                        <LiveSparkline
                            points={history.data ?? []}
                            from={m.openTime}
                            to={m.cutoff}
                            live={m.phase === "live"}
                            className="mb-1 h-12 min-w-0 flex-1 sm:h-14"
                        />
                    </div>
                </div>

                <div className={BOTTOM}>
                    <CountdownRing market={m} className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                    <ProbabilityBar up={m.upChance} />
                    <div className="mt-6 grid grid-cols-2 gap-3">
                        <BuyButton market={m} side="up" tradable={tradable} />
                        <BuyButton market={m} side="down" tradable={tradable} />
                    </div>
                </div>
            </motion.div>
        </section>
    );
}

function BuyButton({ market, side, tradable }: { market: Market; side: Side; tradable: boolean }) {
    const q = market.quote;
    const price = q ? (side === "up" ? q.askUp : q.askDown) : null;
    const className = cn(BUY, BUY_FILL[side]);
    const label = (
        <>
            Buy {side === "up" ? "UP" : "DOWN"}
            {price !== null && <span className="font-medium num">{formatCents(price)}</span>}
        </>
    );

    if (!tradable) {
        return (
            <Button variant={side} className={className} disabled>
                {label}
            </Button>
        );
    }
    return (
        <Button variant={side} className={className} asChild>
            <Link href={`/market/${market.id}?side=${side}`}>{label}</Link>
        </Button>
    );
}

function EthSpot({ strike }: { strike: number }) {
    const eth = useEthPrice();
    if (eth.error) return <p className="mt-2 text-sm text-muted-foreground">ETH price unavailable</p>;
    if (!eth.data) return <Skeleton className="mx-auto mt-2 h-5 w-32 rounded-full" />;
    const above = eth.data.price > strike;
    return (
        <p className="mt-2 flex items-center justify-center gap-1.5 font-secondary text-sm text-muted-foreground num">
            ETH
            <span className="font-semibold text-foreground">{formatPrice(eth.data.price)}</span>
            <span aria-hidden className={cn("text-[0.65rem]", above ? "text-up" : "text-down")}>
                {above ? "▲" : "▼"}
            </span>
            <span className="sr-only">{above ? "above strike" : "below strike"}</span>
        </p>
    );
}

function FeaturedSkeleton() {
    return (
        <div className={CARD} aria-busy>
            <div className={TOP}>
                <Skeleton className="mx-auto h-8 w-4/5 sm:h-9" />
                <Skeleton className="mx-auto mt-2 h-5 w-32 rounded-full" />
                <div className="mt-6 flex items-end gap-5 sm:gap-8">
                    <Skeleton className="h-15 w-40 sm:h-18" />
                    <Skeleton className="mb-1 h-12 flex-1 sm:h-14" />
                </div>
            </div>
            <div className={BOTTOM}>
                <Skeleton className="h-2 w-full rounded-full" />
                <div className="mt-6 grid grid-cols-2 gap-3">
                    <Skeleton className="h-14 rounded-full" />
                    <Skeleton className="h-14 rounded-full" />
                </div>
            </div>
        </div>
    );
}
