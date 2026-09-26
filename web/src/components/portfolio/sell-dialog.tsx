"use client";

import { useState } from "react";
import { Clock, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { AmountInput, AssetChip, Balance, Countdown, MarketQuestion, Profit, SwapOutput, SwapStack } from "@/components/market";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useQuote, useWallet } from "@/lib/data";
import { formatCents, formatNumber, formatTokens, formatUsd, tokenTicker } from "@/lib/format";
import { isTradable, nextDeadline } from "@/lib/phase";
import { previewSell } from "@/lib/trade";
import type { Position } from "@/lib/types";

// Inputs within a cent of the balance sell the whole position, so no dust is left behind
const FULL_TOLERANCE = 0.01;

function SellForm({ position: p, onDone }: { position: Position; onDone: () => void }) {
    const wallet = useWallet();
    const quote = useQuote(p.marketId).data ?? null;
    const balance = Math.floor(p.qty * 100) / 100;
    const [amount, setAmount] = useState(() => String(balance));
    const [submitting, setSubmitting] = useState(false);

    const ticker = tokenTicker(p.side);
    const parsed = Number(amount) || 0;
    const full = parsed > 0 && Math.abs(parsed - p.qty) < FULL_TOLERANCE;
    const qty = full ? p.qty : parsed;
    const over = !full && parsed > p.qty;
    const tradable = isTradable(p.market.phase) && !!quote?.tradable;
    const preview = quote && qty > 0 && !over ? previewSell(quote, p.side, qty) : null;
    const profit = preview ? preview.usdc - qty * p.avgPrice : 0;
    const deadline = nextDeadline(p.market, p.market.phase);

    const label = !tradable ? "Trading closed" : over ? `Not enough ${ticker}` : qty <= 0 ? "Enter an amount" : submitting ? "Selling" : "Sell";

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!preview || !tradable || submitting) return;
        setSubmitting(true);
        try {
            if (wallet.wrongNetwork) await wallet.switchNetwork();
            const t = await wallet.sell(p.marketId, p.side, qty);
            toast.success(`Sold ${formatTokens(t.qty)} ${ticker} for ${formatUsd(t.usdc)}`);
            onDone();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Sell failed");
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={submit} className="grid gap-5">
            <div className="px-10 text-center">
                <DialogTitle className="text-lg leading-tight">
                    <MarketQuestion strike={p.market.strike} expiry={p.market.expiry} as="span" />
                </DialogTitle>
                {deadline !== null && (
                    <p className="mt-1.5 inline-flex items-center gap-1 font-secondary text-xs text-muted-foreground">
                        <Clock aria-hidden className="size-3" />
                        <Countdown to={deadline} />
                    </p>
                )}
            </div>

            <SwapStack
                top={
                    <AmountInput
                        id="sell-amount"
                        label="You sell"
                        value={amount}
                        onChange={setAmount}
                        quick={[]}
                        max={p.qty}
                        disabled={submitting}
                        autoFocus
                        adornment={
                            <span className="flex items-center gap-3">
                                <Balance value={formatNumber(balance)} />
                                <AssetChip asset={{ kind: "outcome", side: p.side }} title={p.market.tokenName} />
                            </span>
                        }
                    />
                }
                bottom={
                    <SwapOutput
                        htmlFor="sell-amount"
                        chip={<AssetChip asset={{ kind: "usdc" }} />}
                        value={preview ? formatNumber(preview.usdc) : null}
                    />
                }
            />

            <dl className="-mt-2 flex items-center justify-between px-1 font-secondary text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                    <dt>Price</dt>
                    <dd className="num font-semibold text-foreground">
                        {preview ? formatCents(preview.avgPrice, 1) : quote ? formatCents(p.side === "up" ? quote.bidUp : quote.bidDown, 1) : "-"}
                    </dd>
                </div>
                <div className="flex items-center gap-1.5">
                    <dt>Profit</dt>
                    <dd className="font-semibold">
                        <Profit value={profit} />
                    </dd>
                </div>
            </dl>

            <Button type="submit" size="xl" className="w-full" disabled={!preview || !tradable || submitting}>
                {submitting && <LoaderCircle aria-hidden className="animate-spin" />}
                {label}
            </Button>
        </form>
    );
}

/** Quick sell from the positions table, styled as the stacked trade card. */
export function SellDialog({
    position,
    open,
    onOpenChange,
    nonce,
}: {
    position: Position | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** changes on every open so the form starts fresh */
    nonce: number;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="gap-0 p-5 sm:max-w-md sm:p-6" aria-describedby={undefined}>
                {position && <SellForm key={`${position.marketId}:${position.side}:${nonce}`} position={position} onDone={() => onOpenChange(false)} />}
            </DialogContent>
        </Dialog>
    );
}
