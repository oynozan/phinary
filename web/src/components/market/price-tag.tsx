import { formatCents, sideLabel } from "@/lib/format";
import type { Side } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Plain inline "▲ UP" / "▼ DOWN" in the side's colour, the side indicator everywhere a logo would go */
export function SideMark({ side, className }: { side: Side; className?: string }) {
    const up = side === "up";
    return (
        <span className={cn("inline-flex items-baseline gap-1 font-secondary font-bold whitespace-nowrap", up ? "text-up" : "text-down", className)}>
            <span aria-hidden className="text-[0.7em] leading-none">
                {up ? "▲" : "▼"}
            </span>
            {sideLabel(side)}
        </span>
    );
}

/** "▲ UP 63¢" pill in the side's colour, or just "▲ UP" without a price */
export function PriceTag({ side, price, className }: { side: Side; price?: number; className?: string }) {
    const up = side === "up";
    return (
        <span
            className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full px-3 font-secondary text-xs font-semibold whitespace-nowrap",
                up ? "bg-up-soft text-up" : "bg-down-soft text-down",
                className,
            )}
        >
            <span aria-hidden className="text-[0.65rem] leading-none">
                {up ? "▲" : "▼"}
            </span>
            {sideLabel(side)}
            {price !== undefined && <span className="num text-foreground">{formatCents(price)}</span>}
        </span>
    );
}
