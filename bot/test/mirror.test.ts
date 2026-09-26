import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, toHex, type Address, type PublicClient } from "viem";
import type { Clients } from "../src/chain.ts";
import type { Quote } from "../src/feeds.ts";
import { createLogger } from "../src/log.ts";
import { parseDecimal } from "../src/math.ts";
import { mirrorTick, resolveTargetPool, type Guard, type MirrorContext, type TargetContext } from "../src/mirror.ts";
import { poolId, poolStateSlot, sqrtPriceX96FromPrice, type Orientation, type PoolKey } from "../src/pricing.ts";

const USDC = getAddress("0x1000000000000000000000000000000000000002");
const WETH = getAddress("0xe000000000000000000000000000000000000001");
const SOL = getAddress("0x0500000000000000000000000000000000000003");
const ETH_ORACLE = getAddress("0x0000000000000000000000000000000000001080");
const SOL_ORACLE = getAddress("0x0000000000000000000000000000000000002080");
const PM = getAddress("0x00B036B58a818B1BC34d502D3fE730Db729e62AC");
const STEERER = getAddress("0x0000000000000000000000000000000000005eee");
const ME = getAddress("0x2d1697607Cd75fb012114391c1320a0c3ed6b25C");

const ETH_KEY: PoolKey = { currency0: USDC, currency1: WETH, fee: 500, tickSpacing: 10, hooks: ETH_ORACLE };
const SOL_KEY: PoolKey = { currency0: SOL, currency1: USDC, fee: 3000, tickSpacing: 60, hooks: SOL_ORACLE };
const ETH_O: Orientation = { baseIsToken0: false, baseDecimals: 18, quoteDecimals: 6 };
const SOL_O: Orientation = { baseIsToken0: true, baseDecimals: 9, quoteDecimals: 6 };
const ETH_GUARD: Guard = { thresholdBps: 2, maxJumpBps: 1000, minPrice: parseDecimal("100"), maxPrice: parseDecimal("100000") };
const SOL_GUARD: Guard = { thresholdBps: 2, maxJumpBps: 1000, minPrice: parseDecimal("5"), maxPrice: parseDecimal("2000") };

interface Chain {
  /** Pool sqrtPriceX96 by pool id */
  pools: Map<string, bigint>;
  /** Transactions sent: the steered pool and the nonce used */
  sent: { pool: string; target: bigint; nonce: number | undefined }[];
  nonceReads: number;
  /** Sends that throw before broadcast */
  sendFails: number;
}

function fakeClients(chain: Chain, withWallet = true): Clients {
  const bySlot = new Map<string, string>();
  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName !== "extsload") throw new Error(`unexpected read ${functionName}`);
      const slot = args![0] as string;
      for (const id of chain.pools.keys()) bySlot.set(poolStateSlot(id as `0x${string}`), id);
      const id = bySlot.get(slot);
      if (id === undefined) throw new Error("unknown slot");
      return toHex(chain.pools.get(id)!, { size: 32 });
    },
    simulateContract: async (call: { args: readonly unknown[] }) => ({ request: { ...call } }),
    estimateContractGas: async () => 100_000n,
    getTransactionCount: async ({ address, blockTag }: { address: Address; blockTag: string }) => {
      assert.equal(address, ME);
      assert.equal(blockTag, "pending");
      chain.nonceReads += 1;
      return 7;
    },
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 1n, gasUsed: 150_000n }),
  };
  const walletClient = {
    writeContract: async (req: { args: readonly [PoolKey, bigint]; nonce?: number }) => {
      if (chain.sendFails > 0) {
        chain.sendFails -= 1;
        throw new Error("nonce too low");
      }
      const [key, target] = req.args;
      chain.pools.set(poolId(key), target);
      chain.sent.push({ pool: poolId(key), target, nonce: req.nonce });
      return toHex(chain.sent.length, { size: 32 });
    },
  };
  return {
    publicClient,
    ...(withWallet ? { walletClient, account: { address: ME } } : {}),
  } as unknown as Clients;
}

function quote(symbol: string, raw: string): { quote: Quote; failures: string[] } {
  return { quote: { symbol, source: "coinbase", raw, price: parseDecimal(raw) }, failures: [] };
}

