"use client";

import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatCents, formatPercent, formatPrice, formatTimeSeconds } from "@/lib/format";
import type { PricePoint } from "@/lib/types";
import { cn } from "@/lib/utils";

const config = {
    mid: { label: "UP", color: "var(--up)" },
} satisfies ChartConfig;

interface TooltipProps {
    active?: boolean;
    payload?: ReadonlyArray<{ payload?: PricePoint }>;
}

function ChartTip({ active, payload }: TooltipProps) {
    const p = payload?.[0]?.payload;
    if (!active || !p) return null;
    return (
        <div className="rounded-2xl border bg-popover/95 px-3 py-2 font-secondary text-xs shadow-xl backdrop-blur-md">
            <div className="text-muted-foreground">{formatTimeSeconds(p.t)}</div>
            <div className="mt-1 flex items-baseline gap-2">
                <span className="text-sm font-semibold text-up">▲ {formatPercent(p.mid)}</span>
                <span className="text-muted-foreground">
                    {formatCents(p.bid)} / {formatCents(p.ask)}
                </span>
            </div>
            <div className="mt-0.5 text-muted-foreground">ETH {formatPrice(p.eth)}</div>
        </div>
    );
}

/**
 * UP probability over time: one orchid line on a fixed 0-100% scale, 50% guide, crosshair tooltip.
 * Pass `domain` to span the full market life (openTime..expiry) so the line grows left to right.
 */
export function ProbabilityChart({
    points,
    domain,
    height = 280,
    className,
}: {
    points: PricePoint[];
    domain?: [number, number];
    height?: number;
    className?: string;
}) {
    return (
        <ChartContainer config={config} className={cn("aspect-auto w-full", className)} style={{ height }}>
            <AreaChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                <defs>
                    <linearGradient id="prob-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-mid)" stopOpacity={0.28} />
                        <stop offset="100%" stopColor="var(--color-mid)" stopOpacity={0} />
                    </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="0" />
                <XAxis
                    dataKey="t"
                    type="number"
                    domain={domain ?? ["dataMin", "dataMax"]}
                    tickFormatter={(t: number) => formatTimeSeconds(t)}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={48}
                    tickMargin={10}
                    className="font-secondary"
                />
                <YAxis
                    orientation="right"
                    domain={[0, 1]}
                    ticks={[0, 0.25, 0.5, 0.75, 1]}
                    tickFormatter={(v: number) => formatPercent(v)}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                    className="font-secondary"
                />
                <ReferenceLine y={0.5} stroke="var(--border-strong)" strokeDasharray="4 4" />
                <ChartTooltip cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }} content={<ChartTip />} />
                <Area
                    dataKey="mid"
                    type="monotone"
                    stroke="var(--color-mid)"
                    strokeWidth={2}
                    fill="url(#prob-fill)"
                    isAnimationActive={false}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)" }}
                />
            </AreaChart>
        </ChartContainer>
    );
}
