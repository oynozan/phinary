"use client";

import { parseEventLogs } from "viem";
import { predictionHookAbi } from "@phinary/swap-sdk";
import { useSyncExternalStore } from "react";
import { executeUpBuy, describeBuyError, type BuyProgress, type BuyQuote, type PendingTransaction } from "./buy.ts";
import { captureWallet, refreshWalletBalances } from "./wallet.ts";
import { createChainClient } from "./client.ts";
import { getConnectionConfig } from "./config.ts";

interface TransactionState {
    busy: boolean; progress?: BuyProgress; pending?: PendingTransaction;
    error?: string; result?: { hash: `0x${string}`; qty?: bigint; usdc?: bigint; marketId: number; account: `0x${string}` };
}
const initial: TransactionState = { busy: false };
let state = initial;
const listeners = new Set<() => void>();
let restored = false;
const key = () => `phinary.pending:${getConnectionConfig().cacheKey}`;
function update(patch: Partial<TransactionState>) { state = { ...state, ...patch }; for (const l of listeners) l(); }
function pending(tx: PendingTransaction | null) {
    update({ pending: tx ?? undefined });
    try { if (tx) localStorage.setItem(key(), JSON.stringify(tx)); else localStorage.removeItem(key()); } catch { /* retain in memory */ }
}
function restore() {
    if (restored) return; restored = true;
    try {
        const raw = localStorage.getItem(key());
        if (!raw) return;
        const tx = JSON.parse(raw) as PendingTransaction;
        if (/^0x[0-9a-fA-F]{64}$/.test(tx.hash) && /^0x[0-9a-fA-F]{40}$/.test(tx.account) &&
            (tx.kind === "approve" || tx.kind === "swap") && Number.isSafeInteger(tx.marketId)) update({ pending: tx });
    } catch { /* invalid storage is ignored */ }
}
function subscribe(listener: () => void) {
    listeners.add(listener); queueMicrotask(restore);
    return () => { listeners.delete(listener); };
}
export function useTransaction() { return useSyncExternalStore(subscribe, () => state, () => initial); }
export async function buyUp(q: BuyQuote) {
    restore();
    if (state.busy || state.pending) throw new Error("Wait for the existing transaction before starting another");
    update({ busy: true, progress: undefined, result: undefined, error: undefined });
    try {
        const session = captureWallet();
        const result = await executeUpBuy(q, { ...session, onProgress: (progress) => update({ progress }), onPending: pending });
        update({ result: { ...result, marketId: q.marketId, account: session.account }, progress: undefined });
        await refreshWalletBalances();
        return result;
    } catch (error) {
        update({ error: describeBuyError(error) });
        throw error;
    } finally { update({ busy: false }); }
}
/** Never resends a transaction after a timeout or page reload. */
export async function checkPendingTransaction() {
    if (!state.pending || state.busy) return;
    const tx = state.pending;
    update({ busy: true, error: undefined });
    try {
        const receipt = await createChainClient().getTransactionReceipt({ hash: tx.hash });
        pending(null);
        if (receipt.status === "reverted") update({ error: "Transaction reverted. Review a new quote.", progress: undefined });
        else if (tx.kind === "swap") {
            const fill = parseEventLogs({ abi: predictionHookAbi, logs: receipt.logs, eventName: "Trade" }).find((log) =>
                log.address.toLowerCase() === getConnectionConfig().predictionHook.toLowerCase() &&
                log.args.marketId === BigInt(tx.marketId) && log.args.isYes && log.args.isBuy);
            if (fill) update({ result: { hash: receipt.transactionHash, marketId: tx.marketId, account: tx.account, qty: fill.args.qty, usdc: fill.args.usdcAmount }, progress: undefined });
            else update({ error: "Transaction confirmed without a purchase event. Check the explorer and your balance.", progress: undefined });
        }
        else update({ progress: undefined, error: "Approval confirmed. Review a fresh quote to continue buying." });
        await refreshWalletBalances();
    } catch { update({ error: "Confirmation is still unavailable. Check the explorer; no new transaction was sent." }); }
    finally { update({ busy: false }); }
}