function setup(ethPool: string, solPool: string, opts: { dryRun?: boolean } = {}) {
  const chain: Chain = {
    pools: new Map([
      [poolId(ETH_KEY), sqrtPriceX96FromPrice(parseDecimal(ethPool), ETH_O)],
      [poolId(SOL_KEY), sqrtPriceX96FromPrice(parseDecimal(solPool), SOL_O)],
    ]),
    sent: [],
    nonceReads: 0,
    sendFails: 0,
  };
  const feed = { ETH: "0", SOL: "0" } as Record<"ETH" | "SOL", string | Error>;
  const price = (s: "ETH" | "SOL") => async () => {
    const v = feed[s];
    if (v instanceof Error) throw v;
    return quote(s, v);
  };
  const eth: TargetContext = { symbol: "ETH", key: ETH_KEY, orientation: ETH_O, guard: ETH_GUARD, state: { rejectStreak: 0 }, getPrice: price("ETH") };
  const sol: TargetContext = { symbol: "SOL", key: SOL_KEY, orientation: SOL_O, guard: SOL_GUARD, state: { rejectStreak: 0 }, getPrice: price("SOL") };
  const lines: string[] = [];
  const ctx: MirrorContext = {
    clients: fakeClients(chain),
    poolManager: PM,
    steerer: STEERER,
    targets: [eth, sol],
    dryRun: opts.dryRun ?? false,
    txTimeoutMs: 1000,
    log: createLogger("mirror", "debug", (l) => lines.push(l)),
  };
  return { chain, feed, eth, sol, ctx, lines };
}

test("one tick steers every pool outside its threshold, one after the other with consecutive nonces", async () => {
  const { chain, feed, ctx, lines } = setup("2000", "150");
  feed.ETH = "2010.5";
  feed.SOL = "151.25";
  const results = await mirrorTick(ctx);
  assert.deepEqual(results.map((r) => [r.symbol, r.decision?.action]), [["ETH", "steer"], ["SOL", "steer"]]);
  assert.ok(results.every((r) => r.hash !== undefined));
  assert.deepEqual(
    chain.sent.map((s) => [s.pool, s.nonce]),
    [[poolId(ETH_KEY), 7], [poolId(SOL_KEY), 8]],
    "the second steer uses the next nonce without asking a possibly lagging RPC again",
  );
  assert.equal(chain.nonceReads, 1);
  assert.equal(chain.sent[0]!.target, sqrtPriceX96FromPrice(parseDecimal("2010.5"), ETH_O));
  assert.equal(chain.sent[1]!.target, sqrtPriceX96FromPrice(parseDecimal("151.25"), SOL_O));
  const steered = lines.filter((l) => l.includes("] steered "));
  assert.match(steered[0]!, /symbol=ETH .*feed=2010.5 pool=2000.00/);
  assert.match(steered[1]!, /symbol=SOL .*feed=151.25 pool=150.00/);

  // Both pools now sit at their feeds: nothing is sent and no nonce is read
  const again = await mirrorTick(ctx);
  assert.deepEqual(again.map((r) => r.decision?.action), ["hold", "hold"]);
  assert.equal(chain.sent.length, 2);
  assert.equal(chain.nonceReads, 1);
});

test("each asset has its own price band and jump guard", async () => {
  const { chain, feed, eth, sol, ctx, lines } = setup("2000", "150");
  // An ETH-sized print is inside ETH's band but far outside SOL's
  feed.ETH = "2000";
  feed.SOL = "2500";
  const [e, s] = await mirrorTick(ctx);
  assert.equal(e!.decision?.action, "hold");
  assert.equal(s!.decision?.action, "reject");
  assert.ok(lines.some((l) => /WARN .*feed price rejected symbol=SOL .*price outside \[5.00, 2000.00\]/.test(l)));

  // A big ETH jump waits for confirmations while SOL keeps steering
  eth.state.lastAccepted = parseDecimal("2000");
  feed.ETH = "3000";
  feed.SOL = "152";
  const [e2, s2] = await mirrorTick(ctx);
  assert.equal(e2!.decision?.action, "reject");
  assert.equal(s2!.decision?.action, "steer");
  assert.equal(eth.state.rejectStreak, 1);
  assert.equal(sol.state.rejectStreak, 0);
  assert.deepEqual(sol.state.lastAccepted, parseDecimal("152"));
  assert.deepEqual(chain.sent.map((x) => [x.pool, x.nonce]), [[poolId(SOL_KEY), 7]]);

  // SOL moving 30% is its own jump, it does not reset ETH's streak
  feed.SOL = "200";
  const [e3, s3] = await mirrorTick(ctx);
  assert.equal(e3!.decision?.action, "reject");
  assert.equal(s3!.decision?.action, "reject");
  assert.equal(eth.state.rejectStreak, 2);
  assert.equal(sol.state.rejectStreak, 1);
});

