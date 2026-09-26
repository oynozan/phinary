"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatUnits } from "viem";
import { Button } from "@/components/ui/button";
import { WalletDialog } from "@/components/wallet/wallet-dialog";
import { retryMarkets, useNow } from "@/lib/data";
import { getConnectionConfig } from "@/lib/onchain/config";
import { parseUsdc } from "@/lib/onchain/buy";
import { useBuyQuote } from "@/lib/onchain/use-buy-quote";
import { useTokenBalance } from "@/lib/onchain/balances";
import { useWalletSession, refreshWalletBalances, switchWalletNetwork } from "@/lib/onchain/wallet";
import { buyUp, checkPendingTransaction, useTransaction } from "@/lib/onchain/transactions";
import { formatCents, formatTokens, formatUsd } from "@/lib/format";
import { isResolved, payoutPerToken } from "@/lib/phase";
import { detailCanBuy, purchaseSummary, DETAIL_PHASE } from "@/lib/markets/detail";
import type { Market } from "@/lib/types";
import type { TradeForm } from "./types";

export const TRADE_INPUT_ID = "trade-amount";
const explorer = "https://sepolia.uniscan.xyz/tx/";

export function TradeCard({ market, form, onFormChange, className, holdings }: {
    market: Market; form: TradeForm; onFormChange: React.Dispatch<React.SetStateAction<TradeForm>>; className?: string; holdings: ReturnType<typeof useTokenBalance>;
}) {
    const wallet = useWalletSession();
    const transaction = useTransaction();
    const now = useNow();
    const refreshHoldings = holdings.refresh;
    const [open, setOpen] = useState(false);
    const [slippage, setSlippage] = useState(100);
    const [reviewed, setReviewed] = useState<ReturnType<typeof useBuyQuote>["quote"]>();
    const wrongNetwork = wallet.chainId !== null && wallet.chainId !== getConnectionConfig().chainId;
    const supported = form.side === "up" && form.mode === "buy";
    const live = detailCanBuy(market, now);
    const locked = transaction.busy || Boolean(transaction.pending);
    const quoteQuery = useBuyQuote(market.id, form.amount, slippage, wallet.address, supported && live && !locked && !wrongNetwork);
    const quote = locked ? reviewed : quoteQuery.quote;
    const ownResult = transaction.result?.marketId === market.id && transaction.result.account === wallet.address ? transaction.result : undefined;
    useEffect(() => {
        if (transaction.result?.marketId === market.id) {
            void refreshHoldings(); retryMarkets(market.id); retryMarkets();
        }
    }, [transaction.result, market.id, refreshHoldings]);
    let amount = 0n;
    try { amount = parseUsdc(form.amount); } catch { /* invalid input disables submit */ }
    const reason = !supported ? "Only UP purchases are available in this phase" : !live ? "Trading closed or unavailable" :
        amount <= 0n ? "Enter an amount" : quoteQuery.error ? quoteQuery.error : !quote ? "Getting quote" :
        (now ?? quote.blockTime) - quote.blockTime > 15 ? "Refreshing quote" : wallet.usdc === null ? "USDC balance unavailable" :
        amount > wallet.usdc ? "Not enough USDC" : wallet.eth === null ? "ETH balance unavailable" : wallet.eth === 0n ? "Test ETH required for gas" : null;
    const hash = transaction.pending?.hash ?? ownResult?.hash ?? transaction.progress?.hash;
    const submit = async () => {
        if (reason || !quote || locked) return;
        setReviewed(quote);
        try { await buyUp(quote); onFormChange((old) => ({ ...old, amount: "", max: false })); }
        catch { /* shared transaction status shows the error, including unresolved receipts */ }
    };
    const summary = supported && quote ? purchaseSummary(quote.amountIn, quote.amountOut) : null;
    const resolved = isResolved(market.phase);
    const setAmount = (amount: string, max = false) => onFormChange((old) => ({ ...old, amount, max }));
    const inputDisabled = locked || !supported || !live || wrongNetwork;
    return <section aria-label="Trade" className={`detail-panel detail-trade ${className ?? ""}`}>
        <div className="detail-trade-heading"><div><h2>{resolved ? "Settlement" : "Trade"}</h2><p>{resolved ? DETAIL_PHASE[market.phase] : "Buy tokens in this market"}</p></div>
            {!resolved && <div className="detail-segments" role="group" aria-label="Trade mode"><button type="button" aria-pressed={form.mode === "buy"} disabled={locked} onClick={() => onFormChange((old) => ({ ...old, mode: "buy", amount: "", max: false }))}>Buy</button><button type="button" aria-pressed={form.mode === "sell"} disabled title="Selling is not connected yet">Sell</button></div>}
        </div>
        {resolved ? <><dl className="detail-quote-summary"><div><dt>UP payout / token</dt><dd>{formatUsd(payoutPerToken(market.phase, "up") ?? 0)}</dd></div><div><dt>DOWN payout / token</dt><dd>{formatUsd(payoutPerToken(market.phase, "down") ?? 0)}</dd></div></dl><p className="detail-note">Your token balances and redeemable value appear in Your Position. Claiming is not connected yet.</p><button type="button" className="detail-primary" disabled>Claim unavailable</button></> : <>
            <fieldset className="detail-side-field"><legend>Select side</legend><div className="detail-sides">{(["up", "down"] as const).map((side) => <button type="button" key={side} className={`detail-${side}`} aria-pressed={form.side === side} disabled={locked} onClick={() => onFormChange((old) => ({ ...old, side, mode: "buy", amount: "", max: false }))}><strong>{side === "up" ? "▲ UP" : "▼ DOWN"}</strong><span>{market.quote ? formatCents(side === "up" ? market.quote.askUp : market.quote.askDown) : "N/A"}</span></button>)}</div></fieldset>
            <p className="detail-note">{supported ? "UP purchases only. Selling is not connected yet." : "DOWN is preview only. Purchases are not connected yet."}</p>
            <div className="detail-amount-label"><label htmlFor={TRADE_INPUT_ID}>Amount</label><span>Balance: {wallet.status !== "connected" || wrongNetwork || wallet.usdc === null ? "N/A" : `${formatTokens(Number(formatUnits(wallet.usdc, 6)))} USDC`}</span></div>
            <div className="detail-amount"><input id={TRADE_INPUT_ID} inputMode="decimal" autoComplete="off" placeholder="0.00" value={form.amount} disabled={inputDisabled} onChange={(event) => setAmount(event.target.value)} aria-describedby="trade-availability" /><span>USDC</span></div>
            <div className="detail-quick">{[10, 50, 100].map((value) => <button type="button" key={value} aria-pressed={!form.max && Number(form.amount) === value} disabled={inputDisabled} onClick={() => setAmount(String(value))}>${value}</button>)}<button type="button" aria-pressed={form.max} disabled={inputDisabled || wallet.status !== "connected" || wallet.usdc === null} onClick={() => { if (wallet.usdc !== null) setAmount(formatUnits(wallet.usdc, 6), true); }}>Max</button></div>
            <dl className="detail-quote-summary" aria-live="polite"><div><dt>You receive</dt><dd className="detail-up">{summary ? `${formatTokens(summary.payout)} UP` : "N/A"}</dd></div><div><dt>Avg price</dt><dd>{summary ? formatCents(summary.average, 1) : "N/A"}</dd></div><div><dt>Potential payout</dt><dd>{summary ? formatUsd(summary.payout) : "N/A"}</dd></div><div><dt>Potential profit</dt><dd className={summary && summary.profit < 0 ? "detail-down" : "detail-positive"}>{summary ? formatUsd(summary.profit, { signed: true }) : "N/A"}</dd></div></dl>
            <p className="detail-note">Payout and profit assume UP wins. Gas costs excluded.</p>
            <div className="detail-submit">
                {!supported || !live ? <button type="button" className="detail-primary" disabled>{!supported ? "DOWN purchase unavailable" : DETAIL_PHASE[market.phase] === "Live" ? "Quote unavailable" : DETAIL_PHASE[market.phase]}</button> : wallet.status !== "connected" ? <button type="button" className="detail-primary" disabled={wallet.status === "connecting" || locked} onClick={() => setOpen(true)}>Connect wallet</button> :
                    wrongNetwork ? <button type="button" className="detail-primary" disabled={locked} onClick={() => { void switchWalletNetwork().catch((error: Error) => toast.error(error.message)); }}>Switch to Unichain Sepolia</button> :
                    <button type="button" className="detail-primary" disabled={Boolean(reason) || locked} onClick={() => void submit()}>{transaction.busy ? transaction.progress?.message ?? "Checking order" : transaction.pending ? "Confirmation pending" : "Buy UP"}</button>}
            </div>
            <p id="trade-availability" className="detail-note" role="status">{reason && !quoteQuery.error ? reason : null}</p>
            <details className="detail-advanced"><summary>Advanced details</summary><div>
                <label>Slippage tolerance<select aria-label="Slippage tolerance" value={slippage} disabled={locked} onChange={(event) => setSlippage(Number(event.target.value))}><option value={100}>1%</option><option value={500}>5%</option><option value={1000}>10%</option></select></label>
                <p><span>Minimum receive</span><span>{supported && quote ? `${formatUnits(quote.minimumOut, 6)} ETHUP` : "N/A"}</span></p>
                <p><span>Your ETHUP</span><span>{holdings.data == null ? "N/A" : formatUnits(holdings.data, 6)}</span></p>
            </div></details>
        </>}
        {wallet.balanceError && <Button variant="outline" className="mt-3 w-full" onClick={() => void refreshWalletBalances()}>Retry balances</Button>}
        <div aria-live="polite" className="detail-transaction-status">
            {transaction.progress && <p>{transaction.progress.step === "approve" ? "1. Approve" : transaction.progress.step === "sign" ? "2. Sign" : "3. Purchase"}: {transaction.progress.message}</p>}
            {quoteQuery.error && !locked && <p role="alert" className="detail-down">{quoteQuery.error}</p>}
            {transaction.error && <p role="alert" className="detail-down">{transaction.error}</p>}
            {ownResult && <p>Purchase confirmed{ownResult.qty === undefined ? ". Check your updated balance." : `: ${formatUnits(ownResult.qty, 6)} ETHUP`}</p>}
            {hash && <a href={`${explorer}${hash}`} target="_blank" rel="noreferrer">View transaction</a>}
            {transaction.pending && <Button variant="outline" disabled={transaction.busy} onClick={() => void checkPendingTransaction()}>Check confirmation</Button>}
        </div>
        <WalletDialog open={open} onOpenChange={setOpen} />
    </section>;
}
