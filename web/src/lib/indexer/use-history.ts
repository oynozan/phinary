"use client";
import { useSyncExternalStore } from 'react';
import { createResource } from '../data/resource';
import { parseHistory } from './client';
import type { MarketHistory } from './history';

const resources = new Map<number, ReturnType<typeof createResource<MarketHistory>>>();
export function useHistory(id: number) {
    let resource = resources.get(id);
    if (!resource) {
        resource = createResource(async () => {
            const response = await fetch(`/api/markets/${id}/history`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw Error('History unavailable');
            return parseHistory(await response.json(), id);
        }, 10000);
        resources.set(id, resource);
    }
    return useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getServerSnapshot);
}
