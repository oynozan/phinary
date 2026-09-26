"use client";

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
    const span = Math.max(1, to - from);
    const xy = points
        .filter((p) => p.t >= from && p.t <= to)
        .map((p) => [((p.t - from) / span) * 100, yOf(p.mid)] as const);

    const line = xy.length > 1 ? `M${xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join("L")}` : "";
    const last = xy[xy.length - 1];

    return (
        <div aria-hidden className={cn("relative", className)}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
                <line
                    x1="0"
                    x2="100"
                    y1={yOf(0.5)}
                    y2={yOf(0.5)}
                    stroke="var(--border-strong)"
                    strokeDasharray="3 4"
                    vectorEffect="non-scaling-stroke"
                />
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
                    className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-up ring-4 ring-primary-soft"
                    style={{ left: `${last[0]}%`, top: `${last[1]}%` }}
                >
                    {live && <span className="absolute inset-0 rounded-full bg-up motion-safe:animate-ping" />}
                </span>
            )}
        </div>
    );
}
