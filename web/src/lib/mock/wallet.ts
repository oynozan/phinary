/**
 * Mock wallet: connection, network, balances and the write actions a real wallet would send.
 * Start state can be forced with ?wallet=disconnected | wrong-network | empty (read once on load).
 */
import { CHAIN } from "@/config/brand";
import { isResolved, payoutPerToken } from "@/lib/phase";
import { previewBuy, previewSell } from "@/lib/trade";
import type { Address, Side, Trade, WalletState } from "@/lib/types";

import { getChain, YOU } from "./chain";

const TX_DELAY_MS = 900;
const DRIP_USDC = 10;
const DRIP_ETH = 0.001;

export const SERVER_WALLET: WalletState = {
    status: "disconnected",
    address: null,
    chainId: null,
    wrongNetwork: false,
    usdc: 0,
    eth: 0,
    vaultShares: 0,
    dripping: false,
};

let state: WalletState | null = null;
const listeners = new Set<() => void>();

function initial(): WalletState {
    let mode: string | null = null;
    try {
        mode = new URLSearchParams(window.location.search).get("wallet");
    } catch {
        mode = null;
    }
    if (mode === "disconnected") return { ...SERVER_WALLET, chainId: CHAIN.id };
    getChain().seedUserHistory(YOU);
    return {
        status: "connected",
        address: YOU,
        chainId: mode === "wrong-network" ? 1 : CHAIN.id,
        wrongNetwork: mode === "wrong-network",
        usdc: mode === "empty" ? 0 : 42.18,
        eth: mode === "empty" ? 0 : 0.0042,
        vaultShares: mode === "empty" ? 0 : 250,
        dripping: false,
    };
}

export function getWallet(): WalletState {
    if (!state) state = initial();
    return state;
}

export function subscribeWallet(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function set(patch: Partial<WalletState>) {
    state = { ...getWallet(), ...patch };
    for (const l of listeners) l();
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

function requireReady(): Address {
    const w = getWallet();
    if (w.status !== "connected" || !w.address) throw new Error("Connect a wallet first");
    if (w.wrongNetwork) throw new Error(`Switch to ${CHAIN.name}`);
    return w.address;
}

export const walletActions = {
    async connect() {
        set({ status: "connecting" });
        await wait(600);
        getChain().seedUserHistory(YOU);
        set({ status: "connected", address: YOU, chainId: CHAIN.id, wrongNetwork: false });
    },

    disconnect() {
        set({ status: "disconnected", address: null });
    },

    async switchNetwork() {
        await wait(500);
        set({ chainId: CHAIN.id, wrongNetwork: false });
    },

    /** Test-funds drip: 10 USDC and a little ETH for gas. */
    async requestTestFunds() {
        requireReady();
        set({ dripping: true });
        await wait(1200);
        const w = getWallet();
        set({ dripping: false, usdc: w.usdc + DRIP_USDC, eth: w.eth + DRIP_ETH });
        return { usdc: DRIP_USDC, eth: DRIP_ETH };
    },

    async buy(marketId: number, side: Side, usdc: number): Promise<Trade> {
        const account = requireReady();
        if (!(usdc > 0)) throw new Error("Enter an amount");
        if (usdc > getWallet().usdc + 1e-9) throw new Error("Not enough USDC");
        await wait(TX_DELAY_MS);
        const chain = getChain();
        const t = nowSec();
        const q = chain.quoteAt(marketId, t);
        if (!q.tradable) throw new Error("Trading has closed for this market");
        const p = previewBuy(q, side, usdc);
        const trade = chain.recordUserTrade({ kind: "trade", marketId, account, side, isBuy: true, qty: p.qty, usdc, price: p.avgPrice, time: t });
        set({ usdc: getWallet().usdc - usdc });
        return trade;
    },

    async sell(marketId: number, side: Side, qty: number): Promise<Trade> {
        const account = requireReady();
        if (!(qty > 0)) throw new Error("Enter an amount");
        const held = heldTokens(account, marketId, side);
        if (qty > held + 1e-9) throw new Error("Not enough tokens");
        await wait(TX_DELAY_MS);
        const chain = getChain();
        const t = nowSec();
        const q = chain.quoteAt(marketId, t);
        if (!q.tradable) throw new Error("Trading has closed for this market");
        const p = previewSell(q, side, Math.min(qty, held));
        const trade = chain.recordUserTrade({ kind: "trade", marketId, account, side, isBuy: false, qty: p.qty, usdc: p.usdc, price: p.avgPrice, time: t });
        set({ usdc: getWallet().usdc + p.usdc });
        return trade;
    },

    /** Redeem both sides of a resolved market. Returns the USDC paid out. */
    async claim(marketId: number): Promise<number> {
        const account = requireReady();
        await wait(TX_DELAY_MS);
        const chain = getChain();
        const t = nowSec();
        const m = chain.marketAt(marketId, t);
        if (!m || !isResolved(m.phase)) throw new Error("This market has not resolved yet");
        let paid = 0;
        for (const side of ["up", "down"] as const) {
            const pay = payoutPerToken(m.phase, side) ?? 0;
            const held = heldTokens(account, marketId, side);
            if (pay <= 0 || held <= 1e-9) continue;
            chain.recordUserTrade({ kind: "claim", marketId, account, side, isBuy: false, qty: held, usdc: held * pay, price: pay, time: t });
            paid += held * pay;
        }
        if (paid <= 0) throw new Error("Nothing to claim");
        set({ usdc: getWallet().usdc + paid });
        return paid;
    },

    async vaultDeposit(usdc: number) {
        requireReady();
        if (!(usdc > 0)) throw new Error("Enter an amount");
        if (usdc > getWallet().usdc + 1e-9) throw new Error("Not enough USDC");
        await wait(TX_DELAY_MS);
        const chain = getChain();
        const t = nowSec();
        const v = chain.vaultAt(t);
        const shares = usdc / v.shareValue;
        chain.recordVaultFlow(t, usdc, shares);
        const w = getWallet();
        set({ usdc: w.usdc - usdc, vaultShares: w.vaultShares + shares });
        return shares;
    },

    /** Withdrawals are priced at navMinus and limited to idle funds. */
    async vaultWithdraw(shares: number) {
        requireReady();
        const w = getWallet();
        if (!(shares > 0)) throw new Error("Enter an amount");
        if (shares > w.vaultShares + 1e-9) throw new Error("Not enough shares");
        await wait(TX_DELAY_MS);
        const chain = getChain();
        const t = nowSec();
        const v = chain.vaultAt(t);
        const assets = shares * v.shareValue;
        if (assets > v.idle) throw new Error("Not enough idle funds right now");
        chain.recordVaultFlow(t, -assets, -shares);
        const after = getWallet();
        set({ usdc: after.usdc + assets, vaultShares: after.vaultShares - shares });
        return assets;
    },

    /** Dev helper: flip the wrong-network state. */
    setWrongNetwork(wrong: boolean) {
        set({ wrongNetwork: wrong, chainId: wrong ? 1 : CHAIN.id });
    },
};

export function heldTokens(account: Address, marketId: number, side: Side): number {
    let qty = 0;
    for (const tr of getChain().userTradesOf(account)) {
        if (tr.marketId !== marketId || tr.side !== side) continue;
        qty += tr.isBuy ? tr.qty : -tr.qty;
    }
    return Math.max(0, qty);
}
