import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  type Abi,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import {
  marketGatekeeperAbi,
  marketSchedulerAbi,
  MarketStatus,
  predictionHookAbi,
  predictionHookAdminAbi,
  predictionHookErrorsAbi,
  sealedPoolOracleAbi,
} from "./abi.ts";
import { assertChainId, makeClients, shutdownSignal, sleep, waitForSuccess, type Clients } from "./chain.ts";
import { loadEnvFiles, loadKeeperConfig, requireAddress, requireSchedulers, USDC_DECIMALS, type KeeperConfig } from "./config.ts";
import { createLogger, errMsg, type Logger } from "./log.ts";
import { isSettleDue, sweepableAmount, type MarketInfo } from "./market.ts";
import { formatRational } from "./math.ts";

/** One MarketScheduler of the gatekeeper, with the timing its `config()` reported on start-up */
export interface Track {
  scheduler: Address;
  ticker: string;
  periodSec: number;
  tenorSec: number;
  windowSec: number;
  cutoffBufferSec: number;
}

export interface TrackState {
  /** Wall-clock second from which the next `open()` is due, undefined until the track's first tick */
  nextCreateAt?: number;
  /** Slot of the last refused `open()` logged, so a refusal warns once per slot */
  refusedSlot?: bigint;
  /** Slot of the last skip logged, a TooLate or too little trading time left */
  skippedSlot?: bigint;
}

export interface KeeperOptions {
  clients: Clients;
  hook: Address;
  /** The gatekeeper that owns `hook`, used only to name the track of markets the keeper did not open itself */
  gatekeeper?: Address;
  tracks: Track[];
  alignToPeriod: boolean;
  /** A slot with fewer seconds of trading left than this is skipped rather than opened */
  minTradeSec: number;
  scanBack: number;
  invalidAfterSec: number;
  dryRun: boolean;
  txTimeoutMs: number;
  log: Logger;
  /** Caller for simulations when there is no account (a dry run without a key). */
  sender?: Address;
}

type HookWrite = { functionName: "settle" | "settleInvalid" | "sweep"; args: readonly [bigint] };

const errorsOf = (abi: Abi) => abi.filter((x) => x.type === "error");

/** With the gatekeeper's, the hook's and the sealed oracle's errors, so a revert anywhere inside `open()` decodes by name */
const openAbi = [
  ...marketSchedulerAbi,
  ...errorsOf(marketGatekeeperAbi),
  ...predictionHookErrorsAbi,
  ...errorsOf(sealedPoolOracleAbi),
] as Abi;

const hookWriteAbi = [...predictionHookAbi, ...predictionHookErrorsAbi] as Abi;

/** First wall-clock second at which the next market should be created. */
export function nextCreateTime(nowSec: number, periodSec: number, align: boolean, first: boolean): number {
  if (!align) return first ? nowSec : nowSec + periodSec;
  const floor = Math.floor(nowSec / periodSec) * periodSec;
  return first && floor === nowSec ? nowSec : floor + periodSec;
}

/** First second at which `open()` for `slot` reverts TooLate, which is also when its market stops trading */
export function openDeadline(track: Track, slot: bigint): number {
  return Number(slot) * track.periodSec + track.tenorSec - track.windowSec - track.cutoffBufferSec;
}

/** swap-sdk's `gasWithHeadroom`, as the oracle's start-of-block read can cost more in the block than at estimate */
export function keeperGasLimit(estimate: bigint): bigint {
  return (estimate * 13n) / 10n + 30_000n;
}

/** Market ids to (re)read after marketCount moved from `last` to `count`; covers 0- and 1-based ids. */
export function idsToScan(last: bigint | undefined, count: bigint, scanBack: number): bigint[] {
  const from = last ?? (count > BigInt(scanBack) ? count - BigInt(scanBack) : 0n);
  const ids: bigint[] = [];
  for (let id = from; id <= count; id++) ids.push(id);
  return ids;
}

function revertOf(e: unknown): ContractFunctionRevertedError | null {
  if (!(e instanceof BaseError)) return null;
  return e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
}

/** True when the call reached the contract and reverted (as opposed to an RPC or transport failure). */
export function isRevert(e: unknown): boolean {
  return revertOf(e) !== null;
}

function revertSlot(e: unknown, errorName: "AlreadyOpened" | "TooLate"): bigint | undefined {
  const r = revertOf(e);
  if (r?.data?.errorName !== errorName) return undefined;
  const [slot] = r.data.args ?? [];
  return typeof slot === "bigint" ? slot : undefined;
}

