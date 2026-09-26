"use client";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import { WalletDialog } from "@/components/wallet/wallet-dialog";
import { useWalletSession, switchWalletNetwork } from "@/lib/onchain/wallet";
import { getConnectionConfig } from "@/lib/onchain/config";
import { useNow } from "@/lib/data";
import { PortfolioScreen } from "./portfolio-screen";

/** Live balances and execution; preview fixtures never enter this route. */
import { useLivePortfolio } from "@/lib/portfolio/use-portfolio";
import { captureWallet } from "@/lib/onchain/wallet";
import { fetchBuyQuote } from "@/lib/onchain/buy";
import { buyUp, claimMarket, useTransaction, checkPendingTransaction } from "@/lib/onchain/transactions";
import type { PortfolioActions } from "@/lib/portfolio/view-model";
export function PortfolioView() {
    const wallet = useWalletSession();
    const now = useNow();
    const query = useLivePortfolio();
    const transaction = useTransaction();
    const actions = useMemo<PortfolioActions>(() => {
        const expected = wallet.address;
        const ensureAccount = () => {
            const session = captureWallet();
            if (!expected || session.account.toLowerCase() !== expected.toLowerCase()) throw new Error("Wallet changed. Reopen the dialog.");
            return session;
        };
        return ({
        quoteSell: async (row, amount) => {
            const session = ensureAccount();
            const review = await fetchBuyQuote(session.client, row.marketId, amount, "auto", session.account, undefined, row.side, "sell");
            return { usdc: Number(review.amountOut) / 1e6, averagePrice: Number(review.amountOut) / Number(amount), review };
        },
        sell: async (row, amount, quote) => {
            ensureAccount();
            if (!quote.review || quote.review.marketId !== row.marketId || quote.review.amountIn !== amount || quote.review.side !== row.side || quote.review.mode !== "sell") throw new Error("Review a fresh sell quote");
            const result = await buyUp(quote.review);
            return Number(result.usdc) / 1e6;
        },
        claimMarket: async id => { ensureAccount(); return Number(await claimMarket(id)) / 1e6; },
    }); }, [wallet.address]);
    const [open, setOpen] = useState(false);
    const disconnected = wallet.status !== "connected";
    const wrong = !disconnected && wallet.chainId !== getConnectionConfig().chainId;
    const availability = disconnected ? "disconnected" : wrong ? "wrong-network" : query.error ? "error" : !query.data ? "loading" : "ready";
    const notice = disconnected ? <><span>Connect your wallet to view your portfolio.</span><button type="button" disabled={wallet.status === "connecting"} onClick={() => setOpen(true)}>Connect wallet</button></> : wrong ? <><span>Portfolio requires Unichain Sepolia.</span><button type="button" onClick={() => void switchWalletNetwork().catch((error: Error) => toast.error(error.message))}>Switch network</button></> : <><span>{query.error ? "Portfolio could not be fully read. Retry before trading." : query.data ? "Balances updated from Unichain Sepolia." : "Loading your balances from Unichain Sepolia…"}</span><button type="button" onClick={() => void query.refresh()}>Refresh</button></>;
    return <><PortfolioScreen key={`${wallet.address}:${wallet.chainId}`} display={{ availability, rows: query.data?.rows ?? [], realized: null, historyComplete: false, accountingComplete: false }} now={now ?? 0} actions={actions} notice={<>{notice}{transaction.progress && <p>{transaction.progress.message}</p>}{transaction.error && <p role="alert">{transaction.error}</p>}{transaction.pending && <button type="button" disabled={transaction.busy} onClick={() => void checkPendingTransaction()}>Check confirmation</button>}</>} /><WalletDialog open={open} onOpenChange={setOpen} /></>;
}
