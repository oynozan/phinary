"use client";

import { cn } from "@/lib/utils";

const DECIMAL = /^\d*\.?\d{0,6}$/;

/**
 * Large 48px numeric input (atomic.cash swap panel) with quick-amount pills.
 * `value` is the raw string so partial input like "1." survives; parse it where you use it.
 */
export function AmountInput({
    value,
    onChange,
    label,
    adornment,
    quick = [1, 5, 10],
    quickPrefix = "$",
    max,
    placeholder = "0",
    disabled,
    autoFocus,
    className,
    id,
}: {
    value: string;
    onChange: (value: string) => void;
    /** small line above the number, e.g. "You pay" */
    label?: React.ReactNode;
    /** right side of the label row, e.g. a balance or a token pill */
    adornment?: React.ReactNode;
    quick?: number[];
    quickPrefix?: string;
    /** shows a Max pill that fills this value */
    max?: number;
    placeholder?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    className?: string;
    id?: string;
}) {
    const floor2 = (n: number) => Math.floor(n * 100) / 100;
    const set = (n: number) => onChange(String(floor2(n)));
    const current = Number.parseFloat(value);
    const chip = (active: boolean) =>
        cn(
            "num rounded-full border px-3 py-1 font-secondary text-xs font-semibold transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring disabled:bg-surface disabled:text-subtle",
            active ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-surface-3 hover:text-foreground",
        );

    return (
        <div className={cn("min-w-0", className)}>
            {(label || adornment) && (
                <div className="flex min-h-10 items-center justify-between gap-3">
                    {label && <label htmlFor={id} className="text-lg leading-none font-semibold text-muted-foreground">{label}</label>}
                    {adornment}
                </div>
            )}
            <input
                id={id}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                autoFocus={autoFocus}
                disabled={disabled}
                placeholder={placeholder}
                value={value}
                onChange={(e) => {
                    const v = e.target.value.replace(",", ".");
                    if (DECIMAL.test(v)) onChange(v);
                }}
                className="num mt-2 h-14 w-full min-w-0 border-0 bg-transparent font-sans text-4xl leading-none font-medium text-white outline-none placeholder:text-white/40 disabled:opacity-50 sm:text-5xl"
            />
            {(quick.length > 0 || max !== undefined) && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {quick.map((q) => (
                        <button key={q} type="button" disabled={disabled} aria-pressed={current === q} onClick={() => set(q)} className={chip(current === q)}>
                            {quickPrefix}
                            {q}
                        </button>
                    ))}
                    {max !== undefined && (
                        <button
                            type="button"
                            disabled={disabled || max <= 0}
                            aria-pressed={max > 0 && current === floor2(max)}
                            onClick={() => set(max)}
                            className={chip(max > 0 && current === floor2(max))}
                        >
                            Max
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
