"use client";

import { cn } from "@/lib/utils";

export interface PillOption<T extends string> {
    value: T;
    label: React.ReactNode;
    /** classes applied when this option is active (defaults to the orchid fill) */
    activeClassName?: string;
    disabled?: boolean;
}

/**
 * Small pill segmented control (atomic.cash slippage / portfolio tabs).
 * size "xs" for inline settings, "sm" for tabs, "md" for prominent toggles like Buy / Sell.
 */
export function SegmentedPills<T extends string>({
    options,
    value,
    onChange,
    size = "sm",
    fullWidth = false,
    className,
    "aria-label": ariaLabel,
}: {
    options: PillOption<T>[];
    value: T;
    onChange: (value: T) => void;
    size?: "xs" | "sm" | "md";
    fullWidth?: boolean;
    className?: string;
    "aria-label"?: string;
}) {
    function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const enabled = options.filter((o) => !o.disabled);
        const at = enabled.findIndex((o) => o.value === value);
        const next = enabled[(at + step + enabled.length) % enabled.length];
        if (!next) return;
        onChange(next.value);
        e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
    }

    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            className={cn(
                "inline-flex items-center gap-1 rounded-full border bg-background p-0.5",
                size === "md" && "p-1",
                fullWidth && "flex w-full",
                className,
            )}
        >
            {options.map((o) => {
                const active = o.value === value;
                return (
                    <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        data-value={o.value}
                        tabIndex={active ? 0 : -1}
                        disabled={o.disabled}
                        onClick={() => onChange(o.value)}
                        onKeyDown={onKeyDown}
                        className={cn(
                            "rounded-full font-secondary font-semibold whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring disabled:text-subtle",
                            size === "xs" && "px-2.5 py-0.5 text-[11px]",
                            size === "sm" && "px-4 py-1.5 text-xs",
                            size === "md" && "h-10 px-5 text-sm",
                            fullWidth && "flex-1",
                            active
                                ? (o.activeClassName ?? "bg-primary text-primary-foreground")
                                : "bg-background text-muted-foreground hover:bg-surface-3 hover:text-foreground",
                        )}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}
