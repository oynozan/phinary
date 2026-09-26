import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { isSourceName, normalizeSymbol, type SourceName } from "./feeds.ts";
import { isLevel, type Level } from "./log.ts";
import { parseDecimal, type Rational } from "./math.ts";
import { poolId, sortTokens, type PoolKey } from "./pricing.ts";

export const BOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(BOT_DIR, "..");
export const DEFAULT_DEPLOYMENTS_FILE = resolve(REPO_DIR, "deployments", "unichain-sepolia.json");
export const DEFAULT_RPC_URL = "https://sepolia.unichain.org";
export const USDC_DECIMALS = 6;

export type Env = Record<string, string | undefined>;

/** Loads KEY=VALUE files into `env` without overriding variables that are already set. Returns the files read. */
export function loadEnvFiles(
  paths: string[] = [resolve(BOT_DIR, ".env"), resolve(REPO_DIR, ".env")],
  env: Env = process.env,
): string[] {
  const loaded: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseEnv(readFileSync(p, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (env[k] === undefined && v !== undefined) env[k] = v;
    }
    loaded.push(p);
  }
  return loaded;
}

/* Deployments */

const ADDRESS_KEYS = [
  "poolManager",
  "v4Quoter",
  "universalRouter",
  "permit2",
  "stateView",
  "usdc",
  "predictionHook",
  "marketScheduler",
  "underlyingOracle",
  "priceSteerer",
  "demoWeth",
  "demoUsdc",
  "sealedOracle",
] as const;

export type AddressKey = (typeof ADDRESS_KEYS)[number];

const ADDRESS_ENV: Record<AddressKey, string> = {
  poolManager: "POOL_MANAGER",
  v4Quoter: "V4_QUOTER",
  universalRouter: "UNIVERSAL_ROUTER",
  permit2: "PERMIT2",
  stateView: "STATE_VIEW",
  usdc: "USDC",
  predictionHook: "PREDICTION_HOOK",
  marketScheduler: "MARKET_SCHEDULER",
  underlyingOracle: "UNDERLYING_ORACLE",
  priceSteerer: "PRICE_STEERER",
  demoWeth: "DEMO_WETH",
  demoUsdc: "DEMO_USDC",
  sealedOracle: "SEALED_ORACLE",
};

/** One oracle-hooked demo pool, `token` against demoUsdc, from the deployments file's `underlyings` list. */
export interface Underlying {
  symbol: string;
  token: Address;
  oracle: Address;
  pool: PoolKey;
}

export type Deployments = Record<AddressKey, Address> & {
  chainId: number;
  rpcUrl?: string;
  underlyingPool: PoolKey;
  /** False when fee and tickSpacing are defaults; the mirror then takes the key from the oracle's poolKey(). */
  underlyingPoolExplicit: boolean;
  /** The `underlyings` list, or undefined when the file only has the flat single-ETH keys. */
  underlyings?: Underlying[];
};

function asAddress(v: unknown, what: string): Address {
  if (v === undefined || v === null || v === "") return zeroAddress;
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error(`${what} is not an address`);
  return getAddress(v);
}