/** The slot of a simulated `open()` that reverted AlreadyOpened, or undefined for any other failure */
export function alreadyOpenedSlot(e: unknown): bigint | undefined {
  return revertSlot(e, "AlreadyOpened");
}

/** The slot of a simulated `open()` that reverted TooLate, or undefined for any other failure */
export function tooLateSlot(e: unknown): bigint | undefined {
  return revertSlot(e, "TooLate");
}

/** True when a simulated `open()` reverted because its slot is already open */
export function isAlreadyOpened(e: unknown): boolean {
  return alreadyOpenedSlot(e) !== undefined;
}

/** A revert's decoded error and args, its selector when undecoded, else the error's short message */
export function revertText(e: unknown): string {
  const r = revertOf(e);
  if (r?.data) return `${r.data.errorName}(${(r.data.args ?? []).map(String).join(", ")})`;
  return r?.signature ?? r?.reason ?? errMsg(e);
}

/** The slot a create due at `wallSec` targets, the later of the wall clock's and the latest block's */
export function targetSlot(chainNow: bigint, wallSec: number, periodSec: number): bigint {
  const now = BigInt(wallSec) > chainNow ? BigInt(wallSec) : chainNow;
  return now / BigInt(periodSec);
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function mustRead<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw new Error(`${what} failed: ${errMsg(e)}`);
  }
}

/** Every scheduler's config, after checking hook, gatekeeper and schedulers point at each other; any failed read throws */
export async function loadTracks(
  publicClient: PublicClient,
  a: { hook: Address; gatekeeper: Address; schedulers: readonly Address[] },
): Promise<Track[]> {
  const [owner, gatekeeperHook, listed] = await Promise.all([
    mustRead(`hook ${a.hook} owner()`, () =>
      publicClient.readContract({ address: a.hook, abi: predictionHookAdminAbi, functionName: "owner" }),
    ),
    mustRead(`gatekeeper ${a.gatekeeper} hook()`, () =>
      publicClient.readContract({ address: a.gatekeeper, abi: marketGatekeeperAbi, functionName: "hook" }),
    ),
    mustRead(`gatekeeper ${a.gatekeeper} schedulers()`, () =>
      publicClient.readContract({ address: a.gatekeeper, abi: marketGatekeeperAbi, functionName: "schedulers" }),
    ),
  ]);
  if (!sameAddress(owner, a.gatekeeper)) {
    throw new Error(`hook ${a.hook} is owned by ${owner}, not by the marketGatekeeper ${a.gatekeeper}`);
  }
  if (!sameAddress(gatekeeperHook, a.hook)) {
    throw new Error(`gatekeeper ${a.gatekeeper} serves hook ${gatekeeperHook}, not predictionHook ${a.hook}`);
  }
  if (listed.length !== a.schedulers.length || listed.some((s, i) => !sameAddress(s, a.schedulers[i]!))) {
    throw new Error(`gatekeeper.schedulers() is [${listed.join(", ")}] but marketSchedulers is [${a.schedulers.join(", ")}]`);
  }
  return Promise.all(
    a.schedulers.map(async (scheduler) => {
      const at = `scheduler ${scheduler}`;
      const call = <F extends "hook" | "gatekeeper">(functionName: F) =>
        mustRead(`${at} ${functionName}()`, () => publicClient.readContract({ address: scheduler, abi: marketSchedulerAbi, functionName }));
      const [hook, gatekeeper, c] = await Promise.all([
        call("hook"),
        call("gatekeeper"),
        mustRead(`${at} config()`, () => publicClient.readContract({ address: scheduler, abi: marketSchedulerAbi, functionName: "config" })),
      ]);
      if (!sameAddress(hook as Address, a.hook)) throw new Error(`${at} serves hook ${hook}, not predictionHook ${a.hook}`);
      if (!sameAddress(gatekeeper as Address, a.gatekeeper)) throw new Error(`${at} has gatekeeper ${gatekeeper}, not ${a.gatekeeper}`);
      return {
        scheduler,
        ticker: c.ticker,
        periodSec: c.period,
        tenorSec: c.tenor,
        windowSec: c.window,
        cutoffBufferSec: c.cutoffBuffer,
      };
    }),
  );
}

