"use client";

/**
 * The only way pages read data. Today these are backed by src/lib/mock; later the live path moves to
 * RPC (viem/wagmi: quote, marketInfo, balances) and the history path to Ponder (charts, trades, feed,
 * leaderboard). Keep the signatures: every hook returns Query<T> = { data, isLoading, error? }.
 */
import { useSyncExternalStore } from "react";

import { getChain } from "@/lib/mock/chain";
import { computePortfolio } from "@/lib/mock/portfolio";
import { getWallet, SERVER_WALLET, subscribeWallet, walletActions } from "@/lib/mock/wallet";
import { tabOf, type MarketTab } from "@/lib/phase";
import type {
    ActivityItem,
    LeaderboardEntry,
    Market,
    Portfolio,
    PricePoint,
    Query,
    Quote,
    Trade,
    VaultState,
    WalletState,
} from "@/lib/types";

import { useNow } from "./clock";

const loading = <T>(): Query<T> => ({ data: undefined, isLoading: true });
const ready = <T>(data: T): Query<T> => ({ data, isLoading: false });

// Selectors take the wallet state so memoisation also refreshes after the user's own writes.
function selectMarkets(now: number, _w: WalletState): Market[] {
    return getChain().marketsAt(now);
}
function selectMarket(id: number, now: number, _w: WalletState): Market | null {
    return getChain().marketAt(id, now);
}
function selectHistory(id: number, now: number, _w: WalletState): PricePoint[] {
    return getChain().historyAt(id, now);
}
function selectTrades(id: number, now: number, _w: WalletState): Trade[] {
    return getChain().tradesOf(id, now);
}

/* ------------------------------------------------------------------ wallet */

export interface UseWallet extends WalletState {
    isConnected: boolean;
    /** true while the page is rendering on the server or hydrating */
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

const serverWallet = () => SERVER_WALLET;

function useWalletState(): WalletState {
    return useSyncExternalStore(subscribeWallet, getWallet, serverWallet);
}

/** Connection, balances and every write action (buy, sell, claim, drip, vault). */
export function useWallet(): UseWallet {
    const w = useWalletState();
    const now = useNow();
    return {
        ...w,
        isConnected: w.status === "connected" && !!w.address,
        isLoading: now === null,
        ...walletActions,
    };
}

/* ----------------------------------------------------------------- markets */

/** All listed markets, newest first. Pass a tab to filter (Live includes closed, averaging and settling). */
export function useMarkets(tab?: MarketTab): Query<Market[]> {
    const now = useNow();
    const w = useWalletState();
    if (now === null) return loading();
    const all = selectMarkets(now, w);
    return ready(tab ? all.filter((m) => tabOf(m.phase) === tab) : all);
}

/** One market; data is null when the id is unknown. */
export function useMarket(id: number): Query<Market | null> {
    const now = useNow();
    const w = useWalletState();
    if (now === null) return loading();
    return ready(selectMarket(id, now, w));
}

/** Newest market open for trading other than `exclude`, null when none is */
export function useLiveMarketId(exclude?: number): Query<number | null> {
    const now = useNow();
    if (now === null) return loading();
    return ready(getChain().liveIdAt(now, exclude));
}

/** Live hook quote (hook.quote(id)), refreshed every second. */
export function useQuote(id: number): Query<Quote | null> {
    const q = useMarket(id);
    if (q.isLoading) return loading();
    return ready(q.data?.quote ?? null);
}

/** UP price per second since open (mid, ask, bid, ETH), plus the outcome point once resolved. */
export function usePriceHistory(id: number): Query<PricePoint[]> {
    const now = useNow();
    const w = useWalletState();
    if (now === null) return loading();
    return ready(selectHistory(id, now, w));
}

/** Trades in one market, newest first. */
export function useMarketTrades(id: number): Query<Trade[]> {
    const now = useNow();
    const w = useWalletState();
    if (now === null) return loading();
    return ready(selectTrades(id, now, w));
}

/** Current ETH price and annualised volatility from the oracle. */
export function useEthPrice(): Query<{ price: number; sigma: number }> {
    const now = useNow();
    if (now === null) return loading();
    const chain = getChain();
    return ready({ price: chain.spotAt(now), sigma: chain.sigmaAt(now) });
}

/* --------------------------------------------------------------- portfolio */

/** Positions (average cost), value at the bid, profit and claimables for the connected wallet. */
export function usePortfolio(): Query<Portfolio | null> {
    const now = useNow();
    const w = useWalletState();
    if (now === null) return loading();
    if (w.status !== "connected" || !w.address) return ready(null);
    return ready(computePortfolio(getChain(), w.address, w.usdc, now));
}

/* ---------------------------------------------------------------- activity */

/** Live feed: trades, new markets and settlements, newest first. */
export function useActivity(limit = 60): Query<ActivityItem[]> {
    const now = useNow();
    const w = useWalletState();
    if (now === null) return loading();
    return ready(selectActivity(now, limit, w));
}

function selectActivity(now: number, limit: number, _w: WalletState) {
    return getChain().activityAt(now, limit);
}

/** Realised profit over resolved markets, best first. */
export function useLeaderboard(limit = 20): Query<LeaderboardEntry[]> {
    const now = useNow();
    const w = useWalletState();
    if (now === null) return loading();
    return ready(selectLeaderboard(now, limit, w));
}

function selectLeaderboard(now: number, limit: number, w: WalletState): LeaderboardEntry[] {
    const stats = getChain().leaderboardAt(now);
    return [...stats.entries()]
        .map(([account, s]) => ({ account, profit: s.profit, volume: s.volume, winRate: s.markets ? s.wins / s.markets : 0, markets: s.markets }))
        .sort((a, b) => b.profit - a.profit)
        .slice(0, limit)
        .map((e, i) => ({ ...e, rank: i + 1, isYou: !!w.address && e.account.toLowerCase() === w.address.toLowerCase() }));
}

/* ------------------------------------------------------------------- vault */

/** LP vault: value range (navMinus..navPlus), idle funds, share value, your shares, risk per market. */
export function useVault(): Query<VaultState> {
    const now = useNow();
    const w = useWalletState();
    if (now === null) return loading();
    const v = getChain().vaultAt(now);
    return ready({ ...v, userShares: w.vaultShares, userValue: w.vaultShares * v.shareValue });
}
