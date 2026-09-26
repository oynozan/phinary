import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  encodeErrorResult,
  http,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type RpcBlock,
} from "viem";
import { poolManagerAbi, sealedPoolOracleAbi, sealedPoolOracleImplAbi } from "../src/abi.ts";
import { makeClients } from "../src/chain.ts";
import { BOT_DIR, loadSealedConfig, REPO_DIR } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { varE36FromAnnualVol } from "../src/market.ts";
import { orientationFor, poolId, poolStateSlot, decodeSlot0, sortTokens, sqrtPriceX96FromPrice, type PoolKey } from "../src/pricing.ts";
import { buildBlockProof, HISTORY_ADDRESS } from "../src/proof.ts";
import { batchGasCap, checkProofWindow, fitBatch, SealedBot, TX_GAS_CAP, txGasLimit, type SealedTick } from "../src/sealed.ts";
import { ANVIL_KEY, deploy, findAnvil, read, send, startAnvil } from "./helpers/anvil.ts";
import { loadArtifact, type Artifact } from "./helpers/artifacts.ts";

const KEY = `0x${"ab".repeat(32)}`;
const EXAMPLE = resolve(BOT_DIR, "config", "unichain-sepolia.example.json");
const ORACLE = "0x00000000000000000000000000000000000000Aa";

test("loadSealedConfig: SEALED_ORACLE, SEALED_KEY falling back to KEEPER_PRIVATE_KEY, batch and poll defaults", () => {
  const env = { DEPLOYMENTS_FILE: EXAMPLE, SEALED_ORACLE: ORACLE };
  const cfg = loadSealedConfig({ ...env, KEEPER_PRIVATE_KEY: KEY });
  assert.equal(cfg.oracle.toLowerCase(), ORACLE.toLowerCase());
  assert.equal(cfg.privateKey?.source, "KEEPER_PRIVATE_KEY");
  assert.equal(cfg.batch, 16);
  assert.equal(cfg.pollMs, 500);
  assert.deepEqual(cfg.fallbackRpcUrls, []);
  const own = loadSealedConfig({
    ...env,
    SEALED_KEY: `0x${"cd".repeat(32)}`,
    KEEPER_PRIVATE_KEY: KEY,
    SEALED_BATCH: "4",
    SEALED_POLL_MS: "250",
    SEALED_RPC_FALLBACKS: "https://a.example, https://b.example",
  });
  assert.equal(own.privateKey?.source, "SEALED_KEY");
  assert.equal(own.batch, 4);
  assert.equal(own.pollMs, 250);
  assert.deepEqual(own.fallbackRpcUrls, ["https://a.example", "https://b.example"]);
  assert.throws(() => loadSealedConfig({ ...env }), /SEALED_KEY or KEEPER_PRIVATE_KEY/);
  assert.throws(() => loadSealedConfig({ DEPLOYMENTS_FILE: EXAMPLE, DRY_RUN: "1" }), /sealedOracle is not deployed.*SEALED_ORACLE/);
  assert.throws(() => loadSealedConfig({ ...env, DRY_RUN: "1", SEALED_BATCH: "0" }), /SEALED_BATCH/);
  assert.equal(loadSealedConfig({ ...env, DRY_RUN: "1" }).privateKey, undefined);
});

/* buildBlockProof against the Task 6 Unichain mainnet fixture, offline */

const FIXTURE = JSON.parse(
  readFileSync(resolve(REPO_DIR, "test", "vectors", "unichain", "pool-proof-59663450.json"), "utf8"),
) as {
  number: number;
  header: Hex;
  poolManager: Address;
  poolId: Hex;
  slot: Hex;
  slotValue: Hex;
  storageHash: Hex;
  accountProof: Hex[];
  slotProof: Hex[];
};
const BLOCK = JSON.parse(readFileSync(resolve(BOT_DIR, "test", "vectors", "unichain-block-59663450.json"), "utf8")) as RpcBlock;

type Rpc = { method: string; params: unknown[] };

