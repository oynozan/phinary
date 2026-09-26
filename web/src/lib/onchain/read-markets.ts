import { predictionHookAbi, type HookQuote, type MarketInfo as ChainMarketInfo } from "@phinary/swap-sdk";
import { createChainClient } from "./client.ts";
import { getConnectionConfig } from "./config.ts";
import { toMarket } from "./market-adapter.ts";
import type { Market } from "../types.ts";
import { underlyingOracleAbi } from "./read-abis.ts";

export const MARKET_LIMIT = 30;
export interface MarketSnapshot {
    markets: Market[];
    timestamp: number;
    blockNumber: bigint;
    count: number;
    eth?: { price: number; sigma: number; warm: boolean };
}

/** All values in a snapshot are pinned to one block. Errors never become an empty market list. */
export async function readMarkets(id?: number, client = createChainClient(), config = getConnectionConfig()): Promise<MarketSnapshot> {
    const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
    if (chainId !== config.chainId) throw new Error("Wrong network returned by RPC");
    const count = await client.readContract({
        address: config.predictionHook, abi: predictionHookAbi, functionName: "marketCount", blockNumber: block.number,
    });
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Market count exceeds display range");
    const total = Number(count);
    const ids = id === undefined
        ? Array.from({ length: Math.min(total, MARKET_LIMIT) }, (_, i) => total - i)
        : Number.isSafeInteger(id) && id > 0 && id <= total ? [id] : [];
    const [results, oracle] = await Promise.all([
        ids.length ? client.multicall({
            contracts: ids.flatMap((marketId) => [
                { address: config.predictionHook, abi: predictionHookAbi, functionName: "marketInfo", args: [BigInt(marketId)] } as const,
                { address: config.predictionHook, abi: predictionHookAbi, functionName: "marketParams", args: [BigInt(marketId)] } as const,
                { address: config.predictionHook, abi: predictionHookAbi, functionName: "quote", args: [BigInt(marketId)] } as const,
            ]),
            blockNumber: block.number, multicallAddress: config.multicall3, allowFailure: true,
        }) : [],
        client.multicall({
            contracts: [
                { address: config.underlyingOracle, abi: underlyingOracleAbi, functionName: "lnSpotSoBWad" },
                { address: config.underlyingOracle, abi: underlyingOracleAbi, functionName: "varianceE36" },
            ],
            blockNumber: block.number, multicallAddress: config.multicall3, allowFailure: true,
        }),
    ]);
    const timestamp = Number(block.timestamp);
    const markets = ids.map((marketId, index) => {
        const info = results[index * 3];
        const params = results[index * 3 + 1];
        const quote = results[index * 3 + 2];
        if (info?.status !== "success" || params?.status !== "success") throw new Error(`Market ${marketId} could not be read`);
        return toMarket(marketId, info.result as ChainMarketInfo,
            (params.result as { nSamples: number }).nSamples,
            quote?.status === "success" ? quote.result as HookQuote : undefined, timestamp);
    });
    return {
        markets, timestamp, blockNumber: block.number, count: total,
        eth: oracle[0].status === "success" && oracle[1].status === "success" ? {
            price: Math.exp(Number(oracle[0].result) / 1e18),
            sigma: Math.sqrt(Number(oracle[1].result[0]) / 1e36 * 31557600),
            warm: oracle[1].result[1],
        } : undefined,
    };
}
