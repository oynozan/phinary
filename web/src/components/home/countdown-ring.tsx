"use client";

import { useNow } from "@/lib/data";
import { formatCountdown } from "@/lib/format";
import { DEADLINE_LABEL } from "@/lib/phase";
import type { Market, Phase } from "@/lib/types";
import { cn } from "@/lib/utils";

const R = 21;
const CIRCUMFERENCE = 2 * Math.PI * R;

const STROKE: Partial<Record<Phase, string>> = {
    upcoming: "var(--subtle)",
    live: "var(--primary)",
    closed: "var(--warn)",
    averaging: "var(--accent-2)",
};

function phaseSpan(m: Market): { from: number; to: number } | null {
    switch (m.phase) {
        case "upcoming":
            return m.createdAt === null ? null : { from: m.createdAt, to: m.openTime };
        case "live":
            return { from: m.openTime, to: m.cutoff };
        case "closed":
            return { from: m.cutoff, to: m.windowStart };
        case "averaging":
            return { from: m.windowStart, to: m.expiry };
        default:
            return null;
    }
}

/** Round timer that bridges the two sections of the featured card, draining as the phase runs out. */
export function CountdownRing({ market, className }: { market: Market; className?: string }) {
    const now = useNow();
    const span = phaseSpan(market);
    const remaining = span && now !== null ? Math.max(0, span.to - now) : 0;
    const fraction = span ? Math.min(1, remaining / Math.max(1, span.to - span.from)) : 0;
    const stroke = STROKE[market.phase] ?? "var(--subtle)";

    return (
        <div
            role="timer"
            className={cn("grid size-14 place-items-center rounded-full border-3 border-surface bg-surface-2", className)}
        >
            <svg viewBox="0 0 50 50" aria-hidden className="absolute inset-0 size-full -rotate-90">
                <circle cx="25" cy="25" r={R} fill="none" stroke="var(--border)" strokeWidth="2.5" />
                <circle
                    cx="25"
                    cy="25"
                    r={R}
                    fill="none"
                    stroke={stroke}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray={CIRCUMFERENCE}
                    strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
                    className="transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
                />
            </svg>
            <span className="relative font-secondary text-xs font-bold num">
                {span ? (
                    <>
                        <span className="sr-only">{DEADLINE_LABEL[market.phase]} </span>
                        {formatCountdown(remaining)}
                    </>
                ) : (
                    "-"
                )}
            </span>
        </div>
    );
}
