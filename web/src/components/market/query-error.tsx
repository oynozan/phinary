"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryMarkets } from "@/lib/data";

export function QueryError({ id }: { id?: number }) {
    return <div role="status" className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm text-muted-foreground">
        <span>Waiting for market data. Reconnecting automatically.</span>
        <Button variant="ghost" onClick={() => retryMarkets(id)}>Retry</Button>
    </div>;
}

/** Reserve the same header space during recovery instead of inserting a banner. */
export function MarketRefreshNotice({ id, stale = true }: { id?: number; stale?: boolean }) {
    return <div role="status" aria-hidden={!stale} className={`flex min-h-11 items-center gap-2 text-xs text-muted-foreground ${stale ? "" : "invisible"}`}>
        <span className="size-1.5 shrink-0 rounded-full bg-amber-300/70" aria-hidden="true" />
        <span title="Showing the last loaded data. Trading resumes after a successful update.">Reconnecting · trading paused</span>
        <button type="button" aria-label="Retry market updates" disabled={!stale} onClick={() => retryMarkets(id)} className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-violet-300">
            <RefreshCw size={14} aria-hidden="true" />
        </button>
    </div>;
}
