import { listMarkets, predictionHookAbi } from "@phinary/swap-sdk";
import { erc20Abi, type Address } from "viem";
import { createChainClient } from "./client.ts";
import { getConnectionConfig } from "./config.ts";

/** Read-only preflight. Success does not imply swaps or keeper operation are healthy. */
export async function checkConnection() {
    const config = getConnectionConfig();
    const client = createChainClient(config);
    const chainId = await client.getChainId();
    if (chainId !== config.chainId) throw new Error(`Wrong chain: expected ${config.chainId}, received ${chainId}`);

    const contracts: Record<string, Address> = {
        predictionHook: config.predictionHook,
        underlyingOracle: config.underlyingOracle,
        usdc: config.usdc,
        poolManager: config.poolManager,
        v4Quoter: config.v4Quoter,
        universalRouter: config.universalRouter,
        permit2: config.permit2,
        multicall3: config.multicall3,
    };
    await Promise.all(Object.entries(contracts).map(async ([name, address]) => {
        const code = await client.getCode({ address });
        if (!code || code === "0x") throw new Error(`No deployed code for ${name} (${address})`);
    }));
    const [block, usdc, decimals, count] = await Promise.all([
        client.getBlock(),
        client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "usdc" }),
        client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "decimals" }),
        client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "marketCount" }),
    ]);
    if (usdc.toLowerCase() !== config.usdc.toLowerCase()) throw new Error("Hook collateral does not match deployment USDC");
    if (decimals !== 6) throw new Error(`Unexpected USDC decimals: ${decimals}`);
    const markets = count === 0n ? [] : await listMarkets(client, {
        hook: config.predictionHook, limit: 3, metadata: true, multicallAddress: config.multicall3,
    });
    if (count > 0n && !markets.some((market) => market.id === count)) {
        throw new Error("Latest market could not be decoded through the SDK");
    }
    for (const market of markets) {
        if (market.info.oracle.toLowerCase() !== config.underlyingOracle.toLowerCase()) {
            throw new Error(`Market ${market.id} oracle does not match deployment`);
        }
    }
    const tradable = markets.filter((market) => market.quote?.tradable &&
        block.timestamp >= market.info.openTime && block.timestamp < market.cutoff);
    return {
        checkedAt: new Date().toISOString(),
        chainId,
        blockNumber: block.number.toString(),
        blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
        contracts,
        marketCount: count.toString(),
        markets: markets.map((market) => ({
            id: market.id.toString(), status: market.status, strikeUsd: market.strikeUsd,
            up: market.yes.address, down: market.no.address,
            expiry: Number(market.info.expiry),
            quoteAvailable: Boolean(market.quote),
            tradable: tradable.some((item) => item.id === market.id),
        })),
        warnings: tradable.length ? [] : ["No tradable market among the latest three. Check keeper and oracle readiness before Phase 2."],
    };
}
