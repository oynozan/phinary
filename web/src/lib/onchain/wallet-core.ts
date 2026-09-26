import type { createChainClient } from "./client.ts";
type ChainClient = ReturnType<typeof createChainClient>;
import { getAddress, numberToHex, type Address } from "viem";

export interface BrowserProvider {
    request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    on?(event: string, listener: (...args: unknown[]) => void): void;
    removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
export function isRejected(error: unknown): boolean {
    for (let current = error, i = 0; current && i < 8; i++) {
        const e = current as { code?: number; cause?: unknown };
        if (e.code === 4001) return true;
        current = e.cause;
    }
    return false;
}
export async function walletIdentity(provider: BrowserProvider) {
    const [accounts, chain] = await Promise.all([
        provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
    ]);
    return { address: (accounts as string[])[0] ? getAddress((accounts as string[])[0]) : null, chainId: Number(chain) };
}

/** Also compare block hashes: local forks can share Sepolia's chain ID. */
export async function assertWalletNetwork(provider: BrowserProvider, client: ChainClient, account: Address, chainId: number) {
    const identity = await walletIdentity(provider);
    if (identity.address?.toLowerCase() !== account.toLowerCase()) throw new Error("Wallet account changed. Review the order again.");
    if (identity.chainId !== chainId || await client.getChainId() !== chainId) throw new Error("Switch to Unichain Sepolia.");
    const head = await client.getBlock();
    const walletBlock = await provider.request({ method: "eth_getBlockByNumber", params: [numberToHex(head.number), false] }) as { hash?: string } | null;
    if (!walletBlock?.hash || walletBlock.hash.toLowerCase() !== head.hash.toLowerCase()) {
        throw new Error("Wallet and app use different networks or the wallet RPC is behind. Check its RPC and retry.");
    }
}
