import type { Metadata } from "next";
import { notFound } from "next/navigation";

import type { Side } from "@/lib/types";

import { MarketView } from "./_components/market-view";

function parseId(raw: string): number | null {
    if (!/^\d{1,12}$/.test(raw)) return null;
    return Number(raw);
}

// Static so it lands in the head, the client sets the question once the market loads
export const metadata: Metadata = { title: "Market" };

export default async function MarketPage({ params, searchParams }: PageProps<"/market/[id]">) {
    const { id } = await params;
    const marketId = parseId(id);
    if (marketId === null) notFound();
    const { side } = await searchParams;
    const initialSide: Side = side === "down" ? "down" : "up";
    return <MarketView key={marketId} id={marketId} initialSide={initialSide} />;
}
