import assert from "node:assert/strict";
import { test } from "node:test";
import { ContractFunctionRevertedError, encodeErrorResult, type Abi, type Address, type PublicClient } from "viem";
import {
  marketGatekeeperAbi,
  marketSchedulerAbi,
  MarketStatus,
  predictionHookAbi,
  predictionHookErrorsAbi,
  sealedPoolOracleAbi,
} from "../src/abi.ts";
import type { Clients } from "../src/chain.ts";
import {
  idsToScan,
  keeperGasLimit,
  isAlreadyOpened,
  isRevert,
  Keeper,
  keeperTick,
  loadTracks,
  nextCreateTime,
  openDeadline,
  targetSlot,
  tooLateSlot,
  type Track,
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
const GATEKEEPER: Address = "0x0000000000000000000000000000000000006a7e";
const S60: Address = "0x00000000000000000000000000000000005cbed";
const S900: Address = "0x00000000000000000000000000000000005cbee";
const T60: Track = { scheduler: S60, ticker: "ETH1M", periodSec: 60, tenorSec: 60, windowSec: 10, cutoffBufferSec: 2 };
const T900: Track = { scheduler: S900, ticker: "ETH15M", periodSec: 900, tenorSec: 900, windowSec: 30, cutoffBufferSec: 2 };
/** A market's own oracle field (IPredictionHook.MarketInfo.oracle); unrelated to the keeper's schedulers. */
const ORACLE: Address = "0x00000000000000000000000000000000000000aa";
const revert = () => new ContractFunctionRevertedError({ abi: predictionHookAbi, functionName: "marketInfo" });

/** A decoded revert of `open()`, `data` encoded with `from` and decoded with the ABI the keeper simulated with */
const openRevert = (abi: Abi, from: Abi, errorName: string, args: readonly unknown[] = []) =>
  new ContractFunctionRevertedError({ abi, functionName: "open", data: encodeErrorResult({ abi: from, errorName, args } as never) });

const alreadyOpened = (slot = 1n) => (abi: Abi) => openRevert(abi, marketSchedulerAbi, "AlreadyOpened", [slot]);
const tooLate = (slot: bigint) => (abi: Abi) => openRevert(abi, marketSchedulerAbi, "TooLate", [slot]);
const insufficientIdle = (abi: Abi) => openRevert(abi, marketSchedulerAbi, "InsufficientIdle", [400_000n, 1_000000n]);
const staleSpot = (abi: Abi) => openRevert(abi, sealedPoolOracleAbi, "StaleSpot", [10n, 15n]);

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
  /** When set, an `open()` simulate throws what it returns for that scheduler, given the simulated ABI */
  openError?: (abi: Abi, scheduler: Address) => Error | undefined;
  /** Timestamps `getBlock` returns in turn, then `chainNow` */
  blockTimes: bigint[];
  chainNow?: bigint;
  /** Every `open()` simulate that was accepted (i.e. did not throw). */
  opens: { scheduler: Address; args: unknown[] }[];
  /** Order of the opens and hook writes simulated, as "open:<scheduler>" or "<function>:<id>" */
  calls: string[];
  /** The market's expiry as `marketInfo` reports it */
  expiry?: bigint;
  /** Gas `estimateContractGas` returns */
  estimate?: bigint;
  /** Function name and gas limit of every transaction sent, when not a dry run */
  sent?: { functionName: string; gas: unknown }[];
  /** What each scheduler's `canOpen()` returns, true when not listed */
  canOpen: Partial<Record<Address, boolean>>;
  /** When set, `sweep` simulates throw this, given the simulated ABI */
  sweepError?: (abi: Abi) => Error;
}

