import {
  BaseError,
  ContractFunctionRevertedError,
  numberToHex,
  parseEventLogs,
  zeroHash,
  type Account,
  type Address,
  type Hash,
  type Log,
  type PublicClient,
} from "viem";
import { sealedPoolOracleAbi, sealedPoolOracleImplAbi } from "./abi.ts";
import { assertChainId, makeClients, shutdownSignal, sleep, waitForSuccess, type Clients } from "./chain.ts";
import { loadEnvFiles, loadSealedConfig } from "./config.ts";
import { verifiedHeader } from "./header.ts";
import { isRevert } from "./keeper.ts";
import { createLogger, errMsg, type Logger } from "./log.ts";
import {
  buildBlockProof,
  HISTORY_ADDRESS,
  readOracleTarget,
  withFallback,
  type BlockProof,
  type OracleTarget,
  type Reader,
  type RetryOptions,
} from "./proof.ts";

const BLOCKHASH_WINDOW = 256n;
const HISTORY_WINDOW = 8191n;
/** A hash this close to leaving its window counts as gone, since the transaction takes time to land */
const WINDOW_MARGIN = 32n;
/** The first chunk is small because its anchor must stay inside a window while its headers are fetched */
const FIRST_CHUNK = 16;
const CHUNK = 128;
/** Parallel RPC reads while building a batch */
const CONCURRENCY = 4;

/** Includes BlockHashes so reverts such as UnknownBlockHash decode by name */
const oracleAbi = [...sealedPoolOracleAbi, ...sealedPoolOracleImplAbi] as const;

export interface SealedBotOptions {
  clients: Clients;
  oracle: Address;
  /** Most proofs per proveMany (SEALED_BATCH) */
  batch: number;
  dryRun: boolean;
  txTimeoutMs: number;
  log: Logger;
  /** Read-only RPCs tried after the primary for headers and proofs */
  fallbacks?: readonly Reader[];
  retry?: RetryOptions;
  /** proveMany batches per tick, so a long catch-up still pokes every few batches (default 4) */
  maxBatchesPerTick?: number;
  /** Caller for estimates when there is no account (a dry run without a key) */
  sender?: Address;
}

export interface SealedTick {
  /** Block the poke landed in, or the latest block when this tick did not poke */
  head: bigint;
  poked: boolean;
  /** The poke proved a run of blocks, applied or queued behind a gap */
  sealed: boolean;
  /** head - 1, the newest block a poke in `head` can seal and the one proofs must reach */
  target: bigint;
  frontier: bigint;
  /** Proofs sent in proveMany */
  proven: number;
  /** Headers stored with checkpointHeaders */
  checkpointed: number;
  caughtUp: boolean;
}

