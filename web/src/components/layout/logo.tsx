import Link from "next/link";
import { useId } from "react";

import { BRAND_NAME } from "@/config/brand";
import { cn } from "@/lib/utils";

/** Brand mark: an up and a down triangle on an orchid tile. */
export function LogoMark({ className }: { className?: string }) {
    const gid = useId();
    return (
        <svg viewBox="0 0 32 32" aria-hidden className={cn("size-8", className)}>
            <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" style={{ stopColor: "var(--orchid)" }} />
                    <stop offset="1" style={{ stopColor: "var(--amethyst)" }} />
                </linearGradient>
            </defs>
            <rect width="32" height="32" rx="10" fill={`url(#${gid})`} />
            <path d="M16 6.5 22 14.5H10Z" fill="#fff" />
            <path d="M16 25.5 10 17.5H22Z" fill="#fff" fillOpacity="0.55" />
        </svg>
    );
}

export function Logo({ className }: { className?: string }) {
    return (
        <Link href="/" aria-label={`${BRAND_NAME} home`} className={cn("flex shrink-0 items-center gap-2.5", className)}>
            <LogoMark className="size-8 sm:size-9" />
            <span className="font-heading text-xl font-medium tracking-tight sm:text-2xl">{BRAND_NAME}</span>
        </Link>
    );
}
