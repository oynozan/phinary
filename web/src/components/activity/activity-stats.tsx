import { Panel } from "@/components/layout/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsd } from "@/lib/format";
import type { Market } from "@/lib/types";
import { cn } from "@/lib/utils";

const HOUR = 3600;

/** Volume, trade count and outcomes over the last hour */
export function ActivityStats({ markets, now, className }: { markets: Market[] | undefined; now: number | null; className?: string }) {
    const ready = !!markets && now !== null;
    let volume = 0;
    let trades = 0;
    let up = 0;
    let down = 0;
    if (ready) {
        const since = now - HOUR;
        for (const m of markets) {
            if (m.openTime > since && m.openTime <= now) {
                volume += m.volume;
                trades += m.tradeCount;
            }
            if (m.settledAt !== null && m.settledAt > since) {
                if (m.phase === "resolved-up") up += 1;
                else if (m.phase === "resolved-down") down += 1;
            }
        }
    }

    return (
        <div className={cn("grid grid-cols-3 gap-2.5 sm:gap-5", className)}>
            <Tile label="Volume 1h" ready={ready}>
                {formatUsd(volume, { whole: true, compact: true })}
            </Tile>
            <Tile label="Trades 1h" ready={ready}>
                {trades.toLocaleString("en-US")}
            </Tile>
            <Tile label="Outcomes 1h" ready={ready}>
                <span className="flex items-baseline gap-x-2 whitespace-nowrap sm:gap-x-4">
                    <span className="text-up">
                        <span className="mr-0.5 text-[0.6em] sm:mr-1">▲</span>
                        {up}
                        <span className="sr-only"> UP</span>
                    </span>
                    <span className="text-down">
                        <span className="mr-0.5 text-[0.6em] sm:mr-1">▼</span>
                        {down}
                        <span className="sr-only"> DOWN</span>
                    </span>
                </span>
            </Tile>
        </div>
    );
}

function Tile({ label, ready, children }: { label: string; ready: boolean; children: React.ReactNode }) {
    return (
        <Panel className="flex min-w-0 flex-col items-center gap-1.5 px-3 py-4 text-center sm:px-6 sm:py-5">
            {ready ? (
                <span className="num font-heading text-xl font-medium sm:text-3xl">{children}</span>
            ) : (
                <Skeleton className="h-7 w-20 sm:h-9 sm:w-28" />
            )}
            <span className="font-secondary text-xs text-muted-foreground">{label}</span>
        </Panel>
    );
}
