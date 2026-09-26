import type { Side } from "@/lib/types";

export type TradeMode = "buy" | "sell";

/** The trade box inputs, where `amount` is USDC for buys and tokens for sells */
export interface TradeForm {
    mode: TradeMode;
    side: Side;
    amount: string;
    /** sell the exact balance instead of the rounded input, so no dust is left */
    max: boolean;
}

export function emptyForm(side: Side, mode: TradeMode = "buy"): TradeForm {
    return { mode, side, amount: "", max: false };
}

export function parseAmount(value: string): number {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Token amount as an input string, to the cent like every balance on the page */
export function amountString(qty: number, round: "nearest" | "down" = "nearest"): string {
    const cents = round === "down" ? Math.floor(qty * 100) : Math.round(qty * 100);
    return String(cents / 100);
}
