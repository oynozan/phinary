"use client";

import Link from "next/link";
import { useState } from "react";

import { PageHeading, PageWide } from "@/components/layout/page";
import { EmptyState } from "@/components/layout/panel";
import { SegmentedPills } from "@/components/market";
import { useClaims } from "@/components/trade/use-claims";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletDialog } from "@/components/wallet/wallet-dialog";
import { useMarkets, usePortfolio, useWallet } from "@/lib/data";
import type { Market, Portfolio, Position } from "@/lib/types";

import { ClaimBanner } from "./claim-banner";
import { HistoryTable, toHistoryRows } from "./history";
import { positionKey, PositionsSkeleton, PositionsTable } from "./positions";
import { SellDialog } from "./sell-dialog";
import { PortfolioSummary, PortfolioSummarySkeleton } from "./summary";

type Tab = "positions" | "history";

function Disconnected() {
    const wallet = useWallet();
    const [open, setOpen] = useState(false);
    const connecting = wallet.status === "connecting";
    return (
        <PageWide>
            <PageHeading>Portfolio</PageHeading>
            <EmptyState
                title="Connect to see your positions"
                className="py-14 sm:py-16"
                action={
                    <Button size="lg" className="min-w-36 font-semibold" disabled={connecting} onClick={() => setOpen(true)}>
                        {connecting ? "Connecting" : "Connect"}
                    </Button>
                }
            />
            <WalletDialog open={open} onOpenChange={setOpen} />
        </PageWide>
    );
}

function Loading() {
    return (
        <PageWide aria-busy>
            <PortfolioSummarySkeleton />
            <div className="mb-6 flex justify-center">
                <Skeleton className="h-9 w-56 rounded-full" />
            </div>
            <PositionsSkeleton />
        </PageWide>
    );
}

function TabLabel({ label, count }: { label: string; count: number }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            {label}
            {count > 0 && <span className="num opacity-70">{count}</span>}
        </span>
    );
}

function Connected({ portfolio, markets }: { portfolio: Portfolio; markets: Market[] }) {
    const claims = useClaims();
    const [tab, setTab] = useState<Tab>("positions");
    const [sellOpen, setSellOpen] = useState(false);
    const [sellTarget, setSellTarget] = useState<Position | null>(null);
    const [sellNonce, setSellNonce] = useState(0);

    const history = toHistoryRows(portfolio.history);
    const marketById = new Map(markets.map((m) => [m.id, m]));
    const liveTarget = sellTarget ? (portfolio.positions.find((p) => positionKey(p) === positionKey(sellTarget)) ?? sellTarget) : null;

    function openSell(p: Position) {
        setSellTarget(p);
        setSellNonce((n) => n + 1);
        setSellOpen(true);
    }

    return (
        <PageWide>
            <PortfolioSummary portfolio={portfolio} />
            <ClaimBanner positions={portfolio.positions} claims={claims} />

            <div className="mb-6 flex justify-center">
                <SegmentedPills<Tab>
                    aria-label="Portfolio view"
                    size="md"
                    value={tab}
                    onChange={setTab}
                    options={[
                        { value: "positions", label: <TabLabel label="Positions" count={portfolio.positions.length} /> },
                        { value: "history", label: <TabLabel label="History" count={history.length} /> },
                    ]}
                />
            </div>

            {tab === "positions" ? (
                portfolio.positions.length > 0 ? (
                    <PositionsTable positions={portfolio.positions} claims={claims} onSell={openSell} />
                ) : (
                    <EmptyState
                        title="No positions yet"
                        action={
                            <Button asChild size="lg" className="min-w-36 font-semibold">
                                <Link href="/">Markets</Link>
                            </Button>
                        }
                    />
                )
            ) : history.length > 0 ? (
                <HistoryTable rows={history} markets={marketById} />
            ) : (
                <EmptyState title="No history yet" />
            )}

            <SellDialog position={liveTarget} open={sellOpen} onOpenChange={setSellOpen} nonce={sellNonce} />
        </PageWide>
    );
}

export function PortfolioView() {
    const wallet = useWallet();
    const portfolio = usePortfolio();
    const markets = useMarkets();

    if (wallet.isLoading || portfolio.isLoading) return <Loading />;
    if (!wallet.isConnected || !portfolio.data) return <Disconnected />;
    return <Connected portfolio={portfolio.data} markets={markets.data ?? []} />;
}
