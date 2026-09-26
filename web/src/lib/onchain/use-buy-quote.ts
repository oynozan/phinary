"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { createChainClient } from "./client.ts";
import { fetchBuyQuote, describeBuyError, parseUsdc, type BuyQuote } from "./buy.ts";

export function useBuyQuote(marketId: number, amount: string, slippage: number, account: Address | null, enabled: boolean, side: "up" | "down" = "up", mode: "buy" | "sell" = "buy") {
    const key = `${marketId}:${amount}:${slippage}:${account ?? ""}:${enabled}:${side}:${mode}`;
    const [state, setState] = useState<{ key: string; quote?: BuyQuote; error?: string }>({ key: "" });
    useEffect(() => {
        if (!enabled) return;
        let value: bigint;
        try { value = parseUsdc(amount); } catch { return; }
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            try {
                const quote = await fetchBuyQuote(createChainClient(), marketId, value, slippage, account ?? undefined, undefined, side, mode);
                if (!cancelled) setState({ key, quote });
            } catch (error) { if (!cancelled) setState({ key, error: describeBuyError(error) === "Transaction could not complete. Check your wallet and network, then retry." ? "Quote unavailable. Retrying automatically." : describeBuyError(error) }); }
            finally { if (!cancelled) timer = setTimeout(() => void refresh(), 5000); }
        };
        timer = setTimeout(() => void refresh(), 350);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [key, enabled, amount, marketId, slippage, account, side, mode]);
    return enabled && state.key === key ? state : { key };
}
