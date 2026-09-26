import assert from "node:assert/strict";
import test from "node:test";
import { getConnectionConfig } from "../src/lib/onchain/config.ts";
import { readVaultCore, readVaultExposure, type VaultClient } from "../src/lib/vault/read.ts";
const config = getConnectionConfig();
test("all markets beyond 30 and every core read use the same block", async () => {
 const seen: bigint[] = [];
 const coreValues: Record<string,bigint> = { vaultIdle: 100n, navPlus: 90n, navMinus: 80n, totalShares: 1000n, sharesOf: 200n, balanceOf: 9n, marketCount: 83n };
 const client = {
  getChainId: async () => config.chainId,
  getBlock: async () => ({ number: 42n, timestamp: 123n }),
  readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => { assert.equal(blockNumber, 42n); return coreValues[functionName]; },
  multicall: async ({ contracts, blockNumber }: { contracts: { args: [bigint] }[]; blockNumber: bigint }) => {
   assert.equal(blockNumber, 42n);
   return contracts.map(({ args: [id] }) => { seen.push(id); return { oracle: config.underlyingOracle, lnStrikeWad: 1n, status: 1, yesWon: false, outYes: 2n, outNo: 1n, bucket: 3n, expiry: 1000n }; });
  },
 } as unknown as VaultClient;
 const core = await readVaultCore(config.usdc, client, config);
 assert.equal(core.userShares, 200n); assert.equal(core.usdc, 9n);
 const exposure = await readVaultExposure(client, config);
 assert.equal(exposure.markets.length, 83); assert.equal(seen.at(-1), 83n);
 assert.equal(exposure.totalValue, 349n); assert.equal(exposure.markets[0].category, "Crypto");
});
test("wrong chain fails before reading contract values", async () => {
 const client = { getChainId: async () => 1, getBlock: async () => ({ number: 1n, timestamp: 1n }) } as unknown as VaultClient;
 await assert.rejects(readVaultCore(undefined, client, config), /Wrong network/);
});