function fakeKeeper(
  f: Fake,
  opts: { dryRun?: boolean; log?: (line: string) => void; tracks?: Track[]; align?: boolean; minTradeSec?: number } = {},
): Keeper {
  const publicClient = {
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
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
      if (functionName === "canOpen") return f.canOpen[address] ?? true;
      throw new Error(`unexpected read ${functionName}`);
    },
    getBlock: async () => ({ timestamp: f.blockTimes.shift() ?? f.chainNow ?? 0n }),
    simulateContract: async ({ address, abi, functionName, args }: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "open") {
        const err = f.openError?.(abi, address);
        if (err) throw err;
        if (f.openFails-- > 0) throw new Error("fetch failed");
        f.opens.push({ scheduler: address, args: [...(args ?? [])] });
        f.calls.push(`open:${address}`);
        return { request: { functionName }, result: f.count + 1n };
      }
      if (functionName === "sweep" && f.sweepError) throw f.sweepError(abi);
      if (f.sent && ["settle", "settleInvalid", "sweep"].includes(functionName)) {
        f.calls.push(`${functionName}:${String(args?.[0])}`);
        return { request: { functionName }, result: undefined };
      }
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
    tracks: opts.tracks ?? [T60],
    alignToPeriod: opts.align ?? false,
    minTradeSec: opts.minTradeSec ?? 5,
    scanBack: 50,
    invalidAfterSec: 3601,
    dryRun: opts.dryRun ?? true,
    txTimeoutMs: 1000,
    log: createLogger("test", opts.log ? "debug" : "error", opts.log ?? (() => {})),
  });
}

const fake = (over: Partial<Fake> = {}): Fake => ({
  count: 0n,
  infoFails: new Map(),
  openFails: 0,
  blockTimes: [],
  opens: [],
  calls: [],
  canOpen: {},
  ...over,
});

const nextAt = (k: Keeper, t: Track = T60) => k.stateOf(t).nextCreateAt;

/** A tick at wall-clock `wall` with the chain's latest block at the same second */
async function tickAt(k: Keeper, f: Fake, wall: number, cfg = { create: true, settle: false }) {
  f.chainNow = BigInt(wall);
  await keeperTick(k, cfg, wall);
}

test("openDeadline is the first second open() reverts TooLate and trading stops", () => {
  assert.equal(openDeadline(T60, 100n), 6048, "slot 6000..6059 with tenor 60 expires at 6060, minus window 10 and buffer 2");
  assert.equal(openDeadline(T900, 7n), 7168, "slot 6300 with tenor 900 expires at 7200, minus window 30 and buffer 2");
});

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

test("a failed creation is logged with its track and retried on the next tick", async () => {
  const lines: string[] = [];
  const f = fake({ openFails: 1 });
  const k = fakeKeeper(f, { log: (l) => lines.push(l) });
  await tickAt(k, f, 1000);
  assert.equal(nextAt(k), 1000, "still due after the failure");
  assert.equal(f.opens.length, 0);
  assert.ok(lines.some((l) => / ERROR .*open failed.*track=ETH1M.*fetch failed/.test(l)), "the error names the track");

  await tickAt(k, f, 1002);
  assert.equal(f.opens.length, 1);
  assert.deepEqual(f.opens[0], { scheduler: S60, args: [] }, "scheduler.open() takes no args");
  assert.equal(nextAt(k), 1062, "next period scheduled once submitted");
});

test("createMarket calls the track's open() with no args, and AlreadyOpened for the targeted slot counts as done", async () => {
  const f = fake({ count: 5n });
  const k = fakeKeeper(f);
  const id = await k.createMarket(T60, 1000n);
  assert.equal(id, 6n);
  assert.deepEqual(f.opens, [{ scheduler: S60, args: [] }]);

  f.openError = alreadyOpened(16n);
  let submitted = false;
  const again = await k.createMarket(T60, 1000n, () => (submitted = true), 1000);
  assert.equal(again, undefined, "nothing to do: the slot is already open");
  assert.equal(f.opens.length, 1, "a second call in the same slot sends nothing");
  assert.equal(submitted, true, "AlreadyOpened(slot 16) at t=1000 counts as submitted, so the caller schedules the next slot");

  f.openError = alreadyOpened(15n);
  submitted = false;
  assert.equal(await k.createMarket(T60, 1000n, () => (submitted = true), 1000), undefined);
  assert.equal(submitted, false, "AlreadyOpened for an earlier slot than t=1000's leaves the create due");
});

