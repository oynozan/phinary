import { ChevronDown } from "lucide-react";

import { DISPLAY_TIMEZONE, UNDERLYING_SYMBOL } from "@/config/brand";
import { formatPrice, formatTimeSeconds } from "@/lib/format";
import type { Market } from "@/lib/types";

/** Collapsed rules, one sentence on how the market resolves */
export function MarketRules({ market }: { market: Market }) {
    return (
        <details className="group rounded-3xl border bg-surface">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-3xl px-5 py-4 font-heading text-lg outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-6 [&::-webkit-details-marker]:hidden">
                Rules
                <ChevronDown aria-hidden className="size-5 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <p className="px-5 pb-5 leading-relaxed text-muted-foreground sm:px-6">
                Resolves <span className="font-semibold text-up">UP</span> if the average {UNDERLYING_SYMBOL} price from{" "}
                <span className="num text-foreground">{formatTimeSeconds(market.windowStart)}</span> to{" "}
                <span className="num text-foreground">{formatTimeSeconds(market.expiry)}</span> {DISPLAY_TIMEZONE} is above{" "}
                <span className="num text-foreground">{formatPrice(market.strike)}</span>, otherwise{" "}
                <span className="font-semibold text-down">DOWN</span>.
            </p>
        </details>
    );
}
