/**
 * UI-facing shapes that mirror src/interfaces/IPredictionHook.sol.
 * On-chain WAD / 6-decimal values are converted to plain numbers at the data-layer boundary:
 * prices are USDC per token in [0, 1], amounts are whole USDC or whole tokens, times are unix seconds.
 * The contracts call the sides YES / NO; the UI calls them UP / DOWN.
 */

export type Address = `0x${string}`;
export type Hash = `0x${string}`;

export type Side = "up" | "down";

/** IPredictionHook.Status */
export type MarketStatus = "none" | "trading" | "settled" | "invalid";

/** Display phase derived from chain state and the clock (see lib/phase.ts). */
export type Phase =
    | "upcoming"
    | "live"
    | "closed"
    | "averaging"
    | "awaiting"
    | "resolved-up"
    | "resolved-down"
    | "invalid";

/** IPredictionHook.MarketInfo (+ params the UI needs from MarketParams) */
export interface MarketInfo {
    id: number;
    /** YES token */
    up: Address;
    /** NO token */
    down: Address;
    oracle: Address;
    /** USD strike, exp(lnStrikeWad) */
    strike: number;
    openTime: number;
    expiry: number;
    /** settlement averaging window, seconds */
    window: number;
    /** trading stops at expiry - window - cutoffBuffer */
    cutoffBuffer: number;
    nSamples: number;
    status: MarketStatus;
    /** yesWon */
    upWon: boolean;
    /** USDC held by the market */
    bucket: number;
    /** outstanding tokens (outYes / outNo) */
    outUp: number;
    outDown: number;
}

/** IPredictionHook.Quote, converted from WAD */
export interface Quote {
    tradable: boolean;
    /** seconds to expiry */
    tau: number;
    /** per-second variance (varE36 / 1e36) */
    variance: number;
    /** ln(S / K) */
    x: number;
    midUp: number;
    askUp: number;
    bidUp: number;
    askDown: number;
    bidDown: number;
    /** underlying price implied by x: K * e^x */
    spot: number;
    /** annualised volatility implied by variance */
    sigma: number;
}

export interface Market extends MarketInfo {
    phase: Phase;
    /** expiry - window - cutoffBuffer */
    cutoff: number;
    /** expiry - window */
    windowStart: number;
    createdAt: number | null;
    /** ERC20 name shared by both tokens, e.g. "ETH > $2684.53 26 Sep 00:48" */
    tokenName: string;
    upTicker: string;
    downTicker: string;
    /** underlying symbol such as "ETH" or "SOL", empty when neither the track nor the oracle is known */
    asset: string;
    /** track period label such as "1m" or "15m", null when the market's scheduler is unknown */
    track: string | null;
    /** spot price from this market's own oracle at the snapshot block */
    oracleSpot: number | null;
    /** live quote while pricing is defined, otherwise the last one before the window (tradable = false) */
    quote: Quote | null;
    /** probability of UP to display: live mid, last mid, or the outcome once resolved */
    upChance: number | null;
    volume: number | null;
    tradeCount: number | null;
    /** geometric average underlying price over the window, once expiry has passed */
    settlementPrice: number | null;
    settledAt: number | null;
}

export interface PricePoint {
    t: number;
    mid: number;
    ask: number;
    bid: number;
    eth: number;
}

export interface Trade {
    /** txFrom is the transaction sender, not a confirmed token recipient. */
    attributedBy?: 'transfer' | 'txFrom';
    id: string;
    /** "claim" is a redeem after resolution, recorded as a sale at the payout price */
    kind: "trade" | "claim";
    marketId: number;
    account: Address;
    side: Side;
    isBuy: boolean;
    /** tokens */
    qty: number;
    /** USDC paid (buy) or received (sell) */
    usdc: number;
    /** average price, USDC per token */
    price: number;
    time: number;
    txHash: Hash;
}

export type PositionState = "open" | "closed" | "pending" | "claimable" | "claimed" | "lost";

export interface Position {
    marketId: number;
    market: Market;
    side: Side;
    /** tokens held */
    qty: number;
    /** remaining cost basis (average-cost method) */
    cost: number;
    avgPrice: number;
    /** current bid for this side, or the payout per token once resolved */
    mark: number;
    /** qty * mark */
    value: number;
    /** value - cost */
    pnl: number;
    realized: number;
    state: PositionState;
    /** USDC redeemable now */
    claimable: number;
}

export interface Portfolio {
    cash: number;
    positionsValue: number;
    total: number;
    unrealized: number;
    realized: number;
    claimable: number;
    positions: Position[];
    history: Trade[];
}

export type ActivityItem =
    | { kind: "trade"; id: string; time: number; trade: Trade }
    | { kind: "created"; id: string; time: number; marketId: number }
    | { kind: "settled"; id: string; time: number; marketId: number; upWon: boolean; invalid: boolean };

export interface LeaderboardEntry {
    rank: number;
    account: Address;
    profit: number;
    volume: number;
    /** 0..1 */
    winRate: number;
    markets: number;
    isYou: boolean;
}

export interface VaultMarketRisk {
    marketId: number;
    phase: Phase;
    bucket: number;
    outUp: number;
    outDown: number;
    /** bucket - outUp */
    returnIfUp: number;
    /** bucket - outDown */
    returnIfDown: number;
}

export interface VaultState {
    idle: number;
    navPlus: number;
    navMinus: number;
    totalShares: number;
    /** navMinus / totalShares: withdrawals are priced at the safe end */
    shareValue: number;
    userShares: number;
    userValue: number;
    markets: VaultMarketRisk[];
}

export type WalletStatus = "disconnected" | "connecting" | "connected";

export interface WalletState {
    status: WalletStatus;
    address: Address | null;
    chainId: number | null;
    wrongNetwork: boolean;
    usdc: number;
    eth: number;
    vaultShares: number;
    dripping: boolean;
}

/** Every data hook returns this shape so pages do not change when the source moves to RPC / Ponder. */
export interface Query<T> {
    data: T | undefined;
    isLoading: boolean;
    error?: Error;
}
