import assert from "node:assert/strict";
import { test } from "node:test";
import { ContractFunctionRevertedError, encodeErrorResult, type Abi, type Address } from "viem";
import { marketSchedulerAbi, MarketStatus, predictionHookAbi, sealedPoolOracleAbi } from "../src/abi.ts";
import type { Clients } from "../src/chain.ts";
import {
  idsToScan,
  keeperGasLimit,
  isAlreadyOpened,
  isRevert,
  Keeper,
  keeperTick,
  nextCreateTime,
  schedulerPeriodFor,
  targetSlot,
} from "../src/keeper.ts";
import { createLogger } from "../src/log.ts";
import type { MarketInfo } from "../src/market.ts";
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
const SCHEDULER: Address = "0x00000000000000000000000000000000005cbed";
/** A market's own oracle field (IPredictionHook.MarketInfo.oracle); unrelated to the keeper's scheduler. */
const ORACLE: Address = "0x00000000000000000000000000000000000000aa";
const revert = () => new ContractFunctionRevertedError({ abi: predictionHookAbi, functionName: "marketInfo" });

/** A real decoded AlreadyOpened revert, as the scheduler's `open()` would produce it. */
const alreadyOpened = (slot = 1n) =>
  new ContractFunctionRevertedError({
    abi: marketSchedulerAbi,
    functionName: "open",
    data: encodeErrorResult({ abi: marketSchedulerAbi, errorName: "AlreadyOpened", args: [slot] }),
  });

/** A decoded InsufficientIdle revert, the scheduler refusing a vault too small for its minimum budget */
const insufficientIdle = () =>
  new ContractFunctionRevertedError({
    abi: marketSchedulerAbi,
    functionName: "open",
    data: encodeErrorResult({ abi: marketSchedulerAbi, errorName: "InsufficientIdle", args: [400_000n, 1_000000n] }),
  });

/** The sealed oracle's StaleSpot bubbling up through `open()`, decoded with the ABI the keeper simulates with */
const staleSpot = (abi: Abi) =>
  new ContractFunctionRevertedError({
    abi,
    functionName: "open",
    data: encodeErrorResult({ abi: sealedPoolOracleAbi, errorName: "StaleSpot", args: [10n, 15n] }),
  });

function info(status: number, expiry = 10n ** 12n): MarketInfo {
  return {
    yes: HOOK,
    no: HOOK,
    oracle: ORACLE,
    lnStrikeWad: 0n,
    openTime: 0n,
    expiry,
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
  /** Generic (non-revert) failures `open()`'s simulate should throw before it succeeds, e.g. an RPC error. */
  openFails: number;
  /** When set, every `open()` simulate throws this, given the simulated ABI, instead of succeeding */
  openError?: (abi: Abi) => Error;
  blockTimes: bigint[];
  /** Args recorded on each `open()` simulate that was accepted (i.e. did not throw). */
  opens: unknown[][];
  /** The market's expiry as `marketInfo` reports it */
  expiry?: bigint;
  /** Gas `estimateContractGas` returns */
  estimate?: bigint;
  /** Function name and gas limit of every transaction sent, when not a dry run */
  sent?: { functionName: string; gas: unknown }[];
  /** The scheduler's `config().period`, or a read that reverts when undefined */
  schedulerPeriod?: number;
}

function fakeKeeper(f: Fake, opts: { dryRun?: boolean; log?: (line: string) => void } = {}): Keeper {
  const publicClient = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "marketCount") return f.count;
      if (functionName === "marketInfo") {
        const id = args![0] as bigint;
        const fails = f.infoFails.get(id) ?? 0;
        if (fails > 0) {
          f.infoFails.set(id, fails - 1);
          throw new Error("HTTP 429");
        }
        if (id === 0n || id > f.count) throw revert();
        return info(MarketStatus.Trading, f.expiry);
      }
      if (functionName === "config") {
        if (f.schedulerPeriod === undefined) throw revert();
        return { period: f.schedulerPeriod };
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    getBlock: async () => ({ timestamp: f.blockTimes.shift() ?? 0n }),
    simulateContract: async ({ abi, functionName, args }: { abi: Abi; functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "open") {
        if (f.openError) throw f.openError(abi);
        if (f.openFails-- > 0) throw new Error("fetch failed");
        f.opens.push([...(args ?? [])]);
        return { request: { functionName }, result: f.count + 1n };
      }
      if (f.sent && ["settle", "settleInvalid", "sweep"].includes(functionName)) return { request: { functionName }, result: undefined };
      throw new Error(`unexpected write ${functionName}`);
    },
    estimateContractGas: async () => f.estimate ?? 100_000n,
    waitForTransactionReceipt: async () => ({ status: "success", logs: [], blockNumber: 1n }),
  };
  const walletClient = {
    writeContract: async (req: { functionName: string; gas?: bigint }) => {
      f.sent?.push({ functionName: req.functionName, gas: req.gas });
      return `0x${"11".repeat(32)}`;
    },
  };
  return new Keeper({
    clients: { publicClient, walletClient } as unknown as Clients,
    hook: HOOK,
    scheduler: SCHEDULER,
    periodSec: 60,
    alignToPeriod: false,
    scanBack: 50,
    invalidAfterSec: 3601,
    dryRun: opts.dryRun ?? true,
    txTimeoutMs: 1000,
    log: createLogger("test", opts.log ? "debug" : "error", opts.log ?? (() => {})),
  });
}

