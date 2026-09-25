import { parseDecimal, type Rational } from "./math.ts";

export interface PriceSource {
  url: string;
  /** Quote currency of the pair; anything but USD is a proxy for the ETH-USD price. */
  quote: "USD" | "USDT";
  /** Returns the price as a plain decimal string. */
  parse: (json: unknown) => string;
}

function field(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null || !(key in obj)) throw new Error(`missing field ${key}`);
  return (obj as Record<string, unknown>)[key];
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} is not a string`);
  return v;
}

export function parseCoinbase(json: unknown): string {
  const data = field(json, "data");
  const base = field(data, "base");
  const currency = field(data, "currency");
  if (base !== "ETH" || currency !== "USD") throw new Error(`unexpected pair ${String(base)}-${String(currency)}`);
  return str(field(data, "amount"), "coinbase amount");
}

export function parseKraken(json: unknown): string {
  const errors = field(json, "error");
  if (Array.isArray(errors) && errors.length > 0) throw new Error(`kraken error ${errors.join(", ")}`);
  const result = field(json, "result");
  if (typeof result !== "object" || result === null) throw new Error("kraken result missing");
  const pair = Object.values(result)[0];
  const last = field(pair, "c");
  if (!Array.isArray(last)) throw new Error("kraken last trade missing");
  return str(last[0], "kraken last price");
}

export function parseBinance(json: unknown): string {
  return str(field(json, "price"), "binance price");
}

export const PRICE_SOURCES = {
  coinbase: { url: "https://api.coinbase.com/v2/prices/ETH-USD/spot", quote: "USD", parse: parseCoinbase },
  kraken: { url: "https://api.kraken.com/0/public/Ticker?pair=ETHUSD", quote: "USD", parse: parseKraken },
  binance: { url: "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", quote: "USDT", parse: parseBinance },
  binanceus: { url: "https://api.binance.us/api/v3/ticker/price?symbol=ETHUSD", quote: "USD", parse: parseBinance },
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
  source: SourceName;
  raw: string;
  price: Rational;
}

export type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export async function fetchFrom(name: SourceName, timeoutMs: number, fetchImpl: Fetch = fetch): Promise<Quote> {
  const src: PriceSource = PRICE_SOURCES[name];
  const res = await fetchImpl(src.url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", "user-agent": "uniswap-prediction-demo-bot" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = src.parse(await res.json());
  const price = parseDecimal(raw);
  if (price.num === 0n) throw new Error("zero price");
  return { source: name, raw, price };
}

/** First source in `order` that answers; the errors of the ones that did not are returned for logging. */
export async function fetchPrice(
  order: readonly SourceName[],
  timeoutMs: number,
  fetchImpl: Fetch = fetch,
): Promise<{ quote: Quote; failures: string[] }> {
  const failures: string[] = [];
  for (const name of order) {
    try {
      return { quote: await fetchFrom(name, timeoutMs, fetchImpl), failures };
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`all price sources failed (${failures.join("; ")})`);
}
