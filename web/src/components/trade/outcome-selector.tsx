"use client";

import { formatCents } from "@/lib/format";
import type { Side } from "@/lib/types";
import { cn } from "@/lib/utils";

const SIDES: Side[] = ["up", "down"];

/** UP and DOWN pills with the price you would trade at, arrow keys move between them */
export function OutcomeSelector({
    value,
    onChange,
    prices,
    disabled,
    className,
}: {
    value: Side;
    onChange: (side: Side) => void;
    prices: Record<Side, number | null>;
    disabled?: boolean;
    className?: string;
}) {
    function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault();
        const next: Side = value === "up" ? "down" : "up";
        onChange(next);
        e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-side="${next}"]`)?.focus();
    }

    return (
        <div role="radiogroup" aria-label="Outcome" className={cn("grid grid-cols-2 gap-2", className)}>
            {SIDES.map((side) => {
                const active = side === value;
                const up = side === "up";
                const price = prices[side];
                return (
                    <button
                        key={side}
                        type="button"
                        role="radio"
                        data-side={side}
                        aria-checked={active}
                        tabIndex={active ? 0 : -1}
                        disabled={disabled}
                        onClick={() => onChange(side)}
                        onKeyDown={onKeyDown}
                        className={cn(
                            "flex h-14 min-w-0 items-center gap-2 rounded-full border px-5 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-not-allowed",
                            active ? (up ? "border-up bg-up-soft" : "border-down bg-down-soft") : "bg-surface hover:bg-surface-2",
                        )}
                    >
                        <span
                            className={cn(
                                "flex items-baseline gap-1.5 font-secondary text-sm font-bold tracking-wide",
                                active ? (up ? "text-up" : "text-down") : "text-muted-foreground",
                            )}
                        >
                            <span aria-hidden className="text-[0.7rem] leading-none">
                                {up ? "▲" : "▼"}
                            </span>
                            {up ? "UP" : "DOWN"}
                        </span>
                        <span className={cn("num ml-auto font-heading text-xl leading-none", !active && "text-muted-foreground")}>
                            {price === null ? "-" : formatCents(price)}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
