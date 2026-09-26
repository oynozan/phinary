import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCountdown, formatUsd } from "@/lib/format";
import { payoutPerToken } from "@/lib/phase";
import { claimPlan, portfolioUnitPrice, amountText, canSell, historyStatus, resultLabel, type PortfolioAvailability, type PortfolioRow, type PortfolioSection } from "@/lib/portfolio/view-model";

export function displayMoney(value: number | null, signed = false) { return value === null ? "N/A" : formatUsd(value, { signed }); }
function date(value: number | null) {
    return value === null ? "N/A" : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }).format(value * 1000) + " UTC";
}
function Profit({ row }: { row: PortfolioRow }) {
    return <span className={row.profit === null ? "" : row.profit > 0 ? "portfolio-positive" : row.profit < 0 ? "portfolio-negative" : ""}>{displayMoney(row.profit, true)}{row.profit !== null && row.profitPercent !== null && <small>({row.profitPercent > 0 ? "+" : ""}{row.profitPercent.toFixed(1)}%)</small>}</span>;
}
export const SECTION_COPY = {
    open: { title: "Open Positions", empty: "No open positions", columns: ["Market", "Side", "Amount", "Avg cost", "Current price", "Value", "P&L", "Time left", "Action"] },
    claimable: { title: "Claimable Positions", empty: "Nothing to claim right now.", columns: ["Market", "Result", "Amount", "Avg cost", "Payout", "Value", "Profit", "Settled", "Action"] },
    history: { title: "History", empty: "No position history yet.", columns: ["Market", "Result", "Amount", "Avg cost", "Payout", "Value", "Profit", "Settled", "Status"] },
};
function StateContent({ availability, section, marketBase }: { availability: PortfolioAvailability; section: PortfolioSection; marketBase: string }) {
    if (availability === "loading") return <div aria-label={`Loading ${SECTION_COPY[section].title}`} aria-busy className="portfolio-loading"><Skeleton /><Skeleton /><Skeleton /></div>;
    if (availability !== "ready") return <div className="portfolio-empty">{availability === "disconnected" ? "Connect your wallet to view this section." : availability === "wrong-network" ? "Switch to Unichain Sepolia to view this section." : availability === "error" ? "Portfolio data could not be loaded." : "Portfolio data is not connected yet."}</div>;
    return <div className="portfolio-empty"><p>{SECTION_COPY[section].empty}</p>{section === "open" && <><span>Explore markets to open a position.</span><a href={`${marketBase}/`}>Browse Markets</a></>}</div>;
}
export function PositionsTable({ rows, section, availability, now, actionsEnabled, onSell, onClaim, marketBase = "", historyComplete = true }: {
    rows: PortfolioRow[]; section: PortfolioSection; availability: PortfolioAvailability; now: number; actionsEnabled: boolean; onSell: (row: PortfolioRow) => void; onClaim: (row: PortfolioRow) => void; marketBase?: string; historyComplete?: boolean;
}) {
    const copy = SECTION_COPY[section];
    function cells(row: PortfolioRow) {
        const open = section === "open";
        const tradable = canSell(row, now);
        const deadline = row.phase === "upcoming" ? `Opens in ${formatCountdown(row.openTime - now)}` : tradable ? formatCountdown(row.cutoff - now) : "Awaiting settlement";
        const payout = payoutPerToken(row.phase, row.side);
        return [
            <a className="portfolio-market-link" href={`${marketBase}/market/${row.marketId}?side=${row.side}`} key="market"><strong>{row.question}</strong><small>{date(row.expiry)}</small></a>,
            open ? <span className={`portfolio-side portfolio-${row.side}`} key="side">{row.side === "up" ? "▲ UP" : "▼ DOWN"}</span> : <span className={`portfolio-result ${payout === 0 ? "portfolio-negative" : ""}`} key="result">{resultLabel(row)}</span>,
            amountText(row.quantity), portfolioUnitPrice(row.avgCost), portfolioUnitPrice(open ? row.currentPrice : payout), displayMoney(row.value), <Profit row={row} key="profit" />,
            open ? deadline : date(row.settledAt),
            section === "history" ? <span className="portfolio-history-status" key="status">{historyStatus(row)}</span> : <button type="button" key="action" className={open ? "portfolio-secondary" : "portfolio-claim"} disabled={!actionsEnabled || (open && !tradable) || (!open && !claimPlan(rows.filter(r => r.marketId === row.marketId)).marketIds.length)} onClick={() => open ? onSell(row) : onClaim(row)} aria-label={`${open ? "Sell" : "Claim"} ${row.side.toUpperCase()}, market ${row.marketId}`} title={!actionsEnabled ? "Not connected yet" : open && !tradable ? "Trading is closed" : undefined}>{open ? "Sell" : "Claim"}</button>,
        ];
    }
    return <section className="portfolio-section" aria-labelledby={`portfolio-${section}-heading`}>
        <div className="portfolio-section-heading"><div><h2 id={`portfolio-${section}-heading`}>{copy.title}</h2></div>{availability === "ready" && (section !== "history" || historyComplete) && <span>{rows.length} {rows.length === 1 ? "position" : "positions"}</span>}</div>
        {availability !== "ready" || rows.length === 0 ? <div className="portfolio-table-shell">{section === "history" && !historyComplete && availability === "ready" ? <div className="portfolio-empty">Complete transaction history is not available yet.</div> : <StateContent availability={availability} section={section} marketBase={marketBase} />}</div> : <>
            <div className="portfolio-table-shell portfolio-desktop"><Table><TableHeader><TableRow>{copy.columns.map((col) => <TableHead key={col}>{col}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.id}>{cells(row).map((value, i) => <TableCell key={copy.columns[i]}>{value}</TableCell>)}</TableRow>)}</TableBody></Table></div>
            <div className="portfolio-mobile">{rows.map((row) => { const values = cells(row); return <article className="portfolio-position-card" key={row.id}><div className="portfolio-card-title">{values[0]}{values[1]}</div><dl>{[5, 6, 2, 3, 4, 7].map((i) => <div key={copy.columns[i]}><dt>{copy.columns[i]}</dt><dd>{values[i]}</dd></div>)}</dl><div className="portfolio-card-action">{section === "history" && <span>Status</span>}{values[8]}</div></article>; })}</div>
        </>}
    </section>;
}
