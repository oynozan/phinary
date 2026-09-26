"use client";
import { useId, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { usePriceHistory } from "@/lib/data";
import { formatPercent, formatPrice, formatTimeSeconds } from "@/lib/format";
import { historyInRange, type ChartRange } from "@/lib/markets/detail";
import type { Market, PricePoint } from "@/lib/types";
import { underlying } from "./detail-presentation";

function HistoryTip({ active, payload, probability }: { active?: boolean; payload?: ReadonlyArray<{ payload?: PricePoint }>; probability: boolean }) {
    const point = payload?.[0]?.payload;
    if (!active || !point) return null;
    return <div className="detail-chart-tip"><p>{formatTimeSeconds(point.t)} UTC</p><strong>{probability ? formatPercent(point.mid, 1) : formatPrice(point.eth)}</strong></div>;
}
export function ChartPanel({ market }: { market: Market }) {
    const history = usePriceHistory(market.id);
    const [mode, setMode] = useState<"probability" | "price">("probability");
    const [range, setRange] = useState<ChartRange>("Max");
    const fillId = useId().replaceAll(":", "");
    const probability = mode === "probability";
    const available = (history.data?.length ?? 0) > 0;
    const points = historyInRange(history.data ?? [], range).filter((p) => Number.isFinite(probability ? p.mid : p.eth));
    const last = points.at(-1);
    const first = points[0];
    const domain: [number, number] = [first?.t ?? market.openTime, Math.max((first?.t ?? market.openTime) + 1, last?.t ?? market.expiry)];
    const windowStart = Math.max(domain[0], market.windowStart);
    const windowEnd = Math.min(domain[1], market.expiry);
    return <section className="detail-panel detail-chart" aria-label="Market price history">
        <div className="detail-chart-controls">
            <div className="detail-segments" role="group" aria-label="Chart metric">
                <button type="button" aria-pressed={probability} disabled={!available} onClick={() => setMode("probability")}>Probability</button>
                <button type="button" aria-pressed={!probability} disabled={!available} onClick={() => setMode("price")}>{underlying(market)} Price</button>
            </div>
            <div className="detail-segments detail-ranges" role="group" aria-label="Chart time range">{(["15m", "1h", "6h", "Max"] as const).map((r) => <button type="button" key={r} aria-pressed={range === r} disabled={!available} onClick={() => setRange(r)}>{r}</button>)}</div>
        </div>
        {history.isLoading ? <Skeleton className="detail-chart-empty" /> : history.error || !last ? <div className="detail-chart-empty"><p>{history.error?.message === "Not connected yet" ? "History unavailable" : history.error ? "Unable to load price history" : "No price history yet"}</p><span>Live quotes appear in the market overview.</span></div> : <>
            <span className="sr-only">{probability ? "UP probability" : "Underlying price"} history in UTC. Latest: {probability ? formatPercent(last.mid) : formatPrice(last.eth)}.</span>
            <ChartContainer config={{ value: { label: probability ? "Chance UP" : `${underlying(market)} price`, color: "#d773ff" } }} className="detail-chart-canvas">
                <AreaChart data={points} margin={{ top: 12, right: 16, left: 0, bottom: 4 }} accessibilityLayer>
                    <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#be37ee" stopOpacity={0.28} /><stop offset="100%" stopColor="#be37ee" stopOpacity={0.01} /></linearGradient></defs>
                    <CartesianGrid stroke="#252a38" vertical={false} />
                    <XAxis dataKey="t" type="number" domain={domain} tickFormatter={formatTimeSeconds} tickLine={false} axisLine={false} minTickGap={60} tick={{ fill: "#b4bdd3" }} />
                    <YAxis domain={probability ? [0, 1] : ["auto", "auto"]} tickFormatter={probability ? (v) => formatPercent(v) : (v) => formatPrice(v)} width={probability ? 40 : 75} tickLine={false} axisLine={false} tick={{ fill: "#b4bdd3" }} />
                    {!probability && <ReferenceLine y={market.strike} stroke="#b4bdd3" strokeDasharray="4 4" ifOverflow="extendDomain" label={{ value: "Strike", fill: "#b4bdd3", position: "insideTopRight" }} />}
                    {!probability && windowStart < windowEnd && <ReferenceArea x1={windowStart} x2={windowEnd} fill="#b739ee" fillOpacity={0.12} label={{ value: "Settlement", fill: "#b4bdd3" }} />}
                    <ChartTooltip content={<HistoryTip probability={probability} />} />
                    <Area type="linear" dataKey={probability ? "mid" : "eth"} stroke="#d773ff" strokeWidth={1.5} fill={`url(#${fillId})`} isAnimationActive={false} dot={false} />
                    <ReferenceDot x={last.t} y={probability ? last.mid : last.eth} r={3} fill="#f5f5fa" stroke="#d773ff" />
                </AreaChart>
            </ChartContainer>
        </>}
    </section>;
}
