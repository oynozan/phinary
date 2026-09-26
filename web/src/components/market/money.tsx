import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const PROFIT_EPSILON = 0.005;

/** Dollar amount, optionally with the cents set small and muted */
export function Money({ value, dimCents = false, className }: { value: number; dimCents?: boolean; className?: string }) {
    const s = formatUsd(value);
    const dot = s.lastIndexOf(".");
    if (!dimCents || dot < 0) return <span className={cn("num whitespace-nowrap", className)}>{s}</span>;
    return (
        <span className={cn("num whitespace-nowrap", className)}>
            {s.slice(0, dot)}
            <span className="text-[0.6em] text-muted-foreground">{s.slice(dot)}</span>
        </span>
    );
}

/** Signed USD, foreground when up, coral when down, muted when flat */
export function Profit({ value, className }: { value: number; className?: string }) {
    const flat = Math.abs(value) < PROFIT_EPSILON;
    return (
        <span className={cn("num", flat ? "text-muted-foreground" : value > 0 ? "text-foreground" : "text-down", className)}>
            {formatUsd(flat ? 0 : value, { signed: true })}
        </span>
    );
}

export function isFlat(value: number) {
    return Math.abs(value) < PROFIT_EPSILON;
}
