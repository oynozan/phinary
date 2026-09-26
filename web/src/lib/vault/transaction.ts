import { recoverReceipt, submittedNonce } from "../onchain/recover-receipt.ts";
import { predictionHookAbi } from "@phinary/swap-sdk";
import { encodeFunctionData, erc20Abi, parseEventLogs, type Address, type Hex, type WalletClient, type TransactionReceipt } from "viem";
import { unichainSepolia } from "viem/chains";
import { getConnectionConfig } from "../onchain/config.ts";
import { isRejected } from "../onchain/wallet-core.ts";
import { readVaultCore, type VaultClient } from "./read.ts";
import { validateVaultAmount, type VaultMode } from "./math.ts";
export interface VaultPending {
    hash: Hex;
    cancelled?: boolean;
    nonce?: number;
    submittedBlock?: string;
    scanBlock?: string;
    kind: "approve" | VaultMode;
    account: Address;
    chainId: number;
    contract: Address;
}
export interface VaultProgress {
    step: "approve" | VaultMode;
    message: string;
    hash?: Hex;
}
export interface VaultResult {
    hash: Hex;
    assets: bigint;
    shares: bigint;
    kind: VaultMode;
}
export interface VaultContext {
    client: VaultClient;
    wallet: WalletClient;
    account: Address;
    assertReady: () => Promise<void>;
    onProgress: (progress: VaultProgress) => void;
    onPending: (pending: VaultPending | null) => void;
    config?: ReturnType<typeof getConnectionConfig>;
}
export class VaultPendingReceiptError extends Error {
    constructor() { super("Transaction sent; confirmation is still unknown. Check its status before retrying."); }
}
export function describeVaultError(error: unknown): string {
    if (isRejected(error))
        return "Cancelled in your wallet";
    if (error instanceof Error && (error.constructor === Error || error instanceof VaultPendingReceiptError))
        return error.message;
    return "Transaction could not complete. Check your wallet and network, then retry.";
}
export function parseVaultReceipt(receipt: TransactionReceipt, pending: VaultPending): VaultResult | null {
    if (receipt.status !== "success")
        throw new Error("Transaction reverted. Refresh and review the amount before retrying.");
    if (pending.kind === "approve")
        return null;
    const event = parseEventLogs({ abi: predictionHookAbi, logs: receipt.logs, eventName: pending.kind === "deposit" ? "Deposit" : "Withdraw" }).find(log => log.address.toLowerCase() === pending.contract.toLowerCase() && log.args.account.toLowerCase() === pending.account.toLowerCase());
    if (!event)
        throw new Error("Transaction confirmed, but the Vault event was not found. Check your balance and explorer before retrying.");
    return { hash: receipt.transactionHash, kind: pending.kind, assets: event.args.assets, shares: event.args.shares };
}
/** Receipt recovery never sends or approves anything. Unknown outcomes keep the durable pending record. */
export async function resumeVaultTransaction(pending: VaultPending, ctx: Pick<VaultContext, "client" | "onPending" | "onProgress" | "config">, recovery = false): Promise<VaultResult | null> {
    const config = ctx.config ?? getConnectionConfig();
    if (pending.chainId !== config.chainId || pending.contract.toLowerCase() !== config.predictionHook.toLowerCase() || await ctx.client.getChainId() !== pending.chainId)
        throw new Error("Pending transaction belongs to a different network or Vault");
    if (recovery) {
        const { receipt, cancelled } = await recoverReceipt(pending, ctx.client, ctx.onPending);
        ctx.onPending(null);
        if (cancelled) throw new Error("Transaction cancelled or replaced. Check your balance before retrying.");
        return parseVaultReceipt(receipt, pending);
    }
    let replaced = pending.cancelled ?? false;
    let receipt: TransactionReceipt;
    try {
        receipt = await ctx.client.waitForTransactionReceipt({ hash: pending.hash, timeout: 90000, onReplaced: replacement => {
                replaced ||= replacement.reason !== "repriced";
                ctx.onPending({ ...pending, hash: replacement.transaction.hash, cancelled: replaced });
                ctx.onProgress({ step: pending.kind, message: "Waiting for replacement confirmation", hash: replacement.transaction.hash });
            } });
    }
    catch {
        throw new VaultPendingReceiptError();
    }
    ctx.onPending(null);
    if (replaced)
        throw new Error("Transaction was cancelled or replaced. Review your wallet before retrying.");
    return parseVaultReceipt(receipt, pending);
}
export async function executeVault(mode: VaultMode, amount: bigint, ctx: VaultContext): Promise<VaultResult> {
    const { client, wallet, account } = ctx;
    const config = ctx.config ?? getConnectionConfig();
    const fresh = async () => {
        await ctx.assertReady();
        if (wallet.account && wallet.account.address.toLowerCase() !== account.toLowerCase())
            throw new Error("Wallet account changed. Review the amount again.");
        validateVaultAmount(mode, amount, await readVaultCore(account, client, config));
        if (await client.getBalance({ address: account }) === 0n)
            throw new Error("Test ETH is required for gas");
    };
    const send = async (kind: VaultPending["kind"], to: Address, data: Hex) => {
        await fresh();
        const gas = await client.estimateGas({ account, to, data });
        await ctx.assertReady();
        ctx.onProgress({ step: kind, message: kind === "approve" ? "Approve USDC in your wallet" : `Confirm ${kind} in your wallet` });
        const submittedBlock = String(await client.getBlockNumber());
        await ctx.assertReady();
        const hash = await wallet.sendTransaction({ account: wallet.account ?? account, chain: unichainSepolia, to, data, gas: gas * 12n / 10n });
        const pending: VaultPending = { hash, kind, account, chainId: config.chainId, contract: config.predictionHook, submittedBlock };
        ctx.onPending(pending);
        pending.nonce = await submittedNonce(client, wallet, hash); ctx.onPending(pending);
        ctx.onProgress({ step: kind, message: "Waiting for confirmation", hash });
        return resumeVaultTransaction(pending, ctx);
    };
    await fresh();
    if (mode === "deposit") {
        const allowance = await client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "allowance", args: [account, config.predictionHook] });
        if (allowance < amount) {
            await client.simulateContract({ address: config.usdc, abi: erc20Abi, functionName: "approve", args: [config.predictionHook, amount], account });
            await send("approve", config.usdc, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [config.predictionHook, amount] }));
        }
    }
    await fresh();
    await client.simulateContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: mode, args: [amount], account });
    const result = await send(mode, config.predictionHook, encodeFunctionData({ abi: predictionHookAbi, functionName: mode, args: [amount] }));
    if (!result)
        throw new Error("No Vault result was returned");
    return result;
}
