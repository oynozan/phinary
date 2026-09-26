"use client";
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useMarketTrades, useNow } from "@/lib/data";
import { formatAgo, formatCents, formatTokens, formatUsd, shortAddress } from "@/lib/format";
import type { Market } from "@/lib/types";
import { blockExplorer } from "./detail-presentation";

export function TradesPanel({ market }: { market: Market }) {
    const trades = useMarketTrades(market.id);
    const now = useNow();
    const [expanded, setExpanded] = useState(false);
    const list = (trades.data ?? []).toSorted((a, b) => b.time - a.time);
    const shown = expanded ? list : list.slice(0, 10);
    return <section className="detail-panel detail-trades" aria-labelledby="trades-heading"><h2 id="trades-heading">Recent Trades</h2>
        {trades.isLoading ? <p className="detail-empty">Loading trades…</p> : trades.error ? <p className="detail-empty">{trades.error.message === "Not connected yet" ? "Trade history unavailable" : "Unable to load trade history"}</p> : !list.length ? <p className="detail-empty">No trades yet.</p> : <Table><TableHeader><TableRow>{["Time", "Wallet", "Side / Action", "Amount", "Price", "Value (USDC)"].map((label) => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader><TableBody>{shown.map((t) => <TableRow key={t.id}>
            <TableCell><a href={`${blockExplorer}/tx/${t.txHash}`} target="_blank" rel="noreferrer">{now === null ? "N/A" : formatAgo(t.time, now)}</a></TableCell>
            <TableCell><a href={`${blockExplorer}/address/${t.account}`} target="_blank" rel="noreferrer">{shortAddress(t.account)}</a></TableCell>
            <TableCell className={t.side === "up" ? "detail-up" : "detail-down"}>{t.kind === "claim" ? "Claimed" : t.isBuy ? "Bought" : "Sold"} {t.side.toUpperCase()}</TableCell>
            <TableCell>{formatTokens(t.qty)}</TableCell><TableCell>{formatCents(t.price, 1)}</TableCell><TableCell>{formatUsd(t.usdc)}</TableCell>
        </TableRow>)}</TableBody></Table>}
        {list.length > 10 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : `All ${list.length} trades`}</button>}
    </section>;
}
