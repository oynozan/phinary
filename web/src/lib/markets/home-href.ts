"use client";
import { useSyncExternalStore } from "react";

const KEY = "phinary:markets-href";

/** Remembers the filtered home URL so "Back to Markets" returns to the same asset and duration */
export function rememberMarketsHref(href: string) {
    try {
        sessionStorage.setItem(KEY, href);
    } catch {
        return;
    }
}

function readHref(): string {
    try {
        const href = sessionStorage.getItem(KEY);
        return href?.startsWith("/?") ? href : "/";
    } catch {
        return "/";
    }
}

const subscribe = () => () => {};

export function useMarketsHref(): string {
    return useSyncExternalStore(subscribe, readHref, () => "/");
}
