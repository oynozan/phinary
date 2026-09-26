import assert from "node:assert/strict";
import test from "node:test";
import { encodeEventTopics, encodeAbiParameters, type TransactionReceipt } from "viem";
import { predictionHookAbi } from "@phinary/swap-sdk";
import { getConnectionConfig } from "../src/lib/onchain/config.ts";
import { resumeVaultTransaction, parseVaultReceipt, describeVaultError, executeVault, VaultPendingReceiptError, type VaultContext, type VaultPending } from "../src/lib/vault/transaction.ts";
const config = getConnectionConfig();
const account = "0x1111111111111111111111111111111111111111";
const pending: VaultPending = { hash: `0x${"a".repeat(64)}`, account, contract: config.predictionHook, chainId: config.chainId, kind: "deposit" };
function receipt(status = "success"): TransactionReceipt {
 return { status, transactionHash: pending.hash, logs: [{ address: config.predictionHook, topics: encodeEventTopics({ abi: predictionHookAbi, eventName: "Deposit", args: { account } }), data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [5n, 8n]) }] } as TransactionReceipt;
}
function recovery(wait: (...args: unknown[]) => Promise<TransactionReceipt>) {
 const changes: (VaultPending | null)[] = [];
 return { changes, ctx: { config, client: { getChainId: async () => config.chainId, waitForTransactionReceipt: wait } as unknown as VaultContext["client"], onPending: (tx: VaultPending | null) => changes.push(tx), onProgress: () => {} } };
}
test("receipt output comes from account-specific contract event", () => {
 assert.deepEqual(parseVaultReceipt(receipt(), pending), { hash: pending.hash, kind: "deposit", assets: 5n, shares: 8n });
 assert.throws(() => parseVaultReceipt(receipt("reverted"), pending), /reverted/);
 assert.throws(() => parseVaultReceipt(receipt(), { ...pending, account: config.usdc }), /not found/);
});
test("unknown confirmation keeps pending; retry recovers without sending", async () => {
 const unknown = recovery(async () => { throw new Error("timeout"); });
 await assert.rejects(resumeVaultTransaction(pending, unknown.ctx), VaultPendingReceiptError);
 assert.equal(unknown.changes.length, 0);
 const known = recovery(async () => receipt());
 assert.equal((await resumeVaultTransaction(pending, known.ctx))?.assets, 5n);
 assert.deepEqual(known.changes, [null]);
});
test("replacement updates durable hash and cancellation is not successful", async () => {
 const testCase = recovery(async (args) => {
  const { onReplaced } = args as { onReplaced: (arg: unknown) => void };
  onReplaced({ reason: "cancelled", transaction: { hash: `0x${"b".repeat(64)}` } });
  return receipt();
 });
 await assert.rejects(resumeVaultTransaction(pending, testCase.ctx), /cancelled/);
 assert.equal(testCase.changes[0]?.hash, `0x${"b".repeat(64)}`);
 assert.equal(testCase.changes[1], null);
});
test("wallet rejection and identity change never trigger a send", async () => {
 assert.equal(describeVaultError({ cause: { code: 4001 } }), "Cancelled in your wallet");
 const ctx = { assertReady: async () => { throw new Error("Wallet account changed"); }, config } as unknown as VaultContext;
 await assert.rejects(executeVault("deposit", 1n, ctx), /account changed/);
});
test("pending from other deployment cannot be recovered on current deployment", async () => {
 const { ctx } = recovery(async () => { throw new Error("must not wait"); });
 await assert.rejects(resumeVaultTransaction({ ...pending, chainId: 1 }, ctx), /different network/);
});
