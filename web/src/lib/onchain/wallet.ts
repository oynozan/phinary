"use client";

import { useSyncExternalStore } from "react";
import { createWalletClient, custom, erc20Abi, getAddress, numberToHex, type Address } from "viem";
import { unichainSepolia } from "viem/chains";
import { getConnectionConfig } from "./config.ts";
import { createChainClient } from "./client.ts";
import { assertWalletNetwork, isRejected, walletIdentity, type BrowserProvider } from "./wallet-core.ts";

export interface WalletOption { id: string; name: string; provider: BrowserProvider }
interface Session {
    status: "disconnected" | "connecting" | "connected";
    address: Address | null;
    chainId: number | null;
    usdc: bigint | null;
    eth: bigint | null;
    balanceError?: string;
    options: WalletOption[];
}
const initial: Session = { status: "disconnected", address: null, chainId: null, usdc: null, eth: null, options: [] };
let state = initial;
let selected: WalletOption | undefined;
let version = 0;
let balanceRequest = 0;
let started = false;
let cleanup: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const savedKey = "phinary.wallet.provider";
function saved(value?: string) {
    try {
        if (value === undefined) return localStorage.getItem(savedKey);
        if (value) localStorage.setItem(savedKey, value); else localStorage.removeItem(savedKey);
    } catch { /* storage may be disabled */ }
}
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
export async function connectWallet(id?: string) {
    if (state.status === "connecting") return;
    const option = state.options.find((item) => item.id === id) ?? state.options[0];
    if (!option) throw new Error("No browser wallet found. Install or enable a wallet extension.");
    const epoch = ++version;
    set({ status: "connecting" });
    try {
        await option.provider.request({ method: "eth_requestAccounts" });
        if (epoch !== version) return;
        attach(option); saved(option.id); await syncIdentity();
    } catch (error) {
        if (epoch === version) set({ status: "disconnected" });
        throw new Error(isRejected(error) ? "Connection cancelled" : "Could not connect wallet");
    }
}
export function disconnectWallet() {
    ++version; clearTimeout(timer); cleanup?.(); cleanup = undefined; selected = undefined; saved("");
    set({ ...initial, options: state.options });
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
                rpcUrls: [config.publicRpcUrl], blockExplorerUrls: ["https://sepolia.uniscan.xyz"],
            }] });
            await selected.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(config.chainId) }] });
        }
        await syncIdentity();
    } catch (error) { throw new Error(isRejected(error) ? "Network switch cancelled" : "Could not switch network"); }
}
function addOption(option: WalletOption) {
    if (state.options.some((item) => item.provider === option.provider)) return;
    set({ options: [...state.options, option] });
    if (!selected && state.status !== "connecting" && saved() === option.id) { attach(option); void syncIdentity(); }
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