/** Seconds after expiry from which settleInvalid can succeed: past the hook's GRACE, and at least `configured`. */
export async function invalidAfterFor(publicClient: PublicClient, hook: Address, configured: number): Promise<number> {
  try {
    const grace = await publicClient.readContract({ address: hook, abi: predictionHookAdminAbi, functionName: "GRACE" });
    return Math.max(configured, Number(grace) + 1);
  } catch {
    return configured;
  }
}

function usdc(amount: bigint): string {
  return formatRational({ num: amount, den: 10n ** BigInt(USDC_DECIMALS) }, 2);
}

export class Keeper {
  readonly opts: KeeperOptions;
  /** Period ascending, the order in which due tracks are opened */
  readonly tracks: readonly Track[];
  readonly schedule = new Map<Address, TrackState>();
  readonly tracked = new Map<bigint, MarketInfo>();
  readonly done = new Set<bigint>();
  /** Ids whose last read failed for a reason other than a revert; rescanned on every refresh. */
  readonly pending = new Set<bigint>();
  /** Ticker of the track that opened each tracked market, when known */
  readonly trackOf = new Map<bigint, string>();
  lastCount: bigint | undefined;

  constructor(opts: KeeperOptions) {
    if (opts.tracks.length === 0) throw new Error("the keeper needs at least one track");
    this.opts = opts;
    this.tracks = [...opts.tracks].sort((x, y) => x.periodSec - y.periodSec);
    for (const t of this.tracks) {
      if (this.schedule.has(t.scheduler)) throw new Error(`scheduler ${t.scheduler} is listed twice`);
      this.schedule.set(t.scheduler, {});
    }
  }

  stateOf(track: Track): TrackState {
    return this.schedule.get(track.scheduler)!;
  }

  /** Market info, or undefined if the hook reverts (no such market). RPC failures throw. */
  async fetchInfo(id: bigint): Promise<MarketInfo | undefined> {
    try {
      return await this.opts.clients.publicClient.readContract({
        address: this.opts.hook,
        abi: predictionHookAbi,
        functionName: "marketInfo",
        args: [id],
      });
    } catch (e) {
      if (isRevert(e)) return undefined;
      throw e;
    }
  }

  async readInfo(id: bigint): Promise<MarketInfo | undefined> {
    return this.fetchInfo(id).catch(() => undefined);
  }

  private async send(
    address: Address,
    abi: Abi,
    call: { functionName: string; args: readonly unknown[] },
    onSubmitted?: () => void,
  ): Promise<{ result: unknown; hash?: Hash; receipt?: TransactionReceipt }> {
    const { publicClient, walletClient, account } = this.opts.clients;
    const { request, result } = await publicClient.simulateContract({
      address,
      abi,
      ...call,
      account: account ?? this.opts.sender,
    } as Parameters<typeof publicClient.simulateContract>[0]);
    if (this.opts.dryRun || !walletClient) {
      onSubmitted?.();
      return { result };
    }
    const gas = keeperGasLimit(await publicClient.estimateContractGas(request as Parameters<typeof publicClient.estimateContractGas>[0]));
    const hash = await walletClient.writeContract({ ...request, gas } as Parameters<typeof walletClient.writeContract>[0]);
    onSubmitted?.();
    const receipt = await waitForSuccess(publicClient, hash, this.opts.txTimeoutMs);
    return { result, hash, receipt };
  }

  private write(call: HookWrite, onSubmitted?: () => void) {
    return this.send(this.opts.hook, hookWriteAbi, call, onSubmitted);
  }

  /** Picks up markets created since the last call (or the last `scanBack` on startup), plus reads that failed. */
  async refresh(): Promise<void> {
    const count = await this.opts.clients.publicClient.readContract({
      address: this.opts.hook,
      abi: predictionHookAbi,
      functionName: "marketCount",
    });
    const ids = [...new Set([...this.pending, ...idsToScan(this.lastCount, count, this.opts.scanBack)])].filter(
      (id) => !this.tracked.has(id) && !this.done.has(id),
    );
    const reads = await Promise.allSettled(ids.map((id) => this.fetchInfo(id)));
    const added: bigint[] = [];
    reads.forEach((r, i) => {
      const id = ids[i]!;
      if (r.status === "rejected") {
        if (!this.pending.has(id)) this.opts.log.warn("market read failed, will retry", { market: id, error: errMsg(r.reason) });
        this.pending.add(id);
        return;
      }
      this.pending.delete(id);
      const info = r.value;
      if (!info || info.status === MarketStatus.None) return;
      if (info.status === MarketStatus.Trading || sweepableAmount(info) > 0n) {
        this.tracked.set(id, info);
        added.push(id);
      } else this.done.add(id);
    });
    this.lastCount = count;
    await this.nameTracks(added);
  }

