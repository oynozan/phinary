"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { Panel } from "@/components/layout/panel";
import { MarketCard, SegmentedPills, type PillOption } from "@/components/market";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { tabOf, type MarketTab } from "@/lib/phase";
import type { Market } from "@/lib/types";
import { cn } from "@/lib/utils";

const PAGE = 12;

const TABS: { value: MarketTab; label: string; empty: string }[] = [
    { value: "live", label: "Live", empty: "No live markets" },
    { value: "upcoming", label: "Upcoming", empty: "No upcoming markets" },
    { value: "resolved", label: "Resolved", empty: "No resolved markets yet" },
];

// Fixed column widths inside a wrapping flex row, so a short last row stays centered
const ITEM = "w-full min-w-0 sm:w-[calc((100%_-_1.25rem)/2)] lg:w-[calc((100%_-_2.5rem)/3)]";

// The featured market already sits above the grid, so Live leaves it out unless it is the only one
function groupByTab(markets: Market[], featuredId: number | null): Record<MarketTab, Market[]> {
    const groups: Record<MarketTab, Market[]> = { live: [], upcoming: [], resolved: [] };
    for (const m of markets) groups[tabOf(m.phase)].push(m);
    if (groups.live.length > 1) groups.live = groups.live.filter((m) => m.id !== featuredId);
    groups.live.sort((a, b) => b.openTime - a.openTime);
    groups.upcoming.sort((a, b) => a.openTime - b.openTime);
    groups.resolved.sort((a, b) => b.expiry - a.expiry);
    return groups;
}

export function MarketBrowser({
    markets,
    featuredId,
    className,
}: {
    markets: Market[] | undefined;
    featuredId: number | null;
    className?: string;
}) {
    const [tab, setTab] = useState<MarketTab>("live");
    const [limit, setLimit] = useState(PAGE);

    const groups = markets ? groupByTab(markets, featuredId) : null;
    const list = groups?.[tab];
    const empty = TABS.find((t) => t.value === tab)!.empty;

    const options: PillOption<MarketTab>[] = TABS.map((t) => ({
        value: t.value,
        label: (
            <span className="flex items-center gap-1.5">
                {t.label}
                {groups && <span className="num opacity-60">{groups[t.value].length}</span>}
            </span>
        ),
    }));

    return (
        <section aria-labelledby="markets-heading" className={className}>
            <h2 id="markets-heading" className="sr-only">
                Markets
            </h2>
            <div className="flex justify-center">
                <SegmentedPills
                    aria-label="Market status"
                    options={options}
                    value={tab}
                    onChange={(t) => {
                        setTab(t);
                        setLimit(PAGE);
                    }}
                    size="md"
                    className="bg-surface"
                />
            </div>

            <div className="mt-8 sm:mt-10">
                {!list ? (
                    <ul className="flex flex-wrap justify-center gap-5">
                        {[0, 1, 2].map((i) => (
                            <li key={i} className={ITEM}>
                                <CardSkeleton />
                            </li>
                        ))}
                    </ul>
                ) : list.length === 0 ? (
                    <Panel className="px-8 py-12 text-center text-lg font-medium">{empty}</Panel>
                ) : (
                    <ul key={tab} className="relative flex flex-wrap justify-center gap-5">
                        <AnimatePresence initial={false} mode="popLayout">
                            {list.slice(0, limit).map((m) => (
                                <motion.li
                                    key={m.id}
                                    layout
                                    initial={{ scale: 0.96 }}
                                    animate={{ scale: 1 }}
                                    exit={{ scale: 0.96 }}
                                    transition={{ duration: 0.3, ease: "easeOut" }}
                                    className={cn(ITEM, "flex")}
                                >
                                    <MarketCard market={m} className="w-full" />
                                </motion.li>
                            ))}
                        </AnimatePresence>
                    </ul>
                )}
            </div>

            {list && list.length > limit && (
                <div className="mt-10 flex justify-center">
                    <Button variant="outline" size="lg" className="bg-surface hover:bg-surface-3" onClick={() => setLimit((n) => n + PAGE)}>
                        Show more
                    </Button>
                </div>
            )}
        </section>
    );
}

function CardSkeleton() {
    return (
        <Panel className="flex flex-col gap-5" aria-hidden>
            <Skeleton className="h-7 w-4/5" />
            <div className="flex items-end justify-between">
                <Skeleton className="h-10 w-24" />
                <Skeleton className="h-10 w-28" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
            <div className="grid grid-cols-2 gap-2">
                <Skeleton className="h-11 rounded-full" />
                <Skeleton className="h-11 rounded-full" />
            </div>
            <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-14 rounded-full" />
                <Skeleton className="h-4 w-16 rounded-full" />
                <Skeleton className="h-4 w-8 rounded-full" />
            </div>
        </Panel>
    );
}