function asInt(v: unknown, what: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error(`${what} is not an integer`);
  return n;
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what} must be an object`);
  return v as Record<string, unknown>;
}

function asPoolKey(v: unknown, what: string): PoolKey {
  const p = asObject(v, what);
  return {
    currency0: asAddress(p.currency0, `${what}.currency0`),
    currency1: asAddress(p.currency1, `${what}.currency1`),
    fee: asInt(p.fee, `${what}.fee`),
    tickSpacing: asInt(p.tickSpacing, `${what}.tickSpacing`),
    hooks: asAddress(p.hooks, `${what}.hooks`),
  };
}

function assertSorted(pool: PoolKey, what: string): void {
  if (BigInt(pool.currency0) >= BigInt(pool.currency1) && pool.currency1 !== zeroAddress) {
    throw new Error(`${what} currencies must be sorted (currency0 < currency1)`);
  }
}

export function parseUnderlyings(v: unknown): Underlying[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error("underlyings must be a non-empty array");
  const seen = new Set<string>();
  return v.map((entry, i) => {
    const e = asObject(entry, `underlyings[${i}]`);
    if (typeof e.symbol !== "string") throw new Error(`underlyings[${i}].symbol is not a string`);
    const symbol = normalizeSymbol(e.symbol);
    const what = `underlyings[${i}] (${symbol})`;
    if (seen.has(symbol)) throw new Error(`underlyings has ${symbol} twice`);
    seen.add(symbol);
    const u: Underlying = {
      symbol,
      token: asAddress(e.token, `${what}.token`),
      oracle: asAddress(e.oracle, `${what}.oracle`),
      pool: asPoolKey(e.pool, `${what}.pool`),
    };
    assertSorted(u.pool, `${what}.pool`);
    if (u.token === zeroAddress || (u.pool.currency0 !== u.token && u.pool.currency1 !== u.token)) {
      throw new Error(`${what}.token ${u.token} is not in its pool`);
    }
    if (u.pool.hooks !== u.oracle) throw new Error(`${what}.pool.hooks ${u.pool.hooks} is not its oracle ${u.oracle}`);
    if (e.poolId !== undefined && String(e.poolId).toLowerCase() !== poolId(u.pool)) {
      throw new Error(`${what}.poolId ${String(e.poolId)} does not match its pool key (${poolId(u.pool)})`);
    }
    return u;
  });
}

/** Parses a deployments file; addresses may be flat or under "contracts", and missing ones are zero. */
export function parseDeployments(json: unknown, env: Env = {}): Deployments {
  const root = asObject(json, "deployments");
  const flat: Record<string, unknown> = { ...(root.contracts ? asObject(root.contracts, "contracts") : {}), ...root };
  const addrs = {} as Record<AddressKey, Address>;
  for (const key of ADDRESS_KEYS) {
    addrs[key] = asAddress(env[ADDRESS_ENV[key]] ?? flat[key], key);
  }
  let pool: PoolKey;
  let explicit = true;
  if (flat.underlyingPool !== undefined) {
    pool = asPoolKey(flat.underlyingPool, "underlyingPool");
  } else {
    const [currency0, currency1] = sortTokens(addrs.demoWeth, addrs.demoUsdc);
    const fee = env.UNDERLYING_POOL_FEE ?? flat.underlyingPoolFee;
    const tickSpacing = env.UNDERLYING_POOL_TICK_SPACING ?? flat.underlyingPoolTickSpacing;
    explicit = fee !== undefined || tickSpacing !== undefined;
    pool = {
      currency0,
      currency1,
      fee: asInt(fee ?? 500, "underlyingPoolFee"),
      tickSpacing: asInt(tickSpacing ?? 10, "underlyingPoolTickSpacing"),
      hooks: addrs.underlyingOracle,
    };
  }
  assertSorted(pool, "underlyingPool");
  const rpcUrl = typeof flat.rpcUrl === "string" ? flat.rpcUrl : undefined;
  return {
    ...addrs,
    chainId: asInt(flat.chainId ?? 1301, "chainId"),
    rpcUrl,
    underlyingPool: pool,
    underlyingPoolExplicit: explicit,
    underlyings: flat.underlyings === undefined || flat.underlyings === null ? undefined : parseUnderlyings(flat.underlyings),
  };
}

export function loadDeployments(file: string, env: Env = {}): Deployments {
  if (!existsSync(file)) {
    throw new Error(`deployments file not found: ${file} (copy bot/config/unichain-sepolia.example.json or set DEPLOYMENTS_FILE)`);
  }
  return parseDeployments(JSON.parse(readFileSync(file, "utf8")), env);
}

export function requireAddress(d: Deployments, key: AddressKey): Address {
  const a = d[key];
  if (a === zeroAddress) throw new Error(`${key} is not deployed: set it in the deployments file or ${ADDRESS_ENV[key]}`);
  return a;
}

/* Env parsing */

function raw(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export function envInt(env: Env, name: string, def: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const v = raw(env, name);
  const n = v === undefined ? def : Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return n;
}

export function envNumber(env: Env, name: string, def: number, min = -Infinity): number {
  const v = raw(env, name);
  const n = v === undefined ? def : Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number >= ${min}`);
  return n;
}

