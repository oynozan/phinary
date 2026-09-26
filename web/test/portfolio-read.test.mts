import test from 'node:test';
import assert from 'node:assert/strict';
import { readPortfolio } from '../src/lib/portfolio/read.ts';
import { getConnectionConfig } from '../src/lib/onchain/config.ts';
import type { createChainClient } from '../src/lib/onchain/client.ts';
const config = getConnectionConfig();
test('portfolio scans beyond the recent window, pins blocks and keeps missing quotes unknown', async () => {
    const ids: bigint[] = [];
    const client = {
        getChainId: async () => 1301,
        getBlock: async () => ({ number: 42n, timestamp: 1000n }),
        readContract: async () => 83n,
        multicall: async ({ contracts, blockNumber }: { contracts: { functionName: string; args: unknown[] }[]; blockNumber: bigint }) => {
            assert.equal(blockNumber, 42n);
            if (contracts[0].functionName === 'marketInfo') return contracts.map(c => { ids.push(c.args[0] as bigint); return { yes: config.usdc, no: config.usdc, status: 1, lnStrikeWad: 8000000000000000000n, openTime: 900n, expiry: 5000n, window: 100, cutoffBuffer: 100, bucket: 0n, outYes: 0n, outNo: 0n }; });
            if (contracts[0].functionName === 'balanceOf') return contracts.map((_, i) => i === 0 ? 1000000n : 0n);
            return contracts.map(() => ({ status: 'failure' }));
        },
    } as unknown as ReturnType<typeof createChainClient>;
    const result = await readPortfolio(config.usdc, client, config);
    assert.equal(ids.length, 83); assert.equal(ids.at(-1), 83n);
    assert.deepEqual(result.rows.map(r => r.marketId), [1, 51]);
    assert.equal(result.rows[0].quantity, 1000000n); assert.equal(result.rows[0].value, null);
    assert.equal(result.rows[0].avgCost, null); assert.equal(result.rows[0].profit, null);
    client.multicall = async () => { throw Error('RPC unavailable'); };
    await assert.rejects(readPortfolio(config.usdc, client, config), /RPC unavailable/);
});
