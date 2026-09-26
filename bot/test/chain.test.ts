import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { makeClients } from "../src/chain.ts";

test("a dead primary RPC falls through to the next URL in the list", async () => {
  let served = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      served++;
      const { id } = JSON.parse(body) as { id: number };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x515" }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    const { publicClient } = makeClients({ rpcUrl: `http://127.0.0.1:1,http://127.0.0.1:${port}`, chainId: 1301 });
    assert.equal(await publicClient.getChainId(), 1301);
    assert.equal(served, 1, "the fallback answered the request");
  } finally {
    server.close();
  }
});

test("an empty RPC list is rejected", () => {
  assert.throws(() => makeClients({ rpcUrl: " , ", chainId: 1301 }), /RPC_URL is empty/);
});
