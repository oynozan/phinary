import { useId } from "react";

import { formatTime } from "@/lib/format";
import type { Side } from "@/lib/types";
import { cn } from "@/lib/utils";

const COLORS = {
    up: { from: "var(--up)", to: "var(--amethyst)" },
    down: { from: "var(--down)", to: "color-mix(in oklab, var(--down) 70%, black)" },
} as const;

/**
 * Outcome token logo (also used for wallet_watchAsset later): ▲ UP orchid, ▼ DOWN coral.
 * At 40px and up it also prints the strike and the deadline.
 */
export function TokenIcon({
    side,
    strike,
    expiry,
    size = 40,
    className,
}: {
    side: Side;
    strike?: number;
    expiry?: number;
    size?: number;
    className?: string;
}) {
    const c = COLORS[side];
    const detailed = size >= 40 && strike !== undefined && expiry !== undefined;
    const gid = useId();
    const glyph = side === "up" ? "M32 12 42 26H22Z" : "M32 26 42 12H22Z";
    return (
        <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={side === "up" ? "UP token" : "DOWN token"} className={cn("shrink-0", className)}>
            <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" style={{ stopColor: c.from }} />
                    <stop offset="1" style={{ stopColor: c.to }} />
                </linearGradient>
            </defs>
            <circle cx="32" cy="32" r="32" fill={`url(#${gid})`} />
            {detailed ? (
                <>
                    <path d={glyph} fill="#fff" transform="translate(0 -1)" />
                    <text x="32" y="41" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="700" fontFamily="var(--font-manrope), sans-serif">
                        {Math.round(strike!).toLocaleString("en-US")}
                    </text>
                    <text x="32" y="53" textAnchor="middle" fill="#fff" fillOpacity="0.8" fontSize="9.5" fontWeight="600" fontFamily="var(--font-manrope), sans-serif">
                        {formatTime(expiry!)}
                    </text>
                </>
            ) : (
                <path d={side === "up" ? "M32 18 46 40H18Z" : "M32 46 46 24H18Z"} fill="#fff" />
            )}
        </svg>
    );
}
