"use client";

import { useState } from "react";
import { ArrowDown } from "lucide-react";

import { cn } from "@/lib/utils";

/** atomic.cash stacked swap card, with `onFlip` the bridging arrow becomes a spinning button */
export function SwapStack({
    top,
    bottom,
    onFlip,
    flipLabel,
    flipDisabled,
    className,
}: {
    top: React.ReactNode;
    bottom: React.ReactNode;
    onFlip?: () => void;
    flipLabel?: string;
    flipDisabled?: boolean;
    className?: string;
}) {
    const [spins, setSpins] = useState(0);
    const bridge = "absolute top-0 left-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-3 border-surface bg-surface-2";

    return (
        <div className={cn("overflow-hidden rounded-3xl border bg-surface transition-colors has-[input:focus-visible]:border-primary", className)}>
            <div className="px-5 pt-4 pb-5">{top}</div>
            <div className="relative border-t bg-surface-2 px-5 pt-5 pb-5">
                {onFlip ? (
                    <button
                        type="button"
                        onClick={() => {
                            setSpins((n) => n + 1);
                            onFlip();
                        }}
                        disabled={flipDisabled}
                        aria-label={flipLabel}
                        className={cn(bridge, "transition-colors outline-none hover:bg-surface-3 focus-visible:ring-3 focus-visible:ring-ring disabled:text-subtle")}
                    >
                        <ArrowDown
                            aria-hidden
                            className="size-6 transition-transform duration-500 ease-out motion-reduce:transition-none"
                            style={{ transform: `rotate(${spins * 360}deg)` }}
                        />
                    </button>
                ) : (
                    <span aria-hidden className={bridge}>
                        <ArrowDown className="size-6" />
                    </span>
                )}
                {bottom}
            </div>
        </div>
    );
}

/** The "You receive" half with its asset chip and the big read-only number */
export function SwapOutput({
    label = "You receive",
    chip,
    value,
    htmlFor,
    children,
}: {
    label?: string;
    chip: React.ReactNode;
    /** formatted amount, or null for the empty 0 */
    value: string | null;
    htmlFor?: string;
    children?: React.ReactNode;
}) {
    return (
        <>
            <div className="flex min-h-10 items-center justify-between gap-3">
                <span className="text-lg leading-none font-semibold text-muted-foreground">{label}</span>
                {chip}
            </div>
            <output
                htmlFor={htmlFor}
                aria-live="polite"
                aria-label={label}
                className={cn(
                    "num mt-2 flex h-14 items-center truncate font-sans text-4xl leading-none font-medium sm:text-5xl",
                    value ? "text-white" : "text-white/40",
                )}
            >
                {value ?? "0"}
            </output>
            {children}
        </>
    );
}
