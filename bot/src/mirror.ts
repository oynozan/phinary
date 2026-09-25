import { erc20Abi, getAddress, zeroAddress, type Address, type Hash, type PublicClient } from "viem";
import { priceSteererAbi, underlyingOracleHookAbi } from "./abi.ts";
import { assertChainId, makeClients, readSlot0, shutdownSignal, sleep, waitForSuccess, type Clients } from "./chain.ts";
import { loadEnvFiles, loadMirrorConfig, requireAddress, type Deployments, type MirrorConfig } from "./config.ts";
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

export interface MirrorContext {
  clients: Clients;
  poolManager: Address;
  steerer: Address;
  key: PoolKey;
  orientation: Orientation;
  guard: Guard;
  state: GuardState;
  dryRun: boolean;
  txTimeoutMs: number;
  log: Logger;
  getPrice: () => Promise<{ quote: Quote; failures: string[] }>;
}

export interface TickResult {
  decision: Decision;
  quote: Quote;
  fromSqrtPriceX96: bigint;
  hash?: Hash;
}

export async function mirrorTick(ctx: MirrorContext): Promise<TickResult> {
  const { publicClient, walletClient, account } = ctx.clients;
  const [{ quote, failures }, slot0] = await Promise.all([
    ctx.getPrice(),
    readSlot0(publicClient, ctx.poolManager, ctx.key),
  ]);
  if (failures.length > 0) {
    const quoted = PRICE_SOURCES[quote.source].quote;
    ctx.log.warn("price source fallback", {
      used: quote.source,
      ...(quoted === "USD" ? {} : { quotedIn: quoted }),
      failed: failures.join("; "),
    });
  }
  if (slot0.sqrtPriceX96 === 0n) throw new Error("underlying pool is not initialized");

  const decision = decideSteer(quote.price, slot0.sqrtPriceX96, ctx.orientation, ctx.guard, ctx.state);
  const poolPrice = formatRational(priceFromSqrtPriceX96(slot0.sqrtPriceX96, ctx.orientation), 2);
  const base = { source: quote.source, feed: quote.raw, pool: poolPrice };
  if (decision.action === "reject") {
    ctx.log.warn("feed price rejected", { ...base, reason: decision.reason });
    return { decision, quote, fromSqrtPriceX96: slot0.sqrtPriceX96 };
  }
  if (decision.action === "hold") {
    ctx.log.debug("within threshold", { ...base, devBps: decision.deviationBps });
    return { decision, quote, fromSqrtPriceX96: slot0.sqrtPriceX96 };
  }
  const fields = { ...base, devBps: decision.deviationBps, target: decision.target };
  if (ctx.dryRun || !walletClient || !account) {
    ctx.log.info("steer (dry run)", fields);
    return { decision, quote, fromSqrtPriceX96: slot0.sqrtPriceX96 };
  }
  const call = { address: ctx.steerer, abi: priceSteererAbi, functionName: "steer", args: [ctx.key, decision.target], account } as const;
  const { request } = await publicClient.simulateContract(call);
  const gas = steerGasLimit(await publicClient.estimateContractGas(call));
  const hash = await walletClient.writeContract({ ...request, gas });
  const receipt = await waitForSuccess(publicClient, hash, ctx.txTimeoutMs);
  ctx.log.info("steered", { ...fields, tx: hash, block: receipt.blockNumber, gas: receipt.gasUsed });
  return { decision, quote, fromSqrtPriceX96: slot0.sqrtPriceX96, hash };
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
 * The pool the oracle is bound to, read from UnderlyingOracleHook.poolKey(). A configured key that disagrees is an
 * error when it was set explicitly; defaults are replaced. Falls back to the configured key if the read fails.
 */
export async function resolveUnderlyingPool(publicClient: PublicClient, d: Deployments, log: Logger): Promise<PoolKey> {
  const configured = d.underlyingPool;
  if (d.underlyingOracle === zeroAddress) return configured;
  let bound: PoolKey;
  try {
    const k = await publicClient.readContract({
      address: d.underlyingOracle,
      abi: underlyingOracleHookAbi,
      functionName: "poolKey",
    });
    bound = { ...k, currency0: getAddress(k.currency0), currency1: getAddress(k.currency1), hooks: getAddress(k.hooks) };
  } catch (e) {
    log.warn("could not read the oracle's poolKey(), using the configured key", { error: errMsg(e) });
    return configured;
  }
  const tokens = [d.demoWeth, d.demoUsdc].map((a) => getAddress(a)).sort();
  if (getAddress(bound.currency0) !== tokens[0] || getAddress(bound.currency1) !== tokens[1]) {
    throw new Error(`oracle pool ${bound.currency0}/${bound.currency1} is not demoWeth/demoUsdc`);
  }
  if (!sameKey(bound, configured)) {
    if (d.underlyingPoolExplicit) {
      throw new Error(
        `configured underlying pool (fee ${configured.fee}, tickSpacing ${configured.tickSpacing}, hooks ${configured.hooks}) ` +
          `differs from the oracle's (fee ${bound.fee}, tickSpacing ${bound.tickSpacing}, hooks ${bound.hooks})`,
      );
    }
    log.info("using the oracle's pool key", { fee: bound.fee, tickSpacing: bound.tickSpacing });
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
  const weth = requireAddress(d, "demoWeth");
  const usdc = requireAddress(d, "demoUsdc");
  const [baseDecimals, quoteDecimals, owner, steererPm] = await Promise.all([
    publicClient.readContract({ address: weth, abi: erc20Abi, functionName: "decimals" }),
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
  const key = await resolveUnderlyingPool(publicClient, d, log);
  const orientation = orientationFor(key, weth, baseDecimals, quoteDecimals);
  log.info("mirror ready", {
    account: account?.address ?? "none",
    keyFrom: cfg.privateKey?.source,
    steerer,
    pool: poolId(key),
    wethIsCurrency0: orientation.baseIsToken0,
    decimals: `${baseDecimals}/${quoteDecimals}`,
    thresholdBps: cfg.thresholdBps,
    intervalMs: cfg.intervalMs,
    sources: cfg.sources.join(","),
    dryRun: cfg.dryRun,
  });
  const usdt = nonUsdSources(cfg.sources);
  if (usdt.length > 0) log.warn("some price sources quote ETH in USDT, not USD", { sources: usdt.join(",") });
  return {
    clients,
    poolManager,
    steerer,
    key,
    orientation,
    guard: { thresholdBps: cfg.thresholdBps, maxJumpBps: cfg.maxJumpBps, minPrice: cfg.minPrice, maxPrice: cfg.maxPrice },
    state: { rejectStreak: 0 },
    dryRun: cfg.dryRun,
    txTimeoutMs: cfg.txTimeoutMs,
    log,
    getPrice: () => fetchPrice(cfg.sources, cfg.fetchTimeoutMs),
  };
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
