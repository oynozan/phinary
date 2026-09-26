import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { detailCanBuy, historyInRange, purchaseSummary } from "../src/lib/markets/detail.ts";
import { toMarket } from "../src/lib/onchain/market-adapter.ts";
import type { Market, PricePoint } from "../src/lib/types.ts";
const address = "0x1111111111111111111111111111111111111111";
const base = toMarket(42, { yes: address, no: address, oracle: address, lnStrikeWad: 0n, openTime: 1000n, expiry: 1120n, window: 10, cutoffBuffer: 2, status: 1, yesWon: false, bucket: 0n, outYes: 0n, outNo: 0n, invYes: 0n, invNo: 0n }, 10, undefined, 1020);
const quote = { tradable: true, tau: 100, variance: .001, x: 0, midUp: .39, askUp: .41, bidUp: .37, askDown: .63, bidDown: .59, spot: 2704.37, sigma: .582, pMin: .02 };
const market: Market = { ...base, quote, upChance: .39, strike: 2705.02 };
test("detail trading guard closes exactly at cutoff and rejects every inactive phase", () => {
    assert.equal(detailCanBuy(market, market.cutoff - 1), true);
    assert.equal(detailCanBuy(market, market.cutoff), false);
    assert.equal(detailCanBuy(market, null), false);
    assert.equal(detailCanBuy({ ...market, quote: null }, 1020), false);
    assert.equal(detailCanBuy({ ...market, quote: { ...quote, tradable: false } }, 1020), false);
    for (const phase of ["upcoming", "closed", "averaging", "awaiting", "resolved-up", "resolved-down", "invalid"] as const) assert.equal(detailCanBuy({ ...market, phase }, 1020), false);
});
test("purchase summary respects six decimals, zero output and negative profit", () => {
    assert.equal(purchaseSummary(1n, 0n), null);
    assert.equal(purchaseSummary(0n, 1n), null);
    const summary = purchaseSummary(10_000_000n, 24_390_000n)!;
    assert.ok(Math.abs(summary.average - 10 / 24.39) < 1e-12);
    assert.equal(summary.payout, 24.39); assert.equal(summary.profit, 14.39);
    assert.equal(purchaseSummary(1_000_001n, 1_000_000n)?.profit, -.000001);
});
test("chart ranges anchor to actual history, preserve boundaries and never mutate source", () => {
    const points = [4000, 0, 3100, 3099, 400].map((t) => ({ t, mid: .5, ask: .51, bid: .49, eth: 2700 }) satisfies PricePoint);
    assert.deepEqual(historyInRange(points, "15m").map((p) => p.t), [3100, 4000]);
    assert.deepEqual(historyInRange(points, "1h").map((p) => p.t), [400, 3099, 3100, 4000]);
    assert.equal(historyInRange(points, "Max").length, 5); assert.equal(historyInRange(points, "6h").length, 5);
    assert.equal(points[0].t, 4000); assert.deepEqual(historyInRange([], "Max"), []);
});
test("overview separates live quotes from resolved payout and preserves missing settlement", async () => {
    const { Overview, PricingExplanation } = await import("../src/app/market/[id]/_components/detail-presentation.tsx");
    const live = renderToStaticMarkup(createElement(Overview, { market }));
    assert.match(live, /41¢/); assert.match(live, /39%/); assert.match(live, /below/);
    for (const phase of ["resolved-up", "resolved-down", "invalid"] as const) {
        const resolved = { ...market, phase, upWon: phase === "resolved-up", quote: null };
        const html = renderToStaticMarkup(createElement(Overview, { market: resolved }));
        assert.match(html, /payout \/ token/); assert.match(html, /Settlement average/); assert.match(html, /N\/A/); assert.doesNotMatch(html, /Chance UP|41¢/);
        assert.match(html, phase === "invalid" ? /50¢/ : /100¢/);
        const pricing = renderToStaticMarkup(createElement(PricingExplanation, { market: resolved }));
        assert.match(pricing, /Live pricing is unavailable/); assert.doesNotMatch(pricing, /39.0%/);
    }
});
test("unknown underlying and rules never invent asset or settlement timestamp", async () => {
    const { detailQuestion } = await import("../src/app/market/[id]/_components/detail-presentation.tsx");
    const { MarketRules } = await import("../src/app/market/[id]/_components/market-rules.tsx");
    assert.match(detailQuestion(market), /^Unknown/);
    const html = renderToStaticMarkup(createElement(MarketRules, { market: { ...market, phase: "resolved-up" } }));
    assert.match(html, /geometric-average/); assert.match(html, /Equal or below resolves DOWN/); assert.match(html, /Settled at<\/dt><dd>N\/A/);
});
