import { isResolved, payoutPerToken } from "@/lib/phase";
import type { Address, Market, Portfolio, Position, Side } from "@/lib/types";

import type { MockChain } from "./chain";

/** Average-cost positions from the account's trades and claims (DASHBOARD.md section 6). */
export function computePortfolio(chain: MockChain, account: Address, cash: number, t: number): Portfolio {
    const trades = chain.userTradesOf(account).filter((x) => x.time <= t);
    const books = new Map<string, { marketId: number; side: Side; qty: number; cost: number; realized: number }>();
    for (const tr of [...trades].sort((a, b) => a.time - b.time)) {
        const key = `${tr.marketId}:${tr.side}`;
        const b = books.get(key) ?? { marketId: tr.marketId, side: tr.side, qty: 0, cost: 0, realized: 0 };
        if (tr.isBuy) {
            b.qty += tr.qty;
            b.cost += tr.usdc;
        } else {
            const avg = b.qty > 0 ? b.cost / b.qty : 0;
            const q = Math.min(tr.qty, b.qty);
            b.realized += tr.usdc - q * avg;
            b.qty -= q;
            b.cost -= q * avg;
        }
        books.set(key, b);
    }

    const markets = new Map<number, Market | null>();
    const marketOf = (id: number) => {
        if (!markets.has(id)) markets.set(id, chain.marketAt(id, t));
        return markets.get(id) ?? null;
    };

    const positions: Position[] = [];
    let realized = 0;
    for (const b of books.values()) {
        realized += b.realized;
        const market = marketOf(b.marketId);
        if (!market || b.qty <= 1e-9) continue;
        const pay = payoutPerToken(market.phase, b.side);
        let mark: number;
        let state: Position["state"];
        if (pay !== null) {
            mark = pay;
            state = pay > 0 ? "claimable" : "lost";
        } else {
            const q = market.quote;
            mark = q ? (b.side === "up" ? q.bidUp : q.bidDown) : 0;
            state = market.phase === "live" || market.phase === "upcoming" ? "open" : "pending";
        }
        const value = b.qty * mark;
        positions.push({
            marketId: b.marketId,
            market,
            side: b.side,
            qty: b.qty,
            cost: b.cost,
            avgPrice: b.cost / b.qty,
            mark,
            value,
            pnl: value - b.cost,
            realized: b.realized,
            state,
            claimable: state === "claimable" ? value : 0,
        });
    }

    const order: Record<Position["state"], number> = { claimable: 0, open: 1, pending: 2, lost: 3, closed: 4, claimed: 5 };
    positions.sort((a, b) => order[a.state] - order[b.state] || b.marketId - a.marketId);

    const open = positions.filter((p) => !isResolved(p.market.phase));
    const positionsValue = positions.reduce((n, p) => n + p.value, 0);
    return {
        cash,
        positionsValue,
        total: cash + positionsValue,
        unrealized: open.reduce((n, p) => n + p.pnl, 0),
        realized,
        claimable: positions.reduce((n, p) => n + p.claimable, 0),
        positions,
        history: [...trades].sort((a, b) => b.time - a.time),
    };
}
