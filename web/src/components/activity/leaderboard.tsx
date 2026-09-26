"use client";

import { Panel } from "@/components/layout/panel";
import { Profit } from "@/components/market/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useLeaderboard } from "@/lib/data";
import { formatPercent, formatUsd } from "@/lib/format";
import type { LeaderboardEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Trader } from "./trader";

const TOP = 15;

export function Leaderboard({ className }: { className?: string }) {
    const board = useLeaderboard(100);
    const entries = board.data;
    const top = entries?.slice(0, TOP) ?? [];
    const you = entries?.find((e) => e.isYou);
    const pinned = you && you.rank > TOP ? you : null;

    return (
        <Panel role="region" aria-labelledby="board-heading" className={cn("p-3 sm:p-4", className)}>
            <div className="hidden px-1.5 pt-1 pb-4 xl:block">
                <h2 id="board-heading" className="text-xl">
                    Leaderboard
                </h2>
            </div>

            <table className="w-full table-fixed">
                <thead>
                    <tr className="border-b border-border/60 font-secondary text-[11px] text-muted-foreground">
                        <th scope="col" className="w-7 px-1.5 pb-2 text-left font-normal sm:w-8">
                            <span aria-hidden>#</span>
                            <span className="sr-only">Rank</span>
                        </th>
                        <th scope="col" className="px-1.5 pb-2 text-left font-normal">
                            Trader
                        </th>
                        <th scope="col" className="w-[4.75rem] px-1.5 pb-2 text-right font-normal sm:w-[5.25rem]">
                            Profit
                        </th>
                        <th scope="col" className="w-[3.75rem] px-1.5 pb-2 text-right font-normal sm:w-[4.25rem]">
                            Volume
                        </th>
                        <th scope="col" className="w-[3.25rem] px-1.5 pb-2 text-right font-normal sm:w-[3.75rem]">
                            Win rate
                        </th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                    {!entries
                        ? Array.from({ length: 6 }, (_, i) => (
                              <tr key={i}>
                                  <td colSpan={5} className="py-1.5">
                                      <Skeleton className="h-9 rounded-xl" />
                                  </td>
                              </tr>
                          ))
                        : top.map((e) => <Row key={e.account} entry={e} />)}
                    {pinned && <Row entry={pinned} pinned />}
                </tbody>
            </table>

            {entries && entries.length === 0 && <p className="py-10 text-center text-muted-foreground">No resolved markets yet</p>}
        </Panel>
    );
}

function Row({ entry: e, pinned }: { entry: LeaderboardEntry; pinned?: boolean }) {
    return (
        <tr className={cn("font-secondary text-xs", e.isYou && "bg-primary/[0.07]", pinned && "border-t-2 border-dashed border-border-strong")}>
            <td className="px-1.5 py-3">
                <Rank rank={e.rank} />
            </td>
            <td className="px-1.5 py-3">
                <Trader address={e.account} isYou={e.isYou} hideAddressForYou />
            </td>
            <td className="px-1.5 py-3 text-right font-semibold">
                <Profit value={e.profit} />
            </td>
            <td className="num px-1.5 py-3 text-right text-foreground/80">{formatUsd(e.volume, { whole: true, compact: true })}</td>
            <td className="num px-1.5 py-3 text-right">{formatPercent(e.winRate)}</td>
        </tr>
    );
}

function Rank({ rank }: { rank: number }) {
    const medal = rank === 1 ? "bg-primary text-white" : rank === 2 ? "bg-accent-2 text-white" : rank === 3 ? "bg-surface-3 text-foreground" : null;
    return (
        <span
            className={cn(
                "num grid size-6 place-items-center rounded-full text-[11px] font-bold",
                medal ?? "text-muted-foreground",
            )}
        >
            {rank}
        </span>
    );
}
