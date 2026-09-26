"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { Flag, Plus } from "lucide-react";

import { Panel } from "@/components/layout/panel";
import { PhaseBadge, PriceTag } from "@/components/market";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivity } from "@/lib/data";
import { formatAgo, formatCents, formatTokens, formatUsd, marketQuestion, shortAddress, sideLabel } from "@/lib/format";
import type { ActivityItem, Address, Market } from "@/lib/types";
import { cn } from "@/lib/utils";

import { LiveDot, Trader } from "./trader";

const PAGE = 20;
const MAX = 240;

const DESKTOP_COLS =
    "md:grid-cols-[7.5rem_8.75rem_minmax(0,1fr)_3.5rem_4rem_2.25rem] md:gap-x-2.5 md:[grid-template-areas:'trader_action_market_shares_total_time']";
const TRADE_ROW = cn("grid-cols-[minmax(0,1fr)_auto] [grid-template-areas:'trader_time'_'action_total'_'market_market']", DESKTOP_COLS);
const EVENT_ROW = cn("grid-cols-[auto_minmax(0,1fr)_auto] [grid-template-areas:'trader_action_time'_'market_market_market']", DESKTOP_COLS);

export function LiveFeed({ markets, now, you, className }: { markets: Map<number, Market> | null; now: number | null; you: Address | null; className?: string }) {
    const [limit, setLimit] = useState(PAGE);
    const activity = useActivity(limit);
    const items = activity.data;

    return (
        <Panel role="region" aria-labelledby="feed-heading" className={cn("p-3 sm:p-4", className)}>
            <div className="hidden items-center gap-2.5 px-3 pt-1 pb-4 xl:flex">
                <h2 id="feed-heading" className="text-xl">
                    Feed
                </h2>
                <LiveDot />
            </div>

            <div
                aria-hidden
                className={cn(
                    "hidden border-b border-border/60 px-3 pb-2 font-secondary text-[11px] text-muted-foreground md:grid",
                    DESKTOP_COLS,
                )}
            >
                <span className="[grid-area:trader]">Trader</span>
                <span className="[grid-area:action]">Trade</span>
                <span className="[grid-area:market]">Market</span>
                <span className="text-right [grid-area:shares]">Shares</span>
                <span className="text-right [grid-area:total]">Total</span>
                <span className="text-right [grid-area:time]">Time</span>
            </div>

            {!items || now === null ? (
                <FeedSkeleton />
            ) : items.length === 0 ? (
                <p className="py-12 text-center text-muted-foreground">No trades yet</p>
            ) : (
                <MotionConfig reducedMotion="user">
                    <ol className="md:divide-y md:divide-border/40">
                        <AnimatePresence initial={false}>
                            {items.map((item) => (
                                <motion.li
                                    key={item.id}
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: "auto", opacity: 1 }}
                                    transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                                    className="overflow-hidden"
                                >
                                    <FeedRow item={item} market={markets?.get(marketIdOf(item)) ?? null} now={now} you={you} />
                                </motion.li>
                            ))}
                        </AnimatePresence>
                    </ol>
                </MotionConfig>
            )}

            {items && items.length >= limit && limit < MAX && (
                <div className="mt-3 flex justify-center">
                    <button
                        type="button"
                        onClick={() => setLimit((l) => Math.min(MAX, l + PAGE))}
                        className="rounded-full border bg-background/60 px-4 py-1.5 text-xs font-medium transition-colors outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        Load more
                    </button>
                </div>
            )}
        </Panel>
    );
}

function marketIdOf(item: ActivityItem): number {
    return item.kind === "trade" ? item.trade.marketId : item.marketId;
}

