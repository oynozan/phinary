import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { getAddress, isAddress, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { isSourceName, type SourceName } from "./feeds.ts";
import { isLevel, type Level } from "./log.ts";
import { varE36FromAnnualVol, validateTemplate, type MarketTemplate } from "./market.ts";
import { parseDecimal, type Rational } from "./math.ts";
import { sortTokens, type PoolKey } from "./pricing.ts";

export const BOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(BOT_DIR, "..");
export const DEFAULT_DEPLOYMENTS_FILE = resolve(REPO_DIR, "deployments", "unichain-sepolia.json");
export const DEFAULT_RPC_URL = "https://sepolia.unichain.org";
export const USDC_DECIMALS = 6;
export const OUTCOME_DECIMALS = 6;

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
  "underlyingOracle",
  "priceSteerer",
  "demoWeth",
  "demoUsdc",
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
  underlyingOracle: "UNDERLYING_ORACLE",
  priceSteerer: "PRICE_STEERER",
  demoWeth: "DEMO_WETH",
  demoUsdc: "DEMO_USDC",
};

export type Deployments = Record<AddressKey, Address> & {
  chainId: number;
  rpcUrl?: string;
  underlyingPool: PoolKey;
  /** False when fee and tickSpacing are defaults; the mirror then takes the key from the oracle's poolKey(). */
  underlyingPoolExplicit: boolean;
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
    const p = asObject(flat.underlyingPool, "underlyingPool");
    pool = {
      currency0: asAddress(p.currency0, "underlyingPool.currency0"),
      currency1: asAddress(p.currency1, "underlyingPool.currency1"),
      fee: asInt(p.fee, "underlyingPool.fee"),
      tickSpacing: asInt(p.tickSpacing, "underlyingPool.tickSpacing"),
      hooks: asAddress(p.hooks, "underlyingPool.hooks"),
    };
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
  if (BigInt(pool.currency0) >= BigInt(pool.currency1) && pool.currency1 !== zeroAddress) {
    throw new Error("underlyingPool currencies must be sorted (currency0 < currency1)");
  }
  const rpcUrl = typeof flat.rpcUrl === "string" ? flat.rpcUrl : undefined;
  return {
    ...addrs,
    chainId: asInt(flat.chainId ?? 1301, "chainId"),
    rpcUrl,
    underlyingPool: pool,
    underlyingPoolExplicit: explicit,
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

/** Decimal string in human units scaled to `decimals` (e.g. "0.01" with 18 -> 1e16). */
export function envUnits(env: Env, name: string, def: string, decimals: number): bigint {
  const v = raw(env, name) ?? def;
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${name} must be a non-negative decimal`);
  const frac = v.split(".")[1] ?? "";
  if (frac.length > decimals) throw new Error(`${name} has more than ${decimals} decimals`);
  return parseUnits(v, decimals);
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

/* Bot configs */

export interface CommonConfig {
  deploymentsFile: string;
  deployments: Deployments;
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
    rpcUrl: envString(env, "RPC_URL", deployments.rpcUrl ?? DEFAULT_RPC_URL),
    chainId: envInt(env, "CHAIN_ID", deployments.chainId, 1),
    dryRun,
    once: envBool(env, "ONCE", false),
    logLevel,
    txTimeoutMs: envInt(env, "TX_TIMEOUT_MS", 30_000, 1000),
    privateKey,
  };
}

export interface MirrorConfig extends CommonConfig {
  intervalMs: number;
  thresholdBps: number;
  sources: SourceName[];
  fetchTimeoutMs: number;
  maxJumpBps: number;
  minPrice: Rational;
  maxPrice: Rational;
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
    minPrice: envRational(env, "MIRROR_MIN_PRICE", "100"),
    maxPrice: envRational(env, "MIRROR_MAX_PRICE", "100000"),
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
  template: MarketTemplate;
}

export function loadMarketTemplate(env: Env): MarketTemplate {
  const sigmaMode = envInt(env, "SIGMA_MODE", 0, 0, 1);
  const fixedVarRaw = raw(env, "FIXED_VAR_E36");
  const template: MarketTemplate = {
    tenorSec: envInt(env, "MARKET_TENOR_SEC", 60, 1),
    windowSec: envInt(env, "MARKET_WINDOW_SEC", 10, 1, 2 ** 32 - 1),
    cutoffBufferSec: envInt(env, "MARKET_CUTOFF_BUFFER_SEC", 2, 0, 2 ** 32 - 1),
    nSamples: envInt(env, "MARKET_N_SAMPLES", 10, 0, 2 ** 32 - 1),
    openDelaySec: envInt(env, "MARKET_OPEN_DELAY_SEC", 0, 0),
    expiryAlignSec: envInt(env, "MARKET_EXPIRY_ALIGN_SEC", 0, 0),
    budget: envUnits(env, "MARKET_BUDGET_USDC", "10", USDC_DECIMALS),
    quote: {
      h0Wad: envUnits(env, "QUOTE_H0", "0.02", 18),
      gammaSWad: envUnits(env, "QUOTE_GAMMA_S", "0.00005", 18),
      lambdaWad: envUnits(env, "QUOTE_LAMBDA", "0.001", 18),
      qEpochMax: envUnits(env, "QUOTE_Q_EPOCH_MAX", "100", OUTCOME_DECIMALS),
      pMinWad: envUnits(env, "QUOTE_P_MIN", "0.02", 18),
    },
    sigmaMode,
    fixedVarE36:
      fixedVarRaw !== undefined
        ? envUnits(env, "FIXED_VAR_E36", "0", 0)
        : varE36FromAnnualVol(envString(env, "FIXED_SIGMA_ANNUAL", "0.6")),
    kernel: envInt(env, "KERNEL", 0, 0, 255),
    timeZone: envString(env, "MARKET_TIMEZONE", "UTC"),
    nameTemplate: envString(env, "MARKET_NAME_TEMPLATE", "{side} ETH>{strike} {time}"),
    symbolTemplate: envString(env, "MARKET_SYMBOL_TEMPLATE", "{side}-{strike}-{hhmmss}"),
  };
  validateTemplate(template);
  return template;
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
    template: loadMarketTemplate(env),
  };
}
