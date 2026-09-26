"use client";
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createResource } from '../data/resource.ts';
import { syncChainClock } from '../data/clock.ts';
import { useWalletSession } from '../onchain/wallet.ts';
import { getConnectionConfig } from '../onchain/config.ts';
import { readPortfolio } from './read.ts';
import { useTransaction } from '../onchain/transactions.ts';
export function useLivePortfolio() {
    const wallet = useWalletSession();
    const transaction = useTransaction();
    const account = wallet.address;
    const enabled = wallet.status === 'connected' && wallet.chainId === getConnectionConfig().chainId;
    const resource = useMemo(() => createResource(async () => {
        if (!account || !enabled) return null;
        const result = await readPortfolio(account);
        syncChainClock(result.timestamp);
        return result;
    }, 15000), [account, enabled]);
    const query = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getServerSnapshot);
    useEffect(() => { if (transaction.result) void resource.refresh(); }, [transaction.result, resource]);
    return { ...query, refresh: resource.refresh };
}