/** A PublicClient that answers eth_getBlockByNumber and eth_getProof from the fixture, unless `hook` does */
function fixtureClient(hook: (req: Rpc) => unknown = () => undefined): PublicClient {
  const request = async (req: Rpc) => {
    const override = hook(req);
    if (override !== undefined) return override;
    if (req.method === "eth_getBlockByNumber") return BLOCK;
    if (req.method === "eth_getProof") {
      return {
        address: FIXTURE.poolManager,
        accountProof: FIXTURE.accountProof,
        balance: "0x0",
        codeHash: `0x${"00".repeat(32)}`,
        nonce: "0x1",
        storageHash: FIXTURE.storageHash,
        storageProof: [{ key: FIXTURE.slot, value: FIXTURE.slotValue, proof: FIXTURE.slotProof }],
      };
    }
    throw new Error(`unexpected ${req.method}`);
  };
  return { request } as unknown as PublicClient;
}

const target = { poolManager: FIXTURE.poolManager, poolId: FIXTURE.poolId };

test("buildBlockProof returns the verified header and the PoolManager's slot0 proofs", async () => {
  const seen: Rpc[] = [];
  const p = await buildBlockProof(
    fixtureClient((r) => void seen.push(r)),
    target,
    BigInt(FIXTURE.number),
  );
  assert.equal(p.header, FIXTURE.header);
  assert.deepEqual(p.accountProof, FIXTURE.accountProof);
  assert.deepEqual(p.slotProof, FIXTURE.slotProof);
  const proofReq = seen.find((r) => r.method === "eth_getProof")!;
  assert.deepEqual(proofReq.params, [FIXTURE.poolManager, [FIXTURE.slot], "0x38e645a"]);
  assert.equal(poolStateSlot(FIXTURE.poolId), FIXTURE.slot);
});

test("buildBlockProof retries refusals and falls back to the next RPC", async () => {
  let refusals = 0;
  const refusing = fixtureClient((r) => {
    if (r.method !== "eth_getProof") return undefined;
    refusals++;
    throw new Error("Unknown state");
  });
  const p = await buildBlockProof([refusing, fixtureClient()], target, BigInt(FIXTURE.number), { baseDelayMs: 1 });
  assert.deepEqual(p.slotProof, FIXTURE.slotProof);
  assert.ok(refusals >= 1);

  const wrongRoot = fixtureClient((r) => (r.method === "eth_getProof" ? { ...proofOf(), accountProof: FIXTURE.slotProof } : undefined));
  await assert.rejects(
    buildBlockProof([wrongRoot], target, BigInt(FIXTURE.number), { attempts: 2, baseDelayMs: 1 }),
    /account proof does not start at the state root/,
  );
  const wrongSlot = fixtureClient((r) => (r.method === "eth_getProof" ? { ...proofOf(), storageHash: BLOCK.stateRoot } : undefined));
  await assert.rejects(buildBlockProof([wrongSlot], target, BigInt(FIXTURE.number), { attempts: 1 }), /slot proof does not start at the storage root/);
  const badHeader = fixtureClient((r) => (r.method === "eth_getBlockByNumber" ? { ...BLOCK, gasUsed: "0x1" } : undefined));
  await assert.rejects(buildBlockProof([badHeader], target, BigInt(FIXTURE.number), { attempts: 1 }), /does not hash to/);
});

function proofOf() {
  return {
    address: FIXTURE.poolManager,
    accountProof: FIXTURE.accountProof,
    storageHash: FIXTURE.storageHash,
    storageProof: [{ key: FIXTURE.slot, value: FIXTURE.slotValue, proof: FIXTURE.slotProof }],
  };
}

test("checkProofWindow warns once when no RPC serves eth_getProof 300 blocks back", async () => {
  const lines: string[] = [];
  const log = createLogger("sealed-test", "debug", (l) => lines.push(l));
  const asked: unknown[] = [];
  const pruned = fixtureClient((r) => {
    if (r.method !== "eth_getProof") return undefined;
    asked.push(r.params[2]);
    throw new Error("distance to target block exceeds maximum proof window");
  });
  assert.equal(await checkProofWindow([pruned, pruned], target, 1000n, log), false);
  assert.deepEqual(asked, ["0x2bc", "0x2bc"], "both RPCs are asked for head - 300");
  const warns = lines.filter((l) => l.includes(" WARN "));
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /archive/);
  assert.match(warns[0]!, /maximum proof window/);

  lines.length = 0;
  assert.equal(await checkProofWindow([pruned, fixtureClient()], target, 1000n, log), true, "one archive fallback is enough");
  assert.equal(await checkProofWindow([fixtureClient()], target, 100n, log), true, "a chain younger than 300 blocks asks for block 0");
  assert.deepEqual(lines, []);
});

