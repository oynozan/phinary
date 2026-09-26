import { PageWide } from "@/components/layout/page";
import { Panel } from "@/components/layout/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { CHART, GRID, PAGE, SIDE } from "./layout";

/** Server and first-paint shape of the market page, so nothing jumps when data arrives */
export function MarketSkeleton() {
    return (
        <PageWide aria-busy="true" className={PAGE}>
            <div className="mb-8 flex flex-col items-center">
                <Skeleton className="h-10 w-full max-w-lg rounded-full sm:h-12" />
                <Skeleton className="mt-3 h-7 w-40 rounded-full" />
                <Skeleton className="mt-4 h-1.5 w-full max-w-xl rounded-full" />
                <Skeleton className="mt-2.5 h-4 w-full max-w-xl rounded-full" />
            </div>
            <div className={GRID}>
                <div className={CHART}>
                    <Panel>
                        <Skeleton className="h-12 w-32 rounded-xl" />
                        <Skeleton className="mt-5 h-65 rounded-2xl" />
                        <Skeleton className="mt-4 h-7 w-72 max-w-full rounded-full" />
                    </Panel>
                </div>
                <div className={cn(SIDE, "order-first space-y-3 lg:order-none")}>
                    <Skeleton className="h-12 rounded-full" />
                    <div className="grid grid-cols-2 gap-2">
                        <Skeleton className="h-14 rounded-full" />
                        <Skeleton className="h-14 rounded-full" />
                    </div>
                    <Skeleton className="h-80 rounded-3xl" />
                    <Skeleton className="h-14 rounded-full" />
                </div>
            </div>
        </PageWide>
    );
}
