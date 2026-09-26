"use client";

import { AnimatePresence, motion } from "motion/react";

import { Panel } from "@/components/layout/panel";
import { Profit } from "@/components/market/money";
import { SideMark } from "@/components/market/price-tag";
import { useClaims } from "@/components/trade/use-claims";
import { Button } from "@/components/ui/button";
import { usePortfolio } from "@/lib/data";
import { formatTokens, formatUsd } from "@/lib/format";
import type { Market, Position, Side } from "@/lib/types";

// Positions below this are rounding dust from partial sells
const MIN_QTY = 0.005;

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="min-w-0">
            <div className="num font-secondary text-base font-semibold">{children}</div>
            <div className="mt-0.5 font-secondary text-xs text-muted-foreground">{label}</div>
        </div>
    );
}

function Row({
    position,
    tradable,
    claiming,
    onSell,
    onClaim,
}: {
    position: Position;
    tradable: boolean;
    claiming: boolean;
    onSell: () => void;
    onClaim: () => void;
}) {
    const p = position;
    return (
        <div className="grid grid-cols-2 items-center gap-x-4 gap-y-4 px-5 py-4 sm:grid-cols-[minmax(0,1.4fr)_1fr_1fr_auto] sm:px-6">
            <div className="min-w-0">
                <div className="num font-heading text-xl leading-tight">{formatTokens(p.qty)}</div>
                <SideMark side={p.side} className="text-xs" />
            </div>
            <div className="order-3 sm:order-none">
                <Metric label="Value">{formatUsd(p.value)}</Metric>
            </div>
            <div className="order-4 sm:order-none">
                <Metric label="Profit">
                    <Profit value={p.pnl} />
                </Metric>
            </div>
            <div className="order-2 flex justify-end sm:order-none">
                {p.state === "open" && (
                    <Button variant="outline" size="lg" disabled={!tradable} onClick={onSell}>
                        Sell
                    </Button>
                )}
                {p.state === "claimable" && (
                    <Button size="lg" disabled={claiming} onClick={onClaim}>
                        {claiming ? "Claiming" : "Claim"}
                    </Button>
                )}
            </div>
        </div>
    );
}

/** Your tokens in this market with value at the bid, profit and Sell or Claim, hidden when you hold none */
export function PositionPanel({ market, onSell }: { market: Market; onSell: (side: Side, qty: number) => void }) {
    const portfolio = usePortfolio();
    const claims = useClaims();
    const positions = (portfolio.data?.positions ?? []).filter((p) => p.marketId === market.id && p.qty >= MIN_QTY);
    const tradable = market.phase === "live" && !!market.quote?.tradable;

    return (
        <AnimatePresence initial={false}>
            {positions.length > 0 && (
                <motion.section
                    key="position"
                    aria-labelledby="position-heading"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                >
                    <Panel flush className="divide-y">
                        <h2 id="position-heading" className="px-5 pt-5 pb-3 text-center text-xl sm:px-6">
                            Position
                        </h2>
                        {positions.map((p) => (
                            <Row
                                key={p.side}
                                position={p}
                                tradable={tradable}
                                claiming={claims.claiming === market.id}
                                onSell={() => onSell(p.side, p.qty)}
                                onClaim={() => void claims.claimOne(market.id)}
                            />
                        ))}
                    </Panel>
                </motion.section>
            )}
        </AnimatePresence>
    );
}
