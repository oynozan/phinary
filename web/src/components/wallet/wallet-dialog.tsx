"use client";

import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { connectWallet, useWalletSession } from "@/lib/onchain/wallet";

export function WalletDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const wallet = useWalletSession();
    return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-sm">
        <DialogTitle className="text-center">Connect wallet</DialogTitle>
        {wallet.options.length === 0 && <p className="text-center text-muted-foreground">No browser wallet found. Enable a wallet extension and reload.</p>}
        {wallet.options.map((option) => <Button key={option.id} variant="outline" disabled={wallet.status === "connecting"} onClick={async () => {
            try { await connectWallet(option.id); onOpenChange(false); }
            catch (error) { toast.error(error instanceof Error ? error.message : "Could not connect"); }
        }}>{wallet.status === "connecting" ? "Connecting" : option.name}</Button>)}
    </DialogContent></Dialog>;
}
