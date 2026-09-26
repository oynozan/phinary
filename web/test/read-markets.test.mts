import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionResult, encodeAbiParameters } from "viem";
import { readMarkets } from "../src/lib/onchain/read-markets.ts";
import { underlyingOracleAbi } from "../src/lib/onchain/read-abis.ts";
import { chainFixture, config } from "./helpers/chain-read.ts";

test("oracle ABI decodes the full Solidity tuple including fallback readiness", () => {
    for (const warm of [true, false]) {
        const data = encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [10n ** 28n, warm]);
        assert.deepEqual(decodeFunctionResult({ abi: underlyingOracleAbi, functionName: "varianceE36", data }), [10n ** 28n, warm]);
    }
});
test("market snapshots pin all reads, limit the list and allow older direct links", async () => {
    const f = chainFixture();
    const result = await readMarkets(undefined, f.client, config);
    assert.equal(result.count, 35); assert.equal(result.markets.length, 30);
    assert.deepEqual([f.ids[0], f.ids.at(-1)], [35n, 6n]);
    assert.deepEqual(result.eth, { price: 1, sigma: Math.sqrt(1e-8 * 31557600), warm: true });
    assert.equal(result.timestamp, 1020); assert.equal(result.blockNumber, 42n);
    const older = await readMarkets(1, f.client, config);
    assert.equal(older.markets[0].id, 1);
    assert.deepEqual((await readMarkets(36, f.client, config)).markets, []);
});
test("fallback variance remains usable and quote/oracle failures preserve market rules", async () => {
    const f = chainFixture(); f.state.warm = false;
    const fallback = await readMarkets(1, f.client, config);
    assert.equal(fallback.eth?.warm, false);
    assert.equal(fallback.markets[0].quote?.tradable, true);
    f.state.failedQuote = true; f.state.failedOracle = true;
    const partial = await readMarkets(1, f.client, config);
    assert.equal(partial.eth, undefined); assert.equal(partial.markets[0].quote, null);
    assert.equal(partial.markets[0].upChance, null); assert.equal(partial.markets[0].expiry, 1060);
});
test("registry failures are errors, while an empty registry is a valid result", async () => {
    const f = chainFixture();
    for (const functionName of ["marketCount", "marketInfo", "marketParams"]) {
        f.state.failedRead = functionName;
        await assert.rejects(readMarkets(undefined, f.client, config));
    }
    f.state.failedRead = ""; f.state.count = 0n;
    assert.deepEqual((await readMarkets(undefined, f.client, config)).markets, []);
    f.state.chainId = 1;
    await assert.rejects(readMarkets(undefined, f.client, config), /Wrong network/);
});
test("a quote cannot keep trading open at the exact cutoff", async () => {
    const f = chainFixture(); f.state.timestamp = 1048n;
    const market = (await readMarkets(1, f.client, config)).markets[0];
    assert.equal(market.phase, "closed"); assert.equal(market.quote, null);
});
