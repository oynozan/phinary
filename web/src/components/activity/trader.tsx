import { shortAddress } from "@/lib/format";
import type { Address } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Deterministic flat violet-to-rose dot, so repeat traders are recognisable at a glance */
export function AddressAvatar({ address, className }: { address: Address; className?: string }) {
    const a = parseInt(address.slice(2, 8), 16) || 0;
    const b = parseInt(address.slice(8, 14), 16) || 0;
    const hue = 250 + (a % 90);
    const light = 40 + (b % 25);
    return (
        <span
            aria-hidden
            className={cn("inline-block size-5 shrink-0 rounded-full border border-border-strong", className)}
            style={{ backgroundColor: `hsl(${hue} 60% ${light}%)` }}
        />
    );
}

export function YouPill({ className }: { className?: string }) {
    return (
        <span
            className={cn(
                "inline-flex h-5 shrink-0 items-center rounded-full bg-primary-soft px-2 font-secondary text-[11px] font-semibold text-primary",
                className,
            )}
        >
            You
        </span>
    );
}

/** Avatar + short address, with a You pill for the connected wallet */
export function Trader({ address, isYou, hideAddressForYou, className }: { address: Address; isYou?: boolean; hideAddressForYou?: boolean; className?: string }) {
    return (
        <span className={cn("flex min-w-0 items-center gap-2", className)}>
            <AddressAvatar address={address} />
            {!(isYou && hideAddressForYou) && (
                <span className="truncate font-mono text-[13px] leading-none text-foreground">{shortAddress(address)}</span>
            )}
            {isYou && <YouPill />}
        </span>
    );
}

export function LiveDot({ className }: { className?: string }) {
    return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full bg-primary animate-live", className)} />;
}
