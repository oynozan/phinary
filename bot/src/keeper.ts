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
import { marketSchedulerAbi, MarketStatus, predictionHookAbi, predictionHookAdminAbi } from "./abi.ts";
import { assertChainId, makeClients, shutdownSignal, sleep, waitForSuccess, type Clients } from "./chain.ts";
import { loadEnvFiles, loadKeeperConfig, requireAddress, USDC_DECIMALS, type KeeperConfig } from "./config.ts";
import { createLogger, errMsg, type Logger } from "./log.ts";
import { isSettleDue, sweepableAmount, type MarketInfo } from "./market.ts";
import { formatRational } from "./math.ts";

export interface KeeperOptions {
  clients: Clients;
  hook: Address;
  /** The ownerless MarketScheduler that owns `hook`; `open()` is the only path to a new market. */
  scheduler: Address;
  periodSec: number;
  alignToPeriod: boolean;
  scanBack: number;
  invalidAfterSec: number;
  dryRun: boolean;
  txTimeoutMs: number;
  log: Logger;
  /** Caller for simulations when there is no account (a dry run without a key). */
  sender?: Address;
}

type HookWrite = { functionName: "settle" | "settleInvalid" | "sweep"; args: readonly [bigint] };

/** First wall-clock second at which the next market should be created. */
export function nextCreateTime(nowSec: number, periodSec: number, align: boolean, first: boolean): number {
  if (!align) return first ? nowSec : nowSec + periodSec;
  const floor = Math.floor(nowSec / periodSec) * periodSec;
  return first && floor === nowSec ? nowSec : floor + periodSec;
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

/** True when the call reached the contract and reverted (as opposed to an RPC or transport failure). */
export function isRevert(e: unknown): boolean {
  return e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null;
}

/** The slot of a simulated `open()` that reverted AlreadyOpened, or undefined for any other failure */
export function alreadyOpenedSlot(e: unknown): bigint | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (revert?.data?.errorName !== "AlreadyOpened") return undefined;
  const [slot] = revert.data.args ?? [];
  return typeof slot === "bigint" ? slot : undefined;
}

/** True when a simulated `open()` reverted because its slot is already open */
export function isAlreadyOpened(e: unknown): boolean {
  return alreadyOpenedSlot(e) !== undefined;
}

/** The slot a create due at `wallSec` targets, the later of the wall clock's and the latest block's */
export function targetSlot(chainNow: bigint, wallSec: number, periodSec: number): bigint {
  const now = BigInt(wallSec) > chainNow ? BigInt(wallSec) : chainNow;
  return now / BigInt(periodSec);
}

/** The scheduler's own slot length, or `configured` when its config cannot be read */
export async function schedulerPeriodFor(publicClient: PublicClient, scheduler: Address, configured: number): Promise<number> {
  try {
    const c = await publicClient.readContract({ address: scheduler, abi: marketSchedulerAbi, functionName: "config" });
    return Number(c.period);
  } catch {
    return configured;
  }
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
  readonly tracked = new Map<bigint, MarketInfo>();
  readonly done = new Set<bigint>();
  /** Ids whose last read failed for a reason other than a revert; rescanned on every refresh. */
  readonly pending = new Set<bigint>();
  lastCount: bigint | undefined;
  nextCreateAt: number | undefined;

  constructor(opts: KeeperOptions) {
    this.opts = opts;
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
    return this.send(this.opts.hook, predictionHookAbi, call, onSubmitted);
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
      if (info.status === MarketStatus.Trading || sweepableAmount(info) > 0n) this.tracked.set(id, info);
      else this.done.add(id);
    });
    this.lastCount = count;
  }

  private retire(id: bigint): void {
    this.tracked.delete(id);
    this.done.add(id);
  }

  private async settle(id: bigint, now: bigint, info: MarketInfo): Promise<MarketInfo> {
    const { log } = this.opts;
    try {
      const { hash } = await this.write({ functionName: "settle", args: [id] });
      if (!hash) {
        log.info("settle (dry run)", { market: id });
        this.retire(id);
        return info;
      }
      const after = (await this.readInfo(id)) ?? info;
      log.info("settled", { market: id, yesWon: after.yesWon, status: after.status, tx: hash });
      return after;
    } catch (e) {
      const fresh = (await this.readInfo(id)) ?? info;
      if (fresh.status !== MarketStatus.Trading) return fresh;
      if (now < info.expiry + BigInt(this.opts.invalidAfterSec)) {
        log.debug("settle not possible yet", { market: id, error: errMsg(e) });
        return fresh;
      }
      try {
        const { hash } = await this.write({ functionName: "settleInvalid", args: [id] });
        log.warn("settled invalid (50/50)", { market: id, tx: hash ?? "dry-run", settleError: errMsg(e) });
        return (await this.readInfo(id)) ?? fresh;
      } catch (e2) {
        log.warn("settle failed", { market: id, error: errMsg(e), invalidError: errMsg(e2) });
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
            this.opts.log.info(hash ? "swept" : "sweep (dry run)", { market: id, usdc: usdc(amount), tx: hash });
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
        this.opts.log.warn("market upkeep failed", { market: id, error: errMsg(e) });
      }
    }
  }

  /** Calls `open()` and returns the market id, `onSubmitted` also runs on AlreadyOpened for the targeted slot or later */
  async createMarket(now: bigint, onSubmitted?: () => void, wallSec = Math.floor(Date.now() / 1000)): Promise<bigint | undefined> {
    const { log, scheduler } = this.opts;
    let outcome: { result: unknown; hash?: Hash; receipt?: TransactionReceipt };
    try {
      outcome = await this.send(scheduler, marketSchedulerAbi, { functionName: "open", args: [] }, onSubmitted);
    } catch (e) {
      const opened = alreadyOpenedSlot(e);
      if (opened === undefined) throw e;
      const target = targetSlot(now, wallSec, this.opts.periodSec);
      if (opened >= target) {
        log.debug("scheduler slot already opened, nothing to do", { now, slot: opened });
        onSubmitted?.();
      } else {
        log.debug("latest block is still in an earlier slot, retrying", { now, opened, target });
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
      const own = opened.find((l) => l.address.toLowerCase() === scheduler.toLowerCase());
      if (own) {
        id = own.args.marketId;
        slot = own.args.slot;
        budget = own.args.budget;
        strikeCents = own.args.strikeCents;
      }
    }
    log.info(hash ? "market opened" : "open (dry run)", {
      market: id,
      now,
      slot,
      budget: budget !== undefined ? usdc(budget) : undefined,
      strikeCents,
      tx: hash,
    });
    if (hash && id !== undefined) {
      const info = await this.readInfo(id);
      if (info) this.tracked.set(id, info);
    }
    return id;
  }

  isCreateDue(nowSec: number): boolean {
    if (this.nextCreateAt === undefined) {
      this.nextCreateAt = nextCreateTime(nowSec, this.opts.periodSec, this.opts.alignToPeriod, true);
    }
    return nowSec >= this.nextCreateAt;
  }

  scheduleNextCreate(nowSec: number): void {
    this.nextCreateAt = nextCreateTime(nowSec, this.opts.periodSec, this.opts.alignToPeriod, false);
  }
}

