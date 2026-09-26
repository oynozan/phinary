import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { getAddress, type Abi, type Address, type Hex } from "viem";
import type { Clients } from "../../src/chain.ts";
import type { Artifact } from "./artifacts.ts";

/** Anvil's first default account (public test key) */
export const ANVIL_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export function findAnvil(): string | undefined {
  const dirs = [process.env.ANVIL_BIN ? resolve(process.env.ANVIL_BIN, "..") : "", resolve(homedir(), ".foundry", "bin")];
  dirs.push(...(process.env.PATH ?? "").split(":"));
  return dirs.map((d) => resolve(d, "anvil")).find((p) => existsSync(p));
}

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? res(addr.port) : rej(new Error("no port"))));
    });
  });
}

export async function waitForRpc(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("anvil did not start");
}

/** Starts anvil on a free port and returns its URL, killed when `t` ends */
export async function startAnvil(t: TestContext, anvil: string, args: string[] = []): Promise<string> {
  const port = await freePort();
  const proc = spawn(anvil, ["--port", String(port), "--silent", ...args], { stdio: "ignore" });
  t.after(() => proc.kill());
  const url = `http://127.0.0.1:${port}`;
  await waitForRpc(url);
  return url;
}

export async function deploy(c: Clients, art: Artifact, args: readonly unknown[]): Promise<Address> {
  const hash = await c.walletClient!.deployContract({ abi: art.abi, bytecode: art.bytecode, args } as never);
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
  assert.ok(receipt.contractAddress);
  return getAddress(receipt.contractAddress);
}

export async function send(c: Clients, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<void> {
  const hash = await c.walletClient!.writeContract({ address, abi, functionName, args } as never);
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", functionName);
}

export function read<T>(c: Clients, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return c.publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>;
}
