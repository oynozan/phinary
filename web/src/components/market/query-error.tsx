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
