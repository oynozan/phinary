import { createPublicClient } from "viem";
import { unichainSepolia } from "viem/chains";
import { createReadTransport } from "./read-transport.ts";
import { getConnectionConfig } from "./config.ts";

export function createChainClient(config = getConnectionConfig()) {
    return createPublicClient({
        chain: unichainSepolia,
        transport: createReadTransport(config.rpcUrl, config.chainId),
    });
}
