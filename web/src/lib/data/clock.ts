"use client";

import { useSyncExternalStore } from "react";

let now: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function schedule() {
    const ms = 1000 - (Date.now() % 1000) + 5;
    timer = setTimeout(() => {
        now = Math.floor(Date.now() / 1000);
        for (const l of listeners) l();
        schedule();
    }, ms);
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (!timer) schedule();
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
}

function getSnapshot() {
    if (now === null) now = Math.floor(Date.now() / 1000);
    return now;
}

const getServerSnapshot = () => null;

/**
 * Current unix time in whole seconds, ticking on the second boundary.
 * Returns null on the server and during hydration, so time-dependent UI renders only on the client.
 */
export function useNow(): number | null {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const noopSubscribe = () => () => {};

/** false on the server and during hydration, true afterwards. */
export function useHydrated(): boolean {
    return useSyncExternalStore(
        noopSubscribe,
        () => true,
        () => false,
    );
}
