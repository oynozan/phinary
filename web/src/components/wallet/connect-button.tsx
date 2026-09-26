"use client";

import { useState } from "react";
import { WalletCards, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { TRADING_ENABLED, useWallet } from "@/lib/data";
import { shortAddress } from "@/lib/format";
import { formatUnits } from "viem";
import { useWalletSession } from "@/lib/onchain/wallet";
import { cn } from "@/lib/utils";

import { WalletDialog } from "./wallet-dialog";

const pill = "h-9 sm:h-11 px-4 sm:px-6 text-sm sm:text-base";

/** Header wallet control: Connect pill, or the address pill with a menu. */
export function ConnectButton({ className }: { className?: string }) {
    const wallet = useWallet();
    const session = useWalletSession();
    const router = useRouter();
    const [open, setOpen] = useState(false);

    if (!TRADING_ENABLED) return <Button className={cn(pill, className)} disabled>Read only</Button>;

    if (wallet.isLoading) return <Skeleton className={cn("h-9 w-28 rounded-full sm:h-11 sm:w-36", className)} />;

    if (!wallet.isConnected || !wallet.address) {
        return (
            <>
                <Button className={cn(pill, className)} disabled={wallet.status === "connecting"} onClick={() => setOpen(true)}>
                    <WalletCards className="size-4" aria-hidden="true" />
                    {wallet.status === "connecting" ? "Connecting" : "Connect wallet"}
                </Button>
                <WalletDialog open={open} onOpenChange={setOpen} />
            </>
        );
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" className={cn(pill, "gap-2", className)}>
                    <WalletCards className={cn("size-4", wallet.wrongNetwork ? "text-down" : "text-violet-300")} aria-hidden="true" />
                    <span className="wallet-address" title={wallet.address}>{shortAddress(wallet.address)}</span>
                    <ChevronDown className="wallet-chevron ml-3 size-3.5 text-muted-foreground" aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem className="font-secondary text-muted-foreground" disabled>
                    {session.usdc === null ? "Unavailable" : formatUnits(session.usdc, 6)} USDC
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => router.push("/portfolio")}>Portfolio</DropdownMenuItem>
                <DropdownMenuItem
                    onSelect={() => {
                        navigator.clipboard?.writeText(wallet.address ?? "").then(
                            () => toast.success("Address copied"),
                            () => undefined,
                        );
                    }}
                >
                    Copy address
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => wallet.disconnect()}>Disconnect</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
