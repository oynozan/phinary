/**
 * Mock "chain + indexer" for the dashboard. Everything is a deterministic function of the clock and a seed,
 * anchored to the moment the page loaded, so countdowns tick and phases change live.
 * Client only: never import from a server component.
 */
import { tokenName, tokenTicker } from "@/lib/format";
import { cutoffOf, isResolved, payoutPerToken, phaseOf, windowStartOf } from "@/lib/phase";
import { askBid, DEMO_QUOTE_PARAMS, priceBinary, SECONDS_PER_YEAR, varianceToSigma } from "@/lib/pricing";
import { previewBuy, previewSell } from "@/lib/trade";
import type { ActivityItem, Address, Market, PricePoint, Quote, Side, Trade, VaultMarketRisk, VaultState } from "@/lib/types";

import { mockAddress, mockHash, rand01, randNormal } from "./rng";

export const MOCK_CONFIG = {
    seed: 2685,
    asset: "ETH",
    ticker: "ETH1M",
    track: "1m",
    /** a new market every minute */
    interval: 60,
    /** each lasts two minutes */
    tenor: 120,
    window: 10,
    cutoffBuffer: 2,
    nSamples: 10,
    /** markets are listed (and struck) this long before they open */
    lead: 60,
    /** USDC the vault allocates per market */
    budget: 100,
    /** keeper settles this long after expiry */
    settleDelay: 4,
    /** minutes of resolved markets available on load */
    historyMinutes: 90,
    /** chance of a synthetic trade in any live second */
    tradeProb: 0.2,
    spot0: 2685,
    sigmaMean: 0.42,
    sigmaMin: 0.25,
    sigmaMax: 0.6,
    vaultBaseAssets: 5000,
    /** share value when the page loads */
    vaultShareValue0: 1.02,
    invalidRate: 0.03,
} as const;

const C = MOCK_CONFIG;
const ID_EPOCH = Date.UTC(2026, 8, 20) / 1000;
const ORACLE: Address = mockAddress(C.seed, 1);
const TRADERS: Address[] = Array.from({ length: 28 }, (_, i) => mockAddress(C.seed, 500 + i));

export const YOU: Address = "0x7a3f5c2b9e1d4a8f6b0c3e2d1f9a8b7c6d5ec91e";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** ETH/USD path, one sample per second, with slowly varying volatility. */
class PricePath {
    readonly start: number;
    private prices: number[] = [C.spot0];
    private sigmas: number[] = [C.sigmaMean];
    private logSig = Math.log(C.sigmaMean);

    constructor(start: number) {
        this.start = start;
    }

    private ensure(t: number) {
        const target = t - this.start;
        const lnMean = Math.log(C.sigmaMean);
        const lnAnchor = Math.log(C.spot0);
        while (this.prices.length - 1 < target) {
            const i = this.prices.length;
            this.logSig += 0.004 * (lnMean - this.logSig) + 0.02 * randNormal(C.seed, i, 9);
            this.logSig = Math.min(Math.log(C.sigmaMax), Math.max(Math.log(C.sigmaMin), this.logSig));
            const sigma = Math.exp(this.logSig);
            const v = (sigma * sigma) / SECONDS_PER_YEAR;
            const p = this.prices[i - 1];
            const revert = (lnAnchor - Math.log(p)) / 5400;
            this.prices.push(p * Math.exp(revert - v / 2 + Math.sqrt(v) * randNormal(C.seed, i)));
            this.sigmas.push(sigma);
        }
    }

    at(t: number): number {
        const i = Math.max(0, Math.floor(t) - this.start);
        this.ensure(this.start + i);
        return this.prices[i];
    }

    sigmaAt(t: number): number {
        const i = Math.max(0, Math.floor(t) - this.start);
        this.ensure(this.start + i);
        return this.sigmas[i];
    }
}

interface StaticMarket {
    id: number;
    up: Address;
    down: Address;
    strike: number;
    openTime: number;
    expiry: number;
    createdAt: number;
    invalid: boolean;
    tokenName: string;
}