test("a proveMany batch is capped at half a block and 5/6 of EIP-7825's per-transaction limit", () => {
  assert.equal(TX_GAS_CAP, 16_777_216n);
  assert.equal(batchGasCap(20_000_000n), 10_000_000n);
  assert.equal(batchGasCap(30_000_000n), 13_981_013n);
  assert.equal(batchGasCap(60_000_000n), 13_981_013n);
  assert.ok((batchGasCap(60_000_000n) * 12n) / 10n <= TX_GAS_CAP, "the padded batch still fits one transaction");
  assert.equal(txGasLimit(20_000_000n, 60_000_000n), TX_GAS_CAP);
  assert.equal(txGasLimit(20_000_000n, 15_000_000n), 15_000_000n);
  assert.equal(txGasLimit(1_000_000n, 60_000_000n), 1_000_000n);
});

test("fitBatch halves on an estimate over the cap and on a failed estimate, but not on UnknownBlockHash", async () => {
  const proofs = Array.from({ length: 16 }, (_, i) => i);
  const tried: number[] = [];
  const perProof = async (ps: number[]) => {
    tried.push(ps.length);
    return BigInt(ps.length) * 720_000n;
  };
  const fit = await fitBatch(proofs, 3_000_000n, perProof);
  assert.deepEqual(tried, [16, 8, 4]);
  assert.deepEqual(fit, { proofs: [0, 1, 2, 3], estimate: 2_880_000n });

  tried.length = 0;
  const capped = async (ps: number[]) => {
    tried.push(ps.length);
    if (ps.length > 2) throw new Error("gas required exceeds allowance (25000000)");
    return 1_440_000n;
  };
  assert.deepEqual(await fitBatch(proofs, 13_981_013n, capped), { proofs: [0, 1], estimate: 1_440_000n });
  assert.deepEqual(tried, [16, 8, 4, 2], "a failed estimate halves the batch instead of retrying it whole");

  await assert.rejects(
    fitBatch([0], 13_981_013n, async () => {
      throw new Error("gas required exceeds allowance");
    }),
    /exceeds allowance/,
    "a single proof that fails throws",
  );

  tried.length = 0;
  const unknown = async (ps: number[]) => {
    tried.push(ps.length);
    throw new ContractFunctionRevertedError({
      abi: sealedPoolOracleImplAbi,
      functionName: "proveMany",
      data: encodeErrorResult({ abi: sealedPoolOracleImplAbi, errorName: "UnknownBlockHash", args: [5n] }),
    });
  };
  await assert.rejects(fitBatch(proofs, 13_981_013n, unknown), /UnknownBlockHash/);
  assert.deepEqual(tried, [16], "UnknownBlockHash throws at once, the next tick checkpoints first");
});

/* Anvil with a PoolManager, a hookless pool and SealedPoolOracle */

const ARTIFACTS = {
  poolManager: ["PoolManager.sol", "PoolManager"],
  demoToken: ["DemoToken.sol", "DemoToken"],
  steerer: ["PriceSteerer.sol", "PriceSteerer"],
  oracle: ["SealedPoolOracle.sol", "SealedPoolOracle"],
} as const;

/** Runtime code that returns 32 zero bytes, EIP-2935 as seen past its window */
const RETURNS_ZERO: Hex = "0x60206000f3";

