export type VaultMode = 'deposit' | 'withdraw';
export interface VaultCore {
    idle: bigint;
    navPlus: bigint;
    navMinus: bigint;
    totalShares: bigint;
    userShares: bigint;
    usdc: bigint;
    timestamp: number;
    fetchedAt: number;
}
export interface ExposureRow {
    id: number;
    market: string;
    category: string;
    liquidity: number;
    allocation: number | null;
    utilization: number | null;
    volume: number | null;
    apr: number | null;
}
export interface VaultPresentation {
    tvl: number | null;
    idle: number | null;
    navMinus: number | null;
    navPlus: number | null;
    userValue: number | null;
    userPercent: number | null;
    depositPrice: number | null;
    withdrawPrice: number | null;
    apy: number | null;
    tvlHistory: number[] | null;
    apyHistory: number[] | null;
    tvlChange: number | null;
    priceChange: number | null;
    composition: {
        label: string;
        amount: number;
        color: string;
    }[];
    exposure: ExposureRow[];
    updatedAt: number | null;
    live: boolean;
    loading: boolean;
    error?: string;
}
export const emptyVault: VaultPresentation = {
    tvl: null, idle: null, navMinus: null, navPlus: null, userValue: null, userPercent: null,
    depositPrice: null, withdrawPrice: null, apy: null, tvlHistory: null, apyHistory: null,
    tvlChange: null, priceChange: null, composition: [], exposure: [], updatedAt: null, live: false, loading: true,
};
export const vaultColors = ['#c51cff', '#9851cf', '#f69b97', '#b837bb', '#8b7caf', '#544068'];
export const usd = (value: number | null, decimals = 2) => value === null ? 'N/A' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
export const pct = (value: number | null) => value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
export const compactUsd = (value: number | null) => value === null ? 'N/A' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
export type SortKey = 'liquidity' | 'allocation' | 'utilization' | 'volume' | 'apr';
export function sortExposure(rows: ExposureRow[], category: string, sort: SortKey, descending: boolean) {
    return rows.filter(r => category === 'All Markets' || r.category === category).sort((a, b) => {
        const av = a[sort], bv = b[sort];
        if (av === null)
            return bv === null ? a.id - b.id : 1;
        if (bv === null)
            return -1;
        return (descending ? bv - av : av - bv) || a.id - b.id;
    });
}
