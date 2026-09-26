"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Droplet } from "lucide-react";
import { toast } from "sonner";

import { Panel } from "@/components/layout/panel";
import { AmountInput, AssetChip, Balance, Profit, SegmentedPills, SwapOutput, SwapStack, TokenIcon } from "@/components/market";
import { Button } from "@/components/ui/button";
import { LiquidMetalButton } from "@/components/ui/liquid-metal-button";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletDialog } from "@/components/wallet/wallet-dialog";
import { COLLATERAL_SYMBOL } from "@/config/brand";
import { useLiveMarketId, useNow, usePortfolio, useWallet } from "@/lib/data";
import { formatCents, formatCountdown, formatNumber, formatTokens, formatUsd, sideLabel, tokenTicker } from "@/lib/format";
import { isResolved } from "@/lib/phase";
import { previewBuy, previewSell } from "@/lib/trade";
import type { Market, Quote, Side } from "@/lib/types";
import { cn } from "@/lib/utils";

import { OutcomeSelector } from "./outcome-selector";
import { TradeSteps } from "./trade-steps";
import { amountString, parseAmount, type TradeForm, type TradeMode } from "./types";
import { useClaims } from "./use-claims";
import { useTradeFlow } from "./use-trade-flow";

export const TRADE_INPUT_ID = "trade-amount";

const QUICK_BUY = [1, 5, 10];
const SELL_FRACTIONS = [0.25, 0.5];
const EPS = 1e-9;

const MODES = [
    { value: "buy" as const, label: "Buy" },
    { value: "sell" as const, label: "Sell" },
];

const pill =
    "num rounded-full border bg-background/40 px-3 py-1 font-secondary text-xs font-semibold text-muted-foreground transition-colors outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40";

function priceOf(q: Quote, side: Side, mode: TradeMode) {
    if (mode === "buy") return side === "up" ? q.askUp : q.askDown;
    return side === "up" ? q.bidUp : q.bidDown;
}

function LiveLink({ id, side }: { id: number; side: Side }) {
    return (
        <Button variant="outline" size="lg" asChild>
            <Link href={`/market/${id}?side=${side}`}>
                Live market
                <ArrowRight aria-hidden />
            </Link>
        </Button>
    );
}

/** Resolved markets swap the form for the payout and a Claim for winners */
function OutcomeCard({ market, side }: { market: Market; side: Side }) {
    const wallet = useWallet();
    const portfolio = usePortfolio();
    const live = useLiveMarketId(market.id);
    const claims = useClaims();
    const invalid = market.phase === "invalid";
    const winner: Side = market.phase === "resolved-down" ? "down" : "up";
    const claimable = (portfolio.data?.positions ?? []).filter((p) => p.marketId === market.id).reduce((n, p) => n + p.claimable, 0);
    const claiming = claims.claiming === market.id;

    return (
        <Panel highlight className="flex flex-col items-center gap-6 px-6 py-10 text-center">
            <div className="flex items-center justify-center -space-x-3">
                {invalid ? (
                    <>
                        <TokenIcon side="up" size={56} />
                        <TokenIcon side="down" size={56} />
                    </>
                ) : (
                    <TokenIcon side={winner} size={64} />
                )}
            </div>
            <p className="font-heading text-3xl leading-tight font-medium">
                {invalid ? (
                    <>
                        <span className="num">$0.50</span> <span className="text-muted-foreground">each side</span>
                    </>
                ) : (
                    <>
                        <span className={winner === "up" ? "text-up" : "text-down"}>{tokenTicker(winner)}</span>{" "}
                        <span className="text-muted-foreground">pays</span> <span className="num">$1.00</span>
                    </>
                )}
            </p>
            {!wallet.isLoading && wallet.isConnected && claimable > 0 && (
                <Button size="xl" className="w-full" disabled={claims.busy} onClick={() => void claims.claimOne(market.id)}>
                    {claiming ? "Claiming" : `Claim ${formatUsd(claimable)}`}
                </Button>
            )}
            {live.data != null && <LiveLink id={live.data} side={side} />}
        </Panel>
    );
}

/** The market's trade box, laid out like atomic.cash's swap panel */
export function TradeCard({
    market,
    form,
    onFormChange,
    className,
}: {
    market: Market;
    form: TradeForm;
    onFormChange: React.Dispatch<React.SetStateAction<TradeForm>>;
    className?: string;
}) {
    if (isResolved(market.phase)) {
        return (
            <section aria-label="Outcome" className={cn("min-w-0", className)}>
                <OutcomeCard market={market} side={form.side} />
            </section>
        );
    }
    return <OrderForm market={market} form={form} onFormChange={onFormChange} className={className} />;
}

