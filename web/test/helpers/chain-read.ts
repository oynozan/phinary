import assert from "node:assert/strict";
import { zeroAddress } from "viem";
import { getConnectionConfig } from "../../src/lib/onchain/config.ts";
import type { createChainClient } from "../../src/lib/onchain/client.ts";

export const config = getConnectionConfig();
export function chainFixture() {
    const state = {
        chainId: 1301, count: 35n, warm: true, timestamp: 1020n,
        missingCode: "", failedRead: "", failedQuote: false, failedOracle: false,
        owner: config.marketScheduler!, keeper: zeroAddress as string,
        hook: config.predictionHook, oracle: config.underlyingOracle,
        marketOracle: config.underlyingOracle,
    };
    const ids: bigint[] = [];
    const read = ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
        assert.equal(blockNumber, 42n, `${functionName} must use the snapshot block`);
        if (functionName === state.failedRead) throw Error("Read unavailable");
        switch (functionName) {
            case "marketCount": return state.count;
            case "usdc": return config.usdc;
            case "decimals": return 6;
            case "owner": return state.owner;
            case "keeper": return state.keeper;
            case "hook": return state.hook;
            case "oracle": return state.oracle;
            case "canOpen": return false;
            case "nextOpenTime": return 1080n;
            default: throw Error(`Unexpected call ${functionName}`);
        }
    };
    const client = {
        getChainId: async () => state.chainId,
        getBlock: async () => ({ number: 42n, timestamp: state.timestamp }),
        getCode: async ({ address, blockNumber }: { address: string; blockNumber: bigint }) => {
            assert.equal(blockNumber, 42n);
            return address === state.missingCode ? "0x" : "0x6000";
        },
        readContract: async (args: Parameters<typeof read>[0]) => read(args),
        multicall: async ({ contracts, blockNumber }: { contracts: { functionName: string; args?: bigint[] }[]; blockNumber: bigint }) => {
            assert.equal(blockNumber, 42n);
            return contracts.map(c => {
                if (c.functionName === state.failedRead || (c.functionName === "quote" && state.failedQuote) ||
                    (state.failedOracle && ["lnSpotSoBWad", "varianceE36"].includes(c.functionName))) return { status: "failure", error: Error("Unavailable") };
                let result: unknown;
                switch (c.functionName) {
                    case "lnSpotSoBWad": result = 0n; break;
                    case "varianceE36": result = [10n ** 28n, state.warm]; break;
                    case "marketInfo":
                        ids.push(c.args![0]);
                        result = { yes: config.usdc, no: config.usdc, oracle: state.marketOracle, lnStrikeWad: 0n,
                            openTime: 1000n, expiry: 1060n, window: 10, cutoffBuffer: 2, status: 1, yesWon: false,
                            bucket: 1000000n, outYes: 0n, outNo: 0n, invYes: 0n, invNo: 0n }; break;
                    case "marketParams": result = { nSamples: 10 }; break;
                    case "quote": result = { tradable: true, tau: 40n, varE36: 10n ** 28n, xWad: 0n,
                        midYes: 5n * 10n ** 17n, askYes: 6n * 10n ** 17n, bidYes: 4n * 10n ** 17n,
                        askNo: 6n * 10n ** 17n, bidNo: 4n * 10n ** 17n }; break;
                    default: throw Error(`Unexpected call ${c.functionName}`);
                }
                return { status: "success", result };
            });
        },
    } as unknown as ReturnType<typeof createChainClient>;
    return { client, state, ids };
}
