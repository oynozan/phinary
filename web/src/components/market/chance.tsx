import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Big "48% ▲ UP" in the heading face, sized by the caller */
export function Chance({ value, className }: { value: number | null; className?: string }) {
    return (
        <span className="flex shrink-0 items-baseline gap-2">
            <span className={cn("num font-heading leading-none font-medium tracking-tight", className)}>{value === null ? "N/A" : formatPercent(value)}</span>
            <span className="font-secondary text-sm font-bold text-up">
                <span aria-hidden>▲ </span>UP
            </span>
        </span>
    );
}