interface Flow {
    trades: Trade[];
    /** last second scanned (exclusive) */
    scanned: number;
    volume: number;
    outUp: number;
    outDown: number;
    bucket: number;
    history: PricePoint[];
}

interface BoardStats {
    profit: number;
    volume: number;
    wins: number;
    markets: number;
}

interface Settlement {
    price: number;
    upWon: boolean;
}

export class MockChain {
    readonly bootTime: number;
    readonly firstId: number;
    private path: PricePath;
    private statics = new Map<number, StaticMarket>();
    private flows = new Map<number, Flow>();
    private settlements = new Map<number, Settlement>();
    private userTrades: Trade[] = [];
    private vaultFlows: { time: number; assets: number; shares: number }[] = [];
    private seq = 0;
    private baseShares: number | null = null;
    private bootRealized: number | null = null;
    private realizedById = new Map<number, number>();
    private boardById = new Map<number, Map<Address, { profit: number; volume: number }>>();
    private listCache: { key: string; list: Market[] } | null = null;
    private boardCache: { key: string; stats: Map<Address, BoardStats> } | null = null;
    private vaultCache: { key: string; vault: Omit<VaultState, "userShares" | "userValue"> } | null = null;

    constructor(now: number) {
        this.bootTime = now;
        const minute = Math.floor(now / 60) * 60;
        this.firstId = this.idAtOpen(minute - C.historyMinutes * 60);
        this.path = new PricePath(this.openOf(this.firstId) - C.lead - 5);
    }

    // ---- ids and timing ----

    openOf(id: number) {
        return ID_EPOCH + id * C.interval;
    }

    idAtOpen(openTime: number) {
        return Math.floor((openTime - ID_EPOCH) / C.interval);
    }

    /** Highest id listed at `t` (created lead seconds before it opens). */
    lastIdAt(t: number) {
        return this.idAtOpen(t + C.lead);
    }

    spotAt(t: number) {
        return this.path.at(t);
    }

    sigmaAt(t: number) {
        return this.path.sigmaAt(t);
    }

    exists(id: number, t: number) {
        return id >= this.firstId && id <= this.lastIdAt(t);
    }

    /** Lowest id in the rolling list window, so a tab left open does not grow the work per tick. */
    private floorAt(t: number) {
        return Math.max(this.firstId, this.idAtOpen(t - C.historyMinutes * 60));
    }

    private settledAtOf(id: number) {
        return this.openOf(id) + C.tenor + C.settleDelay;
    }

    // Cache key for per-second results that the user's own writes can change
    private keyAt(t: number) {
        return `${t}:${this.userTrades.length}:${this.vaultFlows.length}`;
    }

    // ---- markets ----

    private staticOf(id: number): StaticMarket {
        let s = this.statics.get(id);
        if (!s) {
            const openTime = this.openOf(id);
            const expiry = openTime + C.tenor;
            const createdAt = openTime - C.lead;
            const strike = round2(this.path.at(createdAt));
            s = {
                id,
                up: mockAddress(C.seed, id, 11),
                down: mockAddress(C.seed, id, 12),
                strike,
                openTime,
                expiry,
                createdAt,
                invalid: rand01(C.seed, id, 77) < C.invalidRate,
                tokenName: tokenName(strike, expiry, C.ticker),
            };
            this.statics.set(id, s);
        }
        return s;
    }

    private timing(s: StaticMarket) {
        return { openTime: s.openTime, expiry: s.expiry, window: C.window, cutoffBuffer: C.cutoffBuffer };
    }

    private settlementOf(s: StaticMarket): Settlement {
        let st = this.settlements.get(s.id);
        if (!st) {
            const from = windowStartOf({ expiry: s.expiry, window: C.window });
            let lnSum = 0;
            for (let k = 0; k < C.nSamples; k++) lnSum += Math.log(this.path.at(from + k));
            const price = Math.exp(lnSum / C.nSamples);
            st = { price, upWon: price > s.strike };
            this.settlements.set(s.id, st);
        }
        return st;
    }

