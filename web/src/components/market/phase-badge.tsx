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
    live: "border-primary/40 bg-primary/15 text-primary",
    closed: "border-warn/30 bg-warn/10 text-warn",
    averaging: "border-accent-2/50 bg-accent-2/20 text-foreground",
    awaiting: "border-border text-muted-foreground",
    "resolved-up": "border-up/40 bg-up/15 text-up",
    "resolved-down": "border-down/40 bg-down/15 text-down",
    invalid: "border-border text-muted-foreground",
};

const GLYPH: Partial<Record<Phase, string>> = { "resolved-up": "▲", "resolved-down": "▼" };

/** Pill with the market phase */
export function PhaseBadge({ phase, className }: { phase: Phase; className?: string }) {
    const dot = PHASE_DOT[phase];
    const glyph = GLYPH[phase];
    return (
        <span
            className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 font-secondary text-xs font-semibold whitespace-nowrap",
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
