import { describe, it, expect } from 'vitest';
import { cachedTransport, getCacheKey, createCachedViemClient } from '../node_modules/ponder/dist/esm/indexing/client.js';
import { createPublicClient, encodeFunctionData, encodeAbiParameters, parseAbi, toHex, multicall3Abi, encodeFunctionResult } from 'viem';
const address = '0xE6780bBeAee4183Ffd8EBe0d2862dEd221B96aA8';
const abi = parseAbi(['function navPlus() view returns(uint256)']);
const blockNumber = 63575170n;
const request = { method: 'eth_call', params: [{ to: address, data: encodeFunctionData({ abi, functionName: 'navPlus' }) }, toHex(blockNumber)] };
const good = encodeAbiParameters([{ type: 'uint256' }], [93355145n]);
const logger = { child() { return this; }, debug() {}, warn() {} };
const metric = { inc() {}, observe() {} };
function fixture(empty, source, multicall) {
    const cache = new Map([[1301, new Map()]]);
    const stored = source === 'database' ? JSON.stringify(empty) : undefined;
    if (source !== 'database') cache.get(1301).set(getCacheKey(request), source === 'promise' ? Promise.resolve(JSON.stringify(empty)) : JSON.stringify(empty));
    let calls = 0;
    const writes = [];
    const client = createPublicClient({ transport: cachedTransport({
        common: { logger, metrics: new Proxy({}, { get: () => metric }) }, chain: { id: 1301, name: 'test' }, cache,
        event: () => ({ type: 'block', eventCallback: { name: 'VaultSnapshot:block' } }),
        rpc: { async request() { calls++; return multicall ? encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: [{ success: true, returnData: good }] }) : good; } },
        syncStore: { async getRpcRequestResults({ requests }) { return requests.map(() => stored); }, async insertRpcRequestResults({ requests }) { writes.push(...requests); } },
    }) });
    return { client, writes, calls: () => calls };
}
describe('Ponder empty response recovery', () => {
    for (const empty of [null, '0x']) for (const source of ['promise', 'memory', 'database']) for (const multi of [false, true]) {
        it(`${String(empty)} from ${source}, multicall=${multi}: fetches fresh data without persisting empties`, async () => {
            const f = fixture(empty, source, multi);
            const value = multi
                ? (await f.client.multicall({ contracts: [{ address, abi, functionName: 'navPlus' }], multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11', blockNumber, allowFailure: false }))[0]
                : await f.client.readContract({ address, abi, functionName: 'navPlus', blockNumber });
            expect(value).toBe(93355145n); expect(f.calls()).toBe(1);
            expect(f.writes.every(w => JSON.parse(w.result) === good)).toBe(true);
        });
    }
    it('still uses a valid cached result without RPC', async () => {
        const f = fixture(good, 'promise', false);
        expect(await f.client.readContract({ address, abi, functionName: 'navPlus', blockNumber })).toBe(93355145n);
        expect(f.calls()).toBe(0);
    });
});


describe('actual Ponder prefetch and retry flow', () => {
    for (const empty of [null, '0x']) it(`recovers from ${String(empty)} during prefetch and ordinary RPC`, async () => {
        let calls = 0, nextEmpty = false;
        const writes = [];
        const chain = { id: 1301, name: 'test' };
        const eventCount = { 'VaultSnapshot:block': 1 };
        const cached = createCachedViemClient({
            common: { logger, metrics: new Proxy({}, { get: () => metric }) }, eventCount,
            indexingBuild: { chains: [chain], rpcs: [{ async request() { calls++; if (nextEmpty) { nextEmpty = false; return empty; } return good; } }] },
            syncStore: { async getRpcRequestResults({ requests }) { return requests.map(() => undefined); }, async insertRpcRequestResults({ requests }) { writes.push(...requests); } },
        });
        const event = n => ({ type: 'block', chain, eventCallback: { name: 'VaultSnapshot:block' }, event: { block: { number: n } } });
        const client = cached.getClient(chain);
        cached.event = event(blockNumber);
        expect(await client.readContract({ address, abi, functionName: 'navPlus' })).toBe(93355145n);
        const next = event(blockNumber + 1n);
        eventCount['VaultSnapshot:block'] = 2; cached.event = next; nextEmpty = true;
        await cached.prefetch({ events: [next] });
        expect(await client.readContract({ address, abi, functionName: 'navPlus' })).toBe(93355145n);
        expect(calls).toBe(3);
        cached.clear(); cached.event = event(blockNumber + 2n); nextEmpty = true;
        expect(await client.readContract({ address, abi, functionName: 'navPlus' })).toBe(93355145n);
        expect(calls).toBe(5);
        expect(writes.every(w => JSON.parse(w.result) === good)).toBe(true);
    });
});
