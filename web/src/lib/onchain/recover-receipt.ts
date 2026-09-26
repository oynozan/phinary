import type { Address, Hex } from 'viem';
import type { createChainClient } from './client.ts';

export interface ReceiptIdentity { hash: Hex; account: Address; nonce?: number; submittedBlock?: string; scanBlock?: string; cancelled?: boolean }
/** Find mined replacements even when the original disappeared from the RPC mempool after reload. */
export async function recoverReceipt<T extends ReceiptIdentity>(pending: T, client: ReturnType<typeof createChainClient>, save: (value: T) => void) {
    try { return { receipt: await client.getTransactionReceipt({ hash: pending.hash }), cancelled: Boolean(pending.cancelled) }; } catch { /* pending or replaced */ }
    let identity = pending;
    if (identity.nonce === undefined || identity.submittedBlock === undefined) {
        const tx = await client.getTransaction({ hash: pending.hash });
        identity = { ...pending, nonce: tx.nonce, submittedBlock: String(tx.blockNumber ?? await client.getBlockNumber()) };
        save(identity);
    }
    const nonce = identity.nonce!;
    const latest = await client.getBlockNumber();
    if (await client.getTransactionCount({ address: identity.account, blockNumber: latest }) <= nonce) throw new Error('Confirmation is still pending; no new transaction was sent.');
    const start = BigInt(identity.scanBlock ?? identity.submittedBlock!);
    const end = latest < start + 199n ? latest : start + 199n;
    for (let n = start; n <= end; n++) {
        const block = await client.getBlock({ blockNumber: n, includeTransactions: true });
        const replacement = block.transactions.find(tx => tx.from.toLowerCase() === identity.account.toLowerCase() && tx.nonce === nonce);
        if (!replacement) continue;
        // Any different hash requires the user to review actual balances. Never infer a successful intended action.
        const cancelled = Boolean(identity.cancelled) || replacement.hash !== identity.hash;
        save({ ...identity, hash: replacement.hash, cancelled });
        return { receipt: await client.getTransactionReceipt({ hash: replacement.hash }), cancelled };
    }
    if (end < latest) save({ ...identity, scanBlock: String(end + 1n) });
    throw new Error('Confirmation search is incomplete. Check confirmation again; no new transaction was sent.');
}

/** Read the wallet's submitted transaction; never choose its nonce using the app RPC mempool. */
export async function submittedNonce(client: Parameters<typeof recoverReceipt>[1], wallet: import('viem').WalletClient, hash: Hex): Promise<number | undefined> {
    try {
        const tx = await wallet.transport.request({ method: 'eth_getTransactionByHash', params: [hash] }) as { nonce?: string } | null;
        if (tx?.nonce && /^0x[0-9a-f]+$/i.test(tx.nonce)) return Number(BigInt(tx.nonce));
    } catch { /* read RPC may already have propagated the transaction */ }
    try { return (await client.getTransaction({ hash })).nonce; } catch { return undefined; }
}
