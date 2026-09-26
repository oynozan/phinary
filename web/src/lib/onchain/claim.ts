import { submittedNonce } from "./recover-receipt.ts";
import { predictionHookAbi, gasWithHeadroom } from '@phinary/swap-sdk';
import { erc20Abi, encodeFunctionData, parseEventLogs, type WalletClient } from 'viem';
import { unichainSepolia } from 'viem/chains';
import { getConnectionConfig } from './config.ts';
import { PendingReceiptError, type PendingTransaction, type BuyProgress } from './buy.ts';
import type { captureWallet } from './wallet.ts';

export function claimAmount(status: number, yesWon: boolean, up: bigint, down: bigint) {
    const amount = status === 2 ? yesWon ? up : down : status === 3 ? up + down : 0n;
    const payout = status === 3 ? amount / 2n : amount;
    return { amount, payout };
}
export async function executeClaim(marketId: number, ctx: Pick<ReturnType<typeof captureWallet>, 'client' | 'account' | 'assertReady'> & {
    wallet: WalletClient;
    onPending: (tx: PendingTransaction | null) => void;
    onProgress: (progress: BuyProgress) => void;
    config?: ReturnType<typeof getConnectionConfig>;
}) {
    const config = ctx.config ?? getConnectionConfig();
    if (!Number.isSafeInteger(marketId) || marketId < 1) throw new Error('Invalid market');
    await ctx.assertReady();
    const block = await ctx.client.getBlock();
    const info = await ctx.client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'marketInfo', args: [BigInt(marketId)], blockNumber: block.number });
    const [up, down] = await Promise.all([info.yes, info.no].map(address => ctx.client.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.account], blockNumber: block.number })));
    const { amount, payout } = claimAmount(info.status, info.yesWon, up, down);
    if (payout === 0n) throw new Error('No redeemable balance in this market');
    const data = encodeFunctionData({ abi: predictionHookAbi, functionName: 'redeem', args: [BigInt(marketId), amount] });
    await ctx.client.simulateContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'redeem', args: [BigInt(marketId), amount], account: ctx.account });
    const gas = await ctx.client.estimateGas({ account: ctx.account, to: config.predictionHook, data });
    await ctx.assertReady();
    ctx.onProgress({ step: 'claim', message: `Confirm redemption of ${amount} token units in your wallet` });
    const submittedBlock = String(await ctx.client.getBlockNumber());
    await ctx.assertReady();
    const hash = await ctx.wallet.sendTransaction({ account: ctx.wallet.account ?? ctx.account, chain: unichainSepolia, to: config.predictionHook, data, gas: gasWithHeadroom(gas) });
    const pending: PendingTransaction = { hash, kind: 'claim', account: ctx.account, marketId, submittedBlock };
    ctx.onPending(pending);
    pending.nonce = await submittedNonce(ctx.client, ctx.wallet, hash); ctx.onPending(pending);
    ctx.onProgress({ step: 'claim', message: 'Waiting for confirmation', hash });
    let replaced = false;
    let receipt;
    try {
        receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 90000, onReplaced: value => {
            replaced ||= value.reason !== 'repriced';
            ctx.onPending({ ...pending, hash: value.transaction.hash, cancelled: replaced });
        } });
    } catch { throw new PendingReceiptError(); }
    ctx.onPending(null);
    if (replaced) throw new Error('Transaction cancelled or replaced. Check your balance.');
    if (receipt.status !== 'success') throw new Error('Redemption reverted');
    const event = parseEventLogs({ abi: predictionHookAbi, logs: receipt.logs, eventName: 'Redeemed' }).find(log => log.address.toLowerCase() === config.predictionHook.toLowerCase() && log.args.marketId === BigInt(marketId) && log.args.account.toLowerCase() === ctx.account.toLowerCase());
    if (!event) throw new Error('Confirmed without a redemption event. Check your balance before retrying.');
    return { hash: receipt.transactionHash, usdc: event.args.payout };
}
