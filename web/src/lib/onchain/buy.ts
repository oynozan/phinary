import { submittedNonce } from "./recover-receipt.ts";
import type { createChainClient } from "./client.ts";
type ChainClient = ReturnType<typeof createChainClient>;
import {
    autoSlippageBps, buildPermitSingle, buildSwap, erc20ApproveTx, estimateSwapGas, gasWithHeadroom,
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
    side?: "up" | "down"; mode?: "buy" | "sell"; account?: Address;
    marketId: number; amountIn: bigint; amountOut: bigint; minimumOut: bigint;
    slippageBps: number; cutoff: number; quotedAt: number; blockTime: number;
    token: Address; poolKey: PoolKey;
}
/** Basis points, or "auto" to size the tolerance to the market like the Uniswap fork and the backup app. */
export type Slippage = number | "auto";
export const MAX_SLIPPAGE_BPS = 9_000;
const CONFIRM_SECONDS = 5;
/** Auto: how far this market's price can move between the quote and the block (wallet confirmation plus a block). */
export function resolveSlippageBps(slippage: Slippage, p: { mode: "buy" | "sell"; amountIn: bigint; amountOut: bigint; secondsToWindow: number }): number {
    if (slippage !== "auto") return slippage;
    return autoSlippageBps({ exactIn: true, isBuy: p.mode === "buy", amountIn: p.amountIn, amountOut: p.amountOut,
        secondsToWindow: p.secondsToWindow, confirmSeconds: CONFIRM_SECONDS, maxBps: MAX_SLIPPAGE_BPS });
}
const validSlippage = (bps: number) => Number.isInteger(bps) && bps >= 0 && bps <= MAX_SLIPPAGE_BPS;
export function validateReview(q: BuyQuote, now: number) {
    if (!validSlippage(q.slippageBps)) throw new Error("Invalid slippage tolerance");
    if (q.amountIn <= 0n || q.minimumOut <= 0n || q.minimumOut !== minOutWithSlippage(q.amountOut, q.slippageBps)) throw new Error("Invalid quote");
    if (now >= q.cutoff) throw new Error("Trading has closed for this market");
    if (Date.now() - q.quotedAt > 30_000) throw new Error("Quote expired. Review a fresh quote.");
}
export async function fetchBuyQuote(client: ChainClient, marketId: number, amount: bigint, slippage: Slippage, account?: Address,
    config = getConnectionConfig(), side: "up" | "down" = "up", mode: "buy" | "sell" = "buy"): Promise<BuyQuote> {
    if (!Number.isSafeInteger(marketId) || marketId < 1) throw new Error("Invalid market");
    if (slippage !== "auto" && !validSlippage(slippage)) throw new Error("Invalid slippage tolerance");
    const [chainId, head] = await Promise.all([client.getChainId(), client.getBlock()]);
    if (chainId !== config.chainId) throw new Error("RPC is on the wrong network");
    const [info, keys, usdc] = await Promise.all([
        client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "marketInfo", args: [BigInt(marketId)], blockNumber: head.number }),
        client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "poolKeys", args: [BigInt(marketId)], blockNumber: head.number }),
        client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "usdc", blockNumber: head.number }),
    ]);
    const cutoff = Number(info.expiry) - info.window - info.cutoffBuffer;
    if (info.status !== 1 || head.timestamp < info.openTime || Number(head.timestamp) >= cutoff) throw new Error("Trading has closed for this market");
    const poolKey = keys[side === "up" ? 0 : 1];
    const token = side === "up" ? info.yes : info.no;
    const input = mode === "buy" ? config.usdc : token;
    const currencies = [poolKey.currency0.toLowerCase(), poolKey.currency1.toLowerCase()];
    if (usdc.toLowerCase() !== config.usdc.toLowerCase() || !currencies.includes(usdc.toLowerCase()) ||
        !currencies.includes(token.toLowerCase()) || poolKey.hooks.toLowerCase() !== config.predictionHook.toLowerCase()) throw new Error("Market route does not match this deployment");
    const quote = await quoteExactIn(client, {
        poolKey, zeroForOne: zeroForOneFor(poolKey, input), amount,
        account, quoter: config.v4Quoter, extraErrors: hookErrorsAbi,
    });
    const slippageBps = resolveSlippageBps(slippage, { mode, amountIn: amount, amountOut: quote.amountOut,
        secondsToWindow: Number(info.expiry) - info.window - Number(head.timestamp) });
    return { account, side, mode, marketId, amountIn: amount, amountOut: quote.amountOut, minimumOut: minOutWithSlippage(quote.amountOut, slippageBps),
        slippageBps, cutoff, quotedAt: Date.now(), blockTime: Number(head.timestamp), token, poolKey };
}
export type BuyStep = "approve" | "sign" | "swap" | "claim";
export interface PendingTransaction { hash: Hex; kind: "approve" | "swap" | "claim"; account: Address; marketId: number; side?: "up" | "down"; mode?: "buy" | "sell"; cancelled?: boolean; nonce?: number; submittedBlock?: string; scanBlock?: string }
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

