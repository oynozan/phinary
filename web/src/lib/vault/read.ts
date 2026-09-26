import { predictionHookAbi, type MarketInfo } from "@phinary/swap-sdk";
import { erc20Abi, type Address } from "viem";
import { createChainClient } from "../onchain/client.ts";
import { getConnectionConfig } from "../onchain/config.ts";
import type { VaultAmounts } from "./math.ts";
export interface CoreSnapshot extends VaultAmounts {
    blockNumber: bigint;
    timestamp: number;
    fetchedAt: number;
    chainId: number;
}
export interface VaultMarket {
    id: number;
    name: string;
    category: "Crypto" | "Other";
    bucket: bigint;
    liability: bigint;
    status: number;
    expiry: number;
}
export interface ExposureSnapshot {
    core: CoreSnapshot;
    markets: VaultMarket[];
    totalValue: bigint;
    active: bigint;
}
export type VaultClient = ReturnType<typeof createChainClient>;
export function marketLiability(info: Pick<MarketInfo, "status" | "yesWon" | "outYes" | "outNo">): bigint {
    if (info.status === 1)
        return info.outYes > info.outNo ? info.outYes : info.outNo;
    if (info.status === 2)
        return info.yesWon ? info.outYes : info.outNo;
    return (info.outYes + info.outNo + 1n) / 2n;
}
async function readAt(account: Address | undefined, client: VaultClient, config: ReturnType<typeof getConnectionConfig>, block: {
    number: bigint;
    timestamp: bigint;
}): Promise<CoreSnapshot> {
    const read = (functionName: "vaultIdle" | "navPlus" | "navMinus" | "totalShares") => client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName, blockNumber: block.number });
    const [idle, navPlus, navMinus, totalShares, userShares, usdc] = await Promise.all([
        read("vaultIdle"), read("navPlus"), read("navMinus"), read("totalShares"),
        account ? client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "sharesOf", args: [account], blockNumber: block.number }) : 0n,
        account ? client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber: block.number }) : 0n,
    ]);
    return { idle, navPlus, navMinus, totalShares, userShares, usdc, blockNumber: block.number, timestamp: Number(block.timestamp), fetchedAt: Date.now(), chainId: config.chainId };
}
export async function readVaultCore(account?: Address, client = createChainClient(), config = getConnectionConfig()): Promise<CoreSnapshot> {
    const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
    if (chainId !== config.chainId)
        throw new Error("Wrong network returned by RPC");
    return readAt(account, client, config, block);
}
export async function readVaultExposure(client = createChainClient(), config = getConnectionConfig()): Promise<ExposureSnapshot> {
    const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
    if (chainId !== config.chainId)
        throw new Error("Wrong network returned by RPC");
    const [core, count] = await Promise.all([readAt(undefined, client, config, block), client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "marketCount", blockNumber: block.number })]);
    if (count > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("Market count exceeds display range");
    const markets: VaultMarket[] = [];
    for (let start = 1; start <= Number(count); start += 40) {
        const ids = Array.from({ length: Math.min(40, Number(count) - start + 1) }, (_, i) => start + i);
        const infos = await client.multicall({ contracts: ids.map(id => ({ address: config.predictionHook, abi: predictionHookAbi, functionName: "marketInfo", args: [BigInt(id)] } as const)), blockNumber: block.number, multicallAddress: config.multicall3, allowFailure: false });
        infos.forEach((info, i) => {
            const crypto = info.oracle.toLowerCase() === config.underlyingOracle.toLowerCase();
            const strike = Math.exp(Number(info.lnStrikeWad) / 1e18);
            markets.push({ id: ids[i], name: crypto ? `ETH > $${strike.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `Market #${ids[i]}`, category: crypto ? "Crypto" : "Other", bucket: info.bucket, liability: marketLiability(info), status: info.status, expiry: Number(info.expiry) });
        });
    }
    const active = markets.reduce((sum, market) => sum + market.bucket, 0n);
    return { core, markets, totalValue: core.idle + active, active };
}
