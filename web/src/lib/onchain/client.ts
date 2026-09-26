import { createPublicClient, http } from "viem";
import { unichainSepolia } from "viem/chains";
import { getConnectionConfig } from "./config.ts";

export function createChainClient(config = getConnectionConfig()) {
    return createPublicClient({
        chain: unichainSepolia,
        transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 1 }),
    });
}
