import type { Query } from "../types.ts";

/** Shared polling resource: one request at a time, no polling without subscribers. */
export function createResource<T>(fetcher: () => Promise<T>, interval = 5000) {
    const initial: Query<T> = { data: undefined, isLoading: true };
    let state = initial;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> | undefined;
    const listeners = new Set<() => void>();
    const emit = () => { for (const listener of listeners) listener(); };
    const refresh = () => {
        if (pending) return pending;
        clearTimeout(timer);
        state = { ...state, isLoading: state.data === undefined, error: undefined };
        emit();
        pending = (async () => {
            try {
                state = { data: await fetcher(), isLoading: false };
            } catch {
                // Never present cached prices as live after a failed request, or expose credential-bearing RPC errors.
                state = { data: undefined, isLoading: false, error: new Error("Could not update market data. Please retry.") };
            } finally {
                pending = undefined;
                emit();
                if (listeners.size) timer = setTimeout(() => { void refresh(); }, interval);
            }
        })();
        return pending;
    };
    return {
        getSnapshot: () => state,
        getServerSnapshot: () => initial,
        refresh,
        subscribe(listener: () => void) {
            listeners.add(listener);
            if (listeners.size === 1) void refresh();
            return () => {
                listeners.delete(listener);
                if (!listeners.size) { clearTimeout(timer); state = initial; }
            };
        },
    };
}
