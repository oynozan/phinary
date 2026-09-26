import { erc20Abi, getAddress, zeroAddress, type Address, type Hash, type PublicClient } from "viem";
import { priceSteererAbi, underlyingOracleHookAbi } from "./abi.ts";
import { assertChainId, makeClients, readSlot0, shutdownSignal, sleep, waitForSuccess, type Clients } from "./chain.ts";
import { loadEnvFiles, loadMirrorConfig, requireAddress, type MirrorConfig, type MirrorTarget } from "./config.ts";
import { fetchPrice, nonUsdSources, PRICE_SOURCES, type Quote } from "./feeds.ts";
import { createLogger, errMsg, type Logger } from "./log.ts";
import { formatRational, type Rational } from "./math.ts";
import {
  deviationBps,
  orientationFor,
  poolId,
  priceFromSqrtPriceX96,
  sqrtPriceX96FromPrice,
  type Orientation,
  type PoolKey,
} from "./pricing.ts";

/**
 * Gas limit for a steer. The oracle hook writes on the first swap of each block (~70k); an RPC that estimates in a
 * block that already has a steer misses that write, so the estimate is padded (test/demo/PriceSteererHooked.t.sol).
 */
export function steerGasLimit(estimate: bigint): bigint {
  return (estimate * 13n) / 10n + 100_000n;
}

/** Consecutive out-of-band readings after which a large move is treated as real rather than a bad print. */
export const JUMP_CONFIRMATIONS = 3;

export interface Guard {
  thresholdBps: number;
  maxJumpBps: number;
  minPrice: Rational;
  maxPrice: Rational;
}

export interface GuardState {
  lastAccepted?: Rational;
  rejectStreak: number;
}

export type Decision =
  | { action: "steer"; target: bigint; deviationBps: number }
  | { action: "hold"; target: bigint; deviationBps: number }
  | { action: "reject"; reason: string };

