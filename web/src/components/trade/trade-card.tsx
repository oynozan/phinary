"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatUnits } from "viem";
import { Panel } from "@/components/layout/panel";
import { AmountInput, AssetChip, SwapOutput, SwapStack } from "@/components/market";
import { Button } from "@/components/ui/button";
import { LiquidMetalButton } from "@/components/ui/liquid-metal-button";
import { WalletDialog } from "@/components/wallet/wallet-dialog";
import { retryMarkets, useNow } from "@/lib/data";
import { getConnectionConfig } from "@/lib/onchain/config";
import { parseUsdc } from "@/lib/onchain/buy";
import { useBuyQuote } from "@/lib/onchain/use-buy-quote";
import { useTokenBalance } from "@/lib/onchain/balances";
import { useWalletSession, refreshWalletBalances, switchWalletNetwork } from "@/lib/onchain/wallet";
import { buyUp, checkPendingTransaction, useTransaction } from "@/lib/onchain/transactions";
import type { Market } from "@/lib/types";
import type { TradeForm } from "./types";

export const TRADE_INPUT_ID = "trade-amount";
const explorer = "https://sepolia.uniscan.xyz/tx/";

export function TradeCard({ market, form, onFormChange, className }: {
    market: Market; form: TradeForm; onFormChange: React.Dispatch<React.SetStateAction<TradeForm>>; className?: string;
}) {
    const wallet = useWalletSession();
    const transaction = useTransaction();
    const holdings = useTokenBalance(market.up);
    const now = useNow();
    const refreshHoldings = holdings.refresh;
    const [open, setOpen] = useState(false);
    const [slippage, setSlippage] = useState(100);
    const [reviewed, setReviewed] = useState<ReturnType<typeof useBuyQuote>["quote"]>();
    const wrongNetwork = wallet.chainId !== null && wallet.chainId !== getConnectionConfig().chainId;
    const supported = form.side === "up" && form.mode === "buy";
    const live = market.phase === "live" && now !== null && now < market.cutoff && Boolean(market.quote?.tradable);
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
    return <section aria-label="Buy UP" className={className}>
        <Panel className="mb-3 text-center text-sm text-muted-foreground">Buy UP on Unichain Sepolia. DOWN purchases, selling and claiming are not available yet.</Panel>
        {!supported && <Button className="mb-3 w-full" disabled={locked} onClick={() => onFormChange((old) => ({ ...old, side: "up", mode: "buy", amount: "", max: false }))}>Buy UP instead</Button>}
        <SwapStack top={<AmountInput id={TRADE_INPUT_ID} label="You pay" value={form.amount}
            onChange={(amount) => onFormChange((old) => ({ ...old, amount, max: false }))}
            disabled={locked || !supported} adornment={<AssetChip asset={{ kind: "usdc" }} />} />}
            bottom={<SwapOutput htmlFor={TRADE_INPUT_ID} label="Estimated receive" chip={<AssetChip asset={{ kind: "outcome", side: "up" }} />}
                value={quote ? formatUnits(quote.amountOut, 6) : "…"} />} />
        <div className="mt-3 space-y-2 px-1 font-secondary text-sm">
            <label className="flex items-center justify-between gap-3">Slippage tolerance
                <select aria-label="Slippage tolerance" className="rounded-full border bg-surface-2 px-3 py-2" value={slippage} disabled={locked} onChange={(event) => setSlippage(Number(event.target.value))}>
                    <option value={100}>1%</option><option value={500}>5%</option><option value={1000}>10%</option>
                </select>
            </label>
            <p className="flex justify-between"><span className="text-muted-foreground">Minimum receive</span><span>{quote ? `${formatUnits(quote.minimumOut, 6)} ETHUP` : "Unavailable"}</span></p>
            {wallet.address && <>
                <p className="flex justify-between"><span className="text-muted-foreground">USDC balance</span><span>{wallet.usdc === null ? "Unavailable" : formatUnits(wallet.usdc, 6)}</span></p>
                <p className="flex justify-between"><span className="text-muted-foreground">Your ETHUP</span><span>{holdings.data === undefined || holdings.data === null ? "Unavailable" : formatUnits(holdings.data, 6)}</span></p>
            </>}
        </div>
        <div className="mt-4">
            {wallet.status !== "connected" ? <Button size="xl" className="w-full" disabled={wallet.status === "connecting" || locked} onClick={() => setOpen(true)}>Connect wallet</Button> :
                wrongNetwork ? <Button size="xl" className="w-full" disabled={locked} onClick={() => { void switchWalletNetwork().catch((error: Error) => toast.error(error.message)); }}>Switch to Unichain Sepolia</Button> :
                <LiquidMetalButton fullWidth disabled={Boolean(reason) || locked} onClick={() => void submit()} label={transaction.busy ? transaction.progress?.message ?? "Checking order" : transaction.pending ? "Confirmation pending" : reason ?? "Buy UP"} />}
        </div>
        {wallet.balanceError && <Button variant="outline" className="mt-3 w-full" onClick={() => void refreshWalletBalances()}>Retry balances</Button>}
        <div aria-live="polite" className="mt-3 space-y-2 text-center text-sm">
            {transaction.progress && <p>{transaction.progress.step === "approve" ? "1. Approve" : transaction.progress.step === "sign" ? "2. Sign" : "3. Purchase"}: {transaction.progress.message}</p>}
            {quoteQuery.error && !locked && <p role="alert" className="text-down">{quoteQuery.error}</p>}
            {transaction.error && <p role="alert" className="text-down">{transaction.error}</p>}
            {ownResult && <p>Purchase confirmed{ownResult.qty === undefined ? ". Check your updated balance." : `: ${formatUnits(ownResult.qty, 6)} ETHUP`}</p>}
            {hash && <a className="text-primary underline" href={`${explorer}${hash}`} target="_blank" rel="noreferrer">View transaction</a>}
            {transaction.pending && <Button variant="outline" disabled={transaction.busy} onClick={() => void checkPendingTransaction()}>Check confirmation</Button>}
        </div>
        <WalletDialog open={open} onOpenChange={setOpen} />
    </section>;
}
