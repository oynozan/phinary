import { createTransport, fallback, http, toFunctionSelector, type Transport } from 'viem';

export const SECONDARY_SEPOLIA_RPC = 'https://unichain-sepolia-rpc.publicnode.com';
const valueReads = new Set([
    'marketCount()', 'marketInfo(uint256)', 'marketParams(uint256)', 'quote(uint256)',
    'lnSpotSoBWad()', 'varianceE36()', 'aggregate3((address,bool,bytes)[])',
    'balanceOf(address)', 'allowance(address,address)', 'totalSupply()',
].map(signature => toFunctionSelector(signature)));

/** HTTP 200 + null is not a valid eth_call response; known value reads cannot return 0x. */
export function invalidReadResult(method: string, params: unknown, result: unknown) {
    if (method !== 'eth_call') return false;
    if (result === null || result === undefined) return true;
    const call = Array.isArray(params) ? params[0] as { data?: unknown } | undefined : undefined;
    return result === '0x' && typeof call?.data === 'string' && valueReads.has(call.data.slice(0,10) as `0x${string}`);
}
export class EmptyRpcResultError extends Error {
    constructor() { super('RPC contract read returned no data'); this.name = 'EmptyRpcResultError'; }
}
export function validatedReadTransport(base: Transport): Transport {
    return options => {
        const transport = base(options);
        return createTransport({
            ...transport.config,
            retryCount: 0,
            request: (async (args: Parameters<typeof transport.request>[0]) => {
                const result = await transport.request(args);
                if (invalidReadResult(args.method, args.params, result)) throw new EmptyRpcResultError();
                return result;
            }) as typeof transport.request,
        }, transport.value);
    };
}
export function createReadTransport(rpcUrl: string, chainId: number): Transport {
    // A local fork may share chain ID 1301. Never escape a custom RPC to public Sepolia.
    const canonical = chainId === 1301 && new URL(rpcUrl).href === 'https://sepolia.unichain.org/';
    const urls = canonical ? [rpcUrl, SECONDARY_SEPOLIA_RPC] : [rpcUrl];
    const transports = urls.map(url => validatedReadTransport(http(url, { timeout: 15_000, retryCount: 0 })));
    // Retry the identical request/block on an independent endpoint, including empty HTTP-200 results.
    return fallback(transports, { retryCount: canonical ? 0 : 1, rank: false });
}
