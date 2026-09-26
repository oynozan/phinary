import { DISPLAY_TIMEZONE } from "@/config/brand";
import type { Side } from "@/lib/types";

const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const num2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** $1,234.56 (compact: $1.2K; whole: $1,235) */
export function formatUsd(value: number, opts: { compact?: boolean; whole?: boolean; signed?: boolean } = {}): string {
    if (!Number.isFinite(value)) return "-";
    const f = opts.compact && Math.abs(value) >= 10_000 ? usdCompact : opts.whole ? usd0 : usd2;
    const s = f.format(Math.abs(value));
    if (opts.signed) return `${value > 0 ? "+" : value < 0 ? "-" : ""}${s}`;
    return value < 0 ? `-${s}` : s;
}

/** Strike style: $2,684.53 */
export function formatPrice(value: number): string {
    return usd2.format(value);
}

/** 1,234.56 */
export function formatNumber(value: number, digits = 2): string {
    if (!Number.isFinite(value)) return "-";
    if (digits === 2) return num2.format(value);
    return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 0.634 -> "63¢" (digits = 1 -> "63.4¢") */
export function formatCents(price: number, digits = 0): string {
    if (!Number.isFinite(price)) return "-";
    return `${(price * 100).toFixed(digits)}¢`;
}

/** 0.62 -> "62%" */
export function formatPercent(p: number, digits = 0): string {
    if (!Number.isFinite(p)) return "-";
    return `${(p * 100).toFixed(digits)}%`;
}

/** Seconds -> "1:05" (or "12:01:05" past an hour). Negative clamps to 0. */
export function formatCountdown(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

const hhmm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: DISPLAY_TIMEZONE });
const hhmmss = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: DISPLAY_TIMEZONE });
const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: DISPLAY_TIMEZONE });

/** unix seconds -> "00:48" */
export function formatTime(unix: number): string {
    return hhmm.format(unix * 1000);
}

/** unix seconds -> "00:48:10" */
export function formatTimeSeconds(unix: number): string {
    return hhmmss.format(unix * 1000);
}

/** unix seconds -> "26 Sep" */
export function formatDay(unix: number): string {
    return dayMonth.format(unix * 1000);
}

/** "12s", "4m", "2h" ago */
export function formatAgo(unix: number, now: number): string {
    const d = Math.max(0, now - unix);
    if (d < 60) return `${d}s`;
    if (d < 3600) return `${Math.floor(d / 60)}m`;
    if (d < 86400) return `${Math.floor(d / 3600)}h`;
    return `${Math.floor(d / 86400)}d`;
}

/** 0x7a3F...c91E */
export function shortAddress(address: string, head = 4, tail = 4): string {
    if (address.length <= head + tail + 2) return address;
    return `${address.slice(0, head + 2)}…${address.slice(-tail)}`;
}

/** "SOL > $142.10 at 00:48?" for the market's own asset */
export function marketQuestion(strike: number, expiry: number, asset: string): string {
    return `${asset} > ${formatPrice(strike)} at ${formatTime(expiry)}?`;
}

/** On-chain ERC20 name shared by both sides: "ETH1M > $2684.53 26 Sep 00:48" (no thousands separator) */
export function tokenName(strike: number, expiry: number, ticker: string): string {
    return `${ticker} > $${strike.toFixed(2)} ${formatDay(expiry)} ${formatTime(expiry)}`;
}

/** ETH1MUP / ETH1MDOWN for the ticker "ETH1M" */
export function tokenTicker(side: Side, ticker: string): string {
    return `${ticker}${side === "up" ? "UP" : "DOWN"}`;
}

export function sideLabel(side: Side): string {
    return side === "up" ? "UP" : "DOWN";
}

/** Token amounts: 7.9, 12.35, 1,204 */
export function formatTokens(qty: number): string {
    if (!Number.isFinite(qty)) return "-";
    const digits = qty >= 1000 ? 0 : 2;
    return qty.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}
