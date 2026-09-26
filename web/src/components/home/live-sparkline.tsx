"use client";

import { useId } from "react";

import type { PricePoint } from "@/lib/types";
import { cn } from "@/lib/utils";

const pad = 6;
const yOf = (p: number) => pad + (1 - Math.min(1, Math.max(0, p))) * (100 - 2 * pad);

/** UP chance over a fixed time span, so the line grows left to right as the market runs. */
export function LiveSparkline({
    points,
    from,
    to,
    live,
    className,
}: {
    points: PricePoint[];
    from: number;
    to: number;
    live: boolean;
    className?: string;
}) {
    const gid = useId();
    const span = Math.max(1, to - from);
    const xy = points
        .filter((p) => p.t >= from && p.t <= to)
        .map((p) => [((p.t - from) / span) * 100, yOf(p.mid)] as const);

    const line = xy.length > 1 ? `M${xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join("L")}` : "";
    const first = xy[0];
    const last = xy[xy.length - 1];
    const area = line && first && last && last[0] - first[0] > 2 ? `${line}L${last[0].toFixed(2)},100L${first[0].toFixed(2)},100Z` : "";

    return (
        <div aria-hidden className={cn("relative", className)}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
                <defs>
                    <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--up)" stopOpacity="0.22" />
                        <stop offset="100%" stopColor="var(--up)" stopOpacity="0" />
                    </linearGradient>
                </defs>
                <line
                    x1="0"
                    x2="100"
                    y1={yOf(0.5)}
                    y2={yOf(0.5)}
                    stroke="var(--border-strong)"
                    strokeDasharray="3 4"
                    vectorEffect="non-scaling-stroke"
                />
                {area && <path d={area} fill={`url(#${gid})`} />}
                {line && (
                    <path
                        d={line}
                        fill="none"
                        stroke="var(--up)"
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                    />
                )}
            </svg>
            {/* HTML dot, the stretched SVG would turn a circle into an ellipse */}
            {last && (
                <span
                    className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-up ring-4 ring-up/20"
                    style={{ left: `${last[0]}%`, top: `${last[1]}%` }}
                >
                    {live && <span className="absolute inset-0 rounded-full bg-up motion-safe:animate-ping" />}
                </span>
            )}
        </div>
    );
}
