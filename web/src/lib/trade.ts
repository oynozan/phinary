import type { Quote, Side } from "@/lib/types";

/** Marginal price impact per whole token of flow (demo lambda). */
export const PRICE_IMPACT_PER_TOKEN = 0.0004;

export interface TradePreview {
    qty: number;
    usdc: number;
    avgPrice: number;
    /** avgPrice vs mid for that side, as a fraction of the mid */
    impact: number;
    /** payout if this side wins: qty * $1 */
    toWin: number;
}

function sideAsk(q: Quote, side: Side) {
    return side === "up" ? q.askUp : q.askDown;
}

function sideBid(q: Quote, side: Side) {
    return side === "up" ? q.bidUp : q.bidDown;
}

export function sideMid(q: Quote, side: Side) {
    return side === "up" ? q.midUp : 1 - q.midUp;
}

/** What `usdc` buys at the current ask, with linear impact. */
export function previewBuy(q: Quote, side: Side, usdc: number): TradePreview {
    const ask = sideAsk(q, side);
    if (usdc <= 0 || ask <= 0) return { qty: 0, usdc: 0, avgPrice: ask, impact: 0, toWin: 0 };
    // avg = ask + k*qty/2 and qty = usdc/avg  =>  k/2*qty^2 + ask*qty - usdc = 0
    const k = PRICE_IMPACT_PER_TOKEN / 2;
    const qty = (-ask + Math.sqrt(ask * ask + 4 * k * usdc)) / (2 * k);
    const avgPrice = usdc / qty;
    const mid = sideMid(q, side);
    return { qty, usdc, avgPrice, impact: mid > 0 ? avgPrice / mid - 1 : 0, toWin: qty };
}

/** What selling `qty` tokens returns at the current bid, with linear impact. */
export function previewSell(q: Quote, side: Side, qty: number): TradePreview {
    const bid = sideBid(q, side);
    if (qty <= 0) return { qty: 0, usdc: 0, avgPrice: bid, impact: 0, toWin: 0 };
    const avgPrice = Math.max(0, bid - (PRICE_IMPACT_PER_TOKEN * qty) / 2);
    const mid = sideMid(q, side);
    return { qty, usdc: qty * avgPrice, avgPrice, impact: mid > 0 ? 1 - avgPrice / mid : 0, toWin: 0 };
}
