"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { QueryError } from "@/components/market/query-error";
import { emptyForm, TradeCard, type TradeForm } from "@/components/trade";
import { BRAND_NAME } from "@/config/brand";
import { useMarket } from "@/lib/data";
import { useTokenBalance } from "@/lib/onchain/balances";
import { isResolved } from "@/lib/phase";
import { useMarketsHref } from "@/lib/markets/home-href";
import { SettlementCompanion } from "./settlement-companion";
import type { Market, Side } from "@/lib/types";
import { ChartPanel } from "./chart-panel";
import { MarketHero } from "./market-hero";
import { MarketRules } from "./market-rules";
import { MarketSkeleton } from "./market-skeleton";
import { PositionPanel } from "./position-panel";
import { TradesPanel } from "./trades-panel";
import { detailQuestion, OnchainInfo, Overview, PricingExplanation } from "./detail-presentation";
import "./market-detail.css";

function MarketContent({ market, initialSide, stale }: { market: Market; initialSide: Side; stale: boolean }) {
    const [form, setForm] = useState<TradeForm>(() => emptyForm(initialSide));
    const upBalance = useTokenBalance(market.up);
    const title = `${detailQuestion(market)} · ${BRAND_NAME}`;
    useEffect(() => {
        const apply = () => { if (document.title !== title) document.title = title; };
        apply();
        const observer = new MutationObserver(apply);
        observer.observe(document.head, { childList: true, subtree: true, characterData: true });
        return () => observer.disconnect();
    }, [title]);
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const current = params.get("side");
        if (current === form.side || (current === null && form.side === "up")) return;
        params.set("side", form.side);
        window.history.replaceState(null, "", `?${params.toString()}`);
    }, [form.side]);
    return <>
        <MarketHero market={market} stale={stale} />
        <div className="detail-grid">
            <div className="detail-overview-slot"><Overview market={market} /></div>
            <div className="detail-chart-slot"><ChartPanel market={market} /></div>
            <div className="detail-trade-slot"><TradeCard stale={stale} market={market} form={form} onFormChange={setForm} holdings={upBalance} />{isResolved(market.phase) && <SettlementCompanion />}</div>
            <div className="detail-position-slot"><PositionPanel market={market} upBalance={upBalance} onSell={side => { setForm({ side, mode: "sell", amount: "", max: false }); document.getElementById("trade-amount")?.focus(); }} /></div>
            <div className="detail-pricing-slot"><PricingExplanation market={market} /></div>
        </div>
        <MarketRules market={market} />
        <div className="detail-bottom"><TradesPanel market={market} /><OnchainInfo market={market} /></div>
    </>;
}
export function MarketView({ id, initialSide }: { id: number; initialSide: Side }) {
    const market = useMarket(id);
    const marketsHref = useMarketsHref();
    return <div className="market-detail-page"><div className="detail-container">
        {market.error && market.data === undefined ? <section className="detail-panel detail-error"><Link href={marketsHref}>Back to Markets</Link><QueryError id={id} /></section> : market.isLoading ? <MarketSkeleton /> : !market.data ? <section className="detail-panel detail-error"><h1>Market not found</h1><Link href={marketsHref}>Back to Markets</Link></section> : <MarketContent key={id} market={market.data} initialSide={initialSide} stale={!!market.error} />}
    </div></div>;
}
