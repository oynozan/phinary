"use client";

import { Panel } from "@/components/layout/panel";
import { Chance } from "@/components/market/chance";
import { Countdown } from "@/components/market/countdown";
import { PriceTag } from "@/components/market/price-tag";
import { ProbabilityChart } from "@/components/market/probability-chart";
import { Skeleton } from "@/components/ui/skeleton";
import { UNDERLYING_SYMBOL } from "@/config/brand";
import { useEthPrice, usePriceHistory } from "@/lib/data";
import { formatPrice, formatUsd } from "@/lib/format";
import { isResolved, payoutPerToken } from "@/lib/phase";
import type { Market } from "@/lib/types";
import { cn } from "@/lib/utils";

const CHART_HEIGHT = 260;

function StatPill({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
    return (
        <span className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-surface-2 px-3 font-secondary text-xs font-semibold whitespace-nowrap">
            <span className="text-muted-foreground">{label}</span>
            <span className={cn("num", className)}>{children}</span>
        </span>
    );
}

function Headline({ market }: { market: Market }) {
    if (market.phase === "resolved-up" || market.phase === "resolved-down") {
        const up = market.phase === "resolved-up";
        return (
            <span className="flex items-baseline gap-3">
                <span className="font-heading text-5xl leading-none font-medium text-muted-foreground">Resolved</span>
                <span className={cn("font-heading text-5xl leading-none font-medium", up ? "text-up" : "text-down")}>
                    <span aria-hidden className="mr-2 text-3xl align-middle">
                        {up ? "▲" : "▼"}
                    </span>
                    {up ? "UP" : "DOWN"}
                </span>
            </span>
        );
    }
    if (market.phase === "invalid") {
        return <span className="num font-heading text-5xl leading-none font-medium text-muted-foreground">50/50</span>;
    }
    return <Chance value={market.upChance} className="text-5xl" />;
}

/** Big UP chance, the probability chart over the market's life, and the stat pills */
export function ChartPanel({ market }: { market: Market }) {
    const history = usePriceHistory(market.id);
    const eth = useEthPrice();
    const points = history.data ?? [];
    const q = market.quote;
    const resolved = isResolved(market.phase);

    const upPrice = resolved ? (payoutPerToken(market.phase, "up") ?? 0) : (q?.askUp ?? null);
    const downPrice = resolved ? (payoutPerToken(market.phase, "down") ?? 0) : (q?.askDown ?? null);

    const settled = market.settlementPrice !== null;
    const ethValue = settled ? market.settlementPrice : (eth.data?.price ?? null);

    return (
        <Panel className="pb-5 text-center">
            <div className="flex justify-center">
                <Headline market={market} />
            </div>

            <div className="relative mt-5 -mr-1 -ml-2">
                {history.isLoading ? (
                    <Skeleton className="w-full rounded-2xl" style={{ height: CHART_HEIGHT }} />
                ) : (
                    <ProbabilityChart points={points} domain={[market.openTime, market.expiry]} height={CHART_HEIGHT} />
                )}
                {!history.isLoading && points.length === 0 && market.phase === "upcoming" && (
                    <div className="absolute inset-0 grid place-items-center pb-8">
                        <span className="rounded-full border bg-surface px-4 py-1.5 font-secondary text-sm font-semibold">
                            <span className="text-muted-foreground">Opens in </span>
                            <Countdown to={market.openTime} />
                        </span>
                    </div>
                )}
            </div>

            <div className="mt-4 flex flex-wrap justify-center gap-2">
                {upPrice !== null && <PriceTag side="up" price={upPrice} />}
                {downPrice !== null && <PriceTag side="down" price={downPrice} />}
                <StatPill label="Vol">{formatUsd(market.volume, { compact: true })}</StatPill>
                {ethValue !== null && (
                    <StatPill
                        label={settled ? "Avg" : UNDERLYING_SYMBOL}
                        className={ethValue > market.strike ? "text-up" : "text-down"}
                    >
                        <span aria-hidden className="mr-1 text-[0.6rem]">
                            {ethValue > market.strike ? "▲" : "▼"}
                        </span>
                        {formatPrice(ethValue)}
                        <span className="sr-only">{ethValue > market.strike ? ", above strike" : ", not above strike"}</span>
                    </StatPill>
                )}
            </div>
        </Panel>
    );
}
