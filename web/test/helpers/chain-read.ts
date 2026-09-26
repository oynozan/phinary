import assert from "node:assert/strict";
import { marketGatekeeperAbi, marketSchedulerAbi, type Underlying } from "@phinary/swap-sdk";
import { decodeFunctionData, encodeFunctionResult, getAddress, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { getConnectionConfig } from "../../src/lib/onchain/config.ts";
import type { createChainClient } from "../../src/lib/onchain/client.ts";

type ConnectionConfig = ReturnType<typeof getConnectionConfig>;
const base = getConnectionConfig();
const ethOracle = base.underlyingOracle;
export const solOracle = getAddress("0x0000000000000000000000000000000000202080");
const legacyScheduler = getAddress("0x511fFFb9fE5d393B10bF185A9c580A732Eff44Dd");
const gatekeeper = getAddress("0x6a7e000000000000000000000000000000000001");
const scheduler = (n: number) => getAddress(`0x5c0000000000000000000000000000000000000${n}`);
const underlying = (symbol: string, oracle: Address): Underlying => ({
    symbol, token: oracle, oracle, poolId: `0x${"00".repeat(32)}`,
    pool: { currency0: oracle, currency1: base.usdc, fee: 500, tickSpacing: 10, hooks: oracle },
});

/** The single-scheduler layout the live file used before the gatekeeper migration */
export const legacyConfig: ConnectionConfig = {
    ...base, marketGatekeeper: undefined, marketSchedulers: [], underlyings: [], marketScheduler: legacyScheduler,
    oracleAssets: { [ethOracle.toLowerCase()]: "ETH" },
};
/** Four tracks behind one gatekeeper, ETH and SOL at 1m and 15m */
export const tracksConfig: ConnectionConfig = {
    ...base, marketGatekeeper: gatekeeper, marketSchedulers: [1, 2, 3, 4].map(scheduler), marketScheduler: undefined,
    underlyings: [underlying("ETH", ethOracle), underlying("SOL", solOracle)],
    oracleAssets: { [ethOracle.toLowerCase()]: "ETH", [solOracle.toLowerCase()]: "SOL" },
};
export const config = legacyConfig;

interface FixtureTrack { scheduler: Address; ticker: string; period: number; oracle: Address; slots: Map<bigint, bigint> }
const track = (address: Address, ticker: string, period: number, oracle: Address, ids: [slot: number, id: number][]): FixtureTrack =>
    ({ scheduler: address, ticker, period, oracle, slots: new Map(ids.map(([s, id]) => [BigInt(s), BigInt(id)])) });
/** At t=1020 the 1m slot is 17 and the 15m slot is 1, ETH1M holds odd ids 5..35, SOL1M even ids 6..34, the 15m tracks ids 1..4 */
function tracksOf(cfg: ConnectionConfig): FixtureTrack[] {
    if (!cfg.marketGatekeeper) return [track(legacyScheduler, "ETH", 60, ethOracle, [])];
    const oneMinute = (first: number) => Array.from({ length: 16 }, (_, k) => [17 - k, first - 2 * k] as [number, number]).filter(([, id]) => id >= 5);
    return [
        track(scheduler(1), "ETH1M", 60, ethOracle, oneMinute(35)),
        track(scheduler(2), "ETH15M", 900, ethOracle, [[1, 3], [0, 1]]),
        track(scheduler(3), "SOL1M", 60, solOracle, oneMinute(34)),
        track(scheduler(4), "SOL15M", 900, solOracle, [[1, 4], [0, 2]]),
    ];
}
const aggregateAbi: Abi = [...marketSchedulerAbi, ...marketGatekeeperAbi];

export function chainFixture(cfg: ConnectionConfig = legacyConfig) {
    const tracks = tracksOf(cfg);
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const trackAt = (address: string) => tracks.find((t) => same(t.scheduler, address));
    const trackOfId = (id: bigint) => cfg.marketGatekeeper ? tracks.find((t) => [...t.slots.values()].includes(id)) : tracks[0];
    const state = {
        chainId: 1301, count: 35n, warm: true, timestamp: 1020n,
        missingCode: "", failedRead: "", failedQuote: false, failedOracle: false,
        owner: (cfg.marketGatekeeper ?? cfg.marketScheduler!) as string, keeper: zeroAddress as string,
        hook: cfg.predictionHook as string, gatekeeperHook: cfg.predictionHook as string,
        gatekeeper: (cfg.marketGatekeeper ?? zeroAddress) as string, schedulers: [...cfg.marketSchedulers] as string[],
        /** Overrides every scheduler's oracle() when set */
        oracle: "",
        /** Overrides every market's oracle when set */
        marketOracle: "",
        lnSpot: { [ethOracle.toLowerCase()]: 0n, [solOracle.toLowerCase()]: 10n ** 18n } as Record<string, bigint>,
    };
    const ids: bigint[] = [];
    const resolve = (address: string, functionName: string, args: readonly unknown[] = []): unknown => {
        if (functionName === state.failedRead) throw Error("Read unavailable");
        const t = trackAt(address);
        switch (functionName) {
            case "marketCount": return state.count;
            case "usdc": return cfg.usdc;
            case "decimals": return 6;
            case "owner": return state.owner;
            case "keeper": return state.keeper;
            case "hook": return same(address, state.gatekeeper) ? state.gatekeeperHook : state.hook;
            case "gatekeeper": return state.gatekeeper;
            case "schedulers": return state.schedulers;
            case "oracle": return state.oracle || t!.oracle;
            case "canOpen": return false;
            case "nextOpenTime": return 1080n;
            case "config": return {
                period: t!.period, tenor: t!.period, window: 10, cutoffBuffer: 2, nSamples: 10,
                quote: { h0Wad: 0n, gammaSWad: 0n, lambdaWad: 0n, qEpochMax: 0n, pMinWad: 0n },
                maxBudget: 10_000000n, minBudget: 1_000000n, ticker: t!.ticker,
            };
            case "marketOfSlot": return t?.slots.get(args[0] as bigint) ?? 0n;
            case "schedulerOf": return trackOfId(args[0] as bigint)?.scheduler ?? zeroAddress;
            case "lnSpotSoBWad": return state.lnSpot[address.toLowerCase()] ?? 0n;
            case "varianceE36": return [10n ** 28n, state.warm];
            case "marketInfo":
                ids.push(args[0] as bigint);
                return { yes: cfg.usdc, no: cfg.usdc, oracle: state.marketOracle || (trackOfId(args[0] as bigint)?.oracle ?? ethOracle),
                    lnStrikeWad: 0n, openTime: 1000n, expiry: 1060n, window: 10, cutoffBuffer: 2, status: 1, yesWon: false,
                    bucket: 1000000n, outYes: 0n, outNo: 0n, invYes: 0n, invNo: 0n };
            case "marketParams": return { nSamples: 10 };
            case "quote": return { tradable: true, tau: 40n, varE36: 10n ** 28n, xWad: 0n,
                midYes: 5n * 10n ** 17n, askYes: 6n * 10n ** 17n, bidYes: 4n * 10n ** 17n,
                askNo: 6n * 10n ** 17n, bidNo: 4n * 10n ** 17n };
            default: throw Error(`Unexpected call ${functionName}`);
        }
    };
    // The SDK's standalone multicall reaches the client as one aggregate3 readContract
    const aggregate3 = (calls: { target: Address; callData: Hex }[]) => calls.map(({ target, callData }) => {
        const { functionName, args } = decodeFunctionData({ abi: aggregateAbi, data: callData });
        try {
            const result = resolve(target, functionName, args ?? []);
            return { success: true, returnData: encodeFunctionResult({ abi: aggregateAbi, functionName, result }) };
        } catch {
            return { success: false, returnData: "0x" };
        }
    });
    const client = {
        getChainId: async () => state.chainId,
        getBlock: async () => ({ number: 42n, timestamp: state.timestamp }),
        getCode: async ({ address, blockNumber }: { address: string; blockNumber: bigint }) => {
            assert.equal(blockNumber, 42n);
            return address === state.missingCode ? "0x" : "0x6000";
        },
        readContract: async ({ address, functionName, args, blockNumber }: { address: string; functionName: string; args?: readonly unknown[]; blockNumber: bigint }) => {
            assert.equal(blockNumber, 42n, `${functionName} must use the snapshot block`);
            if (functionName === "aggregate3") return aggregate3(args![0] as { target: Address; callData: Hex }[]);
            return resolve(address, functionName, args);
        },
        multicall: async ({ contracts, blockNumber }: { contracts: { address: string; functionName: string; args?: bigint[] }[]; blockNumber: bigint }) => {
            assert.equal(blockNumber, 42n);
            return contracts.map(c => {
                if ((c.functionName === "quote" && state.failedQuote) ||
                    (state.failedOracle && ["lnSpotSoBWad", "varianceE36"].includes(c.functionName))) return { status: "failure", error: Error("Unavailable") };
                try {
                    return { status: "success", result: resolve(c.address, c.functionName, c.args) };
                } catch (error) {
                    if ((error as Error).message.startsWith("Unexpected call")) throw error;
                    return { status: "failure", error };
                }
            });
        },
    } as unknown as ReturnType<typeof createChainClient>;
    return { client, state, ids };
}
