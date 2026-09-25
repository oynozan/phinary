import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPrice, nonUsdSources, parseBinance, parseCoinbase, parseKraken, PRICE_SOURCES, type Fetch } from "../src/feeds.ts";

const COINBASE = { data: { amount: "2691.6", base: "ETH", currency: "USD" } };
const KRAKEN = {
  error: [],
  result: { XETHZUSD: { a: ["2692.40000", "4", "4.000"], c: ["2692.39000", "0.00551485"] } },
};
const BINANCE = { symbol: "ETHUSDT", price: "2692.90000000" };

test("parsers read the live payload shapes", () => {
  assert.equal(parseCoinbase(COINBASE), "2691.6");
  assert.equal(parseKraken(KRAKEN), "2692.39000");
  assert.equal(parseBinance(BINANCE), "2692.90000000");
  assert.throws(() => parseCoinbase({ data: { amount: "1", base: "BTC", currency: "USD" } }), /unexpected pair/);
  assert.throws(() => parseKraken({ error: ["EQuery:Unknown asset pair"], result: {} }), /kraken error/);
  assert.throws(() => parseBinance({ code: -1121, msg: "Invalid symbol." }), /missing field/);
});

function fakeFetch(responses: Record<string, { ok: boolean; status: number; body: unknown } | Error>): Fetch {
  return async (url) => {
    const r = responses[url];
    if (r === undefined) throw new Error(`unexpected url ${url}`);
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
}

test("fetchPrice falls back in order and reports failures", async () => {
  const f = fakeFetch({
    [PRICE_SOURCES.coinbase.url]: new Error("timeout"),
    [PRICE_SOURCES.kraken.url]: { ok: false, status: 503, body: {} },
    [PRICE_SOURCES.binance.url]: { ok: true, status: 200, body: BINANCE },
  });
  const { quote, failures } = await fetchPrice(["coinbase", "kraken", "binance"], 100, f);
  assert.equal(quote.source, "binance");
  assert.deepEqual(quote.price, { num: 269290000000n, den: 100000000n });
  assert.deepEqual(failures, ["coinbase: timeout", "kraken: HTTP 503"]);
});

test("fetchPrice uses the first healthy source", async () => {
  const f = fakeFetch({ [PRICE_SOURCES.coinbase.url]: { ok: true, status: 200, body: COINBASE } });
  const { quote, failures } = await fetchPrice(["coinbase", "kraken"], 100, f);
  assert.equal(quote.source, "coinbase");
  assert.equal(quote.raw, "2691.6");
  assert.deepEqual(failures, []);
});

test("fetchPrice throws when every source fails, including bad numbers", async () => {
  const f = fakeFetch({
    [PRICE_SOURCES.coinbase.url]: { ok: true, status: 200, body: { data: { amount: "-1", base: "ETH", currency: "USD" } } },
    [PRICE_SOURCES.binanceus.url]: { ok: true, status: 200, body: { price: "0.0" } },
  });
  await assert.rejects(fetchPrice(["coinbase", "binanceus"], 100, f), /all price sources failed/);
});

test("only the binance source is USDT-quoted", () => {
  assert.deepEqual(nonUsdSources(["coinbase", "kraken", "binanceus"]), []);
  assert.deepEqual(nonUsdSources(["coinbase", "binance"]), ["binance"]);
  assert.match(PRICE_SOURCES.binance.url, /ETHUSDT$/);
});
