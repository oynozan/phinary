import { test } from "node:test";
import assert from "node:assert/strict";
import { rpcUrlList } from "../src/lib/onchain/rpc-urls.ts";

test("an RPC list keeps its order, primary first, and rejects anything but HTTP(S)", () => {
    assert.deepEqual(rpcUrlList("https://sepolia.unichain.org"), ["https://sepolia.unichain.org"]);
    assert.deepEqual(rpcUrlList(" https://a.example/v2/k , https://b.example ,"), ["https://a.example/v2/k", "https://b.example"]);
    assert.throws(() => rpcUrlList(" , "), /missing/);
    assert.throws(() => rpcUrlList("https://a.example,wss://b.example"), /HTTP or HTTPS/);
});
