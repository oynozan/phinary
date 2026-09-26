"use client";
import { formatUnits } from "viem";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatUsd } from "@/lib/format";
import { portfolioUnitPrice, amountText, canSell, tokenAmount, type PortfolioActions, type PortfolioRow, type SellPreview } from "@/lib/portfolio/view-model";

function SellForm({ row, now, actions, onDone, onBusy }: { row: PortfolioRow; now: number; actions: PortfolioActions; onDone: (message: string) => void; onBusy: (busy: boolean) => void }) {
    const [amount, setAmount] = useState(amountText(row.quantity));
    const [quoteState, setQuote] = useState<{ key: string; value?: SellPreview; error?: string }>({ key: "" });
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const units = tokenAmount(amount);
    const tradable = canSell(row, now);
    const valid = units !== null && units > 0n && units <= row.quantity;
    const quoteKey = `${row.id}:${amount}:${row.quantity}:${tradable}`;
    const quote = quoteState.key === quoteKey ? quoteState.value : undefined;
    const quoteError = quoteState.key === quoteKey ? quoteState.error : undefined;
    useEffect(() => {
        if (!valid || !tradable || units === null || submitting) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            void actions.quoteSell(row, units).then((value) => { if (!cancelled) setQuote({ key: quoteKey, value }); }).catch((e: unknown) => { if (!cancelled) setQuote({ key: quoteKey, error: e instanceof Error ? e.message : "Quote unavailable" }); });
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [actions, row, units, valid, tradable, quoteKey, submitting]);
    const reason = !tradable ? "Trading is closed" : units === null || units <= 0n ? "Enter a valid amount (up to 6 decimals)" : units > row.quantity ? "Amount exceeds your position balance" : quoteError ?? (!quote ? "Getting quote…" : null);
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (reason || !quote || units === null || submitting) return;
        setSubmitting(true); onBusy(true); setError("");
        try { const paid = await actions.sell(row, units, quote); onDone(`Sold ${amountText(units)} ${row.side.toUpperCase()}${typeof paid === "number" ? ` for ${formatUsd(paid)}` : ""}`); }
        catch (e) { setError(e instanceof Error ? e.message : "Sale failed. Try again."); }
        finally { setSubmitting(false); onBusy(false); }
    }
    return <form onSubmit={submit} className="portfolio-sell-form">
        <DialogTitle>Sell {row.side.toUpperCase()}</DialogTitle><DialogDescription>{row.question}</DialogDescription>
        <p className={`portfolio-${row.side}`}>{row.side === "up" ? "▲ UP" : "▼ DOWN"}<span>Balance: {amountText(row.quantity)} tokens</span></p>
        <label htmlFor="portfolio-sell-amount">Amount in tokens</label><input id="portfolio-sell-amount" value={amount} inputMode="decimal" autoComplete="off" disabled={submitting || !tradable} onChange={(e) => { setAmount(e.target.value); setError(""); }} aria-describedby="portfolio-sell-status" />
        <div className="portfolio-percentages">{[25, 50, 75, 100].map((percent) => <button type="button" key={percent} disabled={submitting || !tradable} onClick={() => setAmount(amountText(row.quantity * BigInt(percent) / 100n))}>{percent === 100 ? "Max" : `${percent}%`}</button>)}</div>
        <dl className="portfolio-dialog-quote"><div><dt>Expected USDC received</dt><dd>{quote && !reason ? formatUsd(quote.usdc) : "N/A"}</dd></div><div><dt>Average sell price</dt><dd>{quote && !reason ? portfolioUnitPrice(quote.averagePrice) : "N/A"}</dd></div></dl>
        {quote?.review && <p className="portfolio-dialog-note">Minimum receive: {formatUnits(quote.review.minimumOut, 6)} USDC · Slippage: {quote.review.slippageBps / 100}%</p>}
        <p id="portfolio-sell-status" role="status" className="portfolio-dialog-note">{reason}</p>{error && <p role="alert" className="portfolio-negative">{error}</p>}
        <button type="submit" className="portfolio-primary" disabled={submitting || Boolean(reason)}>{submitting ? "Selling…" : `Sell ${row.side.toUpperCase()}`}</button>
    </form>;
}
export function SellDialog({ row, now, actions, onClose, onDone, restoreFocus }: { restoreFocus: () => void; row: PortfolioRow | null; now: number; actions?: PortfolioActions; onClose: () => void; onDone: (message: string) => void }) {
    const [busy, setBusy] = useState(false);
    return <Dialog open={row !== null && Boolean(actions)} onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="portfolio-dialog" onCloseAutoFocus={(e) => { e.preventDefault(); restoreFocus(); }} showCloseButton={!busy} onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }} onPointerDownOutside={(e) => { if (busy) e.preventDefault(); }}>
        {row && actions && <SellForm key={row.id} row={row} now={now} actions={actions} onBusy={setBusy} onDone={onDone} />}
    </DialogContent></Dialog>;
}
