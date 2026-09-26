/** Phase 3: real Scheduler -> Hook -> oracle -> frontend swap code, on loopback Anvil only. */
import assert from 'node:assert/strict';
import { erc20Abi } from 'viem';
import { startFixture } from './helpers/fork.mts';
import { executeUpBuy, fetchBuyQuote, type PendingTransaction } from '../src/lib/onchain/buy.ts';
import { assertWalletNetwork, isRejected } from '../src/lib/onchain/wallet-core.ts';

const f = await startFixture({ marketSource: 'scheduler' });
try {
    const { client, wallet, account, config, marketId, rpc } = f;
    const provider = { request: async ({ method, params }: { method: string; params?: unknown[] }) =>
        method === 'eth_accounts' ? [account.address] : rpc(method, params) };
    const steps: string[] = [];
    let pending: PendingTransaction | null = null;
    const ctx = { client, wallet, account: account.address, config,
        assertReady: () => assertWalletNetwork(provider, client, account.address, 1301),
        onProgress: (progress: { step: string }) => { steps.push(progress.step); },
        onPending: (value: PendingTransaction | null) => { pending = value; } };
    const balance = (address: `0x${string}`) => client.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    for (const side of ['up', 'down'] as const) {
        // An explicit test-only 10% limit accommodates short-dated markets; the UI default stays unchanged.
        const quote = await fetchBuyQuote(client, marketId, 100000n, 1000, account.address, config, side);
        const before = await balance(config.usdc);
        const bought = await executeUpBuy(quote, ctx);
        assert.equal(before - await balance(config.usdc), quote.amountIn);
        assert.equal(await balance(quote.token), bought.qty);
        assert.ok(bought.qty >= quote.minimumOut);
        for (const fraction of [2n, 1n]) {
            const held = await balance(quote.token);
            const sellQuote = await fetchBuyQuote(client, marketId, held / fraction, 1000, account.address, config, side, 'sell');
            const cash = await balance(config.usdc);
            const sold = await executeUpBuy(sellQuote, ctx);
            assert.equal(await balance(config.usdc) - cash, sold.usdc);
            assert.equal(held - await balance(quote.token), sellQuote.amountIn);
            assert.ok(sold.usdc >= sellQuote.minimumOut);
        }
        assert.equal(await balance(quote.token), 0n);
        console.log(`${side}: scheduler-market purchase, partial sell and full sell passed`);
    }
    assert.equal(pending, null);
    for (const step of ['approve', 'sign', 'swap']) assert.ok(steps.includes(step));
    // Before any signature, frontend guards must reject insufficient funds and expired reviews.
    const q = await fetchBuyQuote(client, marketId, 100000n, 1000, account.address, config);
    const nonce = await client.getTransactionCount({ address: account.address });
    await assert.rejects(executeUpBuy({ ...q, amountIn: 1001_000000n }, ctx), /Insufficient input balance/);
    await assert.rejects(executeUpBuy({ ...q, quotedAt: Date.now() - 31000 }, ctx), /Quote expired/);
    await assert.rejects(executeUpBuy({ ...q, account: config.usdc }, ctx), /Wallet changed/);
    assert.equal(await client.getTransactionCount({ address: account.address }), nonce);
    const cashBeforeReject = await balance(config.usdc);
    const tokensBeforeReject = await balance(q.token);
    let signatureRequested = false;
    await assert.rejects(executeUpBuy(q, { ...ctx, wallet: { ...wallet, signTypedData: async () => {
        signatureRequested = true;
        throw Object.assign(new Error('Test wallet declined Permit2 signature'), { code: 4001 });
    } } }), isRejected);
    assert.ok(signatureRequested, 'Must reach the Permit2 signature request');
    assert.equal(pending, null);
    assert.equal(await balance(config.usdc), cashBeforeReject);
    assert.equal(await balance(q.token), tokensBeforeReject);
    // Approval may have succeeded before signature rejection; it must not be reported as a swap.
    const nonceAfterReject = await client.getTransactionCount({ address: account.address });
    await rpc('evm_setNextBlockTimestamp', [q.cutoff]); await rpc('evm_mine');
    await assert.rejects(executeUpBuy(q, ctx), /Trading has closed/);
    assert.equal(await client.getTransactionCount({ address: account.address }), nonceAfterReject);
    console.log(JSON.stringify({ passed: true, marketId, source: 'deployed scheduler and oracle on local fork',
        checks: ['UP/DOWN buy', 'partial/full sell', 'minimum outputs', 'balance deltas', 'insufficient balance', 'expired quote', 'account mismatch', 'Permit2 rejection without swap', 'cutoff without send'] }, null, 2));
} finally { f.stop(); }
