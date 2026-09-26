"use client";

import { MotionConfig } from "motion/react";

import { useMarkets } from "@/lib/data";

import { FeaturedMarket, pickFeatured } from "./featured-market";
import { MarketBrowser } from "./market-browser";

/** Featured live market and the tabbed grid, both fed by one markets query. */
export function MarketsHome() {
    const { data: markets } = useMarkets();
    const featured = markets ? pickFeatured(markets) : undefined;

    return (
        <MotionConfig reducedMotion="user">
            <FeaturedMarket market={featured} />
            <MarketBrowser markets={markets} featuredId={featured?.id ?? null} className="mt-10 sm:mt-12" />
        </MotionConfig>
    );
}