function range(from: bigint, to: bigint): bigint[] {
  const out: bigint[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  return revert?.data?.errorName;
}

/**
 * Keeps a SealedPoolOracle's history complete. Every tick it pokes once if a new block has no poke yet, then proves,
 * in order and in batches, every block from the frontier up to the one before its poke that no seal covered. When a
 * block is older than BLOCKHASH and EIP-2935 reach, it first stores the missing hashes with checkpointHeaders. It needs
 * no role, since the contract verifies every seal and proof, so a faulty bot can stall the oracle but never corrupt it.
 */
export class SealedBot {
  readonly opts: SealedBotOptions;
  private target?: OracleTarget;
  private gasLimit?: bigint;
  private lastPokeHead?: bigint;
  /** Blocks this bot stored with checkpointHeaders, contiguous from `lo` to the anchor `hi` */
  private stored?: { lo: bigint; hi: bigint };

  constructor(opts: SealedBotOptions) {
    this.opts = opts;
  }

  private get pc(): PublicClient {
    return this.opts.clients.publicClient;
  }

  private get readers(): readonly Reader[] {
    return [this.pc, ...(this.opts.fallbacks ?? [])];
  }

  private read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.pc.readContract({ address: this.opts.oracle, abi: oracleAbi, functionName, args } as never) as Promise<T>;
  }

  async frontier(): Promise<bigint> {
    return this.read<bigint>("frontier");
  }

  private async started(frontier: bigint): Promise<boolean> {
    if (frontier > 0n) return true;
    try {
      await this.read("oldestObservationTime");
      return true;
    } catch (e) {
      if (isRevert(e)) return false;
      throw e;
    }
  }

  private async head(): Promise<bigint> {
    return this.pc.getBlockNumber({ cacheTime: 0 });
  }

  private get caller(): Address | Account | undefined {
    return this.opts.clients.account ?? this.opts.sender;
  }

  private async blockGasLimit(): Promise<bigint> {
    return (this.gasLimit ??= (await this.pc.getBlock({ blockTag: "latest" })).gasLimit);
  }

  /** The oracle's PoolManager and pool id, read once */
  async oracleTarget(): Promise<OracleTarget> {
    return (this.target ??= await readOracleTarget(this.pc, this.opts.oracle));
  }

  /** Estimates unless given, pads and sends one oracle call, or only estimates it in a dry run */
  private async send(
    functionName: "poke" | "proveMany" | "checkpointHeaders",
    args: readonly unknown[],
    pad: (estimate: bigint) => bigint,
    estimate?: bigint,
  ): Promise<{ hash?: Hash; blockNumber?: bigint; gasUsed?: bigint; logs: Log[] }> {
    const { walletClient } = this.opts.clients;
    const call = { address: this.opts.oracle, abi: oracleAbi, functionName, args, account: this.caller } as const;
    const gasEstimate = estimate ?? (await this.pc.estimateContractGas(call as never));
    if (this.opts.dryRun || !walletClient) return { logs: [] };
    const limit = await this.blockGasLimit();
    const gas = pad(gasEstimate) < limit ? pad(gasEstimate) : limit;
    const hash = await walletClient.writeContract({ ...call, gas } as never);
    const receipt = await waitForSuccess(this.pc, hash, this.opts.txTimeoutMs);
    return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, logs: receipt.logs };
  }

  private async poke(): Promise<{ sealed: boolean; blockNumber?: bigint }> {
    const r = await this.send("poke", [], (g) => (g * 13n) / 10n + 50_000n);
    const logs = parseEventLogs({ abi: sealedPoolOracleAbi, logs: r.logs, eventName: ["Sealed", "Queued"] }).filter(
      (l) => l.address.toLowerCase() === this.opts.oracle.toLowerCase(),
    );
    const runs = logs.map((l) => `${l.eventName === "Queued" ? "queued " : ""}${l.args.fromBlock}-${l.args.toBlock}`);
    this.opts.log.debug(r.hash ? "poked" : "poke (dry run)", { block: r.blockNumber, runs: runs.join(",") || undefined, tx: r.hash });
    return { sealed: logs.length > 0, blockNumber: r.blockNumber };
  }

  /** True when EIP-2935 serves block `n`'s real hash */
  private async historyServes(n: bigint): Promise<boolean> {
    try {
      const [res, block] = await Promise.all([
        this.pc.call({ to: HISTORY_ADDRESS, data: numberToHex(n, { size: 32 }) }),
        this.pc.getBlock({ blockNumber: n }),
      ]);
      return res.data !== undefined && res.data.toLowerCase() === block.hash.toLowerCase();
    } catch {
      return false;
    }
  }

  /** True when [from, last] is already checkpointed, known from this run or unambiguous on chain */
  private async isStored(from: bigint, last: bigint, head: bigint): Promise<boolean> {
    const s = this.stored;
    if (s && s.lo <= from && last <= s.hi) return true;
    // Inside a window a nonzero blockHashOf may be the window's, outside every window it can only be a checkpoint
    if (head - last <= HISTORY_WINDOW) return false;
    const hashes = await Promise.all(
      [from, last].map((n) => this.read<Hash>("blockHashOf", [n])),
    );
    return hashes.every((h) => h !== zeroHash);
  }

  /** Checkpoints whatever part of [from, end] no hash window will serve when the proofs land, returns headers stored */
  private async ensureHashes(from: bigint, end: bigint): Promise<number> {
    const head = await this.head();
    if (head - from <= BLOCKHASH_WINDOW - WINDOW_MARGIN) return 0;
    if (head - from <= HISTORY_WINDOW - WINDOW_MARGIN && (await this.historyServes(from))) return 0;
    const deep = head - (HISTORY_WINDOW - WINDOW_MARGIN);
    const anchor = deep > from && (await this.historyServes(deep)) ? deep : head - (BLOCKHASH_WINDOW - WINDOW_MARGIN);
    const last = end < anchor ? end : anchor - 1n;
    if (await this.isStored(from, last, head)) return 0;
    const s = this.stored;
    const extends_ = s !== undefined && s.lo <= from && from <= s.hi;
    const stored = await this.checkpoint(anchor, extends_ ? s.hi : from);
    if (!this.opts.dryRun) this.stored = { lo: extends_ ? s.lo : from, hi: anchor };
    return stored;
  }

  /** Stores the hashes of blocks [bottom, top] with checkpointHeaders, newest first, anchored at `top` */
  private async checkpoint(top: bigint, bottom: bigint): Promise<number> {
    let total = 0;
    let hi = top;
    let chunk = FIRST_CHUNK;
    while (hi > bottom) {
      const lo = hi - BigInt(chunk - 1) > bottom ? hi - BigInt(chunk - 1) : bottom;
      const numbers = range(lo, hi).reverse();
      const headers = await mapLimit(numbers, CONCURRENCY, (n) =>
        withFallback(this.readers, (r) => verifiedHeader(r, n), this.opts.retry).then((h) => h.header),
      );
      const r = await this.send("checkpointHeaders", [headers], (g) => (g * 12n) / 10n + 100_000n);
      this.opts.log.info(r.hash ? "checkpointed" : "checkpoint (dry run)", {
        oldest: lo,
        newest: hi,
        headers: headers.length,
        gas: r.gasUsed,
        tx: r.hash,
      });
      total += headers.length;
      if (!r.hash) break;
      // The oldest stored header anchors the next chunk
      hi = lo;
      chunk = CHUNK;
    }
    return total;
  }

  /** Sends one proveMany from `from`, at most `batch` blocks and halved until its gas fits half a block */
  private async proveBatch(from: bigint, to: bigint): Promise<{ proven: number; checkpointed: number }> {
    const target = await this.oracleTarget();
    const last = from + BigInt(this.opts.batch) - 1n;
    const end = last < to ? last : to;
    const checkpointed = await this.ensureHashes(from, end);
    // A dry run stored nothing, so the proofs would not verify yet
    if (this.opts.dryRun && checkpointed > 0) return { proven: 0, checkpointed };
    let proofs: BlockProof[] = await mapLimit(range(from, end), CONCURRENCY, (n) =>
      buildBlockProof(this.readers, target, n, this.opts.retry),
    );
    const cap = (await this.blockGasLimit()) / 2n;
    let estimate: bigint;
    for (;;) {
      try {
        estimate = await this.pc.estimateContractGas({
          address: this.opts.oracle,
          abi: oracleAbi,
          functionName: "proveMany",
          args: [proofs],
          account: this.caller,
        });
      } catch (e) {
        // The windows moved on since ensureHashes looked, so the next attempt starts from scratch
        if (revertName(e) === "UnknownBlockHash") this.stored = undefined;
        throw e;
      }
      if (estimate <= cap || proofs.length === 1) break;
      proofs = proofs.slice(0, Math.ceil(proofs.length / 2));
    }
    const r = await this.send("proveMany", [proofs], (g) => (g * 12n) / 10n + 100_000n, estimate);
    this.opts.log.debug(r.hash ? "proved" : "prove (dry run)", {
      from,
      to: from + BigInt(proofs.length) - 1n,
      estimate,
      gas: r.gasUsed,
      tx: r.hash,
    });
    return { proven: proofs.length, checkpointed };
  }

  /** Pokes once per new block, then proves from frontier + 1 while the frontier is below the block before the poke */
  async tick(): Promise<SealedTick> {
    const { log } = this.opts;
    let head = await this.head();
    const [snapBlock] = await this.read<readonly [bigint, ...unknown[]]>("snapshot");
    let poked = false;
    let sealed = false;
    if (snapBlock !== head && this.lastPokeHead !== head) {
      this.lastPokeHead = head;
      try {
        const r = await this.poke();
        poked = true;
        sealed = r.sealed;
        if (r.blockNumber !== undefined) head = r.blockNumber;
      } catch (e) {
        log.warn("poke failed", { head, error: errMsg(e) });
      }
    }
    const target = head - 1n;
    let frontier = await this.frontier();
    let started = await this.started(frontier);
    const startByProof = !started && poked && !sealed && snapBlock > 0n;
    let proven = 0;
    let checkpointed = 0;
    for (let i = 0; i < (this.opts.maxBatchesPerTick ?? 4); i++) {
      const from = started ? frontier + 1n : target;
      if (started ? from > target : !startByProof || i > 0) break;
      const r = await this.proveBatch(from, target);
      proven += r.proven;
      checkpointed += r.checkpointed;
      if (this.opts.dryRun) break;
      frontier = await this.frontier();
      started = await this.started(frontier);
    }
    const caughtUp = started && frontier >= target;
    if (proven > 0 || checkpointed > 0) log.info("tick", { head, target, frontier, proven, checkpointed, caughtUp });
    return { head, poked, sealed, target, frontier, proven, checkpointed, caughtUp };
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const cfg = loadSealedConfig();
  const log = createLogger("sealed", cfg.logLevel);
  const clients = makeClients(cfg);
  await assertChainId(clients.publicClient, cfg.chainId);
  const fallbacks: PublicClient[] = [];
  for (const [i, url] of cfg.fallbackRpcUrls.entries()) {
    const { publicClient } = makeClients({ rpcUrl: url, chainId: cfg.chainId });
    try {
      await assertChainId(publicClient, cfg.chainId);
    } catch (e) {
      throw new Error(`SEALED_RPC_FALLBACKS entry ${i + 1}: ${errMsg(e)}`);
    }
    fallbacks.push(publicClient);
  }
  const bot = new SealedBot({
    clients,
    oracle: cfg.oracle,
    batch: cfg.batch,
    dryRun: cfg.dryRun,
    txTimeoutMs: cfg.txTimeoutMs,
    log,
    fallbacks,
  });
  const target = await bot.oracleTarget();
  log.info("sealed bot ready", {
    account: clients.account?.address ?? "none (dry run)",
    keyFrom: cfg.privateKey?.source,
    oracle: cfg.oracle,
    poolManager: target.poolManager,
    poolId: target.poolId,
    frontier: await bot.frontier(),
    batch: cfg.batch,
    fallbacks: fallbacks.length,
    dryRun: cfg.dryRun,
  });
  const stop = shutdownSignal((sig) => log.info("stopping", { signal: sig }));
  while (!stop.aborted) {
    const started = Date.now();
    let catchingUp = false;
    try {
      const r = await bot.tick();
      catchingUp = !r.caughtUp && r.proven + r.checkpointed > 0;
    } catch (e) {
      log.error("tick failed", { error: errMsg(e) });
    }
    if (cfg.once) break;
    // A tick that proved and is still behind is followed at once, so pokes keep sealing between batches
    if (!catchingUp || cfg.dryRun) await sleep(Math.max(0, cfg.pollMs - (Date.now() - started)), stop);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`sealed: ${errMsg(e)}`);
    process.exit(1);
  });
}
