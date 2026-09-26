import { predictionHookAbi } from "@phinary/swap-sdk";
import { erc20Abi, zeroAddress, type Address } from "viem";
import { createChainClient } from "./client.ts";
import { getConnectionConfig } from "./config.ts";
import { readMarkets } from "./read-markets.ts";
import { hookOwnershipAbi, schedulerReadAbi } from "./read-abis.ts";

/** Read-only preflight at one block. This never opens a market or sends a transaction. */
export async function checkConnection(client = createChainClient(), config = getConnectionConfig()) {
    const scheduler = config.marketScheduler;
    if (!scheduler) throw new Error("Market scheduler is missing from deployment");
    // Use the same SDK ABI and adapter as the dashboard, including partial quote failures.
    const snapshot = await readMarkets(undefined, client, config);
    const blockNumber = snapshot.blockNumber;
    const contracts: Record<string, Address> = {
        predictionHook: config.predictionHook,
        marketScheduler: scheduler,
        underlyingOracle: config.underlyingOracle,
        usdc: config.usdc,
        poolManager: config.poolManager,
        v4Quoter: config.v4Quoter,
        universalRouter: config.universalRouter,
        permit2: config.permit2,
        multicall3: config.multicall3,
    };
    await Promise.all(Object.entries(contracts).map(async ([name, address]) => {
        const code = await client.getCode({ address, blockNumber });
        if (!code || code === "0x") throw new Error(`No deployed code for ${name} (${address})`);
    }));
    const [usdc, decimals, owner, keeper, schedulerHook, schedulerOracle, canOpen, nextOpenTime] = await Promise.all([
        client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "usdc", blockNumber }),
        client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "decimals", blockNumber }),
        client.readContract({ address: config.predictionHook, abi: hookOwnershipAbi, functionName: "owner", blockNumber }),
        client.readContract({ address: config.predictionHook, abi: hookOwnershipAbi, functionName: "keeper", blockNumber }),
        client.readContract({ address: scheduler, abi: schedulerReadAbi, functionName: "hook", blockNumber }),
        client.readContract({ address: scheduler, abi: schedulerReadAbi, functionName: "oracle", blockNumber }),
        client.readContract({ address: scheduler, abi: schedulerReadAbi, functionName: "canOpen", blockNumber }),
        client.readContract({ address: scheduler, abi: schedulerReadAbi, functionName: "nextOpenTime", blockNumber }),
    ]);
    const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
    if (!same(usdc, config.usdc)) throw new Error("Hook collateral does not match deployment USDC");
    if (decimals !== 6) throw new Error(`Unexpected USDC decimals: ${decimals}`);
    if (!same(owner, scheduler)) throw new Error("Hook owner does not match scheduler");
    if (!same(keeper, zeroAddress)) throw new Error("Scheduler-owned hook still has a privileged keeper");
    if (!same(schedulerHook, config.predictionHook)) throw new Error("Scheduler hook does not match deployment");
    if (!same(schedulerOracle, config.underlyingOracle)) throw new Error("Scheduler oracle does not match deployment");
    for (const market of snapshot.markets) {
        if (!same(market.oracle, config.underlyingOracle)) {
            throw new Error(`Market ${market.id} oracle does not match deployment`);
        }
    }
    const markets = snapshot.markets.slice(0, 3);
    const warnings: string[] = [];
    if (!markets.some(market => market.quote?.tradable)) {
        warnings.push("No tradable market among the latest three. Check keeper and oracle readiness before trading.");
    }
    if (!snapshot.eth) warnings.push("Oracle price or variance is unavailable at the checked block.");
    else if (!snapshot.eth.warm) warnings.push("Oracle is using fallback variance while observations warm up.");
    return {
        checkedAt: new Date().toISOString(),
        chainId: config.chainId,
        blockNumber: blockNumber.toString(),
        blockTime: new Date(snapshot.timestamp * 1000).toISOString(),
        contracts,
        scheduler: { owner, keeper, hook: schedulerHook, oracle: schedulerOracle, canOpen, nextOpenTime: nextOpenTime.toString() },
        oracle: snapshot.eth ?? null,
        marketCount: String(snapshot.count),
        markets: markets.map(market => ({
            id: String(market.id), status: market.status, phase: market.phase, strikeUsd: market.strike,
            up: market.up, down: market.down, expiry: market.expiry, cutoff: market.cutoff,
            quoteAvailable: Boolean(market.quote), tradable: Boolean(market.quote?.tradable),
        })),
        warnings,
    };
}