function FeedRow({ item, market, now, you }: { item: ActivityItem; market: Market | null; now: number; you: Address | null }) {
    const id = marketIdOf(item);
    const question = market ? marketQuestion(market.strike, market.expiry) : `Market #${id}`;
    const ago = formatAgo(item.time, now);
    const time = (
        <time dateTime={new Date(item.time * 1000).toISOString()} className="num text-right font-secondary text-[11px] text-muted-foreground [grid-area:time]">
            {ago}
        </time>
    );
    const marketCell = <span className="truncate font-secondary text-xs text-muted-foreground [grid-area:market] md:text-foreground/80">{question}</span>;

    if (item.kind === "trade") {
        const t = item.trade;
        const isYou = !!you && t.account.toLowerCase() === you.toLowerCase();
        const who = isYou ? "You" : shortAddress(t.account);
        const label = `${who} ${t.isBuy ? "bought" : "sold"} ${formatTokens(t.qty)} ${sideLabel(t.side)} at ${formatCents(t.price, 1)} for ${formatUsd(t.usdc)}, ${question}, ${ago} ago`;
        return (
            <RowLink href={`/market/${id}`} label={label} className={cn(TRADE_ROW, isYou && "bg-primary/[0.07]")}>
                <Trader address={t.account} isYou={isYou} hideAddressForYou className="[grid-area:trader]" />
                <span className="flex min-w-0 items-center gap-2 [grid-area:action]">
                    <span className={cn("w-7 shrink-0 font-secondary text-xs font-semibold", t.isBuy ? "text-foreground" : "text-muted-foreground")}>
                        {t.isBuy ? "Buy" : "Sell"}
                    </span>
                    <PriceTag side={t.side} price={t.price} />
                </span>
                {marketCell}
                <span className="num hidden text-right font-secondary text-xs md:block md:[grid-area:shares]">{formatTokens(t.qty)}</span>
                <span className="num text-right font-secondary text-xs font-semibold [grid-area:total]">{formatUsd(t.usdc)}</span>
                {time}
            </RowLink>
        );
    }

    if (item.kind === "created") {
        return (
            <RowLink href={`/market/${id}`} label={`New market, ${question}, ${ago} ago`} className={EVENT_ROW}>
                <EventLabel icon={<Plus className="size-3" />} text="New market" />
                <span className="[grid-area:action]" />
                {marketCell}
                {time}
            </RowLink>
        );
    }

    const outcome = item.invalid ? "invalid" : item.upWon ? "up" : "down";
    return (
        <RowLink
            href={`/market/${id}`}
            label={`${question} resolved ${outcome === "invalid" ? "invalid" : outcome.toUpperCase()}, ${ago} ago`}
            className={EVENT_ROW}
        >
            <EventLabel icon={<Flag className="size-3" />} text="Resolved" />
            <span className="flex min-w-0 items-center [grid-area:action]">
                <OutcomePill outcome={outcome} />
            </span>
            {marketCell}
            {time}
        </RowLink>
    );
}

function RowLink({ href, label, className, children }: { href: string; label: string; className?: string; children: React.ReactNode }) {
    return (
        <div className="pb-2 md:pb-0">
            <Link
                href={href}
                prefetch={false}
                aria-label={label}
                className={cn(
                    "relative grid items-center gap-x-3 gap-y-2 rounded-2xl border bg-background/30 p-3 transition-colors outline-none hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    "md:rounded-none md:border-0 md:bg-transparent md:gap-y-0 md:px-3 md:py-3 md:hover:bg-background/40",
                    className,
                )}
            >
                <motion.span
                    aria-hidden
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 0 }}
                    transition={{ duration: 2.4, ease: "easeOut" }}
                    className="pointer-events-none absolute inset-0 rounded-[inherit] bg-primary/15"
                />
                {children}
            </Link>
        </div>
    );
}

function EventLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2 [grid-area:trader]">
            <span className="grid size-5 shrink-0 place-items-center rounded-full border border-border-strong bg-surface-3 text-muted-foreground">{icon}</span>
            <span className="truncate text-sm leading-none text-muted-foreground">{text}</span>
        </span>
    );
}

function OutcomePill({ outcome }: { outcome: "up" | "down" | "invalid" }) {
    return outcome === "invalid" ? <PhaseBadge phase="invalid" /> : <PriceTag side={outcome} />;
}

function FeedSkeleton() {
    return (
        <div className="space-y-2 pt-3">
            {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-12 rounded-2xl" />
            ))}
        </div>
    );
}