test("targetSlot is the later of the wall clock's and the chain's slot", () => {
  assert.equal(targetSlot(5999n, 6000, 60), 100n);
  assert.equal(targetSlot(6125n, 6000, 60), 102n);
  assert.equal(targetSlot(6000n, 5999, 60), 100n);
});

test("an AlreadyOpened for the previous slot leaves the create due, and a later poll in the slot opens the market", async () => {
  const f = fake({ openError: alreadyOpened(99n) });
  const k = fakeKeeper(f);
  const cfg = { create: true, settle: false };
  // Wall clock 6000 starts slot 100, but the RPC's latest block (5999) is still in slot 99
  f.blockTimes.push(5999n);
  await keeperTick(k, cfg, 6000);
  assert.equal(f.opens.length, 0);
  assert.equal(nextAt(k), 6000, "slot 100 is still due");

  f.openError = undefined;
  f.blockTimes.push(6001n);
  await keeperTick(k, cfg, 6002);
  assert.equal(f.opens.length, 1, "the next poll opens slot 100's market");
  assert.equal(nextAt(k), 6062, "and only then is the next period scheduled");
});

test("an AlreadyOpened for the targeted slot or a later one counts as done", async () => {
  const f = fake({ openError: alreadyOpened(100n) });
  const k = fakeKeeper(f);
  const cfg = { create: true, settle: false };
  f.blockTimes.push(6001n);
  await keeperTick(k, cfg, 6000);
  assert.equal(nextAt(k), 6060, "someone else opened slot 100, the next attempt waits for the next period");
  f.blockTimes.push(6003n);
  await keeperTick(k, cfg, 6002);
  assert.equal(f.opens.length, 0, "nothing is simulated again inside the slot");

  // A chain ahead of the wall clock targets the latest block's own slot
  const ahead = fake({ openError: alreadyOpened(102n) });
  const k2 = fakeKeeper(ahead);
  ahead.blockTimes.push(6125n);
  await keeperTick(k2, cfg, 6000);
  assert.equal(nextAt(k2), 6060);
});

test("isAlreadyOpened recognises a decoded AlreadyOpened revert and nothing else", () => {
  assert.equal(isAlreadyOpened(alreadyOpened()(marketSchedulerAbi)), true);
  assert.equal(isAlreadyOpened(revert()), false);
  assert.equal(isAlreadyOpened(new Error("fetch failed")), false);
  assert.equal(tooLateSlot(tooLate(7n)(marketSchedulerAbi)), 7n);
  assert.equal(tooLateSlot(alreadyOpened(7n)(marketSchedulerAbi)), undefined);
});

test("a second tick in the same slot sends nothing", async () => {
  const f = fake();
  const k = fakeKeeper(f);
  await tickAt(k, f, 1000, { create: true, settle: true });
  assert.equal(f.opens.length, 1);
  await tickAt(k, f, 1000, { create: true, settle: true });
  assert.equal(f.opens.length, 1, "isCreateDue is false right after a successful open, so nothing is sent");
});

test("keeperGasLimit pads the estimate by 30% plus 30k, as swap-sdk's gasWithHeadroom does", () => {
  assert.equal(keeperGasLimit(1_670_860n), 2_202_118n);
  assert.equal(keeperGasLimit(100_000n), 160_000n);
});

test("open, settle and sweep are sent with the padded estimate, not viem's bare one", async () => {
  const f = fake({ count: 1n, expiry: 1000n, estimate: 1_670_860n, sent: [] });
  const k = fakeKeeper(f, { dryRun: false });
  await k.createMarket(T60, 2000n, undefined, 2000);
  await k.refresh();
  await k.settleAndSweep(2000n);
  assert.deepEqual(
    f.sent!.map((s) => s.functionName),
    ["open", "settle"],
    "the fake's market stays Trading after settle, so there is nothing to sweep",
  );
  for (const s of f.sent!) assert.equal(s.gas, keeperGasLimit(1_670_860n), `${s.functionName} gas`);
});

