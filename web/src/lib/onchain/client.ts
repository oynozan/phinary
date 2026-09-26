import { createPublicClient, fallback, http } from "viem";
import { unichainSepolia } from "viem/chains";
import { getConnectionConfig } from "./config.ts";

export function createChainClient(config = getConnectionConfig()) {
    const transports = config.rpcUrls.map((url) => http(url, { timeout: 15_000, retryCount: 1 }));
    return createPublicClient({
        chain: unichainSepolia,
        // A rate-limited or failing primary falls through to the next URL.
        transport: transports.length === 1 ? transports[0]! : fallback(transports),
    });
}
