import assert from 'node:assert/strict';
import { erc20Abi, parseAbi } from 'viem';
import { predictionHookAbi } from '@phinary/swap-sdk';
import { startFixture } from './helpers/fork.mts';
import { executeUpBuy, fetchBuyQuote } from '../src/lib/onchain/buy.ts';
import { executeClaim } from '../src/lib/onchain/claim.ts';
import { readPortfolio } from '../src/lib/portfolio/read.ts';
import { executeVault } from '../src/lib/vault/transaction.ts';
import { readVaultCore } from '../src/lib/vault/read.ts';
import { depositShares, withdrawAssets, maxWithdrawShares } from '../src/lib/vault/math.ts';
import { claimPlan, portfolioTotals } from '../src/lib/portfolio/view-model.ts';
const fixture = await startFixture();
try {
    const { client, wallet, account, config, marketId, expiry, rpc } = fixture;
    const ctx = { client, wallet, account: account.address, config, assertReady: async () => { assert.equal(await client.getChainId(), 1301); }, onPending() {}, onProgress() {} };
    const balance = (address: `0x${string}`) => client.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    for (const side of ['up', 'down'] as const) {
        const quote = await fetchBuyQuote(client, marketId, 100000n, 100, account.address, config, side);
        const before = await balance(config.usdc);
        const buy = await executeUpBuy(quote, ctx);
        assert.equal(before - await balance(config.usdc), quote.amountIn);
        assert.equal(await balance(quote.token), buy.qty); assert.ok(buy.qty >= quote.minimumOut);
        const sellQuote = await fetchBuyQuote(client, marketId, buy.qty / 2n, 100, account.address, config, side, 'sell');
        const beforeSell = await balance(config.usdc);
        const sell = await executeUpBuy(sellQuote, ctx);
        assert.equal(await balance(config.usdc) - beforeSell, sell.usdc); assert.ok(sell.usdc >= sellQuote.minimumOut);
        const remaining = await balance(quote.token);
        const full = await fetchBuyQuote(client, marketId, remaining, 100, account.address, config, side, 'sell');
        const sold = await executeUpBuy(full, ctx);
        assert.ok(sold.usdc >= full.minimumOut); assert.equal(await balance(quote.token), 0n);
        await executeUpBuy(await fetchBuyQuote(client, marketId, 100000n, 100, account.address, config, side), ctx);
        console.log(`${side} buy, partial and full sell passed`);
    }
    const portfolio = await readPortfolio(account.address, client, config);
    assert.equal(portfolio.rows.filter(r => r.marketId === marketId).length, 2);
    const initialVault = await readVaultCore(account.address, client, config);
    const deposit = await executeVault('deposit', 1000001n, ctx);
    const depositedVault = await readVaultCore(account.address, client, config);
    assert.equal(deposit.shares, depositShares(1000001n, initialVault));
    assert.equal(initialVault.usdc - depositedVault.usdc, 1000001n);
    assert.equal(depositedVault.userShares - initialVault.userShares, deposit.shares);
    assert.equal(deposit.shares, maxWithdrawShares(depositedVault));
    const nonce = await client.getTransactionCount({ address: account.address });
    await assert.rejects(executeVault('withdraw', depositedVault.userShares + 1n, ctx), /Not enough shares/);
    await assert.rejects(executeVault('withdraw', 1n, ctx), /too small/);
    await assert.rejects(executeVault('deposit', depositedVault.usdc + 1n, ctx), /Not enough USDC/);
    assert.equal(await client.getTransactionCount({ address: account.address }), nonce);
    const vaultSnapshot = await rpc('evm_snapshot');
    const params = await client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'marketParams', args: [BigInt(marketId)] });
    const owner = await client.readContract({ address: config.predictionHook, abi: parseAbi(['function owner() view returns (address)']), functionName: 'owner' });
    // The isolated fixture already impersonates owner locally. Reserve idle in another
    // market through createMarket, without writing Vault storage directly.
    const reserve = await wallet.writeContract({ account: owner, address: config.predictionHook, abi: predictionHookAbi, functionName: 'createMarket', args: [{ ...params, budget: depositedVault.idle - 1n }] });
    assert.equal((await client.waitForTransactionReceipt({ hash: reserve })).status, 'success');
    const constrained = await readVaultCore(account.address, client, config);
    assert.equal(constrained.idle, 1n);
    const max = maxWithdrawShares(constrained);
    assert.ok(max > 0n && max < constrained.userShares);
    const simulated = await client.simulateContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'withdraw', args: [max], account: account.address });
    assert.equal(simulated.result, withdrawAssets(max, constrained));
    await assert.rejects(client.simulateContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'withdraw', args: [max + 1n], account: account.address }));
    await assert.rejects(executeVault('withdraw', max + 1n, ctx), /Not enough idle USDC/);
    await rpc('evm_revert', [vaultSnapshot]);
    const withdrawal = await executeVault('withdraw', deposit.shares, ctx);
    const withdrawnVault = await readVaultCore(account.address, client, config);
    assert.equal(withdrawal.assets, withdrawAssets(deposit.shares, depositedVault));
    assert.equal(withdrawnVault.usdc - depositedVault.usdc, withdrawal.assets);
    assert.equal(withdrawnVault.userShares, initialVault.userShares);
    assert.ok(withdrawal.assets > 0n); console.log('Vault deposit and withdrawal passed');
    const snapshot = await rpc('evm_snapshot');
    await rpc('evm_setNextBlockTimestamp', [expiry]); await rpc('evm_mine');
    const hash = await wallet.writeContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'settle', args: [BigInt(marketId)] });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
    const beforeClaim = await balance(config.usdc);
    const settledPortfolio = await readPortfolio(account.address, client, config);
    const winningRows = settledPortfolio.rows.filter(r => r.marketId === marketId && r.currentPrice === 1);
    assert.equal(winningRows.length, 1);
    const claimed = await executeClaim(marketId, ctx);
    assert.equal(claimed.usdc, winningRows[0].quantity);
    assert.ok(claimed.usdc > 0n); assert.equal(await balance(config.usdc) - beforeClaim, claimed.usdc);
    await assert.rejects(executeClaim(marketId, ctx), /No redeemable balance/);
    assert.ok((await readPortfolio(account.address, client, config)).rows.filter(r => r.marketId === marketId).every(r => r.currentPrice === 0));
    console.log('Settlement and winning claim passed');
    await rpc('evm_revert', [snapshot]);
    await rpc('anvil_setCode', [fixture.oracle, '0x60006000fd']);
    await rpc('evm_setNextBlockTimestamp', [expiry + 3601]); await rpc('evm_mine');
    const invalidHash = await wallet.writeContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'settleInvalid', args: [BigInt(marketId)] });
    assert.equal((await client.waitForTransactionReceipt({ hash: invalidHash })).status, 'success');
    const info = await client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'marketInfo', args: [BigInt(marketId)] });
    // Keep odd raw quantities on both sides through ordinary transfers, not token storage edits.
    const sink = '0x000000000000000000000000000000000000dEaD';
    for (const token of [info.yes, info.no]) {
        const transfer = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [sink, await balance(token) - 3n] });
        assert.equal((await client.waitForTransactionReceipt({ hash: transfer })).status, 'success');
    }
    const invalidPortfolio = await readPortfolio(account.address, client, config);
    assert.equal(claimPlan(invalidPortfolio.rows).amount, .000003);
    assert.equal(portfolioTotals({ availability: 'ready', rows: invalidPortfolio.rows, realized: null }).claimable, .000003);
    const invalidSnapshot = await rpc('evm_snapshot');
    const beforeRefund = await balance(config.usdc);
    const refunded = await executeClaim(marketId, ctx);
    const expectedRefund = 3n; // floor((3 + 3) / 2), not floor(3/2) + floor(3/2).
    assert.equal(refunded.usdc, expectedRefund); assert.equal(await balance(config.usdc) - beforeRefund, expectedRefund);
    console.log('Invalid combined-side refund passed');
    assert.equal(await balance(info.yes), 0n); assert.equal(await balance(info.no), 0n);
    assert.equal((await readPortfolio(account.address, client, config)).rows.length, 0);
    await rpc('evm_revert', [invalidSnapshot]);
    for (const [token, keep] of [[info.yes, 1n], [info.no, 0n]] as const) {
        const transfer = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [sink, await balance(token) - keep] });
        assert.equal((await client.waitForTransactionReceipt({ hash: transfer })).status, 'success');
    }
    const dustRows = (await readPortfolio(account.address, client, config)).rows;
    assert.deepEqual(claimPlan(dustRows).marketIds, []);
    assert.equal(portfolioTotals({ availability: 'ready', rows: dustRows, realized: null }).claimable, 0);
    const dustNonce = await client.getTransactionCount({ address: account.address });
    await assert.rejects(executeClaim(marketId, ctx), /No redeemable balance/);
    assert.equal(await client.getTransactionCount({ address: account.address }), dustNonce);
    console.log('Invalid odd-unit rounding, dust exclusion and post-claim holdings passed');
} finally { fixture.stop(); }