test("a refused open() warns once per slot and stays due, hook and gatekeeper reverts are named, a transport error is logged", async () => {
  const lines: string[] = [];
  const f = fake({ openError: insufficientIdle });
  const k = fakeKeeper(f, { log: (l) => lines.push(l) });
  const warns = () => lines.filter((l) => l.includes(" WARN ") && l.includes("open() refused"));
  await tickAt(k, f, 6000);
  assert.equal(warns().length, 1);
  assert.match(warns()[0]!, /track=ETH1M slot=100 .*InsufficientIdle\(400000, 1000000\)/);
  assert.equal(nextAt(k), 6000, "still due");
  for (const t of [6002, 6004, 6030]) await tickAt(k, f, t);
  assert.equal(warns().length, 1, "no repeat inside slot 100");

  f.openError = staleSpot;
  await tickAt(k, f, 6061);
  assert.equal(warns().length, 2, "slot 101 warns again");
  assert.match(warns()[1]!, /StaleSpot/, "an oracle revert through open() is named");

  f.openError = (abi) => openRevert(abi, predictionHookErrorsAbi, "InvalidParams");
  await tickAt(k, f, 6121);
  assert.match(warns()[2]!, /InvalidParams\(\)/, "a hook revert through the gatekeeper hop is named");
  f.openError = (abi) => openRevert(abi, marketGatekeeperAbi, "NotScheduler");
  await tickAt(k, f, 6181);
  assert.match(warns()[3]!, /NotScheduler\(\)/, "a gatekeeper revert is named");

  f.openError = () => new Error("fetch failed");
  await tickAt(k, f, 6183);
  assert.equal(warns().length, 4);
  assert.ok(lines.some((l) => / ERROR .*open failed.*fetch failed/.test(l)));

  f.openError = undefined;
  await tickAt(k, f, 6185);
  assert.equal(f.opens.length, 1, "opens once the scheduler accepts");
});

test("two tracks (60 s and 900 s) keep independent schedules", async () => {
  const f = fake();
  const k = fakeKeeper(f, { tracks: [T60, T900], align: true });
  await tickAt(k, f, 6010);
  assert.deepEqual(f.opens.map((o) => o.scheduler), [S60, S900], "both open at start-up, their slots can still be opened");
  assert.equal(nextAt(k, T60), 6060);
  assert.equal(nextAt(k, T900), 6300);

  await tickAt(k, f, 6060);
  await tickAt(k, f, 6120);
  assert.deepEqual(f.opens.map((o) => o.scheduler), [S60, S900, S60, S60], "only the 1m track opens between quarter hours");
  assert.equal(nextAt(k, T60), 6180);
  assert.equal(nextAt(k, T900), 6300);

  // A refusal on one track leaves the other's schedule alone
  f.openError = (abi, s) => (s === S60 ? insufficientIdle(abi) : undefined);
  await tickAt(k, f, 6180);
  assert.equal(nextAt(k, T60), 6180, "the 1m track stays due");
  assert.equal(nextAt(k, T900), 6300);
  assert.equal(k.msUntilNextCreate(6_180_500, 6180), 119_500, "the refused track retries on the poll, the sleep targets the 15m open");
});

test("at a shared quarter-hour boundary the shorter track opens first, then the longer one, then settle runs", async () => {
  const f = fake({ count: 1n, expiry: 6300n, sent: [] });
  const k = fakeKeeper(f, { tracks: [T900, T60], align: true, dryRun: false });
  assert.deepEqual(k.tracks.map((t) => t.ticker), ["ETH1M", "ETH15M"], "period ascending, whatever the configured order");
  await k.refresh();
  f.calls.length = 0;
  f.canOpen = { [S60]: false, [S900]: false };
  await tickAt(k, f, 6290, { create: true, settle: true });
  assert.equal(f.opens.length, 0, "canOpen() is false, so start-up waits for each track's next slot");
  assert.equal(nextAt(k, T60), 6300);
  assert.equal(nextAt(k, T900), 6300, "6300 = 7 * 900 is also a minute boundary");
  assert.equal(k.msUntilNextCreate(6_290_000, 6290), 10_000);

  f.calls.length = 0;
  await tickAt(k, f, 6300, { create: true, settle: true });
  assert.deepEqual(f.calls, [`open:${S60}`, `open:${S900}`, "settle:1"], "opens first, period ascending, then settle");
  assert.equal(nextAt(k, T60), 6360);
  assert.equal(nextAt(k, T900), 7200);
});

