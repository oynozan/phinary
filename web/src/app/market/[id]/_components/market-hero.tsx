"use client";

import { Clock } from "lucide-react";

import { Countdown } from "@/components/market/countdown";
import { MarketQuestion } from "@/components/market/market-question";
import { PhaseBadge } from "@/components/market/phase-badge";
import { DEADLINE_LABEL, nextDeadline } from "@/lib/phase";
import type { Market } from "@/lib/types";
import { cn } from "@/lib/utils";

import { MarketTimeline } from "./market-timeline";

/** Centered question, phase and countdown, then the timeline */
export function MarketHero({ market, className }: { market: Market; className?: string }) {
    const deadline = nextDeadline(market, market.phase);
    return (
        <div className={cn("flex flex-col items-center text-center", className)}>
            <MarketQuestion
                as="h1"
                accentStrike
                strike={market.strike}
                expiry={market.expiry}
                className="text-4xl leading-[1.08] sm:text-5xl lg:text-[2.5rem]"
            />
            <div className="mt-3 flex items-center justify-center gap-2">
                <PhaseBadge phase={market.phase} />
                {deadline !== null && (
                    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border px-3 font-secondary text-xs font-semibold">
                        <Clock aria-hidden className="size-3.5 text-muted-foreground" />
                        <span className="sr-only">{DEADLINE_LABEL[market.phase]}</span>
                        <Countdown to={deadline} />
                    </span>
                )}
            </div>
            <MarketTimeline market={market} className="mt-4 max-w-xl" />
        </div>
    );
}
