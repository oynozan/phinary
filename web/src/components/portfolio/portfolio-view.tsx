"use client";
import { useState } from "react";
import { toast } from "sonner";
import { WalletDialog } from "@/components/wallet/wallet-dialog";
import { useWalletSession, switchWalletNetwork } from "@/lib/onchain/wallet";
import { getConnectionConfig } from "@/lib/onchain/config";
import { useNow } from "@/lib/data";
import { PortfolioScreen } from "./portfolio-screen";

/** Real route: portfolio accounting/execution are not connected. Never mount preview fixtures here. */
export function PortfolioView() {
    const wallet = useWalletSession();
    const now = useNow();
    const [open, setOpen] = useState(false);
    const disconnected = wallet.status !== "connected";
    const wrong = !disconnected && wallet.chainId !== getConnectionConfig().chainId;
    const availability = disconnected ? "disconnected" : wrong ? "wrong-network" : "unavailable";
    const notice = disconnected ? <><span>Connect your wallet to view your portfolio.</span><button type="button" disabled={wallet.status === "connecting"} onClick={() => setOpen(true)}>Connect wallet</button></> : wrong ? <><span>Portfolio requires Unichain Sepolia.</span><button type="button" onClick={() => void switchWalletNetwork().catch((error: Error) => toast.error(error.message))}>Switch network</button></> : <span>Portfolio data is not connected yet. View individual token balances on the market detail page.</span>;
    return <><PortfolioScreen display={{ availability, rows: [], realized: null }} now={now ?? 0} notice={notice} /><WalletDialog open={open} onOpenChange={setOpen} /></>;
}
