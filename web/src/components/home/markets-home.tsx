"use client";

import { QueryError } from "@/components/market/query-error";
import { MARKET_LIMIT } from "@/lib/onchain/read-markets";

import { MotionConfig } from "motion/react";

import { useMarkets } from "@/lib/data";

import { FeaturedMarket, pickFeatured } from "./featured-market";
import { MarketBrowser } from "./market-browser";

/** Featured live market and the tabbed grid, both fed by one markets query. */
export function MarketsHome() {
    const { data: markets, error } = useMarkets();
    const featured = markets ? pickFeatured(markets) : undefined;

    if (error) return <QueryError />;

    return (
        <MotionConfig reducedMotion="user">
            <p className="mb-5 text-center text-sm text-muted-foreground">Unichain Sepolia · Latest {MARKET_LIMIT} markets</p>
            <FeaturedMarket market={featured} />
            <MarketBrowser markets={markets} featuredId={featured?.id ?? null} className="mt-6 sm:mt-8" />
        </MotionConfig>
    );
}
