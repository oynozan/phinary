import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/** UP share vs DOWN share, split by a 2px gap. Optional labels above. */
export function ProbabilityBar({ up, labels = false, className }: { up: number; labels?: boolean; className?: string }) {
    const p = Math.min(1, Math.max(0, up));
    return (
        <div className={cn("w-full", className)}>
            {labels && (
                <div className="mb-2 flex justify-between font-secondary text-xs font-semibold">
                    <span className="text-up">▲ {formatPercent(p)}</span>
                    <span className="text-down">{formatPercent(1 - p)} ▼</span>
                </div>
            )}
            <div
                className="flex h-2 w-full gap-0.5"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(p * 100)}
                aria-label="UP chance"
            >
                <div className="h-full rounded-full bg-up transition-[width] duration-700" style={{ width: `${p * 100}%` }} />
                <div className="h-full flex-1 rounded-full bg-down/80 transition-[width] duration-700" />
            </div>
        </div>
    );
}
