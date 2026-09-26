import { formatPrice } from "@/lib/format";
import { isResolved } from "@/lib/phase";
import { DETAIL_PHASE } from "@/lib/markets/detail";
import type { Market } from "@/lib/types";
import { DetailMetric, SettlementTimes, underlying, utcDate } from "./detail-presentation";

export function MarketRules({ market }: { market: Market }) {
    const resolved = isResolved(market.phase);
    return <section className="detail-panel detail-rules" aria-labelledby="rules-heading">
        <h2 id="rules-heading">Market Rules / Settlement</h2>
        <dl><DetailMetric label="Underlying">{underlying(market)} / USDC</DetailMetric>
            {resolved ? <><DetailMetric label="Settlement average">{market.settlementPrice === null ? "N/A" : formatPrice(market.settlementPrice)}</DetailMetric><DetailMetric label="Strike">{formatPrice(market.strike)}</DetailMetric><DetailMetric label="Result">{DETAIL_PHASE[market.phase]}</DetailMetric><DetailMetric label="Settled at">{market.settledAt === null ? "N/A" : utcDate(market.settledAt)}</DetailMetric></> : <SettlementTimes market={market} />}
        </dl>
        <p>{market.phase === "invalid" ? "Invalid market: each UP and DOWN token redeems for 0.50 USDC. Claiming is not connected yet." : `UP wins if the geometric-average ${underlying(market)} price during the settlement window is above ${formatPrice(market.strike)}. Equal or below resolves DOWN.`}</p>
    </section>;
}
