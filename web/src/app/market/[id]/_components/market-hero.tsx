"use client";
import Link from "next/link";
import { Countdown } from "@/components/market/countdown";
import { DEADLINE_LABEL, nextDeadline } from "@/lib/phase";
import { DETAIL_PHASE } from "@/lib/markets/detail";
import type { Market } from "@/lib/types";
import { detailQuestion, utcDate } from "./detail-presentation";

export function MarketHero({ market }: { market: Market }) {
    const deadline = nextDeadline(market, market.phase);
    return <header className="detail-hero">
        <Link href="/" className="detail-back">Back to Markets</Link>
        <div className="detail-title-row"><div><h1>{detailQuestion(market)}</h1><p>{utcDate(market.expiry)}</p></div>
            <p className={`detail-status ${market.phase === "live" ? "is-live" : ""}`}>
                {DETAIL_PHASE[market.phase]}{deadline !== null && <> · <span aria-label={DEADLINE_LABEL[market.phase]}><Countdown to={deadline} /></span></>}
            </p>
        </div>
    </header>;
}
