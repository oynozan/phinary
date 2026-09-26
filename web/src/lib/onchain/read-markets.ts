import {
    predictionHookAbi, readTracks, recentTrackMarketIds, sameAddress, schedulerOfMarkets,
    type HookQuote, type MarketInfo as ChainMarketInfo, type Track,
} from "@phinary/swap-sdk";
import type { Address } from "viem";
import { createChainClient } from "./client.ts";
import { getConnectionConfig } from "./config.ts";
import { toMarket } from "./market-adapter.ts";
import type { Market } from "../types.ts";
import { MarketReadError, readStage, reportMarketFailure, summarizeMarketFailure } from "./market-diagnostics.ts";
import { underlyingOracleAbi } from "./read-abis.ts";

export const MARKET_LIMIT = 30;
/** Recent slots read from every track beside the newest ids, so 1m markets never push a 15m track out */
export const TRACK_MARKET_LIMIT = 8;
export interface OracleReading { price: number; sigma: number; warm: boolean }
export interface MarketSnapshot {
    markets: Market[];
    /** Deployment order, empty when the file lists no scheduler */
    tracks: Track[];
    timestamp: number;
    blockNumber: bigint;
    count: number;
    eth?: OracleReading;
}
type ChainClient = ReturnType<typeof createChainClient>;
type ConnectionConfig = ReturnType<typeof getConnectionConfig>;

const trackCache = new Map<string, Promise<Track[]>>();
/** Track configs are frozen at deploy, so they are read once per deployment */
function tracksOf(client: ChainClient, config: ConnectionConfig, blockNumber: bigint): Promise<Track[]> {
    const schedulers = config.marketGatekeeper ? config.marketSchedulers : config.marketScheduler ? [config.marketScheduler] : [];
    const key = `${config.cacheKey}:${schedulers.join(",")}`;
    let tracks = trackCache.get(key);
    if (!tracks) {
        tracks = readTracks(client, { marketSchedulers: schedulers, multicall3: config.multicall3 }, { blockNumber });
        trackCache.set(key, tracks);
        tracks.catch(() => trackCache.delete(key));
    }
    return tracks;
}

/** All values in a snapshot are pinned to one block. Errors never become an empty market list. */
async function readMarketSnapshot(id?: number, client = createChainClient(), config = getConnectionConfig()): Promise<MarketSnapshot> {
    const [chainId, block] = await Promise.all([readStage("chain", () => client.getChainId()), readStage("head", () => client.getBlock())]);
    if (chainId !== config.chainId) throw new Error("Wrong network returned by RPC");
    const blockNumber = block.number;
    const opts = { blockNumber, multicallAddress: config.multicall3 };
    const gatekeeper = config.marketGatekeeper;
    const tracks = await readStage("tracks", () => tracksOf(client, config, blockNumber));
    const [count, recent] = await Promise.all([
        readStage("count", () => client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "marketCount", blockNumber })),
        id === undefined && gatekeeper
            ? Promise.all(tracks.map((track) => recentTrackMarketIds(client, track, block.timestamp, TRACK_MARKET_LIMIT, opts)))
            : [],
    ]);
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Market count exceeds display range");
    const total = Number(count);
    const ids = id === undefined
        ? [...new Set([...Array.from({ length: Math.min(total, MARKET_LIMIT) }, (_, i) => total - i), ...recent.flat().map(Number)])]
            .filter((marketId) => marketId > 0 && marketId <= total).sort((a, b) => b - a)
        : Number.isSafeInteger(id) && id > 0 && id <= total ? [id] : [];
    const oracles = [...new Map([config.underlyingOracle, ...config.underlyings.map((u) => u.oracle), ...tracks.map((t) => t.oracle)]
        .map((address) => [address.toLowerCase(), address] as const)).values()];
    const [results, oracleResults, owners] = await Promise.all([
        ids.length ? readStage("markets", () => client.multicall({
            contracts: ids.flatMap((marketId) => [
                { address: config.predictionHook, abi: predictionHookAbi, functionName: "marketInfo", args: [BigInt(marketId)] } as const,
                { address: config.predictionHook, abi: predictionHookAbi, functionName: "marketParams", args: [BigInt(marketId)] } as const,
                { address: config.predictionHook, abi: predictionHookAbi, functionName: "quote", args: [BigInt(marketId)] } as const,
            ]),
            blockNumber, multicallAddress: config.multicall3, allowFailure: true,
        })) : [],
        readStage("oracle", () => client.multicall({
            contracts: oracles.flatMap((address) => [
                { address, abi: underlyingOracleAbi, functionName: "lnSpotSoBWad" } as const,
                { address, abi: underlyingOracleAbi, functionName: "varianceE36" } as const,
            ]),
            blockNumber, multicallAddress: config.multicall3, allowFailure: true,
        })),
        gatekeeper && ids.length ? schedulerOfMarkets(client, gatekeeper, ids.map(BigInt), opts) : undefined,
    ]);
    const readings = new Map<string, OracleReading | undefined>(oracles.map((address, i) => {
        const spot = oracleResults[i * 2];
        const variance = oracleResults[i * 2 + 1];
        if (spot?.status !== "success" || variance?.status !== "success") return [address.toLowerCase(), undefined] as const;
        const [varPerSecE36, warm] = variance.result as readonly [bigint, boolean];
        return [address.toLowerCase(), {
            price: Math.exp(Number(spot.result as bigint) / 1e18),
            sigma: Math.sqrt(Number(varPerSecE36) / 1e36 * 31557600),
            warm,
        }] as const;
    }));
    const pMinOf = (result: unknown) => {
        const wad = (result as { quote?: { pMinWad?: bigint } }).quote?.pMinWad;
        return wad === undefined ? undefined : Number(wad) / 1e18;
    };
    const trackOf = (scheduler: Address | undefined) => tracks.find((t) => sameAddress(t.scheduler, scheduler));
    const timestamp = Number(block.timestamp);
    const markets = ids.map((marketId, index) => {
        const info = results[index * 3];
        const params = results[index * 3 + 1];
        const quote = results[index * 3 + 2];
        if (info?.status !== "success") throw new MarketReadError("market-info", info?.error);
        if (params?.status !== "success") throw new MarketReadError("market-params", params?.error);
        const chain = info.result as ChainMarketInfo;
        const track = trackOf(gatekeeper ? owners?.[index] : config.marketScheduler);
        const asset = track?.asset ?? config.oracleAssets[chain.oracle.toLowerCase()] ?? "";
        return toMarket(marketId, chain,
            (params.result as { nSamples: number }).nSamples,
            quote?.status === "success" ? quote.result as HookQuote : undefined, timestamp, {
                asset, ticker: track?.ticker ?? asset, track: track?.label ?? null,
                oracleSpot: readings.get(chain.oracle.toLowerCase())?.price ?? null,
                pMin: pMinOf(params.result),
            });
    });
    return {
        markets, tracks, timestamp, blockNumber, count: total,
        eth: readings.get(config.underlyingOracle.toLowerCase()),
    };
}

export async function readMarkets(id?: number, client = createChainClient(), config = getConnectionConfig()): Promise<MarketSnapshot> {
    const started = performance.now();
    try { return await readMarketSnapshot(id, client, config); }
    catch (error) { reportMarketFailure(summarizeMarketFailure(error, id, performance.now() - started)); throw error; }
}
