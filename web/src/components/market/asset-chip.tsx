import { Landmark, Wallet } from "lucide-react";

import { COLLATERAL_SYMBOL } from "@/config/brand";
import { tokenTicker } from "@/lib/format";
import type { Side } from "@/lib/types";
import { cn } from "@/lib/utils";

import { TokenIcon } from "./token-icon";

export function UsdcIcon({ size = 28 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
            <circle cx="16" cy="16" r="16" fill="var(--usdc)" />
            <text x="16" y="21.5" textAnchor="middle" fill="#fff" fontSize="16" fontWeight="700" fontFamily="var(--font-manrope), sans-serif">
                $
            </text>
        </svg>
    );
}

export function SharesIcon({ size = 28 }: { size?: number }) {
    return (
        <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-primary/20 text-primary" style={{ width: size, height: size }}>
            <Landmark className="size-3.5" />
        </span>
    );
}

export type Asset = { kind: "usdc" } | { kind: "shares" } | { kind: "outcome"; side: Side };

function iconOf(asset: Asset) {
    if (asset.kind === "usdc") return <UsdcIcon />;
    if (asset.kind === "shares") return <SharesIcon />;
    return (
        <span aria-hidden>
            <TokenIcon side={asset.side} size={28} />
        </span>
    );
}

function labelOf(asset: Asset) {
    if (asset.kind === "usdc") return COLLATERAL_SYMBOL;
    if (asset.kind === "shares") return "Shares";
    return tokenTicker(asset.side);
}

/** Token pill like atomic.cash's asset selector, icon then ticker or custom content */
export function AssetChip({ asset, title, children, className }: { asset: Asset; title?: string; children?: React.ReactNode; className?: string }) {
    return (
        <span
            title={title}
            className={cn(
                "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border bg-background/20 pr-4 pl-1.5 text-sm font-semibold whitespace-nowrap",
                className,
            )}
        >
            {iconOf(asset)}
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