  /** Best effort, a failed `schedulerOf` read only leaves the market's track out of the logs */
  private async nameTracks(ids: bigint[]): Promise<void> {
    const { gatekeeper } = this.opts;
    const unnamed = ids.filter((id) => !this.trackOf.has(id));
    if (!gatekeeper || unnamed.length === 0) return;
    const reads = await Promise.allSettled(
      unnamed.map((id) =>
        this.opts.clients.publicClient.readContract({ address: gatekeeper, abi: marketGatekeeperAbi, functionName: "schedulerOf", args: [id] }),
      ),
    );
    reads.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      const track = this.tracks.find((t) => sameAddress(t.scheduler, r.value));
      if (track) this.trackOf.set(unnamed[i]!, track.ticker);
    });
  }

  private retire(id: bigint): void {
    this.tracked.delete(id);
    this.trackOf.delete(id);
    this.done.add(id);
  }

  private async settle(id: bigint, now: bigint, info: MarketInfo): Promise<MarketInfo> {
    const { log } = this.opts;
    const track = this.trackOf.get(id);
    try {
      const { hash } = await this.write({ functionName: "settle", args: [id] });
      if (!hash) {
        log.info("settle (dry run)", { market: id, track });
        this.retire(id);
        return info;
      }
      const after = (await this.readInfo(id)) ?? info;
      log.info("settled", { market: id, track, yesWon: after.yesWon, status: after.status, tx: hash });
      return after;
    } catch (e) {
      const fresh = (await this.readInfo(id)) ?? info;
      if (fresh.status !== MarketStatus.Trading) return fresh;
      if (now < info.expiry + BigInt(this.opts.invalidAfterSec)) {
        log.debug("settle not possible yet", { market: id, track, error: errMsg(e) });
        return fresh;
      }
      try {
        const { hash } = await this.write({ functionName: "settleInvalid", args: [id] });
        log.warn("settled invalid (50/50)", { market: id, track, tx: hash ?? "dry-run", settleError: errMsg(e) });
        return (await this.readInfo(id)) ?? fresh;
      } catch (e2) {
        log.warn("settle failed", { market: id, track, error: errMsg(e), invalidError: errMsg(e2) });
        return fresh;
      }
    }
  }

  /** Settles every due market and sweeps surplus of settled ones back to the vault. */
  async settleAndSweep(now: bigint): Promise<void> {
    for (const [id, cached] of [...this.tracked]) {
      try {
        let info = cached;
        if (info.status === MarketStatus.Trading) {
          if (!isSettleDue(info, now)) continue;
          info = await this.settle(id, now, info);
          if (!this.tracked.has(id)) continue;
        }
        if (info.status === MarketStatus.Settled || info.status === MarketStatus.Invalid) {
          const amount = sweepableAmount(info);
          if (amount > 0n) {
            const { hash } = await this.write({ functionName: "sweep", args: [id] });
            this.opts.log.info(hash ? "swept" : "sweep (dry run)", { market: id, track: this.trackOf.get(id), usdc: usdc(amount), tx: hash });
            if (!hash) {
              this.retire(id);
              continue;
            }
            info = (await this.readInfo(id)) ?? info;
          }
          if (sweepableAmount(info) === 0n) {
            this.retire(id);
            continue;
          }
        }
        this.tracked.set(id, info);
      } catch (e) {
        this.opts.log.warn("market upkeep failed", { market: id, track: this.trackOf.get(id), error: revertText(e) });
      }
    }
  }

  /** Calls the track's `open()` and returns the market id, `onSubmitted` also runs on AlreadyOpened for the targeted slot or later */
  async createMarket(
    track: Track,
    now: bigint,
    onSubmitted?: () => void,
    wallSec = Math.floor(Date.now() / 1000),
  ): Promise<bigint | undefined> {
    const { log } = this.opts;
    let outcome: { result: unknown; hash?: Hash; receipt?: TransactionReceipt };
    try {
      outcome = await this.send(track.scheduler, openAbi, { functionName: "open", args: [] }, onSubmitted);
    } catch (e) {
      const opened = alreadyOpenedSlot(e);
      if (opened === undefined) throw e;
      const target = targetSlot(now, wallSec, track.periodSec);
      if (opened >= target) {
        log.debug("slot already opened, nothing to do", { track: track.ticker, now, slot: opened });
        onSubmitted?.();
      } else {
        log.debug("latest block is still in an earlier slot, retrying", { track: track.ticker, now, opened, target });
      }
      return undefined;
    }
    const { result, hash, receipt } = outcome;
    let id = typeof result === "bigint" ? result : undefined;
    let slot: bigint | undefined;
    let budget: bigint | undefined;
    let strikeCents: bigint | undefined;
    if (receipt) {
      const opened = parseEventLogs({ abi: marketSchedulerAbi, logs: receipt.logs, eventName: "MarketOpened" });
      const own = opened.find((l) => sameAddress(l.address, track.scheduler));
      if (own) {
        id = own.args.marketId;
        slot = own.args.slot;
        budget = own.args.budget;
        strikeCents = own.args.strikeCents;
      }
    }
    log.info(hash ? "market opened" : "open (dry run)", {
      track: track.ticker,
      market: id,
      now,
      slot,
      budget: budget !== undefined ? usdc(budget) : undefined,
      strikeCents,
      tx: hash,
    });
    if (hash && id !== undefined) {
      this.trackOf.set(id, track.ticker);
      const info = await this.readInfo(id);
      if (info) this.tracked.set(id, info);
    }
    return id;
  }

  /** Moves the track past `slot` and logs the skip once */
  private skipSlot(track: Track, slot: bigint, msg: string, fields: Record<string, unknown> = {}): void {
    const st = this.stateOf(track);
    st.nextCreateAt = Number(slot + 1n) * track.periodSec;
    if (st.skippedSlot !== slot) this.opts.log.info(msg, { track: track.ticker, slot, ...fields, nextAt: st.nextCreateAt });
    st.skippedSlot = slot;
  }

  /** Opens the due slot's market, a late slot is skipped, a refused `open()` warns once per slot and stays due, other failures throw */
  async openDue(track: Track, now: bigint, wallSec: number): Promise<void> {
    const st = this.stateOf(track);
    const slot = targetSlot(now, wallSec, track.periodSec);
    const left = openDeadline(track, slot) - Math.max(Number(now), wallSec);
    if (left < this.opts.minTradeSec) {
      this.skipSlot(track, slot, "slot skipped, too little trading time left", { left, minTradeSec: this.opts.minTradeSec });
      return;
    }
    try {
      await this.createMarket(track, now, () => this.scheduleNextCreate(track, wallSec), wallSec);
    } catch (e) {
      const late = tooLateSlot(e);
      if (late !== undefined && late >= slot) {
        this.skipSlot(track, late, "slot skipped, past its open deadline", { error: revertText(e) });
        return;
      }
      if (late !== undefined) {
        this.opts.log.debug("latest block is still in an earlier slot, retrying", { track: track.ticker, now, late, target: slot });
        return;
      }
      if (!isRevert(e)) throw e;
      if (slot !== st.refusedSlot) this.opts.log.warn("open() refused, retrying every poll", { track: track.ticker, slot, error: revertText(e) });
      st.refusedSlot = slot;
    }
  }

  /** Aligned, the first open is due at once when `canOpen()` (or the chain lags the wall clock's slot), else at the next slot start */
  async primeSchedule(track: Track, now: bigint, wallSec: number): Promise<void> {
    const st = this.stateOf(track);
    if (st.nextCreateAt !== undefined) return;
    if (!this.opts.alignToPeriod) {
      st.nextCreateAt = wallSec;
      return;
    }
    const canOpen = await this.opts.clients.publicClient.readContract({
      address: track.scheduler,
      abi: marketSchedulerAbi,
      functionName: "canOpen",
    });
    const lagging = now / BigInt(track.periodSec) < BigInt(Math.floor(wallSec / track.periodSec));
    st.nextCreateAt = canOpen || lagging ? wallSec : nextCreateTime(wallSec, track.periodSec, true, true);
    this.opts.log.info("track scheduled", { track: track.ticker, periodSec: track.periodSec, canOpen, firstOpenAt: st.nextCreateAt });
  }

  isCreateDue(track: Track, nowSec: number): boolean {
    const at = this.stateOf(track).nextCreateAt;
    return at !== undefined && nowSec >= at;
  }

  scheduleNextCreate(track: Track, nowSec: number): void {
    this.stateOf(track).nextCreateAt = nextCreateTime(nowSec, track.periodSec, this.opts.alignToPeriod, false);
  }

  /** Opens every due track in period-ascending order, a track whose open fails is logged and retried next poll */
  async openDueTracks(wallSec: number): Promise<void> {
    const { publicClient } = this.opts.clients;
    for (const track of this.tracks) {
      try {
        let now: bigint | undefined;
        if (this.stateOf(track).nextCreateAt === undefined) {
          now = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
          await this.primeSchedule(track, now, wallSec);
        }
        if (!this.isCreateDue(track, wallSec)) continue;
        now ??= (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
        await this.openDue(track, now, wallSec);
      } catch (e) {
        this.opts.log.error("open failed, retrying next poll", { track: track.ticker, error: errMsg(e) });
      }
    }
  }

  /** Milliseconds until the earliest open scheduled after `attemptedAtSec`, the tick's own due tracks wait a full poll */
  msUntilNextCreate(nowMs: number, attemptedAtSec: number): number {
    let min = Infinity;
    for (const { nextCreateAt } of this.schedule.values()) {
      if (nextCreateAt === undefined || nextCreateAt <= attemptedAtSec) continue;
      min = Math.min(min, Math.max(0, nextCreateAt * 1000 - nowMs));
    }
    return min;
  }
}

