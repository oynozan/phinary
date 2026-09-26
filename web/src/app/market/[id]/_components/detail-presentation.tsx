import type { ReactNode } from "react";
import { Countdown } from "@/components/market/countdown";
import { getConnectionConfig } from "@/lib/onchain/config";
import { questionOf, underlyingOf } from "@/lib/markets/explorer";
import { formatCents, formatPercent, formatPrice, formatTimeSeconds } from "@/lib/format";
import { isResolved, payoutPerToken } from "@/lib/phase";
import { CHAIN } from "@/config/brand";
import type { Market } from "@/lib/types";

export const blockExplorer = "https://sepolia.uniscan.xyz";
export function underlying(market: Market) {
    return underlyingOf(market, { [getConnectionConfig().underlyingOracle.toLowerCase()]: { symbol: "ETH", name: "Ethereum" } }).symbol;
}
export function detailQuestion(market: Market) {
    return questionOf(market, { [getConnectionConfig().underlyingOracle.toLowerCase()]: { symbol: "ETH", name: "Ethereum" } });
}
export function utcDate(t: number) {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(t * 1000) + " UTC";
}
export function DetailMetric({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
    return <div className={`detail-metric ${className}`}><dt>{label}</dt><dd>{children}</dd></div>;
}
export function Overview({ market }: { market: Market }) {
    const q = market.quote;
    const resolved = isResolved(market.phase);
    const difference = q ? q.spot - market.strike : null;
    const up = resolved ? payoutPerToken(market.phase, "up") : q?.askUp;
    const down = resolved ? payoutPerToken(market.phase, "down") : q?.askDown;
    return <dl className="detail-panel detail-overview" aria-label="Market overview">
        <DetailMetric label={resolved ? "Settlement average" : "Spot"}>
            {resolved ? market.settlementPrice === null ? "N/A" : formatPrice(market.settlementPrice) : q ? formatPrice(q.spot) : "N/A"}
            {!resolved && difference !== null && <small className={difference >= 0 ? "detail-positive" : "detail-down"}>{difference === 0 ? "At strike" : `${formatPrice(Math.abs(difference))} ${difference > 0 ? "above" : "below"} strike`}</small>}
        </DetailMetric>
        <DetailMetric label="Strike">{formatPrice(market.strike)}</DetailMetric>
        <DetailMetric label={resolved ? "Result" : "Chance UP"}>{resolved ? market.phase === "invalid" ? "50/50" : market.upWon ? "UP" : "DOWN" : q ? formatPercent(q.midUp) : "N/A"}</DetailMetric>
        <DetailMetric label={resolved ? "UP payout / token" : "UP"} className="detail-up">▲ {up == null ? "N/A" : formatCents(up)}</DetailMetric>
        <DetailMetric label={resolved ? "DOWN payout / token" : "DOWN"} className="detail-down">▼ {down == null ? "N/A" : formatCents(down)}</DetailMetric>
    </dl>;
}
export function PricingExplanation({ market }: { market: Market }) {
    const q = market.quote;
    return <section className="detail-panel detail-pricing" aria-labelledby="pricing-heading">
        <div className="detail-section-title"><h2 id="pricing-heading">Why this price?</h2><p>Black-Scholes binary pricing, matched to the geometric-average settlement window.</p></div>
        <dl className="detail-pricing-grid">
            <DetailMetric label="Spot">{q ? formatPrice(q.spot) : "N/A"}</DetailMetric>
            <DetailMetric label="Strike">{formatPrice(market.strike)}</DetailMetric>
            <DetailMetric label="Time to expiry">{q ? <Countdown to={market.expiry} /> : "N/A"}</DetailMetric>
            <DetailMetric label="Volatility (annual)">{q ? formatPercent(q.sigma, 1) : "N/A"}</DetailMetric>
            <DetailMetric label="Chance UP" className="detail-model-output">{q ? formatPercent(q.midUp, 1) : "N/A"}</DetailMetric>
        </dl>
        {!q && <p className="detail-note">Live pricing is unavailable for this market state.</p>}
    </section>;
}
export function OnchainInfo({ market }: { market: Market }) {
    const config = getConnectionConfig();
    const address = (value: string) => <a href={`${blockExplorer}/address/${value}`} target="_blank" rel="noreferrer" title={value}>{value.slice(0, 8)}…{value.slice(-6)}<span className="sr-only"> (opens in a new tab)</span></a>;
    return <section className="detail-panel detail-onchain" aria-labelledby="onchain-heading">
        <h2 id="onchain-heading">Onchain Info</h2>
        <dl>{[["Network", CHAIN.name], ["Market ID", `#${market.id}`], ["Prediction Hook", address(config.predictionHook)], ["UP Token", address(market.up)], ["DOWN Token", address(market.down)], ["UP Pool", "N/A"], ["DOWN Pool", "N/A"]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </section>;
}
export function SettlementTimes({ market }: { market: Market }) {
    return <><DetailMetric label="Trading closes">{formatTimeSeconds(market.cutoff)} UTC</DetailMetric><DetailMetric label="Settlement window">{formatTimeSeconds(market.windowStart)} - {formatTimeSeconds(market.expiry)} UTC</DetailMetric></>;
}
