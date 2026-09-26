import { test } from "node:test";
import assert from "node:assert/strict";
import { toMarket } from "../src/lib/onchain/market-adapter.ts";
import { phaseOf } from "../src/lib/phase.ts";
import { buyPrice } from "../src/lib/trade.ts";
import type { MarketInfo, HookQuote } from "@phinary/swap-sdk";

const address = "0x1111111111111111111111111111111111111111" as const;
const info: MarketInfo = {
    yes: address, no: address, oracle: address, lnStrikeWad: 0n,
    openTime: 1000n, expiry: 1060n, window: 10, cutoffBuffer: 2,
    status: 1, yesWon: false, bucket: 10_000_000n, outYes: 1_500_000n,
    outNo: 2_000_000n, invYes: 0n, invNo: 0n,
};
const quote: HookQuote = {
    tradable: true, tau: 40n, varE36: 10n ** 28n, xWad: 0n,
    midYes: 600_000_000_000_000_000n, askYes: 620_000_000_000_000_000n,
    bidYes: 580_000_000_000_000_000n, askNo: 420_000_000_000_000_000n, bidNo: 380_000_000_000_000_000n,
};
test("converts integer units and does not fabricate historical data", () => {
    const m = toMarket(1, info, 10, quote, 1020);
    assert.equal(m.bucket, 10); assert.equal(m.outUp, 1.5);
    assert.equal(m.upChance, .6); assert.equal(m.quote?.askUp, .62);
    assert.equal(m.cutoff, 1048); assert.equal(m.windowStart, 1050);
    for (const field of [m.volume, m.tradeCount, m.createdAt, m.settledAt, m.settlementPrice]) assert.equal(field, null);
});
test("exact cutoff, averaging and expiry boundaries follow contract timing", () => {
    for (const [now, expected] of [[999,"upcoming"],[1000,"live"],[1047,"live"],[1048,"closed"],[1050,"averaging"],[1060,"awaiting"]] as const) {
        assert.equal(toMarket(1, info, 10, quote, now).phase, expected);
    }
    assert.equal(toMarket(1, info, 10, quote, 1048).quote, null);
});
test("missing and sentinel quotes are unavailable, not 0%", () => {
    assert.equal(toMarket(1, info, 10, undefined, 1020).upChance, null);
    assert.equal(toMarket(1, info, 10, {...quote, varE36: 0n}, 1020).upChance, null);
    assert.equal(toMarket(1, info, 10, {...quote, midYes: 0n}, 1020).upChance, 0);
});
test("settled and invalid markets derive their result from status, not quote", () => {
    assert.equal(toMarket(1, {...info, status: 2, yesWon: true}, 10, undefined, 1070).upChance, 1);
    assert.equal(toMarket(1, {...info, status: 2}, 10, quote, 1070).upChance, 0);
    const invalid = toMarket(1, {...info, status: 3}, 10, quote, 1070);
    assert.equal(invalid.upChance, .5); assert.equal(invalid.phase, "invalid");
    assert.equal(phaseOf(invalid, 1000), "invalid");
    assert.throws(() => toMarket(1, {...info, status: 0}, 10, quote, 1070));
});
test("buy prices outside the tradable band are never offered", () => {
    const decided: HookQuote = {
        ...quote, midYes: 990_000_000_000_000_000n, askYes: 1_020_000_000_000_000_000n,
        bidYes: 980_000_000_000_000_000n, askNo: 20_000_000_000_000_000n, bidNo: 0n,
    };
    const m = toMarket(1, info, 10, decided, 1020, { pMin: 0.02 });
    assert.equal(buyPrice(m.quote!, "up"), null);
    assert.equal(buyPrice(m.quote!, "down"), 0.02);
    assert.equal(buyPrice(toMarket(1, info, 10, quote, 1020, { pMin: 0.02 }).quote!, "up"), 0.62);
    assert.equal(buyPrice(toMarket(1, info, 10, decided, 1020).quote!, "up"), null, "no band read: still never above 100¢");
});