    /** Hook quote as of second t (pricing frozen at the last second before the window). */
    quoteAt(id: number, t: number): Quote {
        const s = this.staticOf(id);
        const tm = this.timing(s);
        const cutoff = cutoffOf(tm);
        const tq = Math.min(t, windowStartOf(tm) - 1);
        const spot = this.path.at(tq);
        const sigma = this.path.sigmaAt(tq);
        const variance = (sigma * sigma) / SECONDS_PER_YEAR;
        const tau = s.expiry - tq;
        const x = Math.log(spot / s.strike);
        const r = priceBinary(x, variance, tau, C.window, C.nSamples);
        const { ask, bid } = askBid(r);
        const inBand = r.mid >= DEMO_QUOTE_PARAMS.pMin && r.mid <= 1 - DEMO_QUOTE_PARAMS.pMin;
        return {
            tradable: t >= s.openTime && t < cutoff && inBand,
            tau: Math.max(0, s.expiry - t),
            variance,
            x,
            midUp: r.mid,
            askUp: ask,
            bidUp: bid,
            askDown: 1 - bid,
            bidDown: ask >= 1 ? 0 : 1 - ask,
            spot,
            sigma: varianceToSigma(variance),
        };
    }

    private flowOf(s: StaticMarket, t: number): Flow {
        let f = this.flows.get(s.id);
        if (!f) {
            f = { trades: [], scanned: s.openTime, volume: 0, outUp: 0, outDown: 0, bucket: C.budget, history: [] };
            this.flows.set(s.id, f);
        }
        const cutoff = cutoffOf(this.timing(s));
        const until = Math.min(t + 1, cutoff);
        for (let sec = f.scanned; sec < until; sec++) {
            const q = this.quoteAt(s.id, sec);
            f.history.push({ t: sec, mid: q.midUp, ask: q.askUp, bid: q.bidUp, eth: q.spot });
            if (!q.tradable || rand01(C.seed, s.id, sec, 1) >= C.tradeProb) continue;
            const trade = this.syntheticTrade(s, sec, q, f);
            if (!trade) continue;
            f.trades.push(trade);
            applyFlow(f, trade);
        }
        f.scanned = Math.max(f.scanned, until);
        return f;
    }

    private syntheticTrade(s: StaticMarket, sec: number, q: Quote, f: Flow): Trade | null {
        const r = (k: number) => rand01(C.seed, s.id, sec, k);
        const account = TRADERS[Math.floor(TRADERS.length * Math.pow(r(2), 1.6))];
        const side: Side = r(3) < 0.2 + 0.6 * q.midUp ? "up" : "down";
        const held = side === "up" ? f.outUp : f.outDown;
        const isBuy = r(4) < 0.74 || held < 2;
        const size = Math.exp(Math.log(8) + 0.9 * randNormal(C.seed, s.id, sec, 5));
        let p;
        if (isBuy) {
            p = previewBuy(q, side, round2(Math.min(120, Math.max(1, size))));
        } else {
            p = previewSell(q, side, Math.min(held * 0.5, Math.max(1, size)));
        }
        if (p.qty <= 0 || p.usdc <= 0) return null;
        return {
            id: `${s.id}-${sec}`,
            kind: "trade",
            marketId: s.id,
            account,
            side,
            isBuy,
            qty: p.qty,
            usdc: p.usdc,
            price: p.avgPrice,
            time: sec,
            txHash: mockHash(C.seed, s.id, sec),
        };
    }

