"use client";

import { Droplet } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/data";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

/** USDC balance, or "Get test funds" when the wallet is empty. Hidden when disconnected. */
export function BalancePill({ className }: { className?: string }) {
    const wallet = useWallet();
    if (wallet.isLoading || !wallet.isConnected) return null;

    if (wallet.usdc < 0.01) {
        return (
            <Button
                variant="outline"
                className={cn("h-11 gap-2 border-primary/50 px-5 text-base text-primary hover:bg-primary/10 hover:text-primary", className)}
                disabled={wallet.dripping || wallet.wrongNetwork}
                onClick={async () => {
                    try {
                        const r = await wallet.requestTestFunds();
                        toast.success(`${formatUsd(r.usdc)} USDC received`);
                    } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Drip failed");
                    }
                }}
            >
                <Droplet className="size-4" />
                {wallet.dripping ? "Sending" : "Get test funds"}
            </Button>
        );
    }

    return (
        <div className={cn("flex h-11 items-center gap-2 rounded-full border bg-background/20 px-5 font-secondary text-base", className)}>
            <span className="num font-semibold">{formatUsd(wallet.usdc)}</span>
            <span className="text-muted-foreground">USDC</span>
        </div>
    );
}
