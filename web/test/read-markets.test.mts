import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionResult, encodeAbiParameters } from "viem";
import { readMarkets } from "../src/lib/onchain/read-markets.ts";
import { underlyingOracleAbi } from "../src/lib/onchain/read-abis.ts";
import { chainFixture, config, solOracle, tracksConfig } from "./helpers/chain-read.ts";

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
    assert.deepEqual(result.tracks.map(t => [t.ticker, t.asset, t.label]), [["ETH", "ETH", "1m"]]);
    assert.ok(result.markets.every(m => m.asset === "ETH" && m.track === "1m" && m.upTicker === "ETHUP" && m.oracleSpot === 1));
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
test("gatekeeper snapshots keep each track's recent markets and tag asset, track and own-oracle spot", async () => {
    const f = chainFixture(tracksConfig);
    const result = await readMarkets(undefined, f.client, tracksConfig);
    // The newest 30 ids stop at 6, the 15m tracks add 1 to 4
    assert.deepEqual(result.markets.map(m => m.id), [...Array.from({ length: 30 }, (_, i) => 35 - i), 4, 3, 2, 1]);
    const tag = (id: number) => {
        const m = result.markets.find(market => market.id === id)!;
        return `${m.asset} ${m.track} ${m.upTicker}`;
    };
    assert.deepEqual([35, 34, 3, 4].map(tag), ["ETH 1m ETH1MUP", "SOL 1m SOL1MUP", "ETH 15m ETH15MUP", "SOL 15m SOL15MUP"]);
    const sol = result.markets.find(m => m.id === 34)!;
    assert.equal(sol.oracle, solOracle);
    assert.ok(Math.abs(sol.oracleSpot! - Math.E) < 1e-9);
    assert.equal(result.markets.find(m => m.id === 35)!.oracleSpot, 1);
    assert.equal(result.eth?.price, 1);
    const direct = await readMarkets(3, f.client, tracksConfig);
    assert.deepEqual(direct.markets.map(m => [m.id, m.asset, m.track]), [[3, "ETH", "15m"]]);
});