/** Opens due tracks first (period ascending), then settles and sweeps every market on the hook */
export async function keeperTick(
  keeper: Keeper,
  cfg: Pick<KeeperConfig, "create" | "settle">,
  wallSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const { publicClient } = keeper.opts.clients;
  if (cfg.create) await keeper.openDueTracks(wallSec);
  await keeper.refresh();
  if (cfg.settle) await keeper.settleAndSweep((await publicClient.getBlock({ blockTag: "latest" })).timestamp);
}

async function main(): Promise<void> {
  loadEnvFiles();
  const cfg = loadKeeperConfig();
  const log = createLogger("keeper", cfg.logLevel);
  const clients = makeClients(cfg);
  await assertChainId(clients.publicClient, cfg.chainId);
  const hook = requireAddress(cfg.deployments, "predictionHook");
  const gatekeeper = requireAddress(cfg.deployments, "marketGatekeeper");
  const schedulers = requireSchedulers(cfg.deployments);
  const tracks = await loadTracks(clients.publicClient, { hook, gatekeeper, schedulers });
  const invalidAfterSec = await invalidAfterFor(clients.publicClient, hook, cfg.invalidAfterSec);
  const keeper = new Keeper({
    clients,
    hook,
    gatekeeper,
    tracks,
    alignToPeriod: cfg.alignToPeriod,
    minTradeSec: cfg.minTradeSec,
    scanBack: cfg.scanBack,
    invalidAfterSec,
    dryRun: cfg.dryRun,
    txTimeoutMs: cfg.txTimeoutMs,
    log,
  });
  for (const t of keeper.tracks) {
    log.info("track", {
      track: t.ticker,
      scheduler: t.scheduler,
      periodSec: t.periodSec,
      tenorSec: t.tenorSec,
      windowSec: t.windowSec,
      cutoffBufferSec: t.cutoffBufferSec,
    });
  }
  log.info("keeper ready", {
    account: clients.account?.address ?? "none (dry run)",
    keyFrom: cfg.privateKey?.source,
    hook,
    gatekeeper,
    tracks: keeper.tracks.map((t) => t.ticker).join(","),
    minTradeSec: cfg.minTradeSec,
    invalidAfterSec,
    create: cfg.create,
    settle: cfg.settle,
    dryRun: cfg.dryRun,
  });
  const stop = shutdownSignal((sig) => log.info("stopping", { signal: sig }));
  while (!stop.aborted) {
    const started = Date.now();
    const wallSec = Math.floor(started / 1000);
    try {
      await keeperTick(keeper, cfg, wallSec);
    } catch (e) {
      log.error("tick failed", { error: errMsg(e) });
    }
    if (cfg.once) break;
    const untilPoll = cfg.pollMs - (Date.now() - started);
    const untilCreate = cfg.create ? keeper.msUntilNextCreate(Date.now(), wallSec) : Infinity;
    await sleep(Math.max(0, Math.min(untilPoll, untilCreate)), stop);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`keeper: ${errMsg(e)}`);
    process.exit(1);
  });
}
