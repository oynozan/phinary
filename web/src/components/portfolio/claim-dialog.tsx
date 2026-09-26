"use client";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatUsd } from "@/lib/format";
import { claimPlan, claimSequentially, type ClaimProgress, type PortfolioActions, type PortfolioRow } from "@/lib/portfolio/view-model";

function ClaimConfirmation({ rows, actions, onDone, onBusy }: { rows: PortfolioRow[]; actions: PortfolioActions; onDone: (message: string) => void; onBusy: (value: boolean) => void }) {
    const plan = claimPlan(rows);
    const [progress, setProgress] = useState<ClaimProgress | null>(null);
    const [busy, setBusy] = useState(false);
    async function submit() {
        if (busy || progress || !plan.marketIds.length || plan.amount === null) return;
        setBusy(true); onBusy(true);
        const result = await claimSequentially(plan.marketIds, actions.claimMarket, setProgress);
        setBusy(false); onBusy(false);
        onDone(`Claimed ${formatUsd(result.paid)}${result.failed ? `. ${result.failed} ${result.failed === 1 ? "claim" : "claims"} failed.` : "."}`);
    }
    return <>
        <DialogTitle>{progress ? busy ? "Claiming positions" : "Claim results" : "Confirm claim"}</DialogTitle>
        <DialogDescription>{progress ? "Successful claims are preserved." : `Claim ${plan.positions} ${plan.positions === 1 ? "position" : "positions"} for ${plan.amount === null ? "N/A" : formatUsd(plan.amount)}?`}</DialogDescription>
        {!progress && <p className="portfolio-dialog-note">{plan.marketIds.length} {plan.marketIds.length === 1 ? "transaction will" : "transactions will"} be submitted, one per market.</p>}
        {progress && <div className="portfolio-claim-progress" role="status"><p>{busy ? `Claiming ${Math.min(progress.completed + 1, progress.total)}/${progress.total}` : `${progress.completed - progress.failed}/${progress.total} claims completed`}</p><strong>Claimed {formatUsd(progress.paid)}</strong>{progress.failed > 0 && <p className="portfolio-negative">{progress.failed} {progress.failed === 1 ? "claim" : "claims"} failed. Remaining positions are still available.</p>}</div>}
        {!progress && <button type="button" className="portfolio-primary" disabled={!plan.marketIds.length || plan.amount === null} onClick={() => void submit()}>Confirm claim</button>}
    </>;
}
export function ClaimAllDialog({ rows, actions, onClose, onDone, restoreFocus }: { restoreFocus: () => void; rows: PortfolioRow[] | null; actions?: PortfolioActions; onClose: () => void; onDone: (message: string) => void }) {
    const [busy, setBusy] = useState(false);
    return <Dialog open={rows !== null && Boolean(actions)} onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="portfolio-dialog" onCloseAutoFocus={(e) => { e.preventDefault(); restoreFocus(); }} showCloseButton={!busy} onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }} onPointerDownOutside={(e) => { if (busy) e.preventDefault(); }}>
        {rows && actions && <ClaimConfirmation rows={rows} actions={actions} onDone={onDone} onBusy={setBusy} />}
    </DialogContent></Dialog>;
}
