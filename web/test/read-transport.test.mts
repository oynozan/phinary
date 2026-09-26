import test from 'node:test';
import assert from 'node:assert/strict';
import { custom, fallback, toFunctionSelector } from 'viem';
import { invalidReadResult, validatedReadTransport, createReadTransport } from '../src/lib/onchain/read-transport.ts';
const call = {method:'eth_call',params:[{to:'0x1111111111111111111111111111111111111111',data:toFunctionSelector('marketCount()')},'0x123']} as const;

test('null and empty contract value reads fail over without changing the pinned block', async () => {
    for (const value of [null,'0x']) {
        const calls: unknown[] = [];
        const primary=validatedReadTransport(custom({async request(args) {calls.push(args);return value;}},{retryCount:0}));
        const backup=validatedReadTransport(custom({async request(args) {calls.push(args);return '0x'+'0'.repeat(63)+'1';}},{retryCount:0}));
        const transport=fallback([primary,backup],{retryCount:0})({});
        assert.equal(await transport.request(call),'0x'+'0'.repeat(63)+'1');
        assert.deepEqual(calls,[call,call]);
    }
});
test('zero values and void simulations are valid; missing transaction receipts remain pending', () => {
    assert.equal(invalidReadResult(call.method,call.params,'0x'+'0'.repeat(64)),false);
    assert.equal(invalidReadResult('eth_call',[{data:'0x12345678'}],'0x'),false);
    assert.equal(invalidReadResult('eth_getTransactionReceipt',[],null),false);
});
test('exhausted RPCs fail closed, rather than decoding an empty result as a price', async () => {
    const broken=validatedReadTransport(custom({async request(){return null;}},{retryCount:0}));
    await assert.rejects(fallback([broken,broken],{retryCount:0})({}).request(call),/returned no data/);
});
test('only the canonical Sepolia RPC gets a public fallback; forks and custom RPCs stay isolated', () => {
    const publicTransport=createReadTransport('https://sepolia.unichain.org',1301)({});
    const forkTransport=createReadTransport('http://localhost:8545',1301)({});
    assert.equal(publicTransport.value?.transports.length,2);
    assert.equal(forkTransport.value?.transports.length,1);
});