test("a failing feed or send on one asset does not stop the others", async () => {
  const { chain, feed, ctx, lines } = setup("2000", "150");
  feed.ETH = new Error("all ETH price sources failed (coinbase: timeout)");
  feed.SOL = "151";
  const [e, s] = await mirrorTick(ctx);
  assert.match(e!.error!, /all ETH price sources failed/);
  assert.equal(s!.decision?.action, "steer");
  assert.ok(lines.some((l) => /ERROR .*tick failed symbol=ETH /.test(l)));
  assert.deepEqual(chain.sent.map((x) => x.nonce), [7]);

  // The first send fails before broadcast: the second asks for the pending nonce again
  feed.ETH = "2010";
  feed.SOL = "152";
  chain.sendFails = 1;
  const [e2, s2] = await mirrorTick(ctx);
  assert.match(e2!.error!, /nonce too low/);
  assert.equal(s2!.decision?.action, "steer");
  assert.equal(chain.nonceReads, 3);
  assert.deepEqual(chain.sent.map((x) => [x.pool, x.nonce]), [[poolId(SOL_KEY), 7], [poolId(SOL_KEY), 7]]);
});

test("a dry run decides for every asset and sends nothing", async () => {
  const { chain, feed, ctx, lines } = setup("2000", "150", { dryRun: true });
  feed.ETH = "2100";
  feed.SOL = "140";
  const results = await mirrorTick(ctx);
  assert.deepEqual(results.map((r) => r.decision?.action), ["steer", "steer"]);
  assert.equal(chain.sent.length, 0);
  assert.equal(lines.filter((l) => l.includes("steer (dry run) symbol=")).length, 2);
});

function oracleClient(keys: Record<string, PoolKey | Error>): PublicClient {
  return {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      assert.equal(functionName, "poolKey");
      const k = keys[getAddress(address)];
      if (k === undefined || k instanceof Error) throw k ?? new Error("no code");
      return k;
    },
  } as unknown as PublicClient;
}

test("each target's pool is checked against its own token and oracle", async () => {
  const log = createLogger("test", "error", () => {});
  const sol = { symbol: "SOL", token: SOL, oracle: SOL_ORACLE, key: SOL_KEY, keyExplicit: true };
  assert.deepEqual(await resolveTargetPool(oracleClient({ [SOL_ORACLE]: SOL_KEY }), sol, USDC, log), SOL_KEY);
  // The SOL oracle bound to the ETH pool
  await assert.rejects(resolveTargetPool(oracleClient({ [SOL_ORACLE]: ETH_KEY }), sol, USDC, log), /SOL oracle pool .* is not/);
  // Right tokens, but hooked by another contract
  await assert.rejects(
    resolveTargetPool(oracleClient({ [SOL_ORACLE]: { ...SOL_KEY, hooks: ETH_ORACLE } }), sol, USDC, log),
    /SOL oracle .* is bound to a pool hooked by/,
  );
  // An explicit key (every underlyings entry) must match the oracle's
  await assert.rejects(
    resolveTargetPool(oracleClient({ [SOL_ORACLE]: { ...SOL_KEY, fee: 500 } }), sol, USDC, log),
    /configured SOL pool .* differs from the oracle's/,
  );
  // A default key (the flat single-ETH setup) takes the oracle's
  const bound = { ...SOL_KEY, fee: 500, tickSpacing: 10 };
  assert.deepEqual(await resolveTargetPool(oracleClient({ [SOL_ORACLE]: bound }), { ...sol, keyExplicit: false }, USDC, log), bound);
  // The configured pool must pair the target's token with demoUsdc even when the oracle cannot be read
  await assert.rejects(resolveTargetPool(oracleClient({}), { ...sol, token: WETH }, USDC, log), /SOL pool .* is not/);
  assert.deepEqual(await resolveTargetPool(oracleClient({ [SOL_ORACLE]: new Error("reverted") }), sol, USDC, log), SOL_KEY);
});
