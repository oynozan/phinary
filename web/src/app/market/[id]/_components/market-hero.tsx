"use client";

import { Clock } from "lucide-react";

import { Countdown } from "@/components/market/countdown";
import { MarketQuestion } from "@/components/market/market-question";
import { DEADLINE_LABEL, nextDeadline } from "@/lib/phase";
import type { Market } from "@/lib/types";
import { cn } from "@/lib/utils";

import { MarketTimeline } from "./market-timeline";

/** Centered question, the countdown to the next phase boundary, then the timeline */
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
            {deadline !== null && (
                <p className="mt-3 flex h-7 items-center justify-center gap-1.5 font-secondary text-base font-semibold">
                    <Clock aria-hidden className="size-4 text-muted-foreground" />
                    <span className="sr-only">{DEADLINE_LABEL[market.phase]}</span>
                    <Countdown to={deadline} />
                </p>
            )}
            <MarketTimeline market={market} className="mt-4 max-w-xl" />
        </div>
    );
}
