import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsdc, validateReview, describeBuyError, resolveSlippageBps, MAX_SLIPPAGE_BPS, type BuyQuote } from "../src/lib/onchain/buy.ts";
import { isRejected, assertWalletNetwork } from "../src/lib/onchain/wallet-core.ts";
import type { createChainClient } from "../src/lib/onchain/client.ts";

const address = "0x1111111111111111111111111111111111111111";
const hash = `0x${"a".repeat(64)}`;
const quote = (): BuyQuote => ({ marketId: 1, amountIn: 1_000_001n, amountOut: 2_000_000n, minimumOut: 1_980_000n, slippageBps: 100,
    cutoff: 100, blockTime: 50, quotedAt: Date.now(), token: address,
    poolKey: { currency0: address, currency1: address, fee: 0, tickSpacing: 60, hooks: address } });
test("USDC input retains all six decimals without float rounding", () => {
    assert.equal(parseUsdc("1.000001"), 1000001n); assert.equal(parseUsdc(".1"), 100000n);
    for (const input of ["0", "-1", "1e3", "0.0000001", "NaN", "", "1,000"]) assert.throws(() => parseUsdc(input));
});
test("review rejects cutoff, stale quotes, invalid minOut and silent tolerance changes", () => {
    validateReview(quote(), 99);
    assert.throws(() => validateReview(quote(), 100));
    assert.throws(() => validateReview({ ...quote(), quotedAt: Date.now() - 31000 }, 50));
    assert.throws(() => validateReview({ ...quote(), minimumOut: 1n }, 50));
    assert.throws(() => validateReview({ ...quote(), slippageBps: 500 }, 50));
});
test("auto slippage sizes the tolerance to the time left, within the review bound", () => {
    const even = { mode: "buy" as const, amountIn: 1_000_000n, amountOut: 2_000_000n };
    assert.equal(resolveSlippageBps(100, { ...even, secondsToWindow: 60 }), 100);
    assert.equal(resolveSlippageBps("auto", { ...even, secondsToWindow: 7 * 86_400 }), 100);
    // A 50c token a minute before the window can move about 0.23 in two standard deviations of a 5 s confirmation.
    assert.equal(resolveSlippageBps("auto", { ...even, secondsToWindow: 60 }), 3160);
    assert.equal(resolveSlippageBps("auto", { mode: "buy", amountIn: 50_000n, amountOut: 1_000_000n, secondsToWindow: 1 }), MAX_SLIPPAGE_BPS);
    validateReview({ ...quote(), slippageBps: 3160, minimumOut: 1_368_000n }, 50);
    assert.throws(() => validateReview({ ...quote(), slippageBps: MAX_SLIPPAGE_BPS + 1, minimumOut: 199_800n }, 50), /slippage/);
});
test("nested wallet rejections are cancellation, not success", () => {
    assert.equal(isRejected({ cause: { code: 4001 } }), true);
    assert.equal(describeBuyError({ cause: { code: 4001 } }), "Cancelled in your wallet");
});
test("wallet checks reject wrong account, chain, and a fork sharing the same chain ID", async () => {
    const client = { getChainId: async () => 1301, getBlock: async () => ({ number: 5n, hash }) } as unknown as ReturnType<typeof createChainClient>;
    const provider = (accounts = [address], chain = "0x515", blockHash = hash) => ({ request: async ({ method }: { method: string }) =>
        method === "eth_accounts" ? accounts : method === "eth_chainId" ? chain : { hash: blockHash } });
    await assertWalletNetwork(provider(), client, address, 1301);
    await assert.rejects(assertWalletNetwork(provider([]), client, address, 1301), /account changed/);
    await assert.rejects(assertWalletNetwork(provider([address], "0x1"), client, address, 1301), /Switch/);
    await assert.rejects(assertWalletNetwork(provider([address], "0x515", "0x1234"), client, address, 1301), /different networks/);
});
