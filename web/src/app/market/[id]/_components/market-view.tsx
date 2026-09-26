"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { PageNarrow, PageWide } from "@/components/layout/page";
import { EmptyState } from "@/components/layout/panel";
import { amountString, emptyForm, TRADE_INPUT_ID, TradeCard, type TradeForm } from "@/components/trade";
import { Button } from "@/components/ui/button";
import { BRAND_NAME } from "@/config/brand";
import { useMarket } from "@/lib/data";
import { marketQuestion } from "@/lib/format";
import { isResolved } from "@/lib/phase";
import type { Side } from "@/lib/types";
import { cn } from "@/lib/utils";

import { ChartPanel } from "./chart-panel";
import { CHART, GRID, PAGE, REST, SIDE } from "./layout";
import { MarketHero } from "./market-hero";
import { MarketRules } from "./market-rules";
import { MarketSkeleton } from "./market-skeleton";
import { PositionPanel } from "./position-panel";
import { TradesPanel } from "./trades-panel";

/** The market page: centered hero, then chart and content left with the sticky trade card right */
export function MarketView({ id, initialSide }: { id: number; initialSide: Side }) {
    const market = useMarket(id);
    const [form, setForm] = useState<TradeForm>(() => emptyForm(initialSide));
    const tradeRef = useRef<HTMLDivElement>(null);

    const m = market.data ?? null;
    const title = m ? `${marketQuestion(m.strike, m.expiry)} · ${BRAND_NAME}` : null;

    // Next re-renders its metadata title into the head after hydration, so reapply ours whenever the head changes
    useEffect(() => {
        if (!title) return;
        const apply = () => {
            if (document.title !== title) document.title = title;
        };
        apply();
        const observer = new MutationObserver(apply);
        observer.observe(document.head, { childList: true, subtree: true, characterData: true });
        return () => observer.disconnect();
    }, [title]);

    // Keep ?side= in the address bar so a copied link opens the same side
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const current = params.get("side");
        if (current === form.side || (current === null && form.side === "up")) return;
        params.set("side", form.side);
        window.history.replaceState(null, "", `?${params.toString()}`);
    }, [form.side]);

    function sellPosition(side: Side, qty: number) {
        setForm({ mode: "sell", side, amount: amountString(qty), max: true });
        const card = tradeRef.current;
        if (card) {
            const top = card.getBoundingClientRect().top;
            if (top < 0 || top > window.innerHeight * 0.6) {
                const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                card.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
            }
        }
        document.getElementById(TRADE_INPUT_ID)?.focus({ preventScroll: true });
    }

    if (market.isLoading) return <MarketSkeleton />;

    if (!m) {
        return (
            <PageNarrow>
                <EmptyState
                    title="Market not found"
                    action={
                        <Button asChild size="lg">
                            <Link href="/">Markets</Link>
                        </Button>
                    }
                />
            </PageNarrow>
        );
    }

    return (
        <PageWide className={PAGE}>
            <MarketHero market={m} className="mb-8" />
            <div className={GRID}>
                <div className={CHART}>
                    <ChartPanel market={m} />
                </div>
                <div ref={tradeRef} className={cn(SIDE, !isResolved(m.phase) && "order-first lg:order-none")}>
                    <TradeCard market={m} form={form} onFormChange={setForm} />
                </div>
                <div className={REST}>
                    <PositionPanel market={m} onSell={sellPosition} />
                    <TradesPanel market={m} />
                    <MarketRules market={m} />
                </div>
            </div>
        </PageWide>
    );
}
