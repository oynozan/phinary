"use client";

import Link from "next/link";

import { SectionHeading } from "@/components/layout/page";
import { Panel } from "@/components/layout/panel";
import { PHASE_DOT } from "@/components/market/phase-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPrice, formatTime, formatTokens, formatUsd, sideLabel } from "@/lib/format";
import { PHASE_LABEL } from "@/lib/phase";
import type { Market, VaultMarketRisk } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Bucket, outstanding UP and DOWN, and the vault's worst-case return for every unresolved market */
export function RiskTable({ risks, markets, className }: { risks: VaultMarketRisk[] | undefined; markets: Map<number, Market> | null; className?: string }) {
    return (
        <section aria-labelledby="risk-heading" className={className}>
            <SectionHeading id="risk-heading" className="text-center">
                Risk
            </SectionHeading>
            <Panel className="p-3 sm:p-4">
                <table className="w-full table-fixed font-secondary text-xs">
                    <thead>
                        <tr className="border-b border-border/60 text-[11px] whitespace-nowrap text-muted-foreground">
                            <th scope="col" className="w-[28%] px-1.5 pb-2 text-left font-normal sm:w-[34%] sm:px-2">
                                Market
                            </th>
                            <th scope="col" className="px-1.5 pb-2 text-right font-normal sm:px-2">
                                Bucket
                            </th>
                            <th scope="col" className="px-1.5 pb-2 text-right font-normal sm:px-2">
                                <span className="text-up">▲</span> UP
                            </th>
                            <th scope="col" className="px-1.5 pb-2 text-right font-normal sm:px-2">
                                <span className="text-down">▼</span> DOWN
                            </th>
                            <th scope="col" className="px-1.5 pb-2 text-right font-normal sm:px-2">
                                Worst case
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                        {!risks
                            ? Array.from({ length: 3 }, (_, i) => (
                                  <tr key={i}>
                                      <td colSpan={5} className="py-1.5">
                                          <Skeleton className="h-9 rounded-xl" />
                                      </td>
                                  </tr>
                              ))
                            : risks.map((r) => <Row key={r.marketId} risk={r} market={markets?.get(r.marketId) ?? null} />)}
                    </tbody>
                </table>
                {risks && risks.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No open markets</p>}
            </Panel>
        </section>
    );
}

function Row({ risk: r, market }: { risk: VaultMarketRisk; market: Market | null }) {
    const worst = Math.min(r.returnIfUp, r.returnIfDown);
    const worstSide = r.returnIfUp < r.returnIfDown - 1e-9 ? "up" : r.returnIfDown < r.returnIfUp - 1e-9 ? "down" : null;
    const cell = "num px-1.5 py-3 text-right sm:px-2";

    return (
        <tr className="transition-colors hover:bg-surface-2">
            <td className="px-1.5 py-2 sm:px-2">
                <Link
                    href={`/market/${r.marketId}`}
                    prefetch={false}
                    className="-mx-1 flex min-w-0 flex-col gap-0.5 rounded-lg px-1 py-1 outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:gap-2"
                >
                    <span className="flex items-center gap-2">
                        <span className={cn("size-1.5 shrink-0 rounded-full", PHASE_DOT[r.phase] ?? "bg-subtle")} aria-hidden />
                        <span className="sr-only">{PHASE_LABEL[r.phase]}, </span>
                        <span className="num font-semibold">{market ? formatTime(market.expiry) : `#${r.marketId}`}</span>
                    </span>
                    {market && <span className="num truncate pl-3.5 text-[11px] text-muted-foreground sm:pl-0 sm:text-xs">{formatPrice(market.strike)}</span>}
                </Link>
            </td>
            <td className={cn(cell, "text-foreground/80")}>{formatUsd(r.bucket, { whole: true })}</td>
            <td className={cell}>{formatTokens(r.outUp)}</td>
            <td className={cell}>{formatTokens(r.outDown)}</td>
            <td className={cell}>
                <span className="inline-flex items-center justify-end gap-1.5">
                    {worstSide && (
                        <span className="rounded-full border px-1.5 text-[10px] leading-4 font-semibold text-muted-foreground" title={`If ${sideLabel(worstSide)} wins`}>
                            <span className="sr-only">If </span>
                            {sideLabel(worstSide)}
                            <span className="sr-only"> wins, </span>
                        </span>
                    )}
                    <span className={cn("font-semibold", worst < 0 ? "text-down" : "text-foreground")}>{formatUsd(worst, { whole: true })}</span>
                </span>
            </td>
        </tr>
    );
}
