"use client";

import { useSyncExternalStore } from "react";
import { useWalletSession, connectWallet, disconnectWallet, switchWalletNetwork } from "@/lib/onchain/wallet";
import { getConnectionConfig } from "@/lib/onchain/config";
import type { walletActions } from "@/lib/mock/wallet";
import { readMarkets, type MarketSnapshot } from "@/lib/onchain/read-markets";
import { phaseOf, tabOf, type MarketTab } from "@/lib/phase";
import type { ActivityItem, LeaderboardEntry, Market, Portfolio, PricePoint, Query, Quote, Trade, VaultState, WalletState } from "@/lib/types";
import { syncChainClock, useNow } from "./clock";
import { createResource } from "./resource";
import { useHistory } from "../indexer/use-history";
import { withHistory } from "../indexer/client";

export const TRADING_ENABLED = true;
const unsupported = async (): Promise<never> => { throw new Error("This action is not connected yet"); };
const unavailable = <T>(): Query<T> => ({ data: undefined, isLoading: false, error: new Error("Not connected yet") });
const ready = <T>(data: T): Query<T> => ({ data, isLoading: false });
const resources = new Map<string, ReturnType<typeof createResource<MarketSnapshot>>>();
function resource(id?: number) {
    const key = id === undefined ? "markets" : `market:${id}`;
    let existing = resources.get(key);
    if (!existing) {
        existing = createResource(async () => {
            const result = await readMarkets(id);
            syncChainClock(result.timestamp);
            return result;
        });
        resources.set(key, existing);
    }
    return existing;
}
function useSnapshot(id?: number) {
    const query = resource(id);
    return useSyncExternalStore(query.subscribe, query.getSnapshot, query.getServerSnapshot);
}
export function retryMarkets(id?: number) { void resource(id).refresh(); }

/** Re-evaluate cutoffs between polls. Never display a cutoff sentinel as a probability. */
function current(m: Market, now: number): Market {
    const phase = phaseOf(m, now);
    const quote = now < m.cutoff ? m.quote : null;
    return { ...m, phase, quote, upChance: m.status === "trading" ? quote?.midUp ?? null : m.upChance };
}
export function useMarkets(tab?: MarketTab): Query<Market[]> {
    const query = useSnapshot();
    const now = useNow();
    if (!query.data || now === null) return { ...query, data: undefined };
    const markets = query.data.markets.map((m) => current(m, now));
    return ready(tab ? markets.filter((m) => tabOf(m.phase) === tab) : markets);
}
export function useMarket(id: number): Query<Market | null> {
    const query = useSnapshot(id);
    const history = useHistory(id);
    const now = useNow();
    if (!query.data || now === null) return { ...query, data: undefined };
    return ready(query.data.markets[0] ? withHistory(current(query.data.markets[0], now), history.data) : null);
}
export function useLiveMarketId(exclude?: number): Query<number | null> {
    const query = useMarkets();
    return { ...query, data: query.data?.find((m) => m.id !== exclude && m.phase === "live")?.id ?? (query.data ? null : undefined) };
}
export function useQuote(id: number): Query<Quote | null> {
    const query = useMarket(id);
    return { ...query, data: query.data ? query.data.quote : query.data };
}
export function useEthPrice(): Query<NonNullable<MarketSnapshot["eth"]>> {
    const query = useSnapshot();
    return { ...query, data: query.data?.eth, error: query.error ?? (query.data && !query.data.eth ? new Error("ETH price unavailable") : undefined) };
}

export function usePriceHistory(id: number): Query<PricePoint[]> { const query = useHistory(id); return { ...query, data: query.data?.prices }; }
export function useMarketTrades(id: number): Query<Trade[]> { const query = useHistory(id); return { ...query, data: query.data?.trades }; }
export function usePortfolio(): Query<Portfolio | null> { return ready(null); }
export function useActivity(_limit = 60): Query<ActivityItem[]> { return unavailable(); }
export function useLeaderboard(_limit = 20): Query<LeaderboardEntry[]> { return unavailable(); }
export function useVault(): Query<VaultState> { return unavailable(); }

export interface UseWallet extends WalletState {
    isConnected: boolean;
    isLoading: boolean;
    connect: typeof walletActions.connect;
    disconnect: typeof walletActions.disconnect;
    switchNetwork: typeof walletActions.switchNetwork;
    requestTestFunds: typeof walletActions.requestTestFunds;
    buy: typeof walletActions.buy;
    sell: typeof walletActions.sell;
    claim: typeof walletActions.claim;
    vaultDeposit: typeof walletActions.vaultDeposit;
    vaultWithdraw: typeof walletActions.vaultWithdraw;
    setWrongNetwork: typeof walletActions.setWrongNetwork;
}
export function useWallet(): UseWallet {
    const session = useWalletSession();
    return {
        status: session.status, address: session.address, chainId: session.chainId,
        wrongNetwork: session.chainId !== null && session.chainId !== getConnectionConfig().chainId,
        usdc: session.usdc === null ? 0 : Number(session.usdc) / 1e6,
        eth: session.eth === null ? 0 : Number(session.eth) / 1e18,
        vaultShares: 0, dripping: false, isConnected: session.status === "connected", isLoading: false,
        connect: connectWallet, disconnect: disconnectWallet, switchNetwork: switchWalletNetwork,
        requestTestFunds: unsupported, buy: unsupported, sell: unsupported, claim: unsupported,
        vaultDeposit: unsupported, vaultWithdraw: unsupported, setWrongNetwork() {},
    };
}
