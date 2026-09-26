import { Money, Profit } from "@/components/market";
import { Skeleton } from "@/components/ui/skeleton";
import type { Portfolio } from "@/lib/types";
import { cn } from "@/lib/utils";

function Stat({ label, value, className }: { label: string; value: number; className?: string }) {
    return (
        <div className={cn("flex flex-col items-center gap-1.5", className)}>
            <Profit value={value} className="font-heading text-2xl font-medium tracking-tight sm:text-3xl" />
            <span className="font-secondary text-xs font-medium text-muted-foreground">{label}</span>
        </div>
    );
}

/** Portfolio value as the page heading, flanked by unrealised and realised profit. */
export function PortfolioSummary({ portfolio }: { portfolio: Portfolio }) {
    return (
        <section
            aria-label="Summary"
            className="mb-12 grid grid-cols-2 items-center gap-x-6 gap-y-7 md:mb-14 md:grid-cols-[1fr_auto_1fr] md:gap-x-12 lg:mb-16 lg:gap-x-16"
        >
            <h1 className="col-span-2 text-center font-heading text-5xl leading-none min-[400px]:text-6xl sm:text-7xl md:col-span-1 md:col-start-2 md:row-start-1 lg:text-8xl">
                <span className="sr-only">Portfolio value </span>
                <Money value={portfolio.total} dimCents />
            </h1>
            <Stat label="Unrealised" value={portfolio.unrealized} className="md:col-start-1 md:row-start-1 md:items-end" />
            <Stat label="Realised" value={portfolio.realized} className="md:col-start-3 md:row-start-1 md:items-start" />
        </section>
    );
}

export function PortfolioSummarySkeleton() {
    return (
        <div aria-hidden className="mb-12 flex flex-col items-center gap-7 md:mb-14 lg:mb-16">
            <Skeleton className="h-16 w-72 rounded-2xl sm:h-20 lg:h-24 lg:w-96" />
            <div className="flex gap-10">
                <Skeleton className="h-10 w-24" />
                <Skeleton className="h-10 w-24" />
            </div>
        </div>
    );
}