/** Settles and sweeps, then opens the due slot's market, and a call that fails before sending retries next poll */
export async function keeperTick(
  keeper: Keeper,
  cfg: Pick<KeeperConfig, "create" | "settle">,
  wallSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const { publicClient } = keeper.opts.clients;
  await keeper.refresh();
  if (cfg.settle) await keeper.settleAndSweep((await publicClient.getBlock({ blockTag: "latest" })).timestamp);
  if (cfg.create && keeper.isCreateDue(wallSec)) {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    await keeper.createMarket(block.timestamp, () => keeper.scheduleNextCreate(wallSec), wallSec);
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const cfg = loadKeeperConfig();
  const log = createLogger("keeper", cfg.logLevel);
  const clients = makeClients(cfg);
  await assertChainId(clients.publicClient, cfg.chainId);
  const hook = requireAddress(cfg.deployments, "predictionHook");
  const scheduler = requireAddress(cfg.deployments, "marketScheduler");
  const invalidAfterSec = await invalidAfterFor(clients.publicClient, hook, cfg.invalidAfterSec);
  const periodSec = await schedulerPeriodFor(clients.publicClient, scheduler, cfg.periodSec);
  if (periodSec !== cfg.periodSec) {
    log.warn("KEEPER_PERIOD_SEC differs from the scheduler's period, following the scheduler", {
      configured: cfg.periodSec,
      scheduler: periodSec,
    });
  }
  const keeper = new Keeper({
    clients,
    hook,
    scheduler,
    periodSec,
    alignToPeriod: cfg.alignToPeriod,
    scanBack: cfg.scanBack,
    invalidAfterSec,
    dryRun: cfg.dryRun,
    txTimeoutMs: cfg.txTimeoutMs,
    log,
  });
  log.info("keeper ready", {
    account: clients.account?.address ?? "none (dry run)",
    keyFrom: cfg.privateKey?.source,
    hook,
    scheduler,
    periodSec,
    invalidAfterSec,
    create: cfg.create,
    settle: cfg.settle,
    dryRun: cfg.dryRun,
  });
  const stop = shutdownSignal((sig) => log.info("stopping", { signal: sig }));
  while (!stop.aborted) {
    const started = Date.now();
    try {
      await keeperTick(keeper, cfg);
    } catch (e) {
      log.error("tick failed", { error: errMsg(e) });
    }
    if (cfg.once) break;
    const untilPoll = cfg.pollMs - (Date.now() - started);
    const untilCreate = keeper.nextCreateAt !== undefined && cfg.create ? keeper.nextCreateAt * 1000 - Date.now() : Infinity;
    // A creation still due after this tick failed: wait a full poll before retrying
    await sleep(Math.max(0, untilCreate > 0 ? Math.min(untilPoll, untilCreate) : untilPoll), stop);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`keeper: ${errMsg(e)}`);
    process.exit(1);
  });
}
