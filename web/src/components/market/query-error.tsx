"use client";

import { Button } from "@/components/ui/button";
import { retryMarkets } from "@/lib/data";

export function QueryError({ id }: { id?: number }) {
    return (
        <div role="alert" className="rounded-3xl border border-down bg-down-soft p-6 text-center text-sm text-down">
            <p>Market data is unavailable.</p>
            <Button variant="outline" className="mt-3" onClick={() => retryMarkets(id)}>Retry</Button>
        </div>
    );
}

export function MarketRefreshNotice({ id }: { id?: number }) {
    return <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 text-sm text-muted-foreground">
        <p>Updates interrupted. Showing the last loaded data; trading is paused until updates recover.</p>
        <Button variant="outline" onClick={() => retryMarkets(id)}>Retry</Button>
    </div>;
}
