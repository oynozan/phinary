/** Opt-in integration test against a disposable local fork, never a public-chain write. */
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, encodeAbiParameters, erc20Abi, http, keccak256, numberToHex, pad } from "viem";
import { unichainSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { predictionHookAbi } from "@phinary/swap-sdk";
import { executeUpBuy, fetchBuyQuote, type PendingTransaction } from "../src/lib/onchain/buy.ts";
import { getConnectionConfig } from "../src/lib/onchain/config.ts";
import { assertWalletNetwork } from "../src/lib/onchain/wallet-core.ts";

const binary = process.env.ANVIL_BIN || "anvil";
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
    const count = await client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: "marketCount" });
    const quote = await fetchBuyQuote(client, Number(count), 100_000n, 100, account.address, config);
    const provider = { request: async ({ method, params }: { method: string; params?: unknown[] }) => method === "eth_accounts" ? [account.address] : rpc(method, params) };
    const steps: string[] = [];
    let pending: PendingTransaction | null = null;
    const result = await executeUpBuy(quote, {
        account: account.address, client, wallet, config,
        assertReady: () => assertWalletNetwork(provider, client, account.address, 1301),
        onProgress: (p) => { steps.push(p.step); }, onPending: (tx) => { pending = tx; },
    });
    const after = await client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    const up = await client.readContract({ address: quote.token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    assert.equal(before - after, quote.amountIn);
    assert.ok(up >= quote.minimumOut);
    assert.equal(up, result.qty);
    assert.equal(pending, null);
    for (const step of ["approve", "sign", "swap"]) assert.ok(steps.includes(step));
    // Re-create the client to model a reload: balances remain on chain.
    const reloaded = createPublicClient({ chain: unichainSepolia, transport: http(rpcUrl) });
    assert.equal(await reloaded.readContract({ address: quote.token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }), up);
    console.log(JSON.stringify({ passed: true, marketId: Number(count), spentUsdcUnits: (before - after).toString(), receivedUpUnits: up.toString(), minimumUpUnits: quote.minimumOut.toString(), steps: [...new Set(steps)], tx: result.hash }, null, 2));
} finally { fork.kill("SIGTERM"); }
