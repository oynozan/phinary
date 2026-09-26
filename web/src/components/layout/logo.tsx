import Link from "next/link";

import { BRAND_NAME } from "@/config/brand";
import { cn } from "@/lib/utils";

/** The "Phinary" wordmark in Akt, no mark */
export function Logo({ className }: { className?: string }) {
    return (
        <Link href="/" aria-label={`${BRAND_NAME} home`} className={cn("flex shrink-0 items-center", className)}>
            <span className="font-heading text-xl font-medium tracking-tight sm:text-2xl">{BRAND_NAME}</span>
        </Link>
    );
}
