import { formatCents, sideLabel } from "@/lib/format";
import type { Side } from "@/lib/types";
import { cn } from "@/lib/utils";

/** "▲ UP 63¢" pill in the side's colour, or just "▲ UP" without a price */
export function PriceTag({ side, price, className }: { side: Side; price?: number; className?: string }) {
    const up = side === "up";
    return (
        <span
            className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full px-3 font-secondary text-xs font-semibold whitespace-nowrap",
                up ? "bg-up/15 text-up" : "bg-down/15 text-down",
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
