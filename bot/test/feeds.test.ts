import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchPrice,
  nonUsdSources,
  normalizeSymbol,
  parseBinance,
  parseCoinbase,
  parseKraken,
  PRICE_SOURCES,
  type Fetch,
} from "../src/feeds.ts";

const COINBASE = { data: { amount: "2691.6", base: "ETH", currency: "USD" } };
const KRAKEN = {
  error: [],
  result: { XETHZUSD: { a: ["2692.40000", "4", "4.000"], c: ["2692.39000", "0.00551485"] } },
};
const BINANCE = { symbol: "ETHUSDT", price: "2692.90000000" };

const SOL_COINBASE = { data: { amount: "148.325", base: "SOL", currency: "USD" } };
/** Kraken names the SOL pair SOLUSD in the result, not XSOLZUSD like the older ETH pair */
const SOL_KRAKEN = { error: [], result: { SOLUSD: { a: ["148.31000", "12", "12.000"], c: ["148.30000", "0.51"] } } };
const SOL_BINANCEUS = { symbol: "SOLUSD", price: "148.3500" };

test("parsers read the live payload shapes", () => {
  assert.equal(parseCoinbase(COINBASE, "ETH"), "2691.6");
  assert.equal(parseKraken(KRAKEN), "2692.39000");
  assert.equal(parseBinance(BINANCE), "2692.90000000");
  assert.throws(() => parseCoinbase({ data: { amount: "1", base: "BTC", currency: "USD" } }, "ETH"), /unexpected pair BTC-USD/);
  assert.throws(() => parseKraken({ error: ["EQuery:Unknown asset pair"], result: {} }), /kraken error/);
  assert.throws(() => parseBinance({ code: -1121, msg: "Invalid symbol." }), /missing field/);
});

test("parsers read SOL payloads, and coinbase's base must be the requested symbol", () => {
  assert.equal(parseCoinbase(SOL_COINBASE, "SOL"), "148.325");
  assert.equal(parseKraken(SOL_KRAKEN), "148.30000");
  assert.equal(parseBinance(SOL_BINANCEUS), "148.3500");
  assert.throws(() => parseCoinbase(SOL_COINBASE, "ETH"), /unexpected pair SOL-USD/);
  assert.throws(() => parseCoinbase(COINBASE, "SOL"), /unexpected pair ETH-USD/);
});

test("source URLs are built per symbol", () => {
  assert.equal(PRICE_SOURCES.coinbase.url("ETH"), "https://api.coinbase.com/v2/prices/ETH-USD/spot");
  assert.equal(PRICE_SOURCES.coinbase.url("SOL"), "https://api.coinbase.com/v2/prices/SOL-USD/spot");
  assert.equal(PRICE_SOURCES.kraken.url("ETH"), "https://api.kraken.com/0/public/Ticker?pair=ETHUSD");
  assert.equal(PRICE_SOURCES.kraken.url("SOL"), "https://api.kraken.com/0/public/Ticker?pair=SOLUSD");
  assert.equal(PRICE_SOURCES.binanceus.url("SOL"), "https://api.binance.us/api/v3/ticker/price?symbol=SOLUSD");
  assert.equal(PRICE_SOURCES.binance.url("SOL"), "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
  assert.equal(normalizeSymbol(" sol "), "SOL");
  assert.throws(() => normalizeSymbol("SOL-USD"), /bad asset symbol/);
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
    [PRICE_SOURCES.coinbase.url("ETH")]: new Error("timeout"),
    [PRICE_SOURCES.kraken.url("ETH")]: { ok: false, status: 503, body: {} },
    [PRICE_SOURCES.binance.url("ETH")]: { ok: true, status: 200, body: BINANCE },
  });
  const { quote, failures } = await fetchPrice("ETH", ["coinbase", "kraken", "binance"], 100, f);
  assert.equal(quote.source, "binance");
  assert.equal(quote.symbol, "ETH");
  assert.deepEqual(quote.price, { num: 269290000000n, den: 100000000n });
  assert.deepEqual(failures, ["coinbase: timeout", "kraken: HTTP 503"]);
});

test("fetchPrice uses the first healthy source", async () => {
  const f = fakeFetch({ [PRICE_SOURCES.coinbase.url("ETH")]: { ok: true, status: 200, body: COINBASE } });
  const { quote, failures } = await fetchPrice("ETH", ["coinbase", "kraken"], 100, f);
  assert.equal(quote.source, "coinbase");
  assert.equal(quote.raw, "2691.6");
  assert.deepEqual(failures, []);
});

test("fetchPrice asks each source for SOL and falls back like ETH", async () => {
  const f = fakeFetch({
    [PRICE_SOURCES.coinbase.url("SOL")]: { ok: true, status: 200, body: COINBASE },
    [PRICE_SOURCES.kraken.url("SOL")]: { ok: true, status: 200, body: SOL_KRAKEN },
    [PRICE_SOURCES.binanceus.url("SOL")]: { ok: true, status: 200, body: SOL_BINANCEUS },
  });
  const { quote, failures } = await fetchPrice("sol", ["coinbase", "kraken", "binanceus"], 100, f);
  assert.equal(quote.symbol, "SOL");
  assert.equal(quote.source, "kraken");
  assert.deepEqual(quote.price, { num: 14830000n, den: 100000n });
  assert.deepEqual(failures, ["coinbase: unexpected pair ETH-USD"], "an ETH answer never passes for SOL");

  const cb = fakeFetch({ [PRICE_SOURCES.coinbase.url("SOL")]: { ok: true, status: 200, body: SOL_COINBASE } });
  assert.equal((await fetchPrice("SOL", ["coinbase"], 100, cb)).quote.raw, "148.325");
  const us = fakeFetch({ [PRICE_SOURCES.binanceus.url("SOL")]: { ok: true, status: 200, body: SOL_BINANCEUS } });
  assert.equal((await fetchPrice("SOL", ["binanceus"], 100, us)).quote.raw, "148.3500");
});

test("fetchPrice throws when every source fails, including bad numbers", async () => {
  const f = fakeFetch({
    [PRICE_SOURCES.coinbase.url("ETH")]: { ok: true, status: 200, body: { data: { amount: "-1", base: "ETH", currency: "USD" } } },
    [PRICE_SOURCES.binanceus.url("ETH")]: { ok: true, status: 200, body: { price: "0.0" } },
  });
  await assert.rejects(fetchPrice("ETH", ["coinbase", "binanceus"], 100, f), /all ETH price sources failed/);
});

test("only the binance source is USDT-quoted", () => {
  assert.deepEqual(nonUsdSources(["coinbase", "kraken", "binanceus"]), []);
  assert.deepEqual(nonUsdSources(["coinbase", "binance"]), ["binance"]);
  assert.match(PRICE_SOURCES.binance.url("ETH"), /ETHUSDT$/);
});
