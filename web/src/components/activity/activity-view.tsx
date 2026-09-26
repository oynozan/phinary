"use client";

import { useState } from "react";

import { SegmentedPills } from "@/components/market";
import { useMarkets, useNow, useWallet } from "@/lib/data";
import { cn } from "@/lib/utils";

import { ActivityStats } from "./activity-stats";
import { Leaderboard } from "./leaderboard";
import { LiveFeed } from "./live-feed";
import { LiveDot } from "./trader";

type View = "feed" | "board";

/** Feed and leaderboard sit side by side from xl and switch by pills below it */
export function ActivityView() {
    const [view, setView] = useState<View>("feed");
    const markets = useMarkets();
    const now = useNow();
    const wallet = useWallet();
    const byId = markets.data ? new Map(markets.data.map((m) => [m.id, m])) : null;

    return (
        <>
            <ActivityStats markets={markets.data} now={now} className="mb-10" />

            <div className="mb-5 flex justify-center xl:hidden">
                <SegmentedPills<View>
                    aria-label="View"
                    value={view}
                    onChange={setView}
                    options={[
                        {
                            value: "feed",
                            label: (
                                <span className="flex items-center gap-2">
                                    Feed
                                    <LiveDot className={cn("size-1.5", view === "feed" && "bg-white")} />
                                </span>
                            ),
                        },
                        { value: "board", label: "Leaderboard" },
                    ]}
                />
            </div>

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem] xl:items-start">
                <LiveFeed markets={byId} now={now} you={wallet.address} className={cn(view !== "feed" && "hidden xl:block")} />
                <Leaderboard className={cn("xl:sticky xl:top-(--shell-top)", view !== "board" && "hidden xl:block")} />
            </div>
        </>
    );
}