export function envBool(env: Env, name: string, def: boolean): boolean {
  const v = raw(env, name)?.toLowerCase();
  if (v === undefined) return def;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be a boolean`);
}

export function envString(env: Env, name: string, def: string): string {
  return raw(env, name) ?? def;
}

export function envRational(env: Env, name: string, def: string): Rational {
  try {
    return parseDecimal(raw(env, name) ?? def);
  } catch {
    throw new Error(`${name} must be a plain decimal`);
  }
}

/** Private key from the first set variable. The value is validated but never echoed. */
export function readPrivateKey(env: Env, names: string[]): { key: Hex; source: string } | undefined {
  for (const name of names) {
    const v = raw(env, name);
    if (v === undefined) continue;
    const hex = v.startsWith("0x") ? v : `0x${v}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} is not a 32-byte hex private key`);
    return { key: hex as Hex, source: name };
  }
  return undefined;
}

/** Splits a comma-separated RPC list, in order, and rejects anything that is not an http(s) URL. */
export function rpcUrlList(value: string, name = "RPC_URL"): string[] {
  const urls = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  for (const url of urls) {
    if (!/^https?:\/\//.test(url)) throw new Error(`${name} must be comma-separated http(s) URLs`);
  }
  return urls;
}

/* Bot configs */

export interface CommonConfig {
  deploymentsFile: string;
  deployments: Deployments;
  /** One RPC URL, or several comma-separated: the first is primary, the rest are fallbacks in order */
  rpcUrl: string;
  chainId: number;
  dryRun: boolean;
  once: boolean;
  logLevel: Level;
  txTimeoutMs: number;
  privateKey?: { key: Hex; source: string };
}

function loadCommon(env: Env, keyVars: string[]): CommonConfig {
  const file = envString(env, "DEPLOYMENTS_FILE", DEFAULT_DEPLOYMENTS_FILE);
  const deploymentsFile = isAbsolute(file) ? file : resolve(BOT_DIR, file);
  const deployments = loadDeployments(deploymentsFile, env);
  const logLevel = envString(env, "LOG_LEVEL", "info").toLowerCase();
  if (!isLevel(logLevel)) throw new Error("LOG_LEVEL must be debug, info, warn or error");
  const dryRun = envBool(env, "DRY_RUN", false);
  const privateKey = readPrivateKey(env, keyVars);
  if (!dryRun && !privateKey) throw new Error(`set ${keyVars.join(" or ")} (or DRY_RUN=1)`);
  return {
    deploymentsFile,
    deployments,
    rpcUrl: rpcUrlList(envString(env, "RPC_URL", deployments.rpcUrl ?? DEFAULT_RPC_URL), "RPC_URL").join(","),
    chainId: envInt(env, "CHAIN_ID", deployments.chainId, 1),
    dryRun,
    once: envBool(env, "ONCE", false),
    logLevel,
    txTimeoutMs: envInt(env, "TX_TIMEOUT_MS", 30_000, 1000),
    privateKey,
  };
}

/** A pool the mirror steers to `symbol`-USD. */
export interface MirrorTarget {
  symbol: string;
  /** The base token; the other side of the pool is demoUsdc */
  token: Address;
  oracle: Address;
  key: PoolKey;
  /** False when fee and tickSpacing are defaults; the mirror then takes the key from the oracle's poolKey(). */
  keyExplicit: boolean;
  /** Feed prices outside [minPrice, maxPrice] are dropped */
  minPrice: Rational;
  maxPrice: Rational;
}

/** Sanity band per asset, in USD. MIRROR_<SYM>_MIN_PRICE / MIRROR_<SYM>_MAX_PRICE override them. */
export const DEFAULT_PRICE_BANDS: Record<string, { min: string; max: string }> = {
  ETH: { min: "100", max: "100000" },
  SOL: { min: "5", max: "2000" },
  BTC: { min: "1000", max: "10000000" },
};

function priceBand(env: Env, symbol: string): { minPrice: Rational; maxPrice: Rational } {
  const def = DEFAULT_PRICE_BANDS[symbol];
  const bound = (side: "MIN" | "MAX", fallback: string | undefined): Rational => {
    const name = `MIRROR_${symbol}_${side}_PRICE`;
    // MIRROR_MIN_PRICE / MIRROR_MAX_PRICE predate the multi-asset mirror and are ETH-sized, so they only apply to ETH
    const legacy = `MIRROR_${side}_PRICE`;
    if (raw(env, name) !== undefined) return envRational(env, name, "0");
    if (symbol === "ETH" && raw(env, legacy) !== undefined) return envRational(env, legacy, "0");
    if (fallback === undefined) throw new Error(`no default price band for ${symbol}: set ${name}`);
    return parseDecimal(fallback);
  };
  const minPrice = bound("MIN", def?.min);
  const maxPrice = bound("MAX", def?.max);
  if (minPrice.num * maxPrice.den >= maxPrice.num * minPrice.den) {
    throw new Error(`MIRROR_${symbol}_MIN_PRICE must be below MIRROR_${symbol}_MAX_PRICE`);
  }
  return { minPrice, maxPrice };
}

/**
 * The pools to steer: every `underlyings` entry, or, when the file has none, the single demoWeth/demoUsdc pool from
 * the flat keys as ETH. MIRROR_SYMBOLS (comma-separated) keeps only the listed ones.
 */
export function mirrorTargets(d: Deployments, env: Env = {}): MirrorTarget[] {
  const all: Omit<MirrorTarget, "minPrice" | "maxPrice">[] = d.underlyings
    ? d.underlyings.map((u) => ({ symbol: u.symbol, token: u.token, oracle: u.oracle, key: u.pool, keyExplicit: true }))
    : [{ symbol: "ETH", token: d.demoWeth, oracle: d.underlyingOracle, key: d.underlyingPool, keyExplicit: d.underlyingPoolExplicit }];
  const only = raw(env, "MIRROR_SYMBOLS")
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map(normalizeSymbol);
  let picked = all;
  if (only && only.length > 0) {
    const missing = only.filter((s) => !all.some((t) => t.symbol === s));
    if (missing.length > 0) {
      throw new Error(`MIRROR_SYMBOLS has ${missing.join(", ")}, the deployments have ${all.map((t) => t.symbol).join(", ")}`);
    }
    picked = all.filter((t) => only.includes(t.symbol));
  }
  return picked.map((t) => ({ ...t, ...priceBand(env, t.symbol) }));
}

export interface MirrorConfig extends CommonConfig {
  intervalMs: number;
  thresholdBps: number;
  sources: SourceName[];
  fetchTimeoutMs: number;
  maxJumpBps: number;
  targets: MirrorTarget[];
}

export function loadMirrorConfig(env: Env = process.env): MirrorConfig {
  const common = loadCommon(env, ["MIRROR_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"]);
  const sources = envString(env, "MIRROR_SOURCES", "coinbase,kraken,binanceus")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  const bad = sources.filter((s) => !isSourceName(s));
  if (bad.length > 0 || sources.length === 0) throw new Error(`MIRROR_SOURCES has unknown sources: ${bad.join(", ")}`);
  return {
    ...common,
    intervalMs: envInt(env, "MIRROR_INTERVAL_MS", 1000, 100),
    thresholdBps: envNumber(env, "MIRROR_THRESHOLD_BPS", 2, 0),
    sources: sources as SourceName[],
    fetchTimeoutMs: envInt(env, "MIRROR_FETCH_TIMEOUT_MS", 2500, 100),
    maxJumpBps: envNumber(env, "MIRROR_MAX_JUMP_BPS", 1000, 0),
    targets: mirrorTargets(common.deployments, env),
  };
}

export interface KeeperConfig extends CommonConfig {
  pollMs: number;
  periodSec: number;
  alignToPeriod: boolean;
  create: boolean;
  settle: boolean;
  scanBack: number;
  invalidAfterSec: number;
}

export function loadKeeperConfig(env: Env = process.env): KeeperConfig {
  const common = loadCommon(env, ["KEEPER_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"]);
  return {
    ...common,
    pollMs: envInt(env, "KEEPER_POLL_MS", 2000, 200),
    periodSec: envInt(env, "KEEPER_PERIOD_SEC", 60, 1),
    alignToPeriod: envBool(env, "KEEPER_ALIGN", true),
    create: envBool(env, "KEEPER_CREATE", true),
    settle: envBool(env, "KEEPER_SETTLE", true),
    scanBack: envInt(env, "KEEPER_SCAN_BACK", 50, 1),
    invalidAfterSec: envInt(env, "KEEPER_INVALID_AFTER_SEC", 3601, 0),
  };
}

export interface SealedConfig extends CommonConfig {
  /** SEALED_ORACLE, else the deployments file's `sealedOracle` */
  oracle: Address;
  /** Most proofs per proveMany, each about 0.72M gas */
  batch: number;
  pollMs: number;
  /** Read-only RPCs tried after RPC_URL for headers and proofs */
  fallbackRpcUrls: string[];
}

export function loadSealedConfig(env: Env = process.env): SealedConfig {
  const common = loadCommon(env, ["SEALED_KEY", "KEEPER_PRIVATE_KEY"]);
  const fallbackRpcUrls = rpcUrlList(envString(env, "SEALED_RPC_FALLBACKS", ""), "SEALED_RPC_FALLBACKS");
  return {
    ...common,
    oracle: requireAddress(common.deployments, "sealedOracle"),
    batch: envInt(env, "SEALED_BATCH", 16, 1, 64),
    pollMs: envInt(env, "SEALED_POLL_MS", 500, 100),
    fallbackRpcUrls,
  };
}
