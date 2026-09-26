import { Skeleton } from "@/components/ui/skeleton";
export function MarketSkeleton() {
    return <div aria-busy="true" aria-label="Loading market"><div className="detail-hero"><Skeleton className="h-4 w-28" /><Skeleton className="mt-4 h-10 w-3/4" /></div><div className="detail-grid"><Skeleton className="detail-overview-slot h-20" /><Skeleton className="detail-chart-slot h-72" /><Skeleton className="detail-trade-slot h-120" /><Skeleton className="detail-position-slot h-24" /><Skeleton className="detail-pricing-slot h-28" /></div></div>;
}