    marketAt(id: number, t: number): Market | null {
        if (!this.exists(id, t)) return null;
        const s = this.staticOf(id);
        const tm = this.timing(s);
        const f = this.flowOf(s, t);
        const settledAt = s.expiry + C.settleDelay;
        const settled = t >= settledAt;
        const st = t >= s.expiry ? this.settlementOf(s) : null;
        const status = settled ? (s.invalid ? "invalid" : "settled") : "trading";
        const upWon = !!st && settled && !s.invalid && st.upWon;
        const phase = phaseOf({ ...tm, status, upWon }, t);

        let volume = f.volume;
        let outUp = f.outUp;
        let outDown = f.outDown;
        let bucket = f.bucket;
        let tradeCount = f.trades.length;
        for (const u of this.userTrades) {
            if (u.marketId !== id || u.kind !== "trade") continue;
            volume += u.usdc;
            tradeCount += 1;
            const sign = u.isBuy ? 1 : -1;
            if (u.side === "up") outUp += sign * u.qty;
            else outDown += sign * u.qty;
            bucket += sign * u.usdc;
        }

        const quote = t < s.createdAt ? null : this.quoteAt(id, t);
        let upChance = quote?.midUp ?? 0.5;
        if (phase === "resolved-up") upChance = 1;
        else if (phase === "resolved-down") upChance = 0;
        else if (phase === "invalid") upChance = 0.5;

        return {
            id,
            up: s.up,
            down: s.down,
            oracle: ORACLE,
            strike: s.strike,
            openTime: s.openTime,
            expiry: s.expiry,
            window: C.window,
            cutoffBuffer: C.cutoffBuffer,
            nSamples: C.nSamples,
            status,
            upWon,
            bucket,
            outUp,
            outDown,
            phase,
            cutoff: cutoffOf(tm),
            windowStart: windowStartOf(tm),
            createdAt: s.createdAt,
            tokenName: s.tokenName,
            upTicker: tokenTicker("up", C.ticker),
            downTicker: tokenTicker("down", C.ticker),
            asset: C.asset,
            track: C.track,
            oracleSpot: null,
            quote,
            upChance,
            volume,
            tradeCount,
            settlementPrice: st ? st.price : null,
            settledAt: settled ? settledAt : null,
        };
    }

    /** Listed markets in the rolling window at t, newest first. */
    marketsAt(t: number): Market[] {
        const key = this.keyAt(t);
        if (this.listCache?.key === key) return this.listCache.list;
        const out: Market[] = [];
        for (let id = this.lastIdAt(t); id >= this.floorAt(t); id--) {
            const m = this.marketAt(id, t);
            if (m) out.push(m);
        }
        this.listCache = { key, list: out };
        return out;
    }

    /** Newest market open for trading at t, other than `exclude`. */
    liveIdAt(t: number, exclude?: number): number | null {
        for (let id = this.lastIdAt(t); id >= this.floorAt(t); id--) {
            if (id === exclude) continue;
            const open = this.openOf(id);
            if (open > t) continue;
            if (t < cutoffOf({ expiry: open + C.tenor, window: C.window, cutoffBuffer: C.cutoffBuffer })) return id;
            return null;
        }
        return null;
    }

    /** UP price history (one point per second) up to t, plus the outcome once resolved. */
    historyAt(id: number, t: number): PricePoint[] {
        if (!this.exists(id, t)) return [];
        const s = this.staticOf(id);
        const f = this.flowOf(s, t);
        const pts = f.history.filter((p) => p.t <= t);
        const m = this.marketAt(id, t);
        if (m && isResolved(m.phase) && m.settledAt && m.upChance !== null) {
            const v = m.upChance;
            pts.push({ t: m.expiry, mid: v, ask: v, bid: v, eth: m.settlementPrice ?? s.strike });
        }
        return pts;
    }

    tradesOf(id: number, t: number): Trade[] {
        if (!this.exists(id, t)) return [];
        const s = this.staticOf(id);
        const f = this.flowOf(s, t);
        const synth = f.trades.filter((x) => x.time <= t);
        const mine = this.userTrades.filter((x) => x.marketId === id && x.kind === "trade" && x.time <= t);
        return [...synth, ...mine].sort((a, b) => b.time - a.time);
    }

    // ---- activity and leaderboard ----

    activityAt(t: number, limit = 60, minutes = 20): ActivityItem[] {
        const items: ActivityItem[] = [];
        const lowest = Math.max(this.firstId, this.idAtOpen(t - minutes * 60));
        for (let id = this.lastIdAt(t); id >= lowest; id--) {
            const m = this.marketAt(id, t);
            if (!m) continue;
            if (m.createdAt !== null) items.push({ kind: "created", id: `c-${id}`, time: m.createdAt, marketId: id });
            if (m.settledAt) {
                items.push({ kind: "settled", id: `s-${id}`, time: m.settledAt, marketId: id, upWon: m.upWon, invalid: m.phase === "invalid" });
            }
            for (const tr of this.tradesOf(id, t)) items.push({ kind: "trade", id: tr.id, time: tr.time, trade: tr });
        }
        items.sort((a, b) => b.time - a.time || (a.kind === "trade" ? 1 : -1));
        return items.slice(0, limit);
    }