function cmp(a: Rational, b: Rational): number {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** |a - b| / b in basis points. */
export function relativeBps(a: Rational, b: Rational): number {
  const diff = a.num * b.den - b.num * a.den;
  const abs = diff < 0n ? -diff : diff;
  return Number((abs * 1_000_000n) / (b.num * a.den)) / 100;
}

/** Decides whether to steer the pool from `currentSqrtPriceX96` to the feed `price`; updates `state`. */
export function decideSteer(
  price: Rational,
  currentSqrtPriceX96: bigint,
  o: Orientation,
  g: Guard,
  state: GuardState,
): Decision {
  if (cmp(price, g.minPrice) < 0 || cmp(price, g.maxPrice) > 0) {
    return { action: "reject", reason: `price outside [${formatRational(g.minPrice, 2)}, ${formatRational(g.maxPrice, 2)}]` };
  }
  if (state.lastAccepted && relativeBps(price, state.lastAccepted) > g.maxJumpBps) {
    state.rejectStreak += 1;
    if (state.rejectStreak < JUMP_CONFIRMATIONS) {
      return { action: "reject", reason: `jump > ${g.maxJumpBps} bps vs last accepted price (${state.rejectStreak}/${JUMP_CONFIRMATIONS})` };
    }
  }
  state.rejectStreak = 0;
  state.lastAccepted = price;
  const target = sqrtPriceX96FromPrice(price, o);
  const dev = deviationBps(currentSqrtPriceX96, target, o);
  if (target === currentSqrtPriceX96 || dev <= g.thresholdBps) return { action: "hold", target, deviationBps: dev };
  return { action: "steer", target, deviationBps: dev };
}

/** One pool the mirror keeps at `symbol`-USD, with its own guard state. */
export interface TargetContext {
  symbol: string;
  key: PoolKey;
  orientation: Orientation;
  guard: Guard;
  state: GuardState;
  getPrice: () => Promise<{ quote: Quote; failures: string[] }>;
}

export interface MirrorContext {
  clients: Clients;
  poolManager: Address;
  steerer: Address;
  targets: TargetContext[];
  dryRun: boolean;
  txTimeoutMs: number;
  log: Logger;
}

export interface TickResult {
  symbol: string;
  decision?: Decision;
  quote?: Quote;
  fromSqrtPriceX96?: bigint;
  hash?: Hash;
  /** Why this target was skipped this tick (feed, RPC or transaction failure); the other targets still run */
  error?: string;
}

/** Next nonce of the mirror account within one tick, so back-to-back steers never reuse or skip one. */
interface NonceCursor {
  next?: number;
}

async function steerTarget(
  ctx: MirrorContext,
  t: TargetContext,
  quote: Quote,
  failures: string[],
  fromSqrtPriceX96: bigint,
  nonce: NonceCursor,
): Promise<TickResult> {
  const { publicClient, walletClient, account } = ctx.clients;
  if (failures.length > 0) {
    const quoted = PRICE_SOURCES[quote.source].quote;
    ctx.log.warn("price source fallback", {
      symbol: t.symbol,
      used: quote.source,
      ...(quoted === "USD" ? {} : { quotedIn: quoted }),
      failed: failures.join("; "),
    });
  }
  if (fromSqrtPriceX96 === 0n) throw new Error("underlying pool is not initialized");

  const decision = decideSteer(quote.price, fromSqrtPriceX96, t.orientation, t.guard, t.state);
  const poolPrice = formatRational(priceFromSqrtPriceX96(fromSqrtPriceX96, t.orientation), 2);
  const base = { symbol: t.symbol, source: quote.source, feed: quote.raw, pool: poolPrice };
  const result: TickResult = { symbol: t.symbol, decision, quote, fromSqrtPriceX96 };
  if (decision.action === "reject") {
    ctx.log.warn("feed price rejected", { ...base, reason: decision.reason });
    return result;
  }
  if (decision.action === "hold") {
    ctx.log.debug("within threshold", { ...base, devBps: decision.deviationBps });
    return result;
  }
  const fields = { ...base, devBps: decision.deviationBps, target: decision.target };
  if (ctx.dryRun || !walletClient || !account) {
    ctx.log.info("steer (dry run)", fields);
    return result;
  }
  const call = { address: ctx.steerer, abi: priceSteererAbi, functionName: "steer", args: [t.key, decision.target], account } as const;
  const { request } = await publicClient.simulateContract(call);
  const gas = steerGasLimit(await publicClient.estimateContractGas(call));
  nonce.next ??= await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  let hash: Hash;
  try {
    hash = await walletClient.writeContract({ ...request, gas, nonce: nonce.next });
  } catch (e) {
    // Not broadcast, or unknown: the next steer asks the RPC again
    nonce.next = undefined;
    throw e;
  }
  nonce.next += 1;
  const receipt = await waitForSuccess(publicClient, hash, ctx.txTimeoutMs);
  ctx.log.info("steered", { ...fields, tx: hash, block: receipt.blockNumber, gas: receipt.gasUsed });
  return { ...result, hash };
}

/**
 * Reads every target's feed price and pool in parallel, then steers each pool outside the threshold, one transaction
 * at a time from the mirror account. A target that fails is logged and skipped; the others still run.
 */
export async function mirrorTick(ctx: MirrorContext): Promise<TickResult[]> {
  const reads = await Promise.allSettled(
    ctx.targets.map((t) => Promise.all([t.getPrice(), readSlot0(ctx.clients.publicClient, ctx.poolManager, t.key)])),
  );
  const nonce: NonceCursor = {};
  const results: TickResult[] = [];
  for (const [i, t] of ctx.targets.entries()) {
    const read = reads[i]!;
    try {
      if (read.status === "rejected") throw read.reason;
      const [{ quote, failures }, slot0] = read.value;
      results.push(await steerTarget(ctx, t, quote, failures, slot0.sqrtPriceX96, nonce));
    } catch (e) {
      ctx.log.error("tick failed", { symbol: t.symbol, error: errMsg(e) });
      results.push({ symbol: t.symbol, error: errMsg(e) });
    }
  }
  return results;
}

function sameKey(a: PoolKey, b: PoolKey): boolean {
  return (
    getAddress(a.currency0) === getAddress(b.currency0) &&
    getAddress(a.currency1) === getAddress(b.currency1) &&
    a.fee === b.fee &&
    a.tickSpacing === b.tickSpacing &&
    getAddress(a.hooks) === getAddress(b.hooks)
  );
}

/**
 * The pool `target`'s oracle is bound to, read from UnderlyingOracleHook.poolKey(). It must pair the target's token
 * with `quoteToken` and be hooked by the oracle itself. A configured key that disagrees is an error when it was set
 * explicitly; defaults are replaced. Falls back to the configured key if the read fails.
 */
export async function resolveTargetPool(
  publicClient: PublicClient,
  target: Pick<MirrorTarget, "symbol" | "token" | "oracle" | "key" | "keyExplicit">,
  quoteToken: Address,
  log: Logger,
): Promise<PoolKey> {
  const configured = target.key;
  const tokens = [target.token, quoteToken].map((a) => getAddress(a)).sort();
  const isPair = (k: PoolKey) => getAddress(k.currency0) === tokens[0] && getAddress(k.currency1) === tokens[1];
  if (!isPair(configured)) {
    throw new Error(`${target.symbol} pool ${configured.currency0}/${configured.currency1} is not ${target.token}/${quoteToken}`);
  }
  if (target.oracle === zeroAddress) return configured;
  let bound: PoolKey;
  try {
    const k = await publicClient.readContract({
      address: target.oracle,
      abi: underlyingOracleHookAbi,
      functionName: "poolKey",
    });
    bound = { ...k, currency0: getAddress(k.currency0), currency1: getAddress(k.currency1), hooks: getAddress(k.hooks) };
  } catch (e) {
    log.warn("could not read the oracle's poolKey(), using the configured key", { symbol: target.symbol, error: errMsg(e) });
    return configured;
  }
  if (!isPair(bound)) {
    throw new Error(`${target.symbol} oracle pool ${bound.currency0}/${bound.currency1} is not ${target.token}/${quoteToken}`);
  }
  if (bound.hooks !== getAddress(target.oracle)) {
    throw new Error(`${target.symbol} oracle ${target.oracle} is bound to a pool hooked by ${bound.hooks}`);
  }
  if (!sameKey(bound, configured)) {
    if (target.keyExplicit) {
      throw new Error(
        `configured ${target.symbol} pool (fee ${configured.fee}, tickSpacing ${configured.tickSpacing}, hooks ${configured.hooks}) ` +
          `differs from the oracle's (fee ${bound.fee}, tickSpacing ${bound.tickSpacing}, hooks ${bound.hooks})`,
      );
    }
    log.info("using the oracle's pool key", { symbol: target.symbol, fee: bound.fee, tickSpacing: bound.tickSpacing });
  }
  return bound;
}

export async function setupMirror(cfg: MirrorConfig, log: Logger): Promise<MirrorContext> {
  const clients = makeClients(cfg);
  const { publicClient, account } = clients;
  await assertChainId(publicClient, cfg.chainId);
  const d = cfg.deployments;
  const poolManager = requireAddress(d, "poolManager");
  const steerer = requireAddress(d, "priceSteerer");
  const usdc = requireAddress(d, "demoUsdc");
  if (cfg.targets.length === 0) throw new Error("no pools to mirror");
  const [quoteDecimals, owner, steererPm] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: steerer, abi: priceSteererAbi, functionName: "owner" }),
    publicClient.readContract({ address: steerer, abi: priceSteererAbi, functionName: "poolManager" }),
  ]);
  if (steererPm.toLowerCase() !== poolManager.toLowerCase()) {
    throw new Error(`PriceSteerer uses PoolManager ${steererPm}, deployments say ${poolManager}`);
  }
  if (account && owner.toLowerCase() !== account.address.toLowerCase() && !cfg.dryRun) {
    throw new Error(`account ${account.address} is not the PriceSteerer owner (${owner})`);
  }
  const targets: TargetContext[] = [];
  for (const t of cfg.targets) {
    if (t.token === zeroAddress) {
      throw new Error(`${t.symbol} token is not deployed: set it in the deployments file (demoWeth or underlyings) or DEMO_WETH`);
    }
    const [baseDecimals, key] = await Promise.all([
      publicClient.readContract({ address: t.token, abi: erc20Abi, functionName: "decimals" }),
      resolveTargetPool(publicClient, t, usdc, log),
    ]);
    const orientation = orientationFor(key, t.token, baseDecimals, quoteDecimals);
    log.info("mirror target", {
      symbol: t.symbol,
      token: t.token,
      pool: poolId(key),
      baseIsCurrency0: orientation.baseIsToken0,
      decimals: `${baseDecimals}/${quoteDecimals}`,
      band: `${formatRational(t.minPrice, 2)}..${formatRational(t.maxPrice, 2)}`,
    });
    targets.push({
      symbol: t.symbol,
      key,
      orientation,
      guard: { thresholdBps: cfg.thresholdBps, maxJumpBps: cfg.maxJumpBps, minPrice: t.minPrice, maxPrice: t.maxPrice },
      state: { rejectStreak: 0 },
      getPrice: () => fetchPrice(t.symbol, cfg.sources, cfg.fetchTimeoutMs),
    });
  }
  log.info("mirror ready", {
    account: account?.address ?? "none",
    keyFrom: cfg.privateKey?.source,
    steerer,
    symbols: targets.map((t) => t.symbol).join(","),
    thresholdBps: cfg.thresholdBps,
    intervalMs: cfg.intervalMs,
    sources: cfg.sources.join(","),
    dryRun: cfg.dryRun,
  });
  const usdt = nonUsdSources(cfg.sources);
  if (usdt.length > 0) log.warn("some price sources quote in USDT, not USD", { sources: usdt.join(",") });
  return { clients, poolManager, steerer, targets, dryRun: cfg.dryRun, txTimeoutMs: cfg.txTimeoutMs, log };
}

async function main(): Promise<void> {
  loadEnvFiles();
  const cfg = loadMirrorConfig();
  const log = createLogger("mirror", cfg.logLevel);
  const ctx = await setupMirror(cfg, log);
  const stop = shutdownSignal((sig) => log.info("stopping", { signal: sig }));
  while (!stop.aborted) {
    const started = Date.now();
    try {
      await mirrorTick(ctx);
    } catch (e) {
      log.error("tick failed", { error: errMsg(e) });
    }
    if (cfg.once) break;
    await sleep(Math.max(0, cfg.intervalMs - (Date.now() - started)), stop);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`mirror: ${errMsg(e)}`);
    process.exit(1);
  });
}
