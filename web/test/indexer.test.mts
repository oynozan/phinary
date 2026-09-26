import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexerClient } from '../src/lib/indexer/graphql.ts';
import { parseMarket, parseTrade, readIndexedActivity, readIndexedMarket, verifyIndexer } from '../src/lib/indexer/history.ts';
import { parseHistory, withHistory } from '../src/lib/indexer/client.ts';
import { aggregateActivity } from '../src/lib/activity/display.ts';
import { createResource } from '../src/lib/data/resource.ts';
import type { Market } from '../src/lib/types.ts';
const address = `0x${'1'.repeat(40)}`;
const market = { id: '1', up: address, down: `0x${'2'.repeat(40)}`, expiry: 11000, openTime: 9000, window: 100, cutoffBuffer: 100,
    lnStrikeWad: '7800000000000000000', volumeUsdc: '1234567', tradeCount: 3, createdAt: 9000 };
const trade = (id: string, timestamp = 9999) => ({ id, marketId: '1', account: address, side: 'UP', isBuy: true,
    qty: '3000001', usdc: '1500001', avgPriceWad: '500000000000000000', timestamp, txHash: `0x${'a'.repeat(64)}`, attributedBy: 'transfer' });
const price = { id: 'p', marketId: '1', timestamp: 9990, midUp: '500000000000000000', askUp: '600000000000000000', bidUp: '400000000000000000', ethLnWad: '7800000000000000000', varE36: '123' };
const head = { asOf: 10000, indexedBlock: 123 };
function mock(handler: (query: string, variables: Record<string, unknown>, path: string) => unknown) {
    return createIndexerClient('http://indexer.test/base?token=test', (async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const result = handler(body.query ?? '', body.variables ?? {}, new URL(String(url)).pathname);
        return result instanceof Response ? result : Response.json({ data: result });
    }) as typeof fetch);
}
const page = (items: unknown[], next = false, cursor: string | null = null) => ({ rows: { items, pageInfo: { hasNextPage: next, endCursor: cursor } } });
test('GraphQL transport paginates all rows with opaque cursors and preserves URL prefix', async () => {
    const calls: unknown[] = [];
    const client = mock((q, v, path) => { assert.equal(path, '/base/graphql'); calls.push(v.after); return v.after ? page([{ id: 'b' }]) : page([{ id: 'a' }], true, 'opaque'); });
    assert.equal((await client.pages('query', {})).length, 2);
    assert.deepEqual(calls, [null, 'opaque']);
});
test('HTTP 200 GraphQL errors and incomplete pagination never become successful empty data', async () => {
    await assert.rejects(mock(() => Response.json({ errors: [{ message: 'bad' }] })).query('query'));
    await assert.rejects(mock(() => page([{ id: 'same' }], true, 'same')).pages('query', {}));
    await assert.rejects(mock(() => page([], true, 'cursor')).pages('query', {}));
    let i = 0;
    await assert.rejects(mock(() => page([{ id: String(i++) }], true, String(i))).pages('query', {}), /limit/);
    assert.equal(i, 20);
});
test('readiness, chain and sync head are checked independently of the last trade', async () => {
    let verified = false;
    const response = { _meta: { status: { chain: { id: 1301, block: { number: 123, timestamp: 10000 } } } }, market };
    const client = mock((_q, _v, path) => path.endsWith('ready') ? new Response('ok') : response);
    assert.deepEqual(await verifyIndexer(client, 1301, async () => { verified = true; }, 10001), head);
    assert.ok(verified);
    await assert.rejects(verifyIndexer(client, 1, async () => {}, 10001), /chain/);
    await assert.rejects(verifyIndexer(client, 1301, async () => {}, 10061), /delayed/);
    await assert.rejects(verifyIndexer(client, 1301, async () => { throw Error('wrong deployment'); }, 10001), /deployment/);
    await assert.rejects(verifyIndexer(mock(() => new Response('', { status: 503 })), 1301, async () => {}, 10001), /catching up/);
});
test('market history converts units and excludes cutoff/cold oracle sentinel prices', async () => {
    const client = mock((q, v) => {
        if (q.includes('priceSnapshots')) return page([price, { ...price, id: 'cold', varE36: '0' }, { ...price, id: 'cutoff', timestamp: 10800 }]);
        if (q.includes('trades')) return page([trade('t')]);
        assert.equal(v.id, '1'); return { market };
    });
    const result = await readIndexedMarket(client, 1, { ...head, asOf: 10900 });
    assert.equal(result.prices.length, 1); assert.equal(result.prices[0].mid, .5);
    assert.equal(result.trades[0].qty, 3.000001); assert.equal(result.market.volume, 1.234567);
    assert.equal(result.market.cutoff, 10800);
    assert.deepEqual(parseHistory(result, 1, 10901), result);
    assert.throws(() => parseHistory(result, 2, 10901));
    assert.throws(() => parseHistory(result, 1, 11000));
    const rpc = { id: 1, up: market.up, down: market.down, volume: null, tradeCount: null, quote: { midUp: .9 } } as Market;
    const merged = withHistory(rpc, result);
    assert.equal(merged.volume, 1.234567); assert.equal(merged.quote, rpc.quote);
    assert.equal(withHistory({ ...rpc, up: market.down as `0x${string}` }, result).volume, null);
    assert.equal(withHistory(rpc).volume, null);
});
test('invalid amounts, attribution, markets and out-of-range rows fail closed', async () => {
    assert.throws(() => parseTrade({ ...trade('bad'), qty: '-1' }));
    assert.throws(() => parseTrade({ ...trade('bad'), attributedBy: 'unknown' }));
    assert.equal(parseTrade({ ...trade('sender'), attributedBy: 'txFrom' }).attributedBy, 'txFrom');
    assert.throws(() => parseMarket({ ...market, id: '9007199254740993' }));
    await assert.rejects(readIndexedMarket(mock(q => q.includes('priceSnapshots') ? page([{ ...price, marketId: '2' }]) : q.includes('trades') ? page([]) : { market }), 1, head));
});
test('activity includes every paged trade in hour totals, but never invents hourly accounting or claims', async () => {
    const rows = [trade('previous', 6400), ...Array.from({ length: 16 }, (_, i) => trade(String(i), 9990 + i % 10))];
    const client = mock((_q, v) => {
        assert.deepEqual(v.where, { timestamp_gt: 2800, timestamp_lte: 10000 });
        return v.after ? page(rows.slice(10)) : page(rows.slice(0, 10), true, 'next');
    });
    const snapshot = await readIndexedActivity(client, head), display = aggregateActivity(snapshot);
    assert.equal(snapshot.previousHour?.trades, 1); assert.equal(display.trades, 16); assert.equal(display.feed.length, 12);
    assert.ok(Math.abs(display.volume! - 16 * 1.500001) < 1e-8);
    assert.equal(snapshot.accountingComplete, false); assert.equal(display.winRate, null); assert.deepEqual(display.ranking, []);
    const empty = await readIndexedActivity(mock(() => page([])), head);
    assert.equal(aggregateActivity(empty).volume, 0);
    await assert.rejects(readIndexedActivity(mock(() => page([trade('future', 10001)])), head));
});
test('history resource failure does not invalidate independent execution reads and recovers', async () => {
    const rpc = createResource(async () => ({ mid: .5 })); let fails = true;
    const history = createResource(async () => { if (fails) throw Error('offline'); return []; });
    await Promise.all([rpc.refresh(), history.refresh()]);
    assert.ok(history.getSnapshot().error); assert.equal(rpc.getSnapshot().data?.mid, .5);
    fails = false; await history.refresh(); assert.deepEqual(history.getSnapshot().data, []);
});
