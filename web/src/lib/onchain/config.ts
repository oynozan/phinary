import { parseDeployment, requireHook } from "@phinary/swap-sdk";
import deployment from "../../../../deployments/unichain-sepolia.json" with { type: "json" };

/** Public connection details only. Never place signing keys in this module. */
export function getConnectionConfig() {
    const contracts = parseDeployment(deployment);
    if (contracts.placeholders.length) {
        throw new Error(`Deployment contains invalid addresses: ${contracts.placeholders.join(", ")}`);
    }
    if (!contracts.underlyingOracle) throw new Error("Underlying oracle is missing");
    const rpcUrl = process.env.NEXT_PUBLIC_PHINARY_RPC_URL || deployment.rpcUrl;
    const url = new URL(rpcUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("RPC must use HTTP or HTTPS");
    return {
        ...contracts,
        predictionHook: requireHook(contracts),
        underlyingOracle: contracts.underlyingOracle,
        rpcUrl,
        // Chain ID alone does not distinguish a local fork from Sepolia.
        cacheKey: `${contracts.chainId}:${rpcUrl}:${contracts.predictionHook}`,
    };
}
