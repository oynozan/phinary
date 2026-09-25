import assert from "node:assert/strict";
import { test } from "node:test";
import { ContractFunctionRevertedError, type Address } from "viem";
import { MarketStatus, predictionHookAbi } from "../src/abi.ts";
import type { Clients } from "../src/chain.ts";
import { loadMarketTemplate } from "../src/config.ts";
import { idsToScan, isRevert, Keeper, keeperTick, nextCreateTime } from "../src/keeper.ts";
import { createLogger } from "../src/log.ts";
import type { MarketInfo, MarketParams } from "../src/market.ts";
import { lnWad } from "../src/math.ts";
import {
  decideSteer,
  JUMP_CONFIRMATIONS,
  relativeBps,
  steerGasLimit,
  type Guard,
  type GuardState,
} from "../src/mirror.ts";
import { sqrtPriceX96FromPrice, type Orientation } from "../src/pricing.ts";

const O: Orientation = { baseIsToken0: false, baseDecimals: 18, quoteDecimals: 6 };
const G: Guard = { thresholdBps: 2, maxJumpBps: 1000, minPrice: { num: 100n, den: 1n }, maxPrice: { num: 100000n, den: 1n } };
const px = (cents: bigint) => ({ num: cents, den: 100n });

test("relativeBps", () => {
  assert.equal(relativeBps(px(200200n), px(200000n)), 10);
  assert.equal(relativeBps(px(200000n), px(200200n)), 9.99);
});

test("decideSteer holds inside the threshold and steers outside it", () => {
  const state: GuardState = { rejectStreak: 0 };
  const current = sqrtPriceX96FromPrice(px(200000n), O);
  const hold = decideSteer(px(200030n), current, O, G, state);
  assert.equal(hold.action, "hold");
  const steer = decideSteer(px(200100n), current, O, G, state);
  assert.equal(steer.action, "steer");
  if (steer.action !== "steer") return;
  assert.equal(steer.target, sqrtPriceX96FromPrice(px(200100n), O));
  assert.ok(Math.abs(steer.deviationBps - 5) < 0.01);
  assert.deepEqual(state.lastAccepted, px(200100n));
});

test("decideSteer holds when already exactly at target even with a zero threshold", () => {
  const current = sqrtPriceX96FromPrice(px(200000n), O);
  const d = decideSteer(px(200000n), current, O, { ...G, thresholdBps: 0 }, { rejectStreak: 0 });
  assert.equal(d.action, "hold");
});

test("decideSteer rejects prices outside the sanity band", () => {
  const current = sqrtPriceX96FromPrice(px(200000n), O);
  assert.equal(decideSteer(px(5000n), current, O, G, { rejectStreak: 0 }).action, "reject");
  assert.equal(decideSteer(px(20000000n), current, O, G, { rejectStreak: 0 }).action, "reject");
});

test("a large jump needs confirmations before it is accepted", () => {
  const current = sqrtPriceX96FromPrice(px(200000n), O);
  const state: GuardState = { rejectStreak: 0, lastAccepted: px(200000n) };
  for (let i = 1; i < JUMP_CONFIRMATIONS; i++) {
    assert.equal(decideSteer(px(300000n), current, O, G, state).action, "reject");
  }
  assert.equal(decideSteer(px(300000n), current, O, G, state).action, "steer");
  assert.equal(state.rejectStreak, 0);
  assert.deepEqual(state.lastAccepted, px(300000n));
});

test("a single bad print is dropped and the streak resets on a normal reading", () => {
  const current = sqrtPriceX96FromPrice(px(200000n), O);
  const state: GuardState = { rejectStreak: 0, lastAccepted: px(200000n) };
  assert.equal(decideSteer(px(20000n * 100n), current, O, G, state).action, "reject");
  assert.equal(decideSteer(px(200010n), current, O, G, state).action, "hold");
  assert.equal(state.rejectStreak, 0);
});

test("nextCreateTime aligns to the period when asked", () => {
  assert.equal(nextCreateTime(1000, 60, false, true), 1000);
  assert.equal(nextCreateTime(1000, 60, false, false), 1060);
  assert.equal(nextCreateTime(1020, 60, true, true), 1020);
  assert.equal(nextCreateTime(1021, 60, true, true), 1080);
  assert.equal(nextCreateTime(1020, 60, true, false), 1080);
  assert.equal(nextCreateTime(1079, 60, true, false), 1080);
});

test("idsToScan covers 0- and 1-based ids", () => {
  assert.deepEqual(idsToScan(undefined, 3n, 50), [0n, 1n, 2n, 3n]);
  assert.deepEqual(idsToScan(undefined, 100n, 2), [98n, 99n, 100n]);
  assert.deepEqual(idsToScan(3n, 5n, 50), [3n, 4n, 5n]);
  assert.deepEqual(idsToScan(undefined, 0n, 50), [0n]);
});

