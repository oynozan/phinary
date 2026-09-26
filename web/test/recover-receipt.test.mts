import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverReceipt, type ReceiptIdentity } from '../src/lib/onchain/recover-receipt.ts';
const account = '0x1111111111111111111111111111111111111111';
const hash = `0x${'a'.repeat(64)}` as const, replacement = `0x${'b'.repeat(64)}` as const;
test('reload recovery locates a mined replacement by sender and nonce without submitting', async () => {
    const saved: ReceiptIdentity[] = [];
    const client = {
        getTransactionReceipt: async ({ hash: h }: { hash: string }) => { if (h === hash) throw Error('not found'); return { transactionHash: replacement, status: 'success' }; },
        getBlockNumber: async () => 12n,
        getTransactionCount: async () => 8,
        getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ transactions: blockNumber === 11n ? [{ from: account, nonce: 7, hash: replacement }] : [] }),
    } as unknown as Parameters<typeof recoverReceipt>[1];
    const result = await recoverReceipt({ hash, account, nonce: 7, submittedBlock: '10' }, client, value => saved.push(value));
    assert.equal(result.cancelled, true); assert.equal(result.receipt.transactionHash, replacement); assert.equal(saved[0].hash, replacement);
});
test('unknown confirmation retains original identity; bounded replacement search advances safely', async () => {
    let saved: ReceiptIdentity | undefined;
    const pending: ReceiptIdentity = { hash, account, nonce: 7, submittedBlock: '10' };
    const client = {
        getTransactionReceipt: async () => { throw Error('not found'); }, getBlockNumber: async () => 300n,
        getTransactionCount: async () => 7, getBlock: async () => ({ transactions: [] }),
    } as unknown as Parameters<typeof recoverReceipt>[1];
    await assert.rejects(recoverReceipt(pending, client, value => { saved = value; }), /pending/); assert.equal(saved, undefined);
    client.getTransactionCount = async () => 8;
    await assert.rejects(recoverReceipt(pending, client, value => { saved = value; }), /incomplete/);
    assert.equal((saved as ReceiptIdentity | undefined)?.scanBlock, '210');
});

test('recovery captures actual wallet nonce instead of selecting one from the read RPC', async () => {
 const { submittedNonce } = await import('../src/lib/onchain/recover-receipt.ts');
 const client = { getTransaction: async () => { throw Error('not propagated'); } } as unknown as Parameters<typeof submittedNonce>[0];
 const wallet = { transport: { request: async () => ({ nonce: '0x9' }) } } as unknown as Parameters<typeof submittedNonce>[1];
 assert.equal(await submittedNonce(client, wallet, hash), 9);
});
