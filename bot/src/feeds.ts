import { parseDecimal, type Rational } from "./math.ts";

export interface PriceSource {
  /** Endpoint for `symbol` (e.g. ETH, SOL) priced in `quote`. */
  url: (symbol: string) => string;
  /** Quote currency of the pair; anything but USD is a proxy for the USD price. */
  quote: "USD" | "USDT";
  /** Returns the price of `symbol` as a plain decimal string. */
  parse: (json: unknown, symbol: string) => string;
}

/** Asset symbols the sources are asked for: upper-case letters and digits, as in ETH-USD or SOLUSD. */
export function normalizeSymbol(s: string): string {
  const sym = s.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(sym)) throw new Error(`bad asset symbol ${JSON.stringify(s)}`);
  return sym;
}

function field(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null || !(key in obj)) throw new Error(`missing field ${key}`);
  return (obj as Record<string, unknown>)[key];
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} is not a string`);
  return v;
}

export function parseCoinbase(json: unknown, symbol: string): string {
  const data = field(json, "data");
  const base = field(data, "base");
  const currency = field(data, "currency");
  if (base !== symbol || currency !== "USD") throw new Error(`unexpected pair ${String(base)}-${String(currency)}`);
  return str(field(data, "amount"), "coinbase amount");
}

export function parseKraken(json: unknown): string {
  const errors = field(json, "error");
  if (Array.isArray(errors) && errors.length > 0) throw new Error(`kraken error ${errors.join(", ")}`);
  const result = field(json, "result");
  if (typeof result !== "object" || result === null) throw new Error("kraken result missing");
  // The result key is Kraken's own pair name (XETHZUSD for ETHUSD, SOLUSD for SOLUSD), so take the only entry
  const pair = Object.values(result)[0];
  const last = field(pair, "c");
  if (!Array.isArray(last)) throw new Error("kraken last trade missing");
  return str(last[0], "kraken last price");
}

export function parseBinance(json: unknown): string {
  return str(field(json, "price"), "binance price");
}

export const PRICE_SOURCES = {
  coinbase: { url: (s) => `https://api.coinbase.com/v2/prices/${s}-USD/spot`, quote: "USD", parse: parseCoinbase },
  kraken: { url: (s) => `https://api.kraken.com/0/public/Ticker?pair=${s}USD`, quote: "USD", parse: parseKraken },
  binance: { url: (s) => `https://api.binance.com/api/v3/ticker/price?symbol=${s}USDT`, quote: "USDT", parse: parseBinance },
  binanceus: { url: (s) => `https://api.binance.us/api/v3/ticker/price?symbol=${s}USD`, quote: "USD", parse: parseBinance },
} as const satisfies Record<string, PriceSource>;

export type SourceName = keyof typeof PRICE_SOURCES;

export function isSourceName(s: string): s is SourceName {
  return Object.hasOwn(PRICE_SOURCES, s);
}

/** Configured sources that do not quote in USD. */
export function nonUsdSources(order: readonly SourceName[]): SourceName[] {
  return order.filter((n) => PRICE_SOURCES[n].quote !== "USD");
}

export interface Quote {
  symbol: string;
  source: SourceName;
  raw: string;
  price: Rational;
}

export type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export async function fetchFrom(symbol: string, name: SourceName, timeoutMs: number, fetchImpl: Fetch = fetch): Promise<Quote> {
  const src: PriceSource = PRICE_SOURCES[name];
  const res = await fetchImpl(src.url(symbol), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", "user-agent": "uniswap-prediction-demo-bot" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = src.parse(await res.json(), symbol);
  const price = parseDecimal(raw);
  if (price.num === 0n) throw new Error("zero price");
  return { symbol, source: name, raw, price };
}

/** `symbol`-USD from the first source in `order` that answers; the errors of the ones that did not are returned for logging. */
export async function fetchPrice(
  symbol: string,
  order: readonly SourceName[],
  timeoutMs: number,
  fetchImpl: Fetch = fetch,
): Promise<{ quote: Quote; failures: string[] }> {
  const sym = normalizeSymbol(symbol);
  const failures: string[] = [];
  for (const name of order) {
    try {
      return { quote: await fetchFrom(sym, name, timeoutMs, fetchImpl), failures };
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`all ${sym} price sources failed (${failures.join("; ")})`);
}
