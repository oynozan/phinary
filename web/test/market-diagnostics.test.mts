import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketReadError, summarizeMarketFailure } from '../src/lib/onchain/market-diagnostics.ts';

test('market failures retain stage, HTTP/RPC code and elapsed time without request URLs', () => {
    const failure = summarizeMarketFailure(new MarketReadError('count', {
        name: 'HttpRequestError', status: 429, message: 'Too many requests https://rpc.invalid/private-key', cause: {code: -32005},
    }), 306, 900.4);
    assert.equal(failure.stage, 'count'); assert.equal(failure.kind, 'rate-limit');
    assert.equal(failure.httpStatus, 429); assert.equal(failure.rpcCode, -32005);
    assert.equal(failure.elapsedMs, 900); assert.equal(failure.marketId, 306);
    assert.ok(!JSON.stringify(failure).includes('private-key'));
});
test('distinguishes unavailable blocks, empty contract data and timeouts', () => {
    for (const [message, kind] of [['header not found','block-unavailable'], ['The contract returned no data','empty-result'], ['Request timed out','timeout']] as const) {
        assert.equal(summarizeMarketFailure(new Error(message), undefined, 500).kind, kind);
    }
});
test('cyclic causes terminate and unknown failures are not labeled rate limits', () => {
    const error: {cause?: unknown; message: string} = {message:'Unexpected result'}; error.cause = error;
    const result = summarizeMarketFailure(error, undefined, 500);
    assert.equal(result.kind,'unknown'); assert.equal(result.marketId,null);
});
