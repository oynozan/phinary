import type { MarketInfo, MarketStatus, Phase } from "@/lib/types";

type Timing = Pick<MarketInfo, "openTime" | "expiry" | "window" | "cutoffBuffer" | "status" | "upWon">;

export function cutoffOf(m: Pick<MarketInfo, "expiry" | "window" | "cutoffBuffer">): number {
    return m.expiry - m.window - m.cutoffBuffer;
}

export function windowStartOf(m: Pick<MarketInfo, "expiry" | "window">): number {
    return m.expiry - m.window;
}

/** Trading needs openTime <= now < expiry - window - cutoffBuffer. */
export function phaseOf(m: Timing, now: number): Phase {
    const status: MarketStatus = m.status;
    if (status === "settled") return m.upWon ? "resolved-up" : "resolved-down";
    if (status === "invalid") return "invalid";
    if (now >= m.expiry) return "awaiting";
    if (now >= windowStartOf(m)) return "averaging";
    if (now >= cutoffOf(m)) return "closed";
    return now < m.openTime ? "upcoming" : "live";
}

export const PHASE_LABEL: Record<Phase, string> = {
    upcoming: "Upcoming",
    live: "Live",
    closed: "Closed",
    averaging: "Averaging",
    awaiting: "Settling",
    "resolved-up": "Resolved UP",
    "resolved-down": "Resolved DOWN",
    invalid: "Invalid",
};

/** Screen-reader label for the countdown each phase shows */
export const DEADLINE_LABEL: Partial<Record<Phase, string>> = {
    upcoming: "Opens in",
    live: "Trading closes in",
    closed: "Averaging starts in",
    averaging: "Expires in",
};

export function isTradable(phase: Phase): boolean {
    return phase === "live";
}

export function isResolved(phase: Phase): boolean {
    return phase === "resolved-up" || phase === "resolved-down" || phase === "invalid";
}

/** Markets home tabs: Live holds everything between open and resolution. */
export type MarketTab = "live" | "upcoming" | "resolved";

export function tabOf(phase: Phase): MarketTab {
    if (phase === "upcoming") return "upcoming";
    if (isResolved(phase)) return "resolved";
    return "live";
}

/** The next clock boundary a phase counts down to, or null once nothing is scheduled. */
export function nextDeadline(m: Pick<MarketInfo, "openTime" | "expiry" | "window" | "cutoffBuffer">, phase: Phase): number | null {
    switch (phase) {
        case "upcoming":
            return m.openTime;
        case "live":
            return cutoffOf(m);
        case "closed":
            return windowStartOf(m);
        case "averaging":
            return m.expiry;
        default:
            return null;
    }
}

/** USDC paid per winning token. */
export function payoutPerToken(phase: Phase, side: "up" | "down"): number | null {
    if (phase === "invalid") return 0.5;
    if (phase === "resolved-up") return side === "up" ? 1 : 0;
    if (phase === "resolved-down") return side === "down" ? 1 : 0;
    return null;
}
