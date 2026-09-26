import { isPlaceholderAddress, parseDeployment, requireHook } from "@phinary/swap-sdk";
import { getAddress, type Address } from "viem";
import deployment from "../../../../deployments/unichain-sepolia.json" with { type: "json" };
import { rpcUrlList } from "./rpc-urls.ts";

/** The single scheduler of a file from before the gatekeeper migration, undefined once `marketGatekeeper` is set */
function legacyScheduler(json: Record<string, unknown>, gatekeeper: Address | undefined): Address | undefined {
    if (gatekeeper || !("marketScheduler" in json)) return undefined;
    if (isPlaceholderAddress(json.marketScheduler)) throw new Error("Deployment contains invalid addresses: marketScheduler");
    return getAddress(json.marketScheduler as string);
}

/** Public connection details only. Never place signing keys in this module. */
export function getConnectionConfig() {
    const contracts = parseDeployment(deployment);
    if (contracts.placeholders.length) {
        throw new Error(`Deployment contains invalid addresses: ${contracts.placeholders.join(", ")}`);
    }
    if (!contracts.underlyingOracle) throw new Error("Underlying oracle is missing");
    if (contracts.marketGatekeeper && !contracts.marketSchedulers.length) throw new Error("Market schedulers are missing");
    const marketScheduler = legacyScheduler(deployment as Record<string, unknown>, contracts.marketGatekeeper);
    // The flat underlying keys always describe the ETH pool
    const oracleAssets: Record<string, string> = { [contracts.underlyingOracle.toLowerCase()]: "ETH" };
    for (const u of contracts.underlyings) oracleAssets[u.oracle.toLowerCase()] = u.symbol;
    // One URL, or several comma-separated: reads go to the first that answers.
    const rpcUrls = rpcUrlList(process.env.NEXT_PUBLIC_PHINARY_RPC_URL || deployment.rpcUrl);
    const rpcUrl = rpcUrls[0]!;
    return {
        ...contracts,
        predictionHook: requireHook(contracts),
        underlyingOracle: contracts.underlyingOracle,
        marketScheduler,
        /** Asset symbol by lower-case oracle address */
        oracleAssets,
        rpcUrl,
        rpcUrls,
        /** Given to wallets that add the network, so a keyed provider URL never leaves this app. */
        publicRpcUrl: deployment.rpcUrl,
        // Chain ID alone does not distinguish a local fork from Sepolia.
        cacheKey: `${contracts.chainId}:${rpcUrl}:${contracts.predictionHook}`,
    };
}
