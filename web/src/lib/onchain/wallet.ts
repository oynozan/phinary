"use client";

import { useSyncExternalStore } from "react";
import { createWalletClient, custom, erc20Abi, getAddress, numberToHex, type Address } from "viem";
import { unichainSepolia } from "viem/chains";
import { getConnectionConfig } from "./config.ts";
import { createChainClient } from "./client.ts";
import { assertWalletNetwork, isRejected, walletIdentity, type BrowserProvider } from "./wallet-core.ts";

export interface WalletOption { id: string; name: string; provider: BrowserProvider }
interface Session {
    connectionReady: boolean;
    status: "disconnected" | "connecting" | "connected";
    address: Address | null;
    chainId: number | null;
    usdc: bigint | null;
    eth: bigint | null;
    balanceError?: string;
    options: WalletOption[];
}
const initial: Session = { connectionReady: false, status: "disconnected", address: null, chainId: null, usdc: null, eth: null, options: [] };
let state = initial;
let selected: WalletOption | undefined;
let releaseWallet: (() => Promise<void>) | undefined;
let openConnection: ((id?: string) => void) | undefined;
let version = 0;
let balanceRequest = 0;
let started = false;
let cleanup: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
function set(patch: Partial<Session>) { state = { ...state, ...patch }; for (const fn of listeners) fn(); }

export async function refreshWalletBalances() {
    const owner = state.address;
    const epoch = version;
    const request = ++balanceRequest;
    clearTimeout(timer);
    if (!owner || state.chainId !== getConnectionConfig().chainId) return;
    try {
        const config = getConnectionConfig();
        const client = createChainClient(config);
        const [usdc, eth] = await Promise.all([
            client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
            client.getBalance({ address: owner }),
        ]);
        if (epoch === version && request === balanceRequest) set({ usdc, eth, balanceError: undefined });
    } catch {
        if (epoch === version && request === balanceRequest) set({ usdc: null, eth: null, balanceError: "Balances unavailable. Retry before trading." });
    } finally {
        if (epoch === version && request === balanceRequest && listeners.size) timer = setTimeout(() => void refreshWalletBalances(), 8000);
    }
}
async function syncIdentity() {
    if (!selected) return;
    const provider = selected.provider;
    const epoch = ++version;
    set({ usdc: null, eth: null, balanceError: undefined });
    try {
        const identity = await walletIdentity(provider);
        if (epoch !== version) return;
        if (!identity.address) { disconnectWallet(); return; }
        set({ ...identity, status: "connected" });
        void refreshWalletBalances();
    } catch { if (epoch === version) disconnectWallet(); }
}
function attach(option: WalletOption) {
    cleanup?.(); selected = option;
    const changed = () => { void syncIdentity(); };
    const disconnected = () => disconnectWallet();
    option.provider.on?.("accountsChanged", changed);
    option.provider.on?.("chainChanged", changed);
    option.provider.on?.("disconnect", disconnected);
    cleanup = () => {
        option.provider.removeListener?.("accountsChanged", changed);
        option.provider.removeListener?.("chainChanged", changed);
        option.provider.removeListener?.("disconnect", disconnected);
    };
}
/** Privy owns connection prompts and persistence; trading continues through its EIP-1193 provider. */
export function registerWalletConnection(open: (id?: string) => void) {
    openConnection = open;
    set({ connectionReady: true });
    return () => { if (openConnection === open) { openConnection = undefined; set({ connectionReady: false }); } };
}
export async function connectWallet(id?: string) {
    if (!openConnection) throw new Error("Wallet connection is still loading. Please try again.");
    openConnection(id);
}
export async function adoptPrivyWallet(option: WalletOption, disconnect: () => Promise<void>) {
    releaseWallet = disconnect;
    if (selected?.provider === option.provider && state.status === "connected") return;
    attach(option);
    await syncIdentity();
}
export function clearWalletSession() {
    ++version; clearTimeout(timer); cleanup?.(); cleanup = undefined; selected = undefined; releaseWallet = undefined;
    set({ ...initial, options: state.options, connectionReady: state.connectionReady });
}
export function disconnectWallet() {
    const release = releaseWallet;
    clearWalletSession();
    void release?.().catch(() => { /* local session remains disconnected */ });
}
export async function switchWalletNetwork() {
    if (!selected) throw new Error("Connect a wallet first");
    const config = getConnectionConfig();
    try {
        try {
            await selected.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(config.chainId) }] });
        } catch (error) {
            if ((error as { code?: number }).code !== 4902) throw error;
            await selected.provider.request({ method: "wallet_addEthereumChain", params: [{
                chainId: numberToHex(config.chainId), chainName: "Unichain Sepolia", nativeCurrency: unichainSepolia.nativeCurrency,
                rpcUrls: [config.rpcUrl], blockExplorerUrls: ["https://sepolia.uniscan.xyz"],
            }] });
            await selected.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(config.chainId) }] });
        }
        await syncIdentity();
    } catch (error) { throw new Error(isRejected(error) ? "Network switch cancelled" : "Could not switch network"); }
}
function addOption(option: WalletOption) {
    if (state.options.some((item) => item.provider === option.provider)) return;
    set({ options: [...state.options, option] });
}
function start() {
    if (started) return; started = true;
    window.addEventListener("eip6963:announceProvider", (event) => {
        const detail = (event as CustomEvent).detail as { info?: { rdns?: string; name?: string }; provider?: BrowserProvider };
        if (detail?.info?.rdns && detail.info.name && detail.provider?.request) {
            addOption({ id: detail.info.rdns, name: detail.info.name, provider: detail.provider });
        }
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const legacy = (window as unknown as { ethereum?: BrowserProvider }).ethereum;
    if (legacy) addOption({ id: "injected", name: "Browser wallet", provider: legacy });
}
function subscribe(listener: () => void) {
    listeners.add(listener);
    queueMicrotask(start);
    if (listeners.size === 1 && state.address) void refreshWalletBalances();
    return () => { listeners.delete(listener); if (!listeners.size) clearTimeout(timer); };
}
export function useWalletSession() { return useSyncExternalStore(subscribe, () => state, () => initial); }

export function captureWallet() {
    if (!selected || !state.address || state.status !== "connected") throw new Error("Connect a wallet first");
    const provider = selected.provider;
    const account = getAddress(state.address);
    const epoch = version;
    const config = getConnectionConfig();
    const client = createChainClient(config);
    const unchanged = () => {
        if (epoch !== version || selected?.provider !== provider) throw new Error("Wallet changed. Review the order again.");
    };
    return {
        account, provider, client,
        wallet: createWalletClient({ account, chain: unichainSepolia, transport: custom(provider) }),
        assertReady: async () => { unchanged(); await assertWalletNetwork(provider, client, account, config.chainId); unchanged(); },
    };
}
