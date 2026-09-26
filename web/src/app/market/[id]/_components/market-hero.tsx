"use client";
import Link from "next/link";
import { MarketRefreshNotice } from "@/components/market/query-error";
import { Countdown } from "@/components/market/countdown";
import { DEADLINE_LABEL, nextDeadline } from "@/lib/phase";
import { DETAIL_PHASE } from "@/lib/markets/detail";
import { useMarketsHref } from "@/lib/markets/home-href";
import type { Market } from "@/lib/types";
import { detailQuestion, utcDate } from "./detail-presentation";

export function MarketHero({ market, stale = false }: { market: Market; stale?: boolean }) {
    const deadline = nextDeadline(market, market.phase);
    const marketsHref = useMarketsHref();
    return <header className="detail-hero">
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4"><Link href={marketsHref} className="detail-back">Back to Markets</Link><MarketRefreshNotice id={market.id} stale={stale} /></div>
        <div className="detail-title-row"><div><h1>{detailQuestion(market)}</h1><p>{utcDate(market.expiry)}</p></div>
            <p className="detail-status">
                {deadline !== null && DEADLINE_LABEL[market.phase] ? <>{DEADLINE_LABEL[market.phase]} <strong><Countdown to={deadline} /></strong></> : DETAIL_PHASE[market.phase]}
            </p>
        </div>
    </header>;
}
