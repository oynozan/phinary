"use client";

import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CHAIN } from "@/config/brand";
import { useWallet } from "@/lib/data";

/** Pill at the top of the page content; renders only when the wallet is on another chain. */
export function WrongNetworkBanner() {
    const wallet = useWallet();
    if (!wallet.isConnected || !wallet.wrongNetwork) return null;

    return (
        <div className="-mt-6 mb-8 flex justify-center px-4">
            <div className="flex items-center gap-3 rounded-full border border-down bg-surface py-1.5 pr-1.5 pl-4 text-sm">
                <TriangleAlert className="size-4 text-down" />
                <span>Wrong network</span>
                <Button size="sm" onClick={() => wallet.switchNetwork()}>
                    Switch to {CHAIN.name}
                </Button>
            </div>
        </div>
    );
}