test("steer gas padding covers the oracle's first-write-in-block cost", () => {
  // Measured through UnderlyingOracleHook (test/demo/PriceSteererHooked.t.sol): 122k later in a block, 193k first
  assert.ok(steerGasLimit(122_000n) >= 193_000n);
  assert.equal(steerGasLimit(100_000n), 230_000n);
});

const HOOK: Address = "0x00000000000000000000000000000000000000cc";
const ORACLE: Address = "0x00000000000000000000000000000000000000aa";
const revert = () => new ContractFunctionRevertedError({ abi: predictionHookAbi, functionName: "marketInfo" });

function info(status: number): MarketInfo {
  return {
    yes: HOOK,
    no: HOOK,
    oracle: ORACLE,
    lnStrikeWad: 0n,
    openTime: 0n,
    expiry: 10n ** 12n,
    window: 10,
    cutoffBuffer: 2,
    status,
    yesWon: false,
    bucket: 0n,
    outYes: 0n,
    outNo: 0n,
    invYes: 0n,
    invNo: 0n,
  };
}

interface Fake {
  count: bigint;
  infoFails: Map<bigint, number>;
  lnSpotFails: number;
  blockTimes: bigint[];
  created: MarketParams[];
}

function fakeKeeper(f: Fake): Keeper {
  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "marketCount") return f.count;
      if (functionName === "vaultIdle") return 10n ** 12n;
      if (functionName === "lnSpotSoBWad") {
        if (f.lnSpotFails-- > 0) throw new Error("fetch failed");
        return lnWad({ num: 270135n, den: 100n });
      }
      if (functionName === "varianceE36") throw new Error("not needed");
      if (functionName === "marketInfo") {
        const id = args![0] as bigint;
        const fails = f.infoFails.get(id) ?? 0;
        if (fails > 0) {
          f.infoFails.set(id, fails - 1);
          throw new Error("HTTP 429");
        }
        if (id === 0n || id > f.count) throw revert();
        return info(MarketStatus.Trading);
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    getBlock: async () => ({ timestamp: f.blockTimes.shift() ?? 0n }),
    simulateContract: async ({ args }: { args: readonly [MarketParams] }) => {
      f.created.push(args[0]);
      return { request: {}, result: f.count + 1n };
    },
  };
  return new Keeper({
    clients: { publicClient } as unknown as Clients,
    hook: HOOK,
    oracle: ORACLE,
    template: loadMarketTemplate({}),
    periodSec: 60,
    alignToPeriod: false,
    scanBack: 50,
    invalidAfterSec: 3601,
    dryRun: true,
    txTimeoutMs: 1000,
    log: createLogger("test", "error", () => {}),
  });
}

test("isRevert tells contract reverts from transport errors", () => {
  assert.equal(isRevert(revert()), true);
  assert.equal(isRevert(new Error("fetch failed")), false);
});

test("a market whose read failed is retried after marketCount has moved on", async () => {
  const f: Fake = { count: 3n, infoFails: new Map([[2n, 2]]), lnSpotFails: 0, blockTimes: [], created: [] };
  const k = fakeKeeper(f);
  await k.refresh();
  assert.deepEqual([...k.tracked.keys()].sort(), [1n, 3n]);
  assert.deepEqual([...k.pending], [2n]);
  f.count = 5n;
  await k.refresh();
  assert.deepEqual([...k.tracked.keys()].sort(), [1n, 3n, 4n, 5n]);
  assert.deepEqual([...k.pending], [2n], "still failing");
  await k.refresh();
  assert.deepEqual([...k.tracked.keys()].sort(), [1n, 2n, 3n, 4n, 5n]);
  assert.equal(k.pending.size, 0);
  assert.equal(k.done.has(0n), false, "a reverting id is neither tracked nor pending");
});

test("a failed creation is retried on the next tick with a fresh block time", async () => {
  const f: Fake = { count: 0n, infoFails: new Map(), lnSpotFails: 1, blockTimes: [], created: [] };
  const k = fakeKeeper(f);
  f.blockTimes.push(1000n, 1001n);
  await assert.rejects(keeperTick(k, { create: true, settle: true }), /fetch failed/);
  const due = k.nextCreateAt;
  assert.ok(due !== undefined && due <= Math.floor(Date.now() / 1000), "still due after the failure");
  assert.equal(f.created.length, 0);

  f.blockTimes.push(2000n, 2007n);
  await keeperTick(k, { create: true, settle: true });
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0]!.openTime, 2007n, "openTime from the block read right before createMarket");
  assert.ok(k.nextCreateAt! > due!, "next period scheduled once submitted");
});
