"use client";

import { useNow } from "@/lib/data";
import { formatCountdown } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Live mm:ss to a unix time. Renders a same-width placeholder until the client clock is available. */
export function Countdown({ to, className }: { to: number; className?: string }) {
    const now = useNow();
    const text = now === null ? "0:00" : formatCountdown(to - now);
    return (
        <span className={cn("num font-secondary", now === null && "invisible", className)}>
            {text}
        </span>
    );
}
