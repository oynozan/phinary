"use client";
import { useSyncExternalStore } from "react";
import { createActivityResource, parseActivity } from "./client";
const resource = createActivityResource(async signal => {
    const response = await fetch("/api/activity", { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (!response.ok) throw Error("Activity temporarily unavailable");
    return parseActivity(await response.json());
});
export function useLiveActivity() {
    return useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getServerSnapshot);
}