test("anvil: the sealed bot pokes every block and proves every gap", async (t) => {
  const anvil = findAnvil();
  const arts = Object.fromEntries(Object.entries(ARTIFACTS).map(([k, [f, n]]) => [k, loadArtifact(f, n)])) as Record<
    keyof typeof ARTIFACTS,
    Artifact | undefined
  >;
  if (!anvil || Object.values(arts).some((a) => !a)) {
    t.skip("needs anvil and `forge build` artifacts");
    return;
  }
  const a = arts as Record<keyof typeof ARTIFACTS, Artifact>;
  const url = await startAnvil(t, anvil, ["--disable-code-size-limit"]);
  const made = makeClients({ rpcUrl: url, chainId: 31337, privateKey: { key: ANVIL_KEY, source: "test" } });
  // Anvil mines on every transaction, so receipts are polled every 50 ms rather than every 500
  const c = { ...made, publicClient: createPublicClient({ chain: made.chain, transport: http(url), pollingInterval: 50 }) };
  const testClient = createTestClient({ mode: "anvil", chain: c.chain, transport: http(url) });
  // Poke and prove require every block one second after its parent, as on Unichain
  await testClient.setBlockTimestampInterval({ interval: 1 });
  const me = c.account!.address;
  const lines: string[] = [];
  const log = createLogger("sealed-test", "debug", (l) => lines.push(l));

  const pm = await deploy(c, a.poolManager, [me]);
  const steerer = await deploy(c, a.steerer, [pm, me]);
  const weth = await deploy(c, a.demoToken, ["Demo WETH", "dWETH", 18, 0n, 0n, me]);
  const usdc = await deploy(c, a.demoToken, ["Demo USDC", "dUSDC", 6, 0n, 0n, me]);
  for (const tok of [weth, usdc]) await send(c, tok, a.demoToken.abi, "setMinter", [steerer, true]);
  const [currency0, currency1] = sortTokens(weth, usdc);
  const key: PoolKey = { currency0, currency1, fee: 500, tickSpacing: 10, hooks: zeroAddress };
  const o = orientationFor(key, weth, 18, 6);
  await send(c, pm, a.poolManager.abi, "initialize", [key, sqrtPriceX96FromPrice({ num: 2700n, den: 1n }, o)]);
  await send(c, steerer, a.steerer.abi, "addLiquidityFullRange", [key, 10n ** 15n]);
  const sign = o.baseIsToken0 ? 1 : -1;
  const oracle = await deploy(c, a.oracle, [
    pm,
    key,
    sign,
    12,
    1, // blockTime
    3, // maxStaleBlocks
    60, // grid seconds
    60,
    3,
    400,
    varE36FromAnnualVol("0.2"),
    varE36FromAnnualVol("2.5"),
    varE36FromAnnualVol("0.6"),
    1024,
  ]);
  const slot = poolStateSlot(poolId(key));

  const makeBot = () =>
    new SealedBot({ clients: c, oracle, batch: 16, dryRun: false, txTimeoutMs: 20_000, log });
  const frontier = () => read<bigint>(c, oracle, sealedPoolOracleAbi, "frontier");
  const head = () => c.publicClient.getBlockNumber({ cacheTime: 0 });

  let step = 0;
  /** Steers the pool a few basis points up or down, off any exact tick price, in one block */
  const swap = async () => {
    const bps = [37n, -53n, 21n, -12n, 44n, -31n][step++ % 6]!;
    const word = await read<Hex>(c, pm, poolManagerAbi, "extsload", [slot]);
    const sp = decodeSlot0(word).sqrtPriceX96;
    await send(c, steerer, a.steerer.abi, "steer", [key, (sp * (20_000n + bps)) / 20_000n + 7n]);
  };

  const endTicks = new Map<bigint, number>();
  const endTick = async (n: bigint) => {
    let tick = endTicks.get(n);
    if (tick === undefined) {
      const word = await c.publicClient.readContract({
        address: pm,
        abi: poolManagerAbi,
        functionName: "extsload",
        args: [slot],
        blockNumber: n,
      });
      tick = decodeSlot0(word).tick;
      endTicks.set(n, tick);
    }
    return sign > 0 ? tick : -tick - 1;
  };

  /** Every Sealed and Proven block equals the pool's end-of-block tick, and they cover [first, frontier] with no gap. */
  const assertHistory = async (): Promise<{ sealed: number; proven: number; provenAt: Map<bigint, bigint> }> => {
    const opts = { address: oracle, abi: sealedPoolOracleAbi, fromBlock: 0n } as const;
    const sealedLogs = await c.publicClient.getContractEvents({ ...opts, eventName: "Sealed" });
    const provenLogs = await c.publicClient.getContractEvents({ ...opts, eventName: "Proven" });
    const covered = new Set<bigint>();
    const provenAt = new Map<bigint, bigint>();
    for (const l of provenLogs) {
      const n = l.args.blockNumber!;
      assert.equal(l.args.normTick, await endTick(n), `proven block ${n}`);
      covered.add(n);
      provenAt.set(n, l.blockNumber);
    }
    for (const l of sealedLogs) {
      for (let j = l.args.fromBlock!; j <= l.args.toBlock!; j++) {
        assert.equal(l.args.normTick, await endTick(j), `sealed block ${j} in [${l.args.fromBlock}, ${l.args.toBlock}]`);
        covered.add(j);
      }
    }
    const f = await frontier();
    const first = [...covered].reduce((m, n) => (n < m ? n : m), f);
    for (let j = first; j <= f; j++) assert.ok(covered.has(j), `block ${j} is applied`);
    return { sealed: sealedLogs.length, proven: provenLogs.length, provenAt };
  };

  /** One idle block, then a tick whose poke seals it, so the frontier is exactly head - 1 */
  const settle = async (bot: SealedBot) => {
    await testClient.mine({ blocks: 1 });
    const r = await bot.tick();
    assert.equal(r.poked, true);
    assert.equal(r.frontier, (await head()) - 1n, "frontier is head - 1 after an idle poke");
    assert.equal(await frontier(), r.frontier);
  };

  const tickUntilCaughtUp = async (bot: SealedBot, max: number): Promise<SealedTick[]> => {
    const ticks: SealedTick[] = [];
    for (;;) {
      const r = await bot.tick();
      ticks.push(r);
      if (r.caughtUp) return ticks;
      assert.ok(ticks.length < max, `caught up within ${max} ticks (frontier ${r.frontier}, target ${r.target})`);
    }
  };

  await t.test("keeps the frontier at head - 1 while a swap every 3 blocks breaks the seal", async () => {
    const bot = makeBot();
    await testClient.mine({ blocks: 1 });
    const first = await bot.tick();
    assert.equal(first.poked, true, "the first poke takes a snapshot");
    await testClient.mine({ blocks: 1 });
    const second = await bot.tick();
    assert.equal(second.caughtUp, true, "the second poke seals and starts the oracle");

    let proven = 0;
    for (let i = 0; i < 60; i++) {
      if (i % 3 === 0) await swap();
      else await testClient.mine({ blocks: 1 });
      const r = await bot.tick();
      assert.equal(r.poked, true, `tick ${i} pokes the new block`);
      assert.ok(r.caughtUp, `tick ${i}: frontier ${r.frontier} reached ${r.target}`);
      proven += r.proven;
    }
    assert.ok(proven >= 20, `every swap left blocks to prove (${proven})`);
    const again = await bot.tick();
    assert.equal(again.poked, false, "no second poke in the same block");
    await settle(bot);
    const h = await assertHistory();
    assert.ok(h.sealed > 0 && h.proven > 0, "both seals and proofs were applied");
  });

  await t.test("catches up after 300-block outage", async () => {
    const f0 = await frontier();
    for (let i = 0; i < 100; i++) {
      await swap();
      await testClient.mine({ blocks: 2 });
    }
    assert.ok((await head()) - f0 > 300n);
    const bot = makeBot();
    const ticks = await tickUntilCaughtUp(bot, 30);
    assert.ok(ticks.reduce((s, r) => s + r.proven, 0) >= 300, "every block of the outage was proven");
    await settle(bot);
    const { provenAt } = await assertHistory();
    const at = provenAt.get(f0 + 1n);
    assert.ok(at !== undefined && at - (f0 + 1n) > 256n, "the oldest block was proven past BLOCKHASH's reach, via EIP-2935");
    assert.equal(ticks.reduce((s, r) => s + r.checkpointed, 0), 0, "no checkpoints while EIP-2935 has the hashes");
  });

  await t.test("catches up through checkpointHeaders when EIP-2935 serves nothing", async () => {
    assert.notEqual(await c.publicClient.getCode({ address: HISTORY_ADDRESS }), undefined, "anvil runs EIP-2935");
    // The last sub-test, so the chain keeps this code until anvil stops
    await testClient.setCode({ address: HISTORY_ADDRESS, bytecode: RETURNS_ZERO });
    // anvil_setCode rewrites the latest block's state in place, so only a seal can cover that block
    await settle(makeBot());
    const f0 = await frontier();
    for (let i = 0; i < 100; i++) {
      await swap();
      await testClient.mine({ blocks: 2 });
    }
    const bot = makeBot();
    const ticks = await tickUntilCaughtUp(bot, 40);
    assert.ok(ticks.reduce((s, r) => s + r.checkpointed, 0) > 0, "headers were checkpointed");
    const cps = await c.publicClient.getContractEvents({
      address: oracle,
      abi: sealedPoolOracleImplAbi,
      eventName: "HeadersCheckpointed",
      fromBlock: 0n,
    });
    assert.ok(cps.some((l) => l.args.oldest! <= f0 + 1n), "the walk reached the first missing block");
    await settle(bot);
    await assertHistory();
    assert.ok(lines.some((l) => l.includes("] checkpointed ")));
  });
});
