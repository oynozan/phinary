"use client";

import { useState } from "react";
import { toast } from "sonner";

import { useWallet } from "@/lib/data";
import { formatUsd } from "@/lib/format";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Claim one market or every claimable market, switching network first, one transaction per market */
export function useClaims() {
    const wallet = useWallet();
    const [claiming, setClaiming] = useState<number | null>(null);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

    const busy = claiming !== null || progress !== null;

    async function claimOne(marketId: number) {
        if (busy) return;
        setClaiming(marketId);
        try {
            if (wallet.wrongNetwork) await wallet.switchNetwork();
            const paid = await wallet.claim(marketId);
            toast.success(`Claimed ${formatUsd(paid)}`);
        } catch (e) {
            toast.error(message(e, "Claim failed"));
        } finally {
            setClaiming(null);
        }
    }

    async function claimAll(marketIds: number[]) {
        if (busy || marketIds.length === 0) return;
        setProgress({ done: 0, total: marketIds.length });
        let paid = 0;
        try {
            if (wallet.wrongNetwork) await wallet.switchNetwork();
            for (const [i, id] of marketIds.entries()) {
                setClaiming(id);
                paid += await wallet.claim(id);
                setProgress({ done: i + 1, total: marketIds.length });
            }
            toast.success(`Claimed ${formatUsd(paid)}`);
        } catch (e) {
            if (paid > 0) toast.success(`Claimed ${formatUsd(paid)}`);
            toast.error(message(e, "Claim failed"));
        } finally {
            setClaiming(null);
            setProgress(null);
        }
    }

    return { claiming, progress, busy, claimOne, claimAll };
}

export type Claims = ReturnType<typeof useClaims>;
