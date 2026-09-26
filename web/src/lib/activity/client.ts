import type { ActivityDisplay, ActivitySnapshot } from "./display";
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const timestamp = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000;
const nullable = (v: unknown) => v === null || finite(v);
const address = (v: unknown) => typeof v === "string" && /^0x[\da-f]{40}$/i.test(v);
export function parseActivity(value: unknown): ActivitySnapshot {
    if (!object(value) || !timestamp(value.asOf) || !Array.isArray(value.events) || !Array.isArray(value.realized) ||
        typeof value.tradesComplete !== "boolean" || typeof value.accountingComplete !== "boolean") throw Error("Invalid activity response");
    if (value.previousHour !== undefined && (!object(value.previousHour) || !nullable(value.previousHour.volume) || !nullable(value.previousHour.trades))) throw Error("Invalid previous hour");
    const base = (r: unknown) => object(r) && typeof r.id === "string" && timestamp(r.timestamp) && address(r.account);
    if (!value.events.every(r => base(r) && object(r) && ["Buy", "Sell", "Claim"].includes(String(r.action)) && ["up", "down"].includes(String(r.side)) && typeof r.market === "string" && nullable(r.amount) && nullable(r.total)) ||
        !value.realized.every(r => base(r) && object(r) && nullable(r.profit) && ["win", "loss", "invalid", "none", null].includes(r.outcome as string | null))) throw Error("Invalid activity rows");
    return value as unknown as ActivitySnapshot;
}
/** Separate from execution-price polling: history retains its last good result. */
export function createActivityResource(fetcher: (signal: AbortSignal) => Promise<ActivitySnapshot>, interval = 5000, now = () => Date.now() / 1000) {
    const initial: ActivityDisplay = { status: "loading", snapshot: null };
    let state = initial;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const listeners = new Set<() => void>();
    const refresh = async () => {
        const current = new AbortController(); controller = current;
        try {
            const snapshot = await fetcher(current.signal);
            if (current.signal.aborted) return;
            state = { status: now() - snapshot.asOf > 60 || snapshot.asOf > now() + 30 ? "paused" : "ready", snapshot, nextUpdateAt: Date.now() + interval };
        } catch {
            if (current.signal.aborted) return;
            state = { status: state.snapshot ? "paused" : "error", snapshot: state.snapshot };
        } finally {
            if (!current.signal.aborted) {
                for (const notify of listeners) notify();
                if (listeners.size) timer = setTimeout(() => void refresh(), interval);
            }
        }
    };
    return {
        getSnapshot: () => state,
        getServerSnapshot: () => initial,
        subscribe(listener: () => void) {
            listeners.add(listener);
            if (listeners.size === 1) void refresh();
            return () => { listeners.delete(listener); if (!listeners.size) { clearTimeout(timer); controller?.abort(); state = initial; } };
        },
    };
}
