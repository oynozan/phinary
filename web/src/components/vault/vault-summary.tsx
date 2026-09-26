import { Panel } from "@/components/layout/panel";
import { Money } from "@/components/market/money";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsd } from "@/lib/format";
import type { VaultState } from "@/lib/types";
import { cn } from "@/lib/utils";

export function formatShareValue(v: number) {
    return `$${v.toFixed(4)}`;
}

/** Page heading showing the vault value as its navMinus to navPlus range */
export function VaultHeading({ vault }: { vault: VaultState | undefined }) {
    return (
        <h1 className="mb-8 flex min-h-12 flex-wrap items-center justify-center gap-x-3 text-center text-[2rem] leading-tight sm:min-h-16 sm:gap-x-5 sm:text-5xl lg:text-6xl">
            <span className="sr-only">Vault value </span>
            {vault ? (
                <>
                    <Money value={vault.navMinus} dimCents />
                    <span aria-hidden className="h-0.5 w-5 shrink-0 rounded-full bg-primary sm:w-9" />
                    <span className="sr-only"> to </span>
                    <Money value={vault.navPlus} dimCents />
                </>
            ) : (
                <Skeleton className="h-10 w-72 rounded-full sm:h-14 sm:w-md" />
            )}
        </h1>
    );
}

/** Share price, idle funds and the value of your shares in one divided strip */
export function VaultStats({ vault, connected, className }: { vault: VaultState | undefined; connected: boolean; className?: string }) {
    return (
        <Panel flush className={cn("grid grid-cols-3 divide-x divide-border overflow-hidden", className)}>
            <Stat label="Share price" ready={!!vault}>
                {vault && formatShareValue(vault.shareValue)}
            </Stat>
            <Stat label="Idle" ready={!!vault}>
                {vault && formatUsd(vault.idle, { whole: true })}
            </Stat>
            <Stat label="Your share" ready={!!vault}>
                {vault && (connected ? formatUsd(vault.userValue) : "-")}
            </Stat>
        </Panel>
    );
}

function Stat({ label, ready, children }: { label: string; ready: boolean; children: React.ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col items-center gap-1.5 px-2 py-4 text-center sm:px-5 sm:py-5">
            {ready ? (
                <span className="num truncate font-heading text-lg font-medium sm:text-2xl">{children}</span>
            ) : (
                <Skeleton className="h-6 w-16 sm:h-8 sm:w-24" />
            )}
            <span className="font-secondary text-xs text-muted-foreground">{label}</span>
        </div>
    );
}