    /** Realised profit per account over resolved markets in the window (average cost, payout at resolution). */
    leaderboardAt(t: number): Map<Address, BoardStats> {
        const key = this.keyAt(t);
        if (this.boardCache?.key === key) return this.boardCache.stats;
        const stats = new Map<Address, BoardStats>();
        for (let id = this.lastIdAt(t); id >= this.floorAt(t); id--) {
            if (t < this.settledAtOf(id)) continue;
            for (const [account, r] of this.boardOf(id, t)) {
                const s = stats.get(account) ?? { profit: 0, volume: 0, wins: 0, markets: 0 };
                s.profit += r.profit;
                s.volume += r.volume;
                s.markets += 1;
                if (r.profit > 0) s.wins += 1;
                stats.set(account, s);
            }
        }
        this.boardCache = { key, stats };
        return stats;
    }

    // Per-account result of one resolved market, fixed once it settles
    private boardOf(id: number, t: number) {
        let per = this.boardById.get(id);
        if (per) return per;
        per = new Map();
        const m = this.marketAt(id, t);
        if (!m || !isResolved(m.phase)) return per;
        const flows = new Map<Address, { cash: number; up: number; down: number; volume: number }>();
        for (const tr of this.tradesOf(id, t)) {
            const a = flows.get(tr.account) ?? { cash: 0, up: 0, down: 0, volume: 0 };
            const sign = tr.isBuy ? 1 : -1;
            a.cash -= sign * tr.usdc;
            a.volume += tr.usdc;
            if (tr.side === "up") a.up += sign * tr.qty;
            else a.down += sign * tr.qty;
            flows.set(tr.account, a);
        }
        for (const [account, a] of flows) {
            const profit = a.cash + a.up * (payoutPerToken(m.phase, "up") ?? 0) + a.down * (payoutPerToken(m.phase, "down") ?? 0);
            per.set(account, { profit, volume: a.volume });
        }
        this.boardById.set(id, per);
        return per;
    }

    // ---- user actions (the mock wallet calls these) ----

    userTradesOf(account: Address): Trade[] {
        return this.userTrades.filter((x) => x.account === account);
    }

    recordUserTrade(input: Omit<Trade, "id" | "txHash">): Trade {
        this.seq += 1;
        const trade: Trade = { ...input, id: `u-${this.seq}-${input.time}`, txHash: mockHash(C.seed, 9000 + this.seq, input.time) };
        this.userTrades.push(trade);
        return trade;
    }

    /** Buys placed before the page loaded, so the portfolio has content. */
    seedUserHistory(account: Address) {
        if (this.userTrades.some((x) => x.account === account)) return;
        const now = this.bootTime;
        const current = this.idAtOpen(Math.floor(now / 60) * 60);
        const plan: { back: number; side: Side; usdc: number; offset: number }[] = [
            { back: 0, side: "up", usdc: 6.2, offset: 15 },
            { back: 1, side: "down", usdc: 10, offset: 30 },
            { back: 3, side: "up", usdc: 12, offset: 40 },
            { back: 4, side: "down", usdc: 5, offset: 20 },
            { back: 6, side: "up", usdc: 8, offset: 55 },
            { back: 9, side: "down", usdc: 15, offset: 70 },
        ];
        for (const p of plan) {
            const id = current - p.back;
            const time = Math.min(now - 5, this.openOf(id) + p.offset);
            if (time < this.openOf(id)) continue;
            const q = this.quoteAt(id, time);
            if (!q.tradable) continue;
            const pv = previewBuy(q, p.side, p.usdc);
            this.recordUserTrade({ kind: "trade", marketId: id, account, side: p.side, isBuy: true, qty: pv.qty, usdc: p.usdc, price: pv.avgPrice, time });
        }
        // One of the older wins was already claimed.
        const claimedId = current - 9;
        const m = this.marketAt(claimedId, now);
        if (m && isResolved(m.phase)) {
            const pay = payoutPerToken(m.phase, "down") ?? 0;
            const held = this.userTrades.filter((x) => x.marketId === claimedId && x.side === "down").reduce((n, x) => n + x.qty, 0);
            if (pay > 0 && held > 0) {
                this.recordUserTrade({ kind: "claim", marketId: claimedId, account, side: "down", isBuy: false, qty: held, usdc: held * pay, price: pay, time: (m.settledAt ?? now) + 30 });
            }
        }
    }

