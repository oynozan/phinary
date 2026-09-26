"use client";

import { formatUnits } from "viem";
import { CircleDollarSign } from "lucide-react";
import { useWalletSession } from "@/lib/onchain/wallet";
import { cn } from "@/lib/utils";

export function BalancePill({ className }: { className?: string }) {
    const wallet = useWalletSession();
    if (wallet.status !== "connected") return null;
    return <div className={cn("flex h-11 items-center gap-2 rounded-full border bg-surface-2 px-5 font-secondary text-base", className)}>
        <CircleDollarSign className="header-usdc-icon size-5 shrink-0" aria-hidden="true" />
        <span className="num font-semibold">{wallet.usdc === null ? "Unavailable" : formatUnits(wallet.usdc, 6)}</span>
        <span className="text-muted-foreground">USDC</span>
    </div>;
}