test("TooLate for the targeted slot skips to the next slot and is logged once", async () => {
  const lines: string[] = [];
  const f = fake({ openError: tooLate(6n) });
  const k = fakeKeeper(f, { tracks: [T900], align: true, log: (l) => lines.push(l) });
  // 6010 is in 900 s slot 6 (5400..6299), whose deadline is 6268: a mined block past it reverts TooLate(6)
  f.blockTimes.push(6010n);
  await keeperTick(k, { create: true, settle: false }, 6010);
  assert.equal(nextAt(k, T900), 6300, "slot 7 is next");
  const skips = () => lines.filter((l) => l.includes("slot skipped, past its open deadline"));
  assert.equal(skips().length, 1);
  assert.match(skips()[0]!, / INFO .*track=ETH15M slot=6 .*TooLate\(6\)/);
  assert.equal(lines.filter((l) => l.includes(" WARN ")).length, 0, "an expected skip is not a warning");
  await tickAt(k, f, 6100);
  assert.equal(skips().length, 1, "nothing is simulated again before slot 7");

  // A TooLate for a slot before the targeted one is a lagging RPC, so the create stays due
  f.openError = tooLate(6n);
  f.blockTimes.push(6299n);
  await keeperTick(k, { create: true, settle: false }, 6300);
  assert.equal(nextAt(k, T900), 6300, "slot 7 is still due");
  f.openError = undefined;
  await tickAt(k, f, 6301);
  assert.equal(f.opens.length, 1);
  assert.equal(nextAt(k, T900), 7200);
});

test("an open that would leave less than KEEPER_MIN_TRADE_SEC of trading is skipped without a call", async () => {
  const lines: string[] = [];
  const f = fake();
  const k = fakeKeeper(f, { log: (l) => lines.push(l) });
  await tickAt(k, f, 6044);
  assert.equal(f.opens.length, 0, "slot 100 stops trading at 6048, 4 s < 5 s");
  assert.equal(nextAt(k), 6060);
  assert.ok(lines.some((l) => / INFO .*slot skipped, too little trading time left track=ETH1M slot=100 left=4 minTradeSec=5/.test(l)));

  const eager = fake();
  const k0 = fakeKeeper(eager, { minTradeSec: 0 });
  await tickAt(k0, eager, 6047);
  assert.equal(eager.opens.length, 1, "with 0 the keeper opens up to the last second");
});

test("aligned start-up opens the current slot at once when canOpen(), else waits for the next slot start", async () => {
  const f = fake();
  const k = fakeKeeper(f, { tracks: [T900], align: true });
  await tickAt(k, f, 6010);
  assert.equal(f.opens.length, 1, "no wait until 6300 for a slot that can still be opened");
  assert.equal(nextAt(k, T900), 6300);

  const closed = fake({ canOpen: { [S900]: false } });
  const kc = fakeKeeper(closed, { tracks: [T900], align: true });
  await tickAt(kc, closed, 6010);
  assert.equal(closed.opens.length, 0);
  assert.equal(nextAt(kc, T900), 6300);

  // canOpen() reads the latest block, which may still be in the previous slot at the wall clock's boundary
  const lag = fake({ canOpen: { [S60]: false } });
  const kl = fakeKeeper(lag, { align: true });
  lag.blockTimes.push(5999n, 6001n);
  await keeperTick(kl, { create: true, settle: false }, 6001);
  assert.equal(lag.opens.length, 1, "the chain lags into slot 99, so slot 100 is tried at once");
});

test("the keeper refuses no tracks and a scheduler listed twice", () => {
  assert.throws(() => fakeKeeper(fake(), { tracks: [] }), /at least one track/);
  assert.throws(() => fakeKeeper(fake(), { tracks: [T60, { ...T900, scheduler: S60 }] }), /listed twice/);
});