    // ---- vault ----

    recordVaultFlow(time: number, assets: number, shares: number) {
        this.vaultFlows.push({ time, assets, shares });
    }

    // Vault profit of one resolved market, fixed once it settles
    private realizedOf(id: number, t: number): number {
        let r = this.realizedById.get(id);
        if (r !== undefined) return r;
        const m = this.marketAt(id, t);
        if (!m || !isResolved(m.phase)) return 0;
        const payout = m.outUp * (payoutPerToken(m.phase, "up") ?? 0) + m.outDown * (payoutPerToken(m.phase, "down") ?? 0);
        r = m.bucket - payout - C.budget;
        this.realizedById.set(id, r);
        return r;
    }

    vaultAt(t: number): Omit<VaultState, "userShares" | "userValue"> {
        const key = this.keyAt(t);
        if (this.vaultCache?.key === key) return this.vaultCache.vault;
        let realized = 0;
        let active = 0;
        let navPlus = 0;
        let navMinus = 0;
        const markets: VaultMarketRisk[] = [];
        for (let id = this.lastIdAt(t); id >= this.firstId; id--) {
            if (t >= this.settledAtOf(id)) {
                realized += this.realizedOf(id, t);
                continue;
            }
            const m = this.marketAt(id, t);
            if (!m) continue;
            active += 1;
            const returnIfUp = m.bucket - m.outUp;
            const returnIfDown = m.bucket - m.outDown;
            navPlus += Math.max(returnIfUp, returnIfDown);
            navMinus += Math.min(returnIfUp, returnIfDown);
            markets.push({ marketId: id, phase: m.phase, bucket: m.bucket, outUp: m.outUp, outDown: m.outDown, returnIfUp, returnIfDown });
        }
        // Backfilled profit is part of the starting balance, so only profit earned since load moves the value
        if (this.bootRealized === null) this.bootRealized = t === this.bootTime ? realized : this.realizedAt(this.bootTime);
        const flows = this.vaultFlows.filter((f) => f.time <= t);
        const assetsIn = flows.reduce((n, f) => n + f.assets, 0);
        const sharesIn = flows.reduce((n, f) => n + f.shares, 0);
        const idle = C.vaultBaseAssets + assetsIn + realized - this.bootRealized - active * C.budget;
        if (this.baseShares === null) {
            // Anchor the share count so the share value reads ~$1.02 at load
            const base: number = t === this.bootTime ? (idle + navMinus) / C.vaultShareValue0 : this.vaultAt(this.bootTime).totalShares;
            this.baseShares = base;
        }
        const totalShares: number = this.baseShares + sharesIn;
        const vault = {
            idle,
            navPlus: idle + navPlus,
            navMinus: idle + navMinus,
            totalShares,
            shareValue: (idle + navMinus) / totalShares,
            markets,
        };
        this.vaultCache = { key, vault };
        return vault;
    }

    private realizedAt(t: number): number {
        let realized = 0;
        for (let id = this.lastIdAt(t); id >= this.firstId; id--) {
            if (t >= this.settledAtOf(id)) realized += this.realizedOf(id, t);
        }
        return realized;
    }
}

function applyFlow(f: Flow, trade: Trade) {
    const sign = trade.isBuy ? 1 : -1;
    f.volume += trade.usdc;
    f.bucket += sign * trade.usdc;
    if (trade.side === "up") f.outUp += sign * trade.qty;
    else f.outDown += sign * trade.qty;
}

let chain: MockChain | null = null;

/** The singleton mock chain, booted on first use in the browser. */
export function getChain(): MockChain {
    if (!chain) chain = new MockChain(Math.floor(Date.now() / 1000));
    return chain;
}

