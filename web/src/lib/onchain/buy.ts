import type { createChainClient } from "./client.ts";
type ChainClient = ReturnType<typeof createChainClient>;
import {
    buildPermitSingle, buildSwap, erc20ApproveTx, estimateSwapGas, gasWithHeadroom,
    hookErrorsAbi, minOutWithSlippage, permitTypedData, predictionHookAbi,
    quoteExactIn, readAllowances, zeroForOneFor, PredictionSwapError, type PoolKey,
} from "@phinary/swap-sdk";
import { erc20Abi, parseEventLogs, parseUnits, type Address, type Hex, type WalletClient } from "viem";
import { unichainSepolia } from "viem/chains";
import { getConnectionConfig } from "./config.ts";
import { isRejected } from "./wallet-core.ts";

export function parseUsdc(value: string): bigint {
    if (!/^(?:\d+\.?\d{0,6}|\.\d{1,6})$/.test(value)) throw new Error("Enter an amount with at most 6 decimal places");
    const amount = parseUnits(value, 6);
    if (amount <= 0n || amount > (1n << 128n) - 1n) throw new Error("Enter a valid positive amount");
    return amount;
}
export interface BuyQuote {
    marketId: number; amountIn: bigint; amountOut: bigint; minimumOut: bigint;
    slippageBps: number; cutoff: number; quotedAt: number; blockTime: number;
    token: Address; poolKey: PoolKey;
}
export function validateReview(q: BuyQuote, now: number) {
    if (!Number.isInteger(q.slippageBps) || q.slippageBps < 0 || q.slippageBps > 1000) throw new Error("Invalid slippage tolerance");
    if (q.amountIn <= 0n || q.minimumOut <= 0n || q.minimumOut !== minOutWithSlippage(q.amountOut, q.slippageBps)) throw new Error("Invalid quote");
    if (now >= q.cutoff) throw new Error("Trading has closed for this market");
    if (Date.now() - q.quotedAt > 30_000) throw new Error("Quote expired. Review a fresh quote.");
}
export async function fetchBuyQuote(client: ChainClient, marketId: number, amount: bigint, slippageBps: number, account?: Address,
    config = getConnectionConfig()): Promise<BuyQuote> {
    if (!Number.isSafeInteger(marketId) || marketId < 1) throw new Error("Invalid market");
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1000) throw new Error("Invalid slippage tolerance");
    const [chainId, head] = await Promise.all([client.getChainId(), client.getBlock()]);
    if (chainId !== config.chainId) throw new Error("RPC is on the wrong network");
    const [info, keys, usdc] = await Promise.all([
        client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "marketInfo", args: [BigInt(marketId)], blockNumber: head.number }),
        client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "poolKeys", args: [BigInt(marketId)], blockNumber: head.number }),
        client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "usdc", blockNumber: head.number }),
    ]);
    const cutoff = Number(info.expiry) - info.window - info.cutoffBuffer;
    if (info.status !== 1 || head.timestamp < info.openTime || Number(head.timestamp) >= cutoff) throw new Error("Trading has closed for this market");
    const poolKey = keys[0];
    const currencies = [poolKey.currency0.toLowerCase(), poolKey.currency1.toLowerCase()];
    if (usdc.toLowerCase() !== config.usdc.toLowerCase() || !currencies.includes(usdc.toLowerCase()) ||
        !currencies.includes(info.yes.toLowerCase()) || poolKey.hooks.toLowerCase() !== config.predictionHook.toLowerCase()) throw new Error("Market route does not match this deployment");
    const quote = await quoteExactIn(client, {
        poolKey, zeroForOne: zeroForOneFor(poolKey, config.usdc), amount,
        account, quoter: config.v4Quoter, extraErrors: hookErrorsAbi,
    });
    return { marketId, amountIn: amount, amountOut: quote.amountOut, minimumOut: minOutWithSlippage(quote.amountOut, slippageBps),
        slippageBps, cutoff, quotedAt: Date.now(), blockTime: Number(head.timestamp), token: info.yes, poolKey };
}
export type BuyStep = "approve" | "sign" | "swap";
export interface PendingTransaction { hash: Hex; kind: "approve" | "swap"; account: Address; marketId: number }
export interface BuyProgress { step: BuyStep; message: string; hash?: Hex }
export class PendingReceiptError extends Error {
    constructor() { super("Transaction sent; confirmation is still unknown. Check its status before retrying."); }
}
export function describeBuyError(error: unknown): string {
    if (isRejected(error)) return "Cancelled in your wallet";
    if (error instanceof PredictionSwapError) return error.message;
    // Our explicit validation messages are plain Errors; provider errors may contain RPC URLs.
    if (error instanceof Error && (error.constructor === Error || error instanceof PendingReceiptError)) return error.message;
    return "Transaction could not complete. Check your wallet and network, then retry.";
}
interface BuyContext {
    client: ChainClient; wallet: WalletClient; account: Address;
    assertReady: () => Promise<void>;
    onProgress: (progress: BuyProgress) => void;
    onPending: (tx: PendingTransaction | null) => void;
    config?: ReturnType<typeof getConnectionConfig>;
}

