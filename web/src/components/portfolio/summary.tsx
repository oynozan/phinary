import { formatUsd } from "@/lib/format";
import { portfolioTotals, type PortfolioDisplay } from "@/lib/portfolio/view-model";

export function PortfolioSummary({ display, onClaimAll, claimEnabled }: { display: PortfolioDisplay; onClaimAll: () => void; claimEnabled: boolean }) {
    const totals = portfolioTotals(display);
    const metrics = [
        ["Total portfolio value", totals.total, false], ["Unrealised P&L", totals.unrealized, true],
        ["Realised P&L", totals.realized, true], ["Open positions", totals.openCount, false], ["Claimable balance", totals.claimable, false],
    ] as const;
    return <section className="portfolio-summary" aria-label="Portfolio summary">
        <dl>{metrics.map(([label, value, signed]) => <div key={label}><dt>{label}</dt><dd className={signed && value !== null ? value > 0 ? "portfolio-positive" : value < 0 ? "portfolio-negative" : "" : ""}>{value === null ? "N/A" : label === "Open positions" ? value : formatUsd(value, { signed })}</dd></div>)}</dl>
        <button type="button" className="portfolio-primary" onClick={onClaimAll} disabled={!claimEnabled} title={!claimEnabled ? "Claiming is unavailable or there are no claimable positions" : undefined}>Claim all</button>
    </section>;
}
