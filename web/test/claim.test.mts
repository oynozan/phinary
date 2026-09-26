import test from 'node:test';
import assert from 'node:assert/strict';
import { claimAmount, executeClaim } from '../src/lib/onchain/claim.ts';
import { getConnectionConfig } from '../src/lib/onchain/config.ts';
import { encodeEventTopics, encodeAbiParameters } from 'viem';
import { predictionHookAbi } from '@phinary/swap-sdk';
const config = getConnectionConfig();
const account = '0x1111111111111111111111111111111111111111';
const hash = `0x${'a'.repeat(64)}` as const;
test('claims select only winning balances; invalid combines sides before flooring and rejects dust', () => {
    assert.deepEqual(claimAmount(2, true, 7n, 8n), { amount: 7n, payout: 7n });
    assert.deepEqual(claimAmount(2, false, 7n, 8n), { amount: 8n, payout: 8n });
    assert.deepEqual(claimAmount(3, false, 7n, 8n), { amount: 15n, payout: 7n });
    assert.equal(claimAmount(3, false, 1n, 0n).payout, 0n);
    assert.equal(claimAmount(1, true, 7n, 8n).payout, 0n);
});
test('claim validates identity immediately before sending and retains unknown receipts', async () => {
    let checks = 0, sends = 0, pending: unknown;
    const ctx = {
        account, config,
        client: {
            getTransactionCount: async () => 1, getBlockNumber: async () => 5n,
            getBlock: async () => ({ number: 5n }),
            readContract: async ({ functionName }: { functionName: string }) => functionName === 'marketInfo' ? { status: 2, yesWon: true, yes: account, no: account } : 10n,
            simulateContract: async () => {}, estimateGas: async () => 100000n,
            waitForTransactionReceipt: async () => { throw Error('timeout'); },
        },
        wallet: { sendTransaction: async () => { sends++; return hash; } },
        assertReady: async () => { checks++; if (checks === 2) throw Error('Wallet changed'); },
        onProgress() {}, onPending(value: unknown) { pending = value; },
    } as unknown as Parameters<typeof executeClaim>[1];
    await assert.rejects(executeClaim(1, ctx), /Wallet changed/); assert.equal(sends, 0);
    ctx.assertReady = async () => {};
    await assert.rejects(executeClaim(1, ctx), /confirmation is still unknown/); assert.equal(sends, 1); assert.ok(pending);
    ctx.client.waitForTransactionReceipt = async () => ({ status: 'success', transactionHash: hash, logs: [{ address: config.predictionHook, topics: encodeEventTopics({ abi: predictionHookAbi, eventName: 'Redeemed', args: { marketId: 1n, account } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [10n, 10n]) }] }) as never;
    const result = await executeClaim(1, ctx); assert.equal(result.usdc, 10n); assert.equal(pending, null);
});