/** Exact-input buy/sell execution. Optional side/mode preserve old UP-buy callers. */
export async function executeUpBuy(q: BuyQuote, ctx: BuyContext) {
    const { client, wallet, account, onProgress, onPending, assertReady } = ctx;
    const config = ctx.config ?? getConnectionConfig();
    if (q.account && q.account.toLowerCase() !== account.toLowerCase()) throw new Error("Wallet changed. Review a fresh quote.");
    const side = q.side ?? "up", mode = q.mode ?? "buy";
    const input = mode === "buy" ? config.usdc : q.token;
    const fresh = async () => {
        await assertReady();
        const head = await client.getBlock();
        validateReview(q, Number(head.timestamp));
        const balance = await client.readContract({ address: input, abi: erc20Abi, functionName: "balanceOf", args: [account] });
        if (balance < q.amountIn) throw new Error("Insufficient input balance");
        return Number(head.timestamp);
    };
    const send = async (kind: "approve" | "swap", tx: { to: Address; data: Hex; value?: bigint; gas?: bigint }) => {
        await fresh();
        const submittedBlock = String(await client.getBlockNumber());
        await assertReady();
        const hash = await wallet.sendTransaction({ account: wallet.account ?? account, chain: unichainSepolia, ...tx });
        const pending: PendingTransaction = { hash, kind, account, marketId: q.marketId, side, mode, submittedBlock };
        onPending(pending);
        pending.nonce = await submittedNonce(client, wallet, hash); onPending(pending);
        onProgress({ step: kind, message: "Waiting for confirmation", hash });
        let receipt;
        let replaced = false;
        try {
            receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000, onReplaced: (replacement) => {
                replaced ||= replacement.reason !== "repriced";
                onPending({ ...pending, hash: replacement.transaction.hash, cancelled: replaced });
                onProgress({ step: kind, message: "Waiting for replacement confirmation", hash: replacement.transaction.hash });
            } });
        } catch { throw new PendingReceiptError(); }
        onPending(null);
        if (replaced) throw new Error("Transaction was cancelled or replaced. Review your wallet before retrying.");
        if (receipt.status !== "success") throw new Error(kind === "swap" ? "Swap reverted on chain: the price moved past your slippage limit or trading closed. Try again." :
            "Transaction reverted. Refresh the quote before retrying.");
        return receipt;
    };
    const now = await fresh();
    const [balance, gasBalance, allowance] = await Promise.all([
        client.readContract({ address: input, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        client.getBalance({ address: account }),
        readAllowances(client, { owner: account, token: input, amount: q.amountIn, spender: config.universalRouter, permit2: config.permit2, now }),
    ]);
    if (balance < q.amountIn) throw new Error("Not enough input tokens");
    if (gasBalance === 0n) throw new Error("Test ETH is required for gas");
    if (allowance.needsErc20Approval) {
        onProgress({ step: "approve", message: "Approve input token in your wallet" });
        await send("approve", erc20ApproveTx({ token: input, spender: config.permit2, amount: q.amountIn }));
    }
    let permit;
    if (allowance.needsPermit) {
        const at = await fresh();
        const single = buildPermitSingle({ token: input, nonce: allowance.permit2Nonce, spender: config.universalRouter,
            amount: q.amountIn, now: at, expiration: q.cutoff, sigDeadline: BigInt(q.cutoff - 1) });
        onProgress({ step: "sign", message: "Sign the trading permission in your wallet" });
        const signature = await wallet.signTypedData({ account: wallet.account ?? account, ...permitTypedData(single, { chainId: config.chainId, permit2: config.permit2 }) });
        permit = { permit: single, signature };
    }
    await fresh();
    onProgress({ step: "swap", message: "Checking the latest price" });
    const updated = await fetchBuyQuote(client, q.marketId, q.amountIn, q.slippageBps, account, config, side, mode);
    if (updated.token.toLowerCase() !== q.token.toLowerCase() || JSON.stringify(updated.poolKey) !== JSON.stringify(q.poolKey)) throw new Error("Market route changed. Review a fresh quote.");
    if (updated.amountOut < q.minimumOut) throw new Error("Price changed beyond your minimum. Review a fresh quote.");
    const tx = buildSwap({ poolKey: q.poolKey, zeroForOne: zeroForOneFor(q.poolKey, input), tradeType: "EXACT_INPUT",
        amount: q.amountIn, limit: q.minimumOut, deadline: BigInt(q.cutoff - 1), permit, router: config.universalRouter });
    const gas = await estimateSwapGas(client, { tx, account, extraErrors: hookErrorsAbi });
    await fresh();
    onProgress({ step: "swap", message: `Confirm ${side.toUpperCase()} ${mode} in your wallet` });
    const receipt = await send("swap", { ...tx, gas: gasWithHeadroom(gas) });
    const fill = parseEventLogs({ abi: predictionHookAbi, logs: receipt.logs, eventName: "Trade" }).find((log) =>
        log.address.toLowerCase() === config.predictionHook.toLowerCase() && log.args.marketId === BigInt(q.marketId) && log.args.isYes === (side === "up") && log.args.isBuy === (mode === "buy"));
    if (!fill) throw new Error("Transaction confirmed, but a trade event was not found. Check the explorer and your balance before retrying.");
    return { hash: receipt.transactionHash, qty: fill.args.qty, usdc: fill.args.usdcAmount };
}