function OrderForm({
    market,
    form,
    onFormChange,
    className,
}: {
    market: Market;
    form: TradeForm;
    onFormChange: React.Dispatch<React.SetStateAction<TradeForm>>;
    className?: string;
}) {
    const wallet = useWallet();
    const portfolio = usePortfolio();
    const live = useLiveMarketId(market.id);
    const now = useNow();
    const flow = useTradeFlow();
    const [walletOpen, setWalletOpen] = useState(false);

    const { mode, side } = form;
    const q = market.quote;
    const tradable = market.phase === "live" && !!q?.tradable;
    const ticker = tokenTicker(side);
    const busy = flow.running;

    const position = (portfolio.data?.positions ?? []).find((p) => p.marketId === market.id && p.side === side) ?? null;
    const held = position?.qty ?? 0;

    const amount = parseAmount(form.amount);
    const sellQty = form.max ? held : amount;
    const preview = q ? (mode === "buy" ? previewBuy(q, side, amount) : previewSell(q, side, sellQty)) : null;
    const receive = mode === "buy" ? (preview?.qty ?? 0) : (preview?.usdc ?? 0);

    const prices: Record<Side, number | null> = {
        up: q ? priceOf(q, "up", mode) : null,
        down: q ? priceOf(q, "down", mode) : null,
    };

    const nextLive = market.phase === "live" ? null : (live.data ?? null);

    function blockedReason(): string | null {
        if (market.phase === "upcoming") return now === null ? "Upcoming" : `Opens in ${formatCountdown(market.openTime - now)}`;
        if (market.phase !== "live") return "Trading closed";
        if (!tradable) return "Trading paused";
        if (!((mode === "buy" ? amount : sellQty) > 0)) return "Enter an amount";
        if (mode === "buy" && amount > wallet.usdc + EPS) return `Not enough ${COLLATERAL_SYMBOL}`;
        if (mode === "sell" && sellQty > held + EPS) return `Not enough ${ticker}`;
        return null;
    }
    const reason = blockedReason();

    const activeStep = flow.steps
        ? flow.steps.approve === "active"
            ? "Approving"
            : flow.steps.sign === "active"
              ? "Signing"
              : flow.steps.swap === "active"
                ? "Swapping"
                : null
        : null;
    const label = activeStep ?? reason ?? `${mode === "buy" ? "Buy" : "Sell"} ${sideLabel(side)}`;

    function setMode(next: TradeMode) {
        onFormChange((f) => (f.mode === next ? f : { ...f, mode: next, amount: "", max: false }));
    }

    function setSide(next: Side) {
        onFormChange((f) => ({ ...f, side: next, amount: f.mode === "sell" ? "" : f.amount, max: false }));
    }

    function setAmount(value: string, max = false) {
        onFormChange((f) => ({ ...f, amount: value, max }));
    }

    async function submit() {
        if (reason || busy) return;
        const token = mode === "buy" ? COLLATERAL_SYMBOL : `${market.id}:${side}`;
        try {
            const trade = await flow.run(token, () =>
                mode === "buy" ? wallet.buy(market.id, side, amount) : wallet.sell(market.id, side, sellQty),
            );
            toast.success(`${trade.isBuy ? "Bought" : "Sold"} ${formatTokens(trade.qty)} ${ticker}`, {
                description: `${formatUsd(trade.usdc)} at ${formatCents(trade.price, 1)}`,
            });
            onFormChange((f) => ({ ...f, amount: "", max: false }));
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Trade failed");
        }
    }

    async function drip() {
        try {
            const r = await wallet.requestTestFunds();
            toast.success(`${formatUsd(r.usdc)} ${COLLATERAL_SYMBOL} received`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Drip failed");
        }
    }

    const showDrip = wallet.isConnected && !wallet.wrongNetwork && mode === "buy" && wallet.usdc < Math.max(amount, 0.01);
    const sellProfit = mode === "sell" && position && preview ? preview.usdc - preview.qty * position.avgPrice : null;
    const outcome = { kind: "outcome" as const, side };
    const usdc = { kind: "usdc" as const };

    let cta: React.ReactNode;
    if (wallet.isLoading) {
        cta = <Skeleton className="h-14 w-full rounded-full" />;
    } else if (!wallet.isConnected) {
        cta = (
            <Button type="button" size="xl" className="w-full" disabled={wallet.status === "connecting"} onClick={() => setWalletOpen(true)}>
                {wallet.status === "connecting" ? "Connecting" : "Connect"}
            </Button>
        );
    } else if (wallet.wrongNetwork) {
        cta = (
            <Button type="button" size="xl" className="w-full" onClick={() => void wallet.switchNetwork()}>
                Switch network
            </Button>
        );
    } else {
        cta = <LiquidMetalButton type="submit" fullWidth label={label} disabled={!!reason || busy} />;
    }

    return (
        <section aria-label="Trade" className={cn("min-w-0", className)}>
            <form
                noValidate
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <SegmentedPills
                    aria-label="Order"
                    size="md"
                    fullWidth
                    options={MODES.map((o) => ({ ...o, disabled: busy }))}
                    value={mode}
                    onChange={setMode}
                />

                <OutcomeSelector className="mt-3" value={side} onChange={setSide} prices={prices} disabled={busy} />

                <SwapStack
                    className="mt-3"
                    onFlip={() => setMode(mode === "buy" ? "sell" : "buy")}
                    flipLabel={mode === "buy" ? "Switch to sell" : "Switch to buy"}
                    flipDisabled={busy}
                    top={
                        mode === "buy" ? (
                            <AmountInput
                                id={TRADE_INPUT_ID}
                                label="You pay"
                                value={form.amount}
                                onChange={(v) => setAmount(v)}
                                quick={QUICK_BUY}
                                max={wallet.isConnected ? wallet.usdc : undefined}
                                disabled={busy}
                                adornment={
                                    <span className="flex items-center gap-3">
                                        {wallet.isConnected && <Balance value={formatNumber(wallet.usdc)} />}
                                        <AssetChip asset={usdc} />
                                    </span>
                                }
                            />
                        ) : (
                            <>
                                <AmountInput
                                    id={TRADE_INPUT_ID}
                                    label="You sell"
                                    value={form.amount}
                                    onChange={(v) => setAmount(v)}
                                    quick={[]}
                                    disabled={busy}
                                    adornment={
                                        <span className="flex items-center gap-3">
                                            {wallet.isConnected && <Balance value={formatTokens(held)} />}
                                            <AssetChip asset={outcome} title={market.tokenName} />
                                        </span>
                                    }
                                />
                                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                                    {SELL_FRACTIONS.map((f) => (
                                        <button
                                            key={f}
                                            type="button"
                                            className={pill}
                                            disabled={busy || held <= 0}
                                            onClick={() => setAmount(amountString(held * f, "down"))}
                                        >
                                            {f * 100}%
                                        </button>
                                    ))}
                                    <button
                                        type="button"
                                        className={cn(pill, form.max && held > 0 && "border-primary/60 bg-primary/15 text-primary")}
                                        aria-pressed={form.max}
                                        disabled={busy || held <= 0}
                                        onClick={() => setAmount(amountString(held), true)}
                                    >
                                        Max
                                    </button>
                                </div>
                            </>
                        )
                    }
                    bottom={
                        <SwapOutput
                            htmlFor={TRADE_INPUT_ID}
                            chip={mode === "buy" ? <AssetChip asset={outcome} title={market.tokenName} /> : <AssetChip asset={usdc} />}
                            value={receive > 0 ? (mode === "buy" ? formatTokens(receive) : formatNumber(receive)) : null}
                        />
                    }
                />

                <dl className="mt-3 flex items-center justify-between gap-3 px-1 font-secondary text-xs text-muted-foreground">
                    <div className="flex items-baseline gap-1.5">
                        <dt>Avg</dt>
                        <dd className="num font-semibold text-foreground">{preview ? formatCents(preview.avgPrice, 1) : "-"}</dd>
                    </div>
                    {mode === "buy" ? (
                        <div className="flex items-baseline gap-1.5">
                            <dt>If {sideLabel(side)} wins</dt>
                            <dd className="num font-semibold text-foreground">{formatUsd(preview?.toWin ?? 0)}</dd>
                        </div>
                    ) : (
                        <div className="flex items-baseline gap-1.5">
                            <dt>Profit</dt>
                            <dd className="font-semibold">
                                {sellProfit === null ? "-" : <Profit value={sellProfit} />}
                            </dd>
                        </div>
                    )}
                </dl>

                <div className="mt-3">{cta}</div>

                <TradeSteps steps={flow.steps} />

                {(showDrip || nextLive !== null) && (
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                        {showDrip && (
                            <Button type="button" variant="outline" size="lg" disabled={wallet.dripping} onClick={() => void drip()}>
                                <Droplet aria-hidden />
                                {wallet.dripping ? "Sending" : "Get test funds"}
                            </Button>
                        )}
                        {nextLive !== null && <LiveLink id={nextLive} side={side} />}
                    </div>
                )}
            </form>
            <WalletDialog open={walletOpen} onOpenChange={setWalletOpen} />
        </section>
    );
}