const fake = (over: Partial<Fake> = {}): Fake => ({ count: 0n, infoFails: new Map(), openFails: 0, blockTimes: [], opens: [], ...over });

test("isRevert tells contract reverts from transport errors", () => {
  assert.equal(isRevert(revert()), true);
  assert.equal(isRevert(new Error("fetch failed")), false);
});

test("a market whose read failed is retried after marketCount has moved on", async () => {
  const f = fake({ count: 3n, infoFails: new Map([[2n, 2]]) });
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
  const f = fake({ openFails: 1 });
  const k = fakeKeeper(f);
  f.blockTimes.push(1000n, 1001n);
  await assert.rejects(keeperTick(k, { create: true, settle: true }), /fetch failed/);
  const due = k.nextCreateAt;
  assert.ok(due !== undefined && due <= Math.floor(Date.now() / 1000), "still due after the failure");
  assert.equal(f.opens.length, 0);

  f.blockTimes.push(2000n, 2007n);
  await keeperTick(k, { create: true, settle: true });
  assert.equal(f.opens.length, 1);
  assert.deepEqual(f.opens[0], [], "scheduler.open() takes no args");
  assert.ok(k.nextCreateAt! > due!, "next period scheduled once submitted");
});

test("createMarket calls scheduler.open with no args, and AlreadyOpened for the targeted slot counts as done", async () => {
  const f = fake({ count: 5n });
  const k = fakeKeeper(f);
  const id = await k.createMarket(1000n);
  assert.equal(id, 6n);
  assert.equal(f.opens.length, 1);
  assert.deepEqual(f.opens[0], []);

  f.openError = () => alreadyOpened(16n);
  let submitted = false;
  const again = await k.createMarket(1000n, () => (submitted = true), 1000);
  assert.equal(again, undefined, "nothing to do: the slot is already open");
  assert.equal(f.opens.length, 1, "a second call in the same slot sends nothing");
  assert.equal(submitted, true, "AlreadyOpened(slot 16) at t=1000 counts as submitted, so the caller schedules the next slot");

  f.openError = () => alreadyOpened(15n);
  submitted = false;
  assert.equal(await k.createMarket(1000n, () => (submitted = true), 1000), undefined);
  assert.equal(submitted, false, "AlreadyOpened for an earlier slot than t=1000's leaves the create due");
});

test("targetSlot is the later of the wall clock's and the chain's slot", () => {
  assert.equal(targetSlot(5999n, 6000, 60), 100n);
  assert.equal(targetSlot(6125n, 6000, 60), 102n);
  assert.equal(targetSlot(6000n, 5999, 60), 100n);
});

test("an AlreadyOpened for the previous slot leaves the create due, and a later poll in the slot opens the market", async () => {
  const f = fake({ openError: () => alreadyOpened(99n) });
  const k = fakeKeeper(f);
  const cfg = { create: true, settle: false };
  // Wall clock 6000 starts slot 100, but the RPC's latest block (5999) is still in slot 99
  f.blockTimes.push(5999n);
  await keeperTick(k, cfg, 6000);
  assert.equal(f.opens.length, 0);
  assert.equal(k.nextCreateAt, 6000, "slot 100 is still due");

  f.openError = undefined;
  f.blockTimes.push(6001n);
  await keeperTick(k, cfg, 6002);
  assert.equal(f.opens.length, 1, "the next poll opens slot 100's market");
  assert.equal(k.nextCreateAt, 6062, "and only then is the next period scheduled");
});

