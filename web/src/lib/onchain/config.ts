import { parseDeployment, requireHook } from "@phinary/swap-sdk";
import deployment from "../../../../deployments/unichain-sepolia.json" with { type: "json" };
import { rpcUrlList } from "./rpc-urls.ts";

/** Public connection details only. Never place signing keys in this module. */
export function getConnectionConfig() {
    const contracts = parseDeployment(deployment);
    if (contracts.placeholders.length) {
        throw new Error(`Deployment contains invalid addresses: ${contracts.placeholders.join(", ")}`);
    }
    if (!contracts.underlyingOracle) throw new Error("Underlying oracle is missing");
    // One URL, or several comma-separated: reads go to the first that answers.
    const rpcUrls = rpcUrlList(process.env.NEXT_PUBLIC_PHINARY_RPC_URL || deployment.rpcUrl);
    const rpcUrl = rpcUrls[0]!;
    return {
        ...contracts,
        predictionHook: requireHook(contracts),
        underlyingOracle: contracts.underlyingOracle,
        rpcUrl,
        rpcUrls,
        /** Given to wallets that add the network, so a keyed provider URL never leaves this app. */
        publicRpcUrl: deployment.rpcUrl,
        // Chain ID alone does not distinguish a local fork from Sepolia.
        cacheKey: `${contracts.chainId}:${rpcUrl}:${contracts.predictionHook}`,
    };
}
