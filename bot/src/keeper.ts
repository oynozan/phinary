import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { MarketStatus, predictionHookAbi, predictionHookAdminAbi, underlyingOracleAbi } from "./abi.ts";
import { assertChainId, makeClients, shutdownSignal, sleep, waitForSuccess, type Clients } from "./chain.ts";
import { loadEnvFiles, loadKeeperConfig, requireAddress, USDC_DECIMALS, type KeeperConfig } from "./config.ts";
import { createLogger, errMsg, type Logger } from "./log.ts";
import {
  buildMarketParams,
  isSettleDue,
  SECONDS_PER_YEAR,
  sweepableAmount,
  type MarketInfo,
  type MarketParams,
  type MarketTemplate,
} from "./market.ts";
import { formatRational, isqrt } from "./math.ts";

export interface KeeperOptions {
  clients: Clients;
  hook: Address;
  oracle: Address;
  template: MarketTemplate;
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

type HookWrite =
  | { functionName: "createMarket"; args: readonly [MarketParams] }
  | { functionName: "settle" | "settleInvalid" | "sweep"; args: readonly [bigint] };

/** First wall-clock second at which the next market should be created. */
export function nextCreateTime(nowSec: number, periodSec: number, align: boolean, first: boolean): number {
  if (!align) return first ? nowSec : nowSec + periodSec;
  const floor = Math.floor(nowSec / periodSec) * periodSec;
  return first && floor === nowSec ? nowSec : floor + periodSec;
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

/** The hook's keeper, else its owner: the account createMarket accepts, for dry runs without a key. */
export async function hookOperator(publicClient: PublicClient, hook: Address): Promise<Address | undefined> {
  const read = (functionName: "keeper" | "owner") =>
    publicClient.readContract({ address: hook, abi: predictionHookAdminAbi, functionName }).catch(() => undefined);
  const keeper = await read("keeper");
  if (keeper && keeper !== zeroAddress) return keeper;
  return read("owner");
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
  private budgetWarned = false;

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

  private async write(
    call: HookWrite,
    onSubmitted?: () => void,
  ): Promise<{ result: unknown; hash?: Hash; receipt?: TransactionReceipt }> {
    const { publicClient, walletClient, account } = this.opts.clients;
    const { request, result } = await publicClient.simulateContract({
      address: this.opts.hook,
      abi: predictionHookAbi,
      ...call,
      account: account ?? this.opts.sender,
    } as Parameters<typeof publicClient.simulateContract>[0]);
    if (this.opts.dryRun || !walletClient) {
      onSubmitted?.();
      return { result };
    }
    const hash = await walletClient.writeContract(request as Parameters<typeof walletClient.writeContract>[0]);
    onSubmitted?.();
    const receipt = await waitForSuccess(publicClient, hash, this.opts.txTimeoutMs);
    return { result, hash, receipt };
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

  /**
   * Creates one market struck at the oracle's current start-of-block price. Returns its id, if known. `onSubmitted`
   * runs once the transaction is sent (or simulated in a dry run); a skip for budget or an earlier error leaves it
   * uncalled, so the caller can retry.
   */
  async createMarket(now: bigint, onSubmitted?: () => void): Promise<bigint | undefined> {
    const { publicClient } = this.opts.clients;
    const { log, template } = this.opts;
    const [lnSpot, idle] = await Promise.all([
      publicClient.readContract({ address: this.opts.oracle, abi: underlyingOracleAbi, functionName: "lnSpotSoBWad" }),
      publicClient.readContract({ address: this.opts.hook, abi: predictionHookAbi, functionName: "vaultIdle" }),
    ]);
    if (idle < template.budget) {
      const fields = { idle: usdc(idle), budget: usdc(template.budget) };
      if (this.budgetWarned) log.debug("vault idle below market budget, skipping", fields);
      else log.warn("vault idle below market budget, skipping", fields);
      this.budgetWarned = true;
      return undefined;
    }
    const built = buildMarketParams(this.opts.oracle, lnSpot, now, template);
    const { result, hash, receipt } = await this.write({ functionName: "createMarket", args: [built.params] }, onSubmitted);
    let id = typeof result === "bigint" ? result : undefined;
    if (receipt) {
      const created = parseEventLogs({ abi: predictionHookAbi, logs: receipt.logs, eventName: "MarketCreated" });
      const own = created.find((l) => l.address.toLowerCase() === this.opts.hook.toLowerCase());
      if (own) id = own.args.marketId;
    }
    log.info(hash ? "market created" : "createMarket (dry run)", {
      market: id,
      name: built.params.yesName,
      strike: built.strike,
      openTime: built.params.openTime,
      expiry: built.params.expiry,
      budget: usdc(built.params.budget),
      sigma: await this.annualVol(),
      tx: hash,
    });
    if (hash && id !== undefined) {
      const info = await this.readInfo(id);
      if (info) this.tracked.set(id, info);
    }
    return id;
  }

  private async annualVol(): Promise<string | undefined> {
    try {
      const [varE36, warm] = await this.opts.clients.publicClient.readContract({
        address: this.opts.oracle,
        abi: underlyingOracleAbi,
        functionName: "varianceE36",
      });
      const volE18 = isqrt(varE36 * SECONDS_PER_YEAR);
      return `${formatRational({ num: volE18 * 100n, den: 10n ** 18n }, 1)}%${warm ? "" : " (warm-up)"}`;
    } catch {
      return undefined;
    }
  }

  isCreateDue(nowSec: number): boolean {
    if (this.nextCreateAt === undefined) {
      this.nextCreateAt = nextCreateTime(nowSec, this.opts.periodSec, this.opts.alignToPeriod, true);
    }
    return nowSec >= this.nextCreateAt;
  }

  scheduleNextCreate(nowSec: number): void {
    this.nextCreateAt = nextCreateTime(nowSec, this.opts.periodSec, this.opts.alignToPeriod, false);
    this.budgetWarned = false;
  }
}

/**
 * One poll: settle and sweep, then create the period's market if due. A creation that fails before its transaction
 * is sent (RPC error, revert, budget) is retried on the next poll; openTime uses a block read just before creating.
 */
export async function keeperTick(keeper: Keeper, cfg: Pick<KeeperConfig, "create" | "settle">): Promise<void> {
  const { publicClient } = keeper.opts.clients;
  await keeper.refresh();
  if (cfg.settle) await keeper.settleAndSweep((await publicClient.getBlock({ blockTag: "latest" })).timestamp);
  const wall = Math.floor(Date.now() / 1000);
  if (cfg.create && keeper.isCreateDue(wall)) {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    await keeper.createMarket(block.timestamp, () => keeper.scheduleNextCreate(wall));
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const cfg = loadKeeperConfig();
  const log = createLogger("keeper", cfg.logLevel);
  const clients = makeClients(cfg);
  await assertChainId(clients.publicClient, cfg.chainId);
  const hook = requireAddress(cfg.deployments, "predictionHook");
  const oracle = requireAddress(cfg.deployments, "underlyingOracle");
  const sender = clients.account ? undefined : await hookOperator(clients.publicClient, hook);
  if (!clients.account && !sender) log.warn("dry run without a key and no hook keeper/owner found: createMarket will revert");
  const invalidAfterSec = await invalidAfterFor(clients.publicClient, hook, cfg.invalidAfterSec);
  const keeper = new Keeper({
    clients,
    hook,
    oracle,
    template: cfg.template,
    periodSec: cfg.periodSec,
    alignToPeriod: cfg.alignToPeriod,
    scanBack: cfg.scanBack,
    invalidAfterSec,
    dryRun: cfg.dryRun,
    txTimeoutMs: cfg.txTimeoutMs,
    log,
    sender,
  });
  const t = cfg.template;
  log.info("keeper ready", {
    account: clients.account?.address ?? `none (simulating as ${sender ?? "0x0"})`,
    keyFrom: cfg.privateKey?.source,
    hook,
    oracle,
    periodSec: cfg.periodSec,
    tenor: t.tenorSec,
    window: t.windowSec,
    cutoffBuffer: t.cutoffBufferSec,
    nSamples: t.nSamples,
    budget: usdc(t.budget),
    h0: formatRational({ num: t.quote.h0Wad, den: 10n ** 18n }, 4),
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
