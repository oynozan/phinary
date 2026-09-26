import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { PortfolioScreen } from "../../src/components/portfolio/portfolio-screen";
import { canSell, sectionOf, type PortfolioActions, type PortfolioAvailability } from "../../src/lib/portfolio/view-model";
import { sampleRows } from "./fixtures";
import "./preview.css";
const base = Math.floor(Date.now() / 1000);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const scenarios = ["Normal", "Empty", "Disconnected", "Wrong network", "Loading", "Unavailable", "RPC error", "Missing accounting", "Quote unavailable", "Sell rejected", "Trading closed", "Partial claim failure", "All claims fail"];
function PreviewState({ scenario }: { scenario: string }) {
    const [rows, setRows] = useState(() => scenario === "Empty" ? [] : sampleRows(base).map((r) => scenario === "Missing accounting" ? { ...r, avgCost: null, profit: null, profitPercent: null, value: sectionOf(r) === "open" ? null : r.value } : scenario === "Trading closed" && sectionOf(r) === "open" ? { ...r, phase: "closed" as const, tradable: false } : r));
    const [now, setNow] = useState(base);
    const [realized, setRealized] = useState(29.2);
    useEffect(() => { const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(timer); }, []);
    const availability: PortfolioAvailability = ({ Disconnected: "disconnected", "Wrong network": "wrong-network", Loading: "loading", Unavailable: "unavailable", "RPC error": "error" } as Record<string, PortfolioAvailability>)[scenario] ?? "ready";
    const actions: PortfolioActions = useMemo(() => ({
        async quoteSell(row, amount) {
            await pause(400);
            if (scenario === "Quote unavailable") throw Error("Quote unavailable. Try another amount or scenario.");
            if (!canSell(row, Math.floor(Date.now() / 1000)) || row.currentPrice === null) throw Error("Trading is closed");
            return { usdc: Number(amount) / 1e6 * row.currentPrice, averagePrice: row.currentPrice };
        },
        async sell(row, amount, quote) {
            await pause(1000);
            if (scenario === "Sell rejected") throw Error("Transaction rejected. No tokens were sold.");
            if (!canSell(row, Math.floor(Date.now() / 1000))) throw Error("Market closed before submission.");
            const ratio = Number(amount) / Number(row.quantity);
            setRows((old) => old.map((r) => r.id === row.id ? { ...r, quantity: r.quantity - amount, value: r.value === null ? null : r.value * (1 - ratio), profit: r.profit === null ? null : r.profit * (1 - ratio) } : r).filter((r) => r.quantity > 0n));
            if (row.avgCost !== null) setRealized((value) => value + quote.usdc - Number(amount) / 1e6 * row.avgCost!);
        },
        async claimMarket(marketId) {
            await pause(1000);
            if (scenario === "All claims fail" || scenario === "Partial claim failure" && marketId === 6) throw Error("Sample claim rejected");
            const targets = rows.filter((r) => r.marketId === marketId && sectionOf(r) === "claimable");
            const paid = targets.reduce((sum, r) => sum + (r.value ?? 0), 0);
            setRows((old) => old.map((r) => targets.some((t) => t.id === r.id) ? { ...r, disposition: r.phase === "invalid" ? "refunded" : "claimed" } : r));
            setRealized((value) => value + targets.reduce((sum, r) => sum + (r.profit ?? 0), 0));
            return paid;
        },
    }), [scenario, rows]);
    return <PortfolioScreen display={{ availability, rows: availability === "ready" ? rows : [], realized: scenario === "Missing accounting" ? null : realized }} now={now} actions={availability === "ready" ? actions : undefined} marketBase="http://localhost:3101" notice={availability !== "ready" ? <span>Preview scenario: {scenario}. No wallet or network request is made.</span> : undefined} />;
}
function Preview() {
    const [scenario, setScenario] = useState("Normal");
    const [revision, setRevision] = useState(0);
    return <>
        <header className="preview-header"><a className="preview-brand" href="http://localhost:3101"><svg width="30" height="32" viewBox="0 0 30 32" fill="none" aria-hidden="true"><defs><linearGradient id="preview-phi" x1="4" y1="3" x2="25" y2="29" gradientUnits="userSpaceOnUse"><stop stopColor="#72ddfa"/><stop offset=".48" stopColor="#9c83fa"/><stop offset="1" stopColor="#bd35f0"/></linearGradient></defs><path d="M15 7C8.1 7 3 10.5 3 16s5.1 9 12 9 12-3.5 12-9-5.1-9-12-9Z" stroke="url(#preview-phi)" strokeWidth="5"/><path d="M15 1v30" stroke="url(#preview-phi)" strokeWidth="5"/></svg>Phinary</a><nav>{["Markets", "Portfolio", "Activity", "Vault"].map((name) => <a key={name} aria-current={name === "Portfolio" ? "page" : undefined} href={name === "Portfolio" ? "/" : `http://localhost:3101/${name === "Markets" ? "" : name.toLowerCase()}`}>{name}</a>)}</nav><span className="preview-wallet">Sample wallet</span></header>
        <main><PreviewState key={`${scenario}:${revision}`} scenario={scenario}/></main>
        <aside className="preview-toolbar" aria-label="Preview controls"><strong>UI preview · Sample data</strong><label>Scenario <select value={scenario} onChange={(e) => setScenario(e.target.value)}>{scenarios.map((s) => <option key={s}>{s}</option>)}</select></label><button type="button" onClick={() => { location.reload(); }}>Reset clock & data</button><button type="button" onClick={() => setRevision((r) => r + 1)}>Reset actions</button><span>No transactions are sent.</span></aside>
    </>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
