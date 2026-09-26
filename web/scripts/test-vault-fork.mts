/** Opt-in integration test against a disposable local fork, never a public-chain write. */
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, encodeAbiParameters, erc20Abi, http, keccak256, numberToHex, pad } from "viem";
import { unichainSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { executeVault, type VaultPending } from "../src/lib/vault/transaction.ts";
import { readVaultCore } from "../src/lib/vault/read.ts";
import { depositShares, withdrawAssets } from "../src/lib/vault/math.ts";
import { getConnectionConfig } from "../src/lib/onchain/config.ts";
import { assertWalletNetwork } from "../src/lib/onchain/wallet-core.ts";

const binary = process.env.ANVIL_BIN || [ `${homedir()}/.foundry/bin/anvil`, "/opt/homebrew/bin/anvil", "/private/tmp/phinary-test-tools/node_modules/@foundry-rs/anvil-darwin-arm64/bin/anvil" ].find(existsSync) || "anvil";
const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("No test port"));
        server.close(() => resolve(address.port));
    });
});
const rpcUrl = `http://127.0.0.1:${port}`;
const original = getConnectionConfig();
const config = { ...original, rpcUrl };
const fork = spawn(binary, ["--fork-url", original.rpcUrl, "--port", String(port), "--host", "127.0.0.1", "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
let startError: Error | undefined;
fork.on("error", (error) => { startError = error; });
let stderr = "";
fork.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
async function rpc(method: string, params: unknown[] = []) {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const json = await res.json(); if (json.error) throw new Error(json.error.message); return json.result;
}
try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
        if (startError) throw startError;
        if (fork.exitCode !== null) throw new Error(`Anvil exited: ${stderr.slice(-500)}`);
        try { await rpc("eth_chainId"); ready = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!ready) throw new Error("Anvil did not start");
    assert.ok(await rpc("web3_clientVersion").then((v: string) => v.toLowerCase().includes("anvil")));
    const client = createPublicClient({ chain: unichainSepolia, transport: http(rpcUrl), pollingInterval: 100 });
    const account = privateKeyToAccount(generatePrivateKey());
    const wallet = createWalletClient({ account, chain: unichainSepolia, transport: http(rpcUrl) });
    await rpc("anvil_setBalance", [account.address, numberToHex(10n ** 18n)]);
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account.address, 9n]));
    await rpc("anvil_setStorageAt", [config.usdc, slot, pad(numberToHex(10_000_000n), { size: 32 })]);
    const before = await client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    assert.equal(before, 10_000_000n);
    const provider = { request: async ({ method, params }: { method: string; params?: unknown[] }) => method === "eth_accounts" ? [account.address] : rpc(method, params) };
    const steps: string[] = [];
    let pending: VaultPending | null = null;
    const ctx = { account: account.address, client, wallet, config,
        assertReady: () => assertWalletNetwork(provider, client, account.address, 1301),
        onProgress: (p: { step: string }) => { steps.push(p.step); }, onPending: (tx: VaultPending | null) => { pending = tx; },
    };
    const initial = await readVaultCore(account.address, client, config);
    const deposited = await executeVault("deposit", 1_000_000n, ctx);
    const afterDeposit = await readVaultCore(account.address, client, config);
    assert.equal(deposited.assets, 1_000_000n);
    assert.equal(deposited.shares, depositShares(1_000_000n, initial));
    assert.equal(initial.usdc - afterDeposit.usdc, deposited.assets);
    assert.equal(afterDeposit.userShares - initial.userShares, deposited.shares);
    const withdrawn = await executeVault("withdraw", deposited.shares, ctx);
    const afterWithdraw = await readVaultCore(account.address, client, config);
    assert.equal(withdrawn.assets, withdrawAssets(deposited.shares, afterDeposit));
    assert.equal(afterWithdraw.usdc - afterDeposit.usdc, withdrawn.assets);
    assert.equal(afterWithdraw.userShares, initial.userShares);
    assert.equal(pending, null);
    for (const step of ["approve", "deposit", "withdraw"]) assert.ok(steps.includes(step));
    console.log(JSON.stringify({ passed: true, depositedUsdcUnits: deposited.assets.toString(), mintedShares: deposited.shares.toString(), withdrawnUsdcUnits: withdrawn.assets.toString(), steps: [...new Set(steps)] }, null, 2));
} finally { fork.kill("SIGTERM"); }
