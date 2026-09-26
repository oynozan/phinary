"use client";

import { TokenIcon } from "@/components/market/token-icon";
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
                            "flex h-14 min-w-0 items-center gap-2.5 rounded-full border pr-4 pl-2 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60",
                            active
                                ? up
                                    ? "border-up/60 bg-up/12"
                                    : "border-down/60 bg-down/12"
                                : "bg-background/20 hover:bg-white/5",
                        )}
                    >
                        <span aria-hidden className={cn("transition-opacity", !active && "opacity-60")}>
                            <TokenIcon side={side} size={38} />
                        </span>
                        <span
                            className={cn(
                                "font-secondary text-sm font-bold tracking-wide",
                                active ? (up ? "text-up" : "text-down") : "text-muted-foreground",
                            )}
                        >
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
