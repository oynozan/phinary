"use client";
import { useRef, useState, type ReactNode } from "react";
import { claimPlan, partitionPortfolio, type PortfolioActions, type PortfolioDisplay, type PortfolioRow } from "@/lib/portfolio/view-model";
import { PortfolioSummary } from "./summary";
import { PositionsTable } from "./positions";
import { HistoryTable } from "./history";
import { SellDialog } from "./sell-dialog";
import { ClaimAllDialog } from "./claim-dialog";
import "./portfolio.css";

export function PortfolioScreen({ display, now, actions, notice, marketBase = "" }: { display: PortfolioDisplay; now: number; actions?: PortfolioActions; notice?: ReactNode; marketBase?: string }) {
    const opener = useRef<HTMLElement | null>(null);
    const heading = useRef<HTMLHeadingElement | null>(null);
    function captureFocus() { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }
    function restoreFocus() { if (opener.current?.isConnected && !opener.current.matches(":disabled")) opener.current.focus(); else heading.current?.focus(); }
    const [sellId, setSellId] = useState<string | null>(null);
    const [claimRows, setClaimRows] = useState<PortfolioRow[] | null>(null);
    const [message, setMessage] = useState("");
    const { open, claimable, history } = partitionPortfolio(display.rows);
    const actionEnabled = display.availability === "ready" && Boolean(actions);
    const sellTarget = sellId ? display.rows.find((r) => r.id === sellId) ?? null : null;
    const shared = { availability: display.availability, now, actionsEnabled: actionEnabled, onSell: (row: PortfolioRow) => { captureFocus(); setMessage(""); setSellId(row.id); }, onClaim: (row: PortfolioRow) => { captureFocus(); setMessage(""); setClaimRows(claimable.filter((r) => r.marketId === row.marketId)); }, marketBase };
    return <div className="portfolio-page"><div className="portfolio-container">
        <header className="page-head"><h1 ref={heading} tabIndex={-1}>Portfolio</h1></header>
        {display.availability === "disconnected" ? <section className="portfolio-connect" aria-label="Connect wallet">
            {notice && <div className="portfolio-notice">{notice}</div>}
        </section> : <>
        {notice && <div className={`portfolio-notice ${display.availability === "ready" ? "portfolio-notice-ready" : ""}`}>{notice}</div>}
        <PortfolioSummary display={display} claimEnabled={actionEnabled && claimPlan(claimable).marketIds.length > 0 && claimPlan(claimable).amount !== null} onClaimAll={() => { captureFocus(); setMessage(""); setClaimRows(claimable); }} />
        {message && <div className="portfolio-toast" role="status">{message}<button type="button" aria-label="Dismiss notification" onClick={() => setMessage("")}>Dismiss</button></div>}
        <PositionsTable {...shared} rows={open} section="open" /><PositionsTable {...shared} rows={claimable} section="claimable" /><HistoryTable {...shared} rows={history} historyComplete={display.historyComplete} />
        {display.accountingComplete === false && <p className="portfolio-availability-note">Cost basis and P&amp;L are not available yet.</p>}
        {!actions && <p className="portfolio-availability-note">Selling and claiming are not connected yet.</p>}
        </>}
        <SellDialog restoreFocus={restoreFocus} row={sellTarget} actions={actions} now={now} onClose={() => setSellId(null)} onDone={(result) => { setMessage(result); setSellId(null); }} />
        <ClaimAllDialog restoreFocus={restoreFocus} rows={claimRows} actions={actions} onClose={() => setClaimRows(null)} onDone={setMessage} />
    </div></div>;
}
