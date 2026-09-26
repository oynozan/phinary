import { formatPrice, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tag = "h1" | "h2" | "h3" | "p" | "span";

/** "ETH > $2,684.53 at 00:48?" in the heading face. The strike can be emphasised. */
export function MarketQuestion({
    asset,
    strike,
    expiry,
    as: Tag = "h3",
    accentStrike = false,
    className,
}: {
    asset: string;
    strike: number;
    expiry: number;
    as?: Tag;
    accentStrike?: boolean;
    className?: string;
}) {
    return (
        <Tag className={cn("font-heading font-medium tracking-tight", className)}>
            {asset} &gt; <span className={cn("num", accentStrike && "text-primary")}>{formatPrice(strike)}</span> at{" "}
            <span className="num">{formatTime(expiry)}</span>?
        </Tag>
    );
}
