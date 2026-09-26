"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { ChevronRight, LoaderCircle, Wallet } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { connectWallet, useWalletSession } from "@/lib/onchain/wallet";
import "./wallet-dialog.css";

export function WalletDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const wallet = useWalletSession();
    const opener = useRef<HTMLElement | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const connecting = wallet.status === "connecting";
    const options = wallet.options.length ? wallet.options : [{ id: "io.metamask", name: "MetaMask" }];
    return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="wallet-dialog" onOpenAutoFocus={() => {
        setConnectionError(null);
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }} onCloseAutoFocus={(event) => {
        if (opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus();
        }
    }}>
        <div className="wallet-dialog-heading">
            <div className="wallet-dialog-brand" aria-hidden="true">
                <svg width="60" height="64" viewBox="0 0 30 32" fill="none">
                    <defs><linearGradient id="phinary-wallet-mark" x1="4" y1="3" x2="25" y2="29" gradientUnits="userSpaceOnUse"><stop stopColor="#72ddfa" /><stop offset=".48" stopColor="#9c83fa" /><stop offset="1" stopColor="#bd35f0" /></linearGradient></defs>
                    <path d="M15 7C8.1 7 3 10.5 3 16s5.1 9 12 9 12-3.5 12-9-5.1-9-12-9Z" stroke="url(#phinary-wallet-mark)" strokeWidth="5" />
                    <path d="M15 1v30" stroke="url(#phinary-wallet-mark)" strokeWidth="5" />
                </svg>
            </div>
            <DialogTitle>Connect to Phinary</DialogTitle>
            <DialogDescription>Choose a wallet to continue.</DialogDescription>
        </div>
        <div className="wallet-dialog-options">
            {options.map((option) => {
                const metamask = option.id === "io.metamask" || option.name.toLowerCase() === "metamask";
                const pending = connecting && selected === option.id;
                return <button type="button" className="wallet-option" key={option.id} disabled={connecting || !wallet.connectionReady} aria-label={`Connect ${option.name}`} aria-busy={pending} onClick={async () => {
                    setConnectionError(null);
                    setSelected(option.id);
                    try { await connectWallet(option.id); onOpenChange(false); }
                    catch (error) {
                        const message = error instanceof Error ? error.message : "Could not connect";
                        setConnectionError(message);
                    }
                    finally { setSelected(null); }
                }}>
                    <span className="wallet-option-icon">{metamask ? <Image src="/wallets/metamask.svg" alt="" width={36} height={36} /> : <Wallet size={28} aria-hidden="true" />}</span>
                    <span className="wallet-option-copy"><strong>{option.name}</strong><span>{pending ? `Confirm in ${option.name}` : 'Browser wallet'}</span></span>
                    {pending ? <LoaderCircle size={20} className="wallet-option-spinner" aria-hidden="true" /> : <ChevronRight size={20} aria-hidden="true" />}
                </button>;
            })}
        </div>
        {connectionError && <p className="wallet-dialog-error" role="alert">{connectionError}</p>}
        <p className="wallet-dialog-note" role="status">{!wallet.connectionReady ? 'Preparing wallet connection…' : 'Connecting does not submit a transaction.'}</p>
    </DialogContent></Dialog>;
}
