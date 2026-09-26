import { Wallet } from "lucide-react";

import { COLLATERAL_SYMBOL } from "@/config/brand";
import { tokenTicker } from "@/lib/format";
import type { Side } from "@/lib/types";
import { cn } from "@/lib/utils";

export type Asset = { kind: "usdc" } | { kind: "shares" } | { kind: "outcome"; side: Side; ticker: string };

function labelOf(asset: Asset) {
    if (asset.kind === "usdc") return COLLATERAL_SYMBOL;
    if (asset.kind === "shares") return "Shares";
    return tokenTicker(asset.side, asset.ticker);
}

/** Token pill like atomic.cash's asset selector: plain ticker, outcome tokens lead with a ▲ / ▼ */
export function AssetChip({ asset, title, children, className }: { asset: Asset; title?: string; children?: React.ReactNode; className?: string }) {
    return (
        <span
            title={title}
            className={cn(
                "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border bg-background px-4 text-sm font-semibold whitespace-nowrap",
                className,
            )}
        >
            {asset.kind === "outcome" && (
                <span aria-hidden className={cn("text-[0.7rem] leading-none", asset.side === "up" ? "text-up" : "text-down")}>
                    {asset.side === "up" ? "▲" : "▼"}
                </span>
            )}
            {children ?? labelOf(asset)}
        </span>
    );
}

/** Small wallet balance shown beside an asset chip */
export function Balance({ value }: { value: string }) {
    return (
        <span className="flex items-center gap-1 font-secondary text-xs font-semibold text-muted-foreground">
            <Wallet aria-hidden className="size-3.5" />
            <span className="sr-only">Balance</span>
            <span className="num">{value}</span>
        </span>
    );
}
