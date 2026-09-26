import { PHASE_LABEL } from "@/lib/phase";
import type { Phase } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Status dot per unresolved phase, Live and Averaging pulse */
export const PHASE_DOT: Partial<Record<Phase, string>> = {
    upcoming: "bg-subtle",
    live: "bg-primary animate-live",
    closed: "bg-warn",
    averaging: "bg-accent-2 animate-live",
    awaiting: "bg-muted-foreground animate-live",
};

const PILL: Record<Phase, string> = {
    upcoming: "border-border text-muted-foreground",
    live: "border-primary bg-primary-soft text-primary",
    closed: "border-warn bg-warn-soft text-warn",
    averaging: "border-accent-2 bg-primary-soft text-foreground",
    awaiting: "border-border text-muted-foreground",
    "resolved-up": "border-up bg-up-soft text-up",
    "resolved-down": "border-down bg-down-soft text-down",
    invalid: "border-border text-muted-foreground",
};

const GLYPH: Partial<Record<Phase, string>> = { "resolved-up": "▲", "resolved-down": "▼" };

/** Phase pill for table cells and rows. Never place it on, above or beside a heading: the countdown carries status there */
export function PhaseBadge({ phase, className }: { phase: Phase; className?: string }) {
    const dot = PHASE_DOT[phase];
    const glyph = GLYPH[phase];
    return (
        <span
            className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border bg-surface-2 px-3 font-secondary text-xs font-semibold whitespace-nowrap",
                PILL[phase],
                className,
            )}
        >
            {dot && <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />}
            {glyph && <span aria-hidden className="text-[0.65rem] leading-none">{glyph}</span>}
            {PHASE_LABEL[phase]}
        </span>
    );
}