/** Existing app/src/trade.ts execution path, narrowed to UP exact-input buys. */
export async function executeUpBuy(q: BuyQuote, ctx: BuyContext) {
    const { client, wallet, account, onProgress, onPending, assertReady } = ctx;
    const config = ctx.config ?? getConnectionConfig();
    const fresh = async () => {
        await assertReady();
        const head = await client.getBlock();
        validateReview(q, Number(head.timestamp));
        return Number(head.timestamp);
    };
    const send = async (kind: "approve" | "swap", tx: { to: Address; data: Hex; value?: bigint; gas?: bigint }) => {
        await fresh();
        const hash = await wallet.sendTransaction({ account: wallet.account ?? account, chain: unichainSepolia, ...tx });
        const pending: PendingTransaction = { hash, kind, account, marketId: q.marketId };
        onPending(pending); onProgress({ step: kind, message: "Waiting for confirmation", hash });
        let receipt;
        let replaced = false;
        try {
            receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000, onReplaced: (replacement) => {
                replaced = replacement.reason !== "repriced";
                onPending({ ...pending, hash: replacement.transaction.hash });
                onProgress({ step: kind, message: "Waiting for replacement confirmation", hash: replacement.transaction.hash });
            } });
        } catch { throw new PendingReceiptError(); }
        onPending(null);
        if (replaced) throw new Error("Transaction was cancelled or replaced. Review your wallet before retrying.");
        if (receipt.status !== "success") throw new Error("Transaction reverted. Refresh the quote before retrying.");
        return receipt;
    };
    const now = await fresh();
    const [balance, gasBalance, allowance] = await Promise.all([
        client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        client.getBalance({ address: account }),
        readAllowances(client, { owner: account, token: config.usdc, amount: q.amountIn, spender: config.universalRouter, permit2: config.permit2, now }),
    ]);
    if (balance < q.amountIn) throw new Error("Not enough USDC");
    if (gasBalance === 0n) throw new Error("Test ETH is required for gas");
    if (allowance.needsErc20Approval) {
        onProgress({ step: "approve", message: "Approve USDC in your wallet" });
        await send("approve", erc20ApproveTx({ token: config.usdc, spender: config.permit2, amount: q.amountIn }));
    }
    let permit;
    if (allowance.needsPermit) {
        const at = await fresh();
        const single = buildPermitSingle({ token: config.usdc, nonce: allowance.permit2Nonce, spender: config.universalRouter,
            amount: q.amountIn, now: at, expiration: q.cutoff, sigDeadline: BigInt(q.cutoff - 1) });
        onProgress({ step: "sign", message: "Sign the trading permission in your wallet" });
        const signature = await wallet.signTypedData({ account: wallet.account ?? account, ...permitTypedData(single, { chainId: config.chainId, permit2: config.permit2 }) });
        permit = { permit: single, signature };
    }
    await fresh();
    onProgress({ step: "swap", message: "Checking the latest price" });
    const updated = await fetchBuyQuote(client, q.marketId, q.amountIn, q.slippageBps, account, config);
    if (updated.amountOut < q.minimumOut) throw new Error("Price changed beyond your minimum. Review a fresh quote.");
    const tx = buildSwap({ poolKey: q.poolKey, zeroForOne: zeroForOneFor(q.poolKey, config.usdc), tradeType: "EXACT_INPUT",
        amount: q.amountIn, limit: q.minimumOut, deadline: BigInt(q.cutoff - 1), permit, router: config.universalRouter });
    const gas = await estimateSwapGas(client, { tx, account, extraErrors: hookErrorsAbi });
    await fresh();
    onProgress({ step: "swap", message: "Confirm UP purchase in your wallet" });
    const receipt = await send("swap", { ...tx, gas: gasWithHeadroom(gas) });
    const fill = parseEventLogs({ abi: predictionHookAbi, logs: receipt.logs, eventName: "Trade" }).find((log) =>
        log.address.toLowerCase() === config.predictionHook.toLowerCase() && log.args.marketId === BigInt(q.marketId) && log.args.isYes && log.args.isBuy);
    if (!fill) throw new Error("Transaction confirmed, but a purchase event was not found. Check the explorer and your balance before retrying.");
    return { hash: receipt.transactionHash, qty: fill.args.qty, usdc: fill.args.usdcAmount };
}
