"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AmountInput, AssetChip, Balance, SegmentedPills, SwapOutput, SwapStack } from "@/components/market";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletDialog } from "@/components/wallet/wallet-dialog";
import type { UseWallet } from "@/lib/data";
import { formatNumber, formatUsd } from "@/lib/format";
import type { VaultState } from "@/lib/types";

import { formatShareValue } from "./vault-summary";

type Mode = "deposit" | "withdraw";

const EPS = 1e-9;

/** Deposit and withdraw as an atomic.cash stacked swap card, the round arrow flips the direction */
export function VaultCard({ vault, wallet, className }: { vault: VaultState | undefined; wallet: UseWallet; className?: string }) {
    const [mode, setMode] = useState<Mode>("deposit");
    const [amount, setAmount] = useState("");
    const [pending, setPending] = useState(false);
    const [connectOpen, setConnectOpen] = useState(false);

    const deposit = mode === "deposit";
    const n = Number.parseFloat(amount) || 0;
    const price = vault?.shareValue ?? 0;
    const maxWithdraw = vault && price > 0 ? Math.max(0, Math.min(wallet.vaultShares, vault.idle / price)) : 0;
    const receive = price > 0 ? (deposit ? n / price : n * price) : 0;

    const switchMode = (next: Mode) => {
        if (next === mode) return;
        setMode(next);
        setAmount("");
    };

    async function submit() {
        setPending(true);
        try {
            if (deposit) {
                const shares = await wallet.vaultDeposit(n);
                toast.success(`Deposited ${formatUsd(n)} for ${formatNumber(shares)} shares`);
            } else {
                const assets = await wallet.vaultWithdraw(n);
                toast.success(`Withdrew ${formatUsd(assets)}`);
            }
            setAmount("");
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Transaction failed");
        } finally {
            setPending(false);
        }
    }

    async function drip() {
        try {
            const r = await wallet.requestTestFunds();
            toast.success(`${formatUsd(r.usdc)} USDC received`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Drip failed");
        }
    }

    const cta = (() => {
        const cls = "mt-3 w-full";
        if (wallet.isLoading || !vault) return <Skeleton className="mt-3 h-14 w-full rounded-full" />;
        if (!wallet.isConnected) {
            return (
                <Button size="xl" className={cls} disabled={wallet.status === "connecting"} onClick={() => setConnectOpen(true)}>
                    {wallet.status === "connecting" ? "Connecting" : "Connect"}
                </Button>
            );
        }
        if (wallet.wrongNetwork) {
            return (
                <Button size="xl" className={cls} onClick={() => void wallet.switchNetwork()}>
                    Switch network
                </Button>
            );
        }
        if (deposit && wallet.usdc < 0.01) {
            return (
                <Button size="xl" className={cls} disabled={wallet.dripping} onClick={() => void drip()}>
                    {wallet.dripping ? <Loader2 className="size-5 animate-spin" /> : null}
                    {wallet.dripping ? "Sending" : "Get test funds"}
                </Button>
            );
        }
        let blocked: string | null = null;
        if (!(n > 0)) blocked = "Enter an amount";
        else if (deposit && n > wallet.usdc + EPS) blocked = "Not enough USDC";
        else if (!deposit && n > wallet.vaultShares + EPS) blocked = "Not enough shares";
        else if (!deposit && n * price > vault.idle + EPS) blocked = "Exceeds idle funds";
        return (
            <Button size="xl" className={cls} disabled={!!blocked || pending} onClick={() => void submit()}>
                {pending && <Loader2 className="size-5 animate-spin" />}
                {pending ? (deposit ? "Depositing" : "Withdrawing") : (blocked ?? (deposit ? "Deposit" : "Withdraw"))}
            </Button>
        );
    })();

    const connected = !wallet.isLoading && wallet.isConnected;

    return (
        <div className={className}>
            <div className="mb-4 flex justify-center">
                <SegmentedPills<Mode>
                    aria-label="Action"
                    size="md"
                    value={mode}
                    onChange={switchMode}
                    options={[
                        { value: "deposit", label: "Deposit" },
                        { value: "withdraw", label: "Withdraw" },
                    ]}
                />
            </div>

            <SwapStack
                onFlip={() => switchMode(deposit ? "withdraw" : "deposit")}
                flipLabel={deposit ? "Switch to withdraw" : "Switch to deposit"}
                top={
                    <AmountInput
                        id="vault-amount"
                        value={amount}
                        onChange={setAmount}
                        label={deposit ? "You deposit" : "You withdraw"}
                        adornment={
                            <span className="flex items-center gap-3">
                                {connected && <Balance value={formatNumber(deposit ? wallet.usdc : wallet.vaultShares)} />}
                                <AssetChip asset={{ kind: deposit ? "usdc" : "shares" }} />
                            </span>
                        }
                        quick={deposit ? [10, 50, 100] : []}
                        max={connected ? (deposit ? wallet.usdc : maxWithdraw) : undefined}
                        disabled={pending}
                    />
                }
                bottom={
                    <SwapOutput
                        htmlFor="vault-amount"
                        chip={<AssetChip asset={{ kind: deposit ? "shares" : "usdc" }} />}
                        value={receive > 0 ? formatNumber(receive) : null}
                    >
                        <div className="num mt-3 flex h-7 items-center font-secondary text-xs text-muted-foreground">
                            {vault ? `1 share = ${formatShareValue(vault.shareValue)}` : <Skeleton className="h-4 w-28" />}
                        </div>
                    </SwapOutput>
                }
            />

            {cta}
            <WalletDialog open={connectOpen} onOpenChange={setConnectOpen} />
        </div>
    );
}