test("a NotSettled from a stale RPC on sweep is named in the warning", async () => {
  const lines: string[] = [];
  const f = fake({
    sweepError: (abi) =>
      new ContractFunctionRevertedError({ abi, functionName: "sweep", data: encodeErrorResult({ abi: predictionHookErrorsAbi, errorName: "NotSettled" }) }),
  });
  const k = fakeKeeper(f, { log: (l) => lines.push(l) });
  k.tracked.set(3n, { ...info(MarketStatus.Settled), bucket: 5n });
  await k.settleAndSweep(2000n);
  assert.ok(lines.some((l) => / WARN .*market upkeep failed market=3 .*NotSettled\(\)/.test(l)));
});

/* Start-up checks */

const CONFIG = (period: number, ticker: string) => ({
  period,
  tenor: period,
  window: period === 60 ? 10 : 30,
  cutoffBuffer: 2,
  nSamples: period === 60 ? 10 : 30,
  quote: { h0Wad: 0n, gammaSWad: 0n, lambdaWad: 0n, qEpochMax: 1n, pMinWad: 1n },
  maxBudget: 10_000000n,
  minBudget: 1_000000n,
  ticker,
});

/** A public client answering `address:function` reads from `values`, an Error value is thrown */
function reader(values: Record<string, unknown>) {
  return {
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      const v = values[`${address}:${functionName}`];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`unexpected read ${address}:${functionName}`);
      return v;
    },
  } as unknown as PublicClient;
}

const chainState = (): Record<string, unknown> => ({
  [`${HOOK}:owner`]: GATEKEEPER,
  [`${GATEKEEPER}:hook`]: HOOK,
  [`${GATEKEEPER}:schedulers`]: [S60, S900],
  [`${S60}:hook`]: HOOK,
  [`${S60}:gatekeeper`]: GATEKEEPER,
  [`${S60}:config`]: CONFIG(60, "ETH1M"),
  [`${S900}:hook`]: HOOK,
  [`${S900}:gatekeeper`]: GATEKEEPER,
  [`${S900}:config`]: CONFIG(900, "ETH15M"),
});

test("start-up reads every track from its scheduler's config()", async () => {
  const tracks = await loadTracks(reader(chainState()), { hook: HOOK, gatekeeper: GATEKEEPER, schedulers: [S60, S900] });
  assert.deepEqual(tracks, [T60, T900]);
});

test("start-up refuses a failed config() read instead of guessing a period", async () => {
  const s = chainState();
  s[`${S900}:config`] = new Error("HTTP 429");
  await assert.rejects(
    loadTracks(reader(s), { hook: HOOK, gatekeeper: GATEKEEPER, schedulers: [S60, S900] }),
    new RegExp(`scheduler ${S900} config\\(\\) failed: HTTP 429`),
  );
});

test("start-up refuses a hook, gatekeeper or scheduler list that do not point at each other", async () => {
  const run = (patch: Record<string, unknown>, schedulers: Address[] = [S60, S900]) =>
    loadTracks(reader({ ...chainState(), ...patch }), { hook: HOOK, gatekeeper: GATEKEEPER, schedulers });
  await assert.rejects(run({ [`${HOOK}:owner`]: S60 }), /is owned by .*, not by the marketGatekeeper/);
  await assert.rejects(run({ [`${GATEKEEPER}:hook`]: ORACLE }), /serves hook .*, not predictionHook/);
  await assert.rejects(run({}, [S60]), /gatekeeper.schedulers\(\) is \[.*\] but marketSchedulers is/);
  await assert.rejects(run({}, [S900, S60]), /but marketSchedulers is/, "the order must match too");
  await assert.rejects(run({ [`${S60}:gatekeeper`]: ORACLE }), new RegExp(`scheduler ${S60} has gatekeeper`));
  await assert.rejects(run({ [`${S900}:hook`]: ORACLE }), new RegExp(`scheduler ${S900} serves hook`));
  await assert.rejects(run({ [`${HOOK}:owner`]: new Error("fetch failed") }), /hook .* owner\(\) failed: fetch failed/);
});
