"use client";

import { useNow } from "@/lib/data";
import { formatTimeSeconds } from "@/lib/format";
import type { Market } from "@/lib/types";
import { cn } from "@/lib/utils";

// Stepper weights, not time, since the closed gap and the window are seconds long but need room for their times
const WEIGHTS = [5, 2, 3];

/** Open, cutoff, window, expiry as a thin segmented bar that fills with the clock */
export function MarketTimeline({ market, className }: { market: Market; className?: string }) {
    const now = useNow();
    const segments = [
        { from: market.openTime, to: market.cutoff, fill: "bg-primary" },
        { from: market.cutoff, to: market.windowStart, fill: "bg-warn" },
        { from: market.windowStart, to: market.expiry, fill: "bg-accent-2" },
    ];
    const ticks = [
        { label: "Open", t: market.openTime },
        { label: "Cutoff", t: market.cutoff },
        { label: "Window", t: market.windowStart },
        { label: "Expiry", t: market.expiry },
    ];
    const total = WEIGHTS.reduce((a, b) => a + b, 0);
    const offsets = [0, WEIGHTS[0], WEIGHTS[0] + WEIGHTS[1], total].map((w) => (w / total) * 100);

    return (
        <div className={cn("w-full", className)}>
            <div aria-hidden className="flex h-1.5 gap-0.5">
                {segments.map((s, i) => {
                    const p = now === null ? 0 : Math.min(1, Math.max(0, (now - s.from) / (s.to - s.from)));
                    return (
                        <div key={i} className="h-full basis-0 overflow-hidden rounded-full bg-white/10" style={{ flexGrow: WEIGHTS[i] }}>
                            <div
                                className={cn("h-full rounded-full transition-[width] duration-1000 ease-linear", s.fill)}
                                style={{ width: `${p * 100}%` }}
                            />
                        </div>
                    );
                })}
            </div>
            <ol aria-label="Timeline" className="relative mt-2.5 h-4 font-secondary text-[11px] leading-4">
                {ticks.map((tick, i) => {
                    const passed = now !== null && now >= tick.t;
                    const edge = i === 0 ? "items-start" : i === ticks.length - 1 ? "-translate-x-full items-end" : "-translate-x-1/2 items-center";
                    return (
                        <li key={tick.label} title={tick.label} className={cn("absolute top-0 flex flex-col", edge)} style={{ left: `${offsets[i]}%` }}>
                            <span className="sr-only">{tick.label} </span>
                            <span className={cn("num font-semibold", passed ? "text-foreground" : "text-subtle")}>{formatTimeSeconds(tick.t)}</span>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
