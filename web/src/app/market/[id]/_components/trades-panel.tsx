"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { Panel } from "@/components/layout/panel";
import { PriceTag } from "@/components/market/price-tag";
import { Button } from "@/components/ui/button";
import { useMarketTrades, useNow, useWallet } from "@/lib/data";
import { formatAgo, formatCents, formatTokens, formatUsd, shortAddress } from "@/lib/format";
import type { Market, Trade } from "@/lib/types";
import { cn } from "@/lib/utils";

const PAGE = 10;

const th = "px-2 py-3 text-right font-medium";
const td = "px-2 py-3 text-right";

function SideCell({ trade }: { trade: Trade }) {
    return (
        <span className="inline-flex items-center gap-2 font-semibold">
            <span className={cn("w-7", trade.isBuy ? "text-foreground" : "text-muted-foreground")}>{trade.isBuy ? "Buy" : "Sell"}</span>
            <PriceTag side={trade.side} className="h-6 px-2.5 text-[11px]" />
        </span>
    );
}

/** Every trade in this market, newest first, with yours marked */
export function TradesPanel({ market }: { market: Market }) {
    const trades = useMarketTrades(market.id);
    const wallet = useWallet();
    const now = useNow();
    const [expanded, setExpanded] = useState(false);

    const list = trades.data ?? [];
    const shown = expanded ? list : list.slice(0, PAGE);
    const me = wallet.address?.toLowerCase() ?? null;

    return (
        <section aria-labelledby="trades-heading">
            <Panel flush className="overflow-hidden">
                <div className="flex items-baseline justify-between gap-4 px-5 pt-5 pb-2 sm:px-6">
                    <h2 id="trades-heading" className="text-xl">
                        Trades
                    </h2>
                    {list.length > 0 && <span className="num font-secondary text-sm text-muted-foreground">{list.length}</span>}
                </div>
                {list.length === 0 ? (
                    <p className="py-12 text-center text-muted-foreground">No trades yet</p>
                ) : (
                    <table className="w-full font-secondary text-sm">
                        <thead>
                            <tr className="border-b text-xs text-muted-foreground">
                                <th scope="col" className="py-3 pr-2 pl-5 text-left font-medium sm:pl-6">
                                    Side
                                </th>
                                <th scope="col" className={th}>
                                    Tokens
                                </th>
                                <th scope="col" className={cn(th, "hidden sm:table-cell")}>
                                    Price
                                </th>
                                <th scope="col" className={th}>
                                    Total
                                </th>
                                <th scope="col" className={cn(th, "hidden sm:table-cell")}>
                                    Trader
                                </th>
                                <th scope="col" className="py-3 pr-5 pl-2 text-right font-medium sm:pr-6">
                                    <span className="sr-only">Time</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <AnimatePresence initial={false}>
                                {shown.map((t) => {
                                    const mine = me !== null && t.account.toLowerCase() === me;
                                    return (
                                        <motion.tr
                                            key={t.id}
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            transition={{ duration: 0.4 }}
                                            className={cn("border-b border-border/60 last:border-0", mine && "bg-primary/6")}
                                        >
                                            <td className="py-3 pr-2 pl-5 text-left whitespace-nowrap sm:pl-6">
                                                <SideCell trade={t} />
                                            </td>
                                            <td className={cn(td, "num")}>{formatTokens(t.qty)}</td>
                                            <td className={cn(td, "num hidden text-muted-foreground sm:table-cell")}>{formatCents(t.price, 1)}</td>
                                            <td className={cn(td, "num font-semibold")}>{formatUsd(t.usdc)}</td>
                                            <td className={cn(td, "hidden sm:table-cell")}>
                                                {mine ? (
                                                    <span className="font-semibold text-primary">You</span>
                                                ) : (
                                                    <span className="font-mono text-xs text-muted-foreground">{shortAddress(t.account)}</span>
                                                )}
                                            </td>
                                            <td className="num py-3 pr-5 pl-2 text-right whitespace-nowrap text-muted-foreground sm:pr-6">
                                                {now === null ? "" : formatAgo(t.time, now)}
                                            </td>
                                        </motion.tr>
                                    );
                                })}
                            </AnimatePresence>
                        </tbody>
                    </table>
                )}
                {list.length > PAGE && (
                    <div className="flex justify-center border-t p-3">
                        <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
                            {expanded ? "Less" : `All ${list.length}`}
                        </Button>
                    </div>
                )}
            </Panel>
        </section>
    );
}