test("an AlreadyOpened for the targeted slot or a later one counts as done", async () => {
  const f = fake({ openError: () => alreadyOpened(100n) });
  const k = fakeKeeper(f);
  const cfg = { create: true, settle: false };
  f.blockTimes.push(6001n);
  await keeperTick(k, cfg, 6000);
  assert.equal(k.nextCreateAt, 6060, "someone else opened slot 100, the next attempt waits for the next period");
  f.blockTimes.push(6003n);
  await keeperTick(k, cfg, 6002);
  assert.equal(f.opens.length, 0, "nothing is simulated again inside the slot");

  // A chain ahead of the wall clock targets the latest block's own slot
  const ahead = fake({ openError: () => alreadyOpened(102n) });
  const k2 = fakeKeeper(ahead);
  ahead.blockTimes.push(6125n);
  await keeperTick(k2, cfg, 6000);
  assert.equal(k2.nextCreateAt, 6060);
});

test("isAlreadyOpened recognises a decoded AlreadyOpened revert and nothing else", () => {
  assert.equal(isAlreadyOpened(alreadyOpened()), true);
  assert.equal(isAlreadyOpened(revert()), false);
  assert.equal(isAlreadyOpened(new Error("fetch failed")), false);
});

test("a second tick in the same slot sends nothing", async () => {
  const f = fake();
  const k = fakeKeeper(f);
  f.blockTimes.push(1000n, 1000n);
  await keeperTick(k, { create: true, settle: true });
  assert.equal(f.opens.length, 1);
  f.blockTimes.push(1000n, 1000n);
  await keeperTick(k, { create: true, settle: true });
  assert.equal(f.opens.length, 1, "isCreateDue is false right after a successful open, so nothing is sent");
});

test("schedulerPeriodFor reads the scheduler's own period, else keeps the configured one", async () => {
  const k = fakeKeeper(fake({ schedulerPeriod: 30 }));
  assert.equal(await schedulerPeriodFor(k.opts.clients.publicClient, SCHEDULER, 60), 30);
  const old = fakeKeeper(fake());
  assert.equal(await schedulerPeriodFor(old.opts.clients.publicClient, SCHEDULER, 60), 60);
});

test("keeperGasLimit pads the estimate by 30% plus 30k, as swap-sdk's gasWithHeadroom does", () => {
  assert.equal(keeperGasLimit(1_670_860n), 2_202_118n);
  assert.equal(keeperGasLimit(100_000n), 160_000n);
});

test("open, settle and sweep are sent with the padded estimate, not viem's bare one", async () => {
  const f = fake({ count: 1n, expiry: 1000n, estimate: 1_670_860n, sent: [] });
  const k = fakeKeeper(f, { dryRun: false });
  await k.createMarket(2000n, undefined, 2000);
  await k.refresh();
  await k.settleAndSweep(2000n);
  assert.deepEqual(
    f.sent!.map((s) => s.functionName),
    ["open", "settle"],
    "the fake's market stays Trading after settle, so there is nothing to sweep",
  );
  for (const s of f.sent!) assert.equal(s.gas, keeperGasLimit(1_670_860n), `${s.functionName} gas`);
});

test("a refused open() warns once per slot and stays due, a transport error still throws", async () => {
  const lines: string[] = [];
  const f = fake({ openError: insufficientIdle });
  const k = fakeKeeper(f, { log: (l) => lines.push(l) });
  const cfg = { create: true, settle: false };
  const warns = () => lines.filter((l) => l.includes(" WARN ") && l.includes("open() refused"));
  f.blockTimes.push(6000n);
  await keeperTick(k, cfg, 6000);
  assert.equal(warns().length, 1);
  assert.match(warns()[0]!, /InsufficientIdle/);
  assert.match(warns()[0]!, /slot=100/);
  assert.equal(k.nextCreateAt, 6000, "still due");
  for (const t of [6002, 6004, 6030]) {
    f.blockTimes.push(BigInt(t));
    await keeperTick(k, cfg, t);
  }
  assert.equal(warns().length, 1, "no repeat inside slot 100");

  f.openError = staleSpot;
  f.blockTimes.push(6061n);
  await keeperTick(k, cfg, 6061);
  assert.equal(warns().length, 2, "slot 101 warns again");
  assert.match(warns()[1]!, /StaleSpot/, "an oracle revert through open() is named");

  f.openError = () => new Error("fetch failed");
  f.blockTimes.push(6063n);
  await assert.rejects(keeperTick(k, cfg, 6063), /fetch failed/);
  assert.equal(warns().length, 2);

  f.openError = undefined;
  f.blockTimes.push(6065n);
  await keeperTick(k, cfg, 6065);
  assert.equal(f.opens.length, 1, "opens once the scheduler accepts");
});
