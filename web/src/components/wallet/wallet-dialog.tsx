"use client";

import { Globe, Wallet } from "lucide-react";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useWallet } from "@/lib/data";

const OPTIONS = [
    { id: "browser", label: "Browser wallet", icon: Globe },
    { id: "demo", label: "Demo wallet", icon: Wallet },
] as const;

export function WalletDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const wallet = useWallet();

    async function choose() {
        try {
            await wallet.connect();
            onOpenChange(false);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not connect");
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-sm">
                <DialogTitle className="text-center font-heading text-xl font-medium">Connect</DialogTitle>
                <div className="flex flex-col gap-2">
                    {OPTIONS.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            type="button"
                            disabled={wallet.status === "connecting"}
                            onClick={choose}
                            className="flex h-14 items-center gap-3 rounded-2xl border bg-surface-2 px-4 text-left text-base transition-colors hover:border-primary hover:bg-surface-3 disabled:bg-surface disabled:text-subtle"
                        >
                            <span className="grid size-9 place-items-center rounded-full bg-primary-soft text-primary">
                                <Icon className="size-4.5" />
                            </span>
                            {label}
                        </button>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}
