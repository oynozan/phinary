"use client";

import { LoaderCircle } from "lucide-react";

import { Panel } from "@/components/layout/panel";
import type { Claims } from "@/components/trade/use-claims";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/lib/format";
import type { Position } from "@/lib/types";

/** "$15.00 to claim" + Claim all, on the orchid wash. */
export function ClaimBanner({ positions, claims }: { positions: Position[]; claims: Claims }) {
    const claimable = positions.filter((p) => p.claimable > 0);
    const amount = claimable.reduce((n, p) => n + p.claimable, 0);
    const marketIds = [...new Set(claimable.map((p) => p.marketId))];
    if (marketIds.length === 0 && !claims.progress) return null;

    const { progress } = claims;
    const label = progress ? `Claiming ${Math.min(progress.done + 1, progress.total)}/${progress.total}` : marketIds.length > 1 ? "Claim all" : "Claim";

    return (
        <Panel highlight role="status" className="mb-10 flex flex-col items-center justify-center gap-5 px-6 py-7 text-center sm:flex-row sm:gap-10 sm:py-8">
            <p className="font-heading text-3xl font-medium tracking-tight sm:text-4xl">
                <span className="num">{formatUsd(amount)}</span> <span className="text-muted-foreground">to claim</span>
            </p>
            <Button size="lg" className="min-w-40 font-semibold" disabled={claims.busy || marketIds.length === 0} onClick={() => claims.claimAll(marketIds)}>
                {progress && <LoaderCircle aria-hidden className="animate-spin" />}
                {label}
            </Button>
        </Panel>
    );
}
