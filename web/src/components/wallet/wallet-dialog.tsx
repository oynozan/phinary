"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { connectWallet, useWalletSession } from "@/lib/onchain/wallet";

/** Existing page entry points open Privy's single shared modal directly. */
export function WalletDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { connectionReady } = useWalletSession();
    const requested = useRef(false);
    useEffect(() => {
        if (!open) { requested.current = false; return; }
        if (!connectionReady || requested.current) return;
        requested.current = true;
        void connectWallet().catch(() => toast.error("Could not open wallet connection. Please try again."));
        onOpenChange(false);
    }, [open, connectionReady, onOpenChange]);
    return null;
}
