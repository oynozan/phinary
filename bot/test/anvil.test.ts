import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  concatHex,
  createTestClient,
  encodeAbiParameters,
  getContractAddress,
  http,
  keccak256,
  numberToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { marketSchedulerAbi, predictionHookAbi } from "../src/abi.ts";
import { makeClients, readSlot0, type Clients } from "../src/chain.ts";
import { loadMirrorConfig } from "../src/config.ts";
import { invalidAfterFor, isAlreadyOpened, Keeper, keeperGasLimit, keeperTick, schedulerPeriodFor } from "../src/keeper.ts";
import { createLogger } from "../src/log.ts";
import { lnStrikeWadFromCents, strikeCentsFromLnSpot, varE36FromAnnualVol } from "../src/market.ts";
import { formatRational, lnWad, type Rational } from "../src/math.ts";
import { mirrorTick, setupMirror, steerGasLimit } from "../src/mirror.ts";
import { orientationFor, poolId, sqrtPriceX96FromPrice, priceFromSqrtPriceX96, type PoolKey } from "../src/pricing.ts";
import { ANVIL_KEY, deploy, findAnvil, read, send, startAnvil } from "./helpers/anvil.ts";
import { loadArtifact, type Artifact } from "./helpers/artifacts.ts";

const ARTIFACTS = {
  poolManager: ["PoolManager.sol", "PoolManager"],
  demoToken: ["DemoToken.sol", "DemoToken"],
  steerer: ["PriceSteerer.sol", "PriceSteerer"],
  hook: ["MockPredictionHook.sol", "MockPredictionHook"],
  oracle: ["MockUnderlyingOracle.sol", "MockUnderlyingOracle"],
  sobHook: ["MockSobHook.sol", "MockSobHook"],
  /** The real Task 3 scheduler; MockPredictionHook stands in for the PredictionHook it owns. */
  scheduler: ["MarketScheduler.sol", "MarketScheduler"],
} as const;

/** Anvil's predeployed CREATE2 factory (input: salt ++ initcode). */
const CREATE2_FACTORY: Address = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
/** v4 hook flags AFTER_INITIALIZE | BEFORE_SWAP, the oracle's permissions. */
const ORACLE_FLAGS = 0x1080n;

/** Deploys `art` through the CREATE2 factory at an address whose low 14 bits are `flags`. */
async function deployHook(c: Clients, art: Artifact, args: Hex, flags: bigint): Promise<Address> {
  const initcode = concatHex([art.bytecode, args]);
  const bytecodeHash = keccak256(initcode);
  for (let i = 0n; ; i++) {
    const salt = numberToHex(i, { size: 32 });
    const at = getContractAddress({ from: CREATE2_FACTORY, salt, bytecodeHash, opcode: "CREATE2" });
    if ((BigInt(at) & 0x3fffn) !== flags || (await c.publicClient.getCode({ address: at })) !== undefined) continue;
    const hash = await c.walletClient!.sendTransaction({ to: CREATE2_FACTORY, data: concatHex([salt, initcode]) });
    assert.equal((await c.publicClient.waitForTransactionReceipt({ hash })).status, "success");
    assert.notEqual(await c.publicClient.getCode({ address: at }), undefined);
    return at;
  }
}

const price = (s: string): Rational => {
  const [i, f = ""] = s.split(".");
  return { num: BigInt(`${i}${f}`), den: 10n ** BigInt(f.length) };
};

test("anvil: mirror steers the real pool and keeper drives a market lifecycle", async (t) => {
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

  const c = makeClients({ rpcUrl: url, chainId: 31337, privateKey: { key: ANVIL_KEY, source: "test" } });
  const me = c.account!.address;
  const testClient = createTestClient({ mode: "anvil", chain: c.chain, transport: http(url) });
  const lines: string[] = [];
  const log = createLogger("test", "debug", (l) => lines.push(l));

  await t.test("mirror: both token orderings through a hooked pool, up and down, exact targets", async () => {
    const pm = await deploy(c, a.poolManager, [me]);
    const steerer = await deploy(c, a.steerer, [pm, me]);
    const pairs: { weth: Address; usdc: Address }[] = [];
    const seen = new Set<boolean>();
    for (let i = 0; i < 12 && seen.size < 2; i++) {
      const weth = await deploy(c, a.demoToken, ["Demo WETH", "dWETH", 18, 0n, 0n, me]);
      const usdc = await deploy(c, a.demoToken, ["Demo USDC", "dUSDC", 6, 0n, 0n, me]);
      const wethIs0 = BigInt(weth) < BigInt(usdc);
      if (seen.has(wethIs0)) continue;
      seen.add(wethIs0);
      pairs.push({ weth, usdc });
    }
    assert.equal(pairs.length, 2, "found both orderings");

    for (const [i, { weth, usdc }] of pairs.entries()) {
      for (const tok of [weth, usdc]) await send(c, tok, a.demoToken.abi, "setMinter", [steerer, true]);
      const [currency0, currency1] = BigInt(weth) < BigInt(usdc) ? [weth, usdc] : [usdc, weth];
      const hook = await deployHook(c, a.sobHook, encodeAbiParameters([{ type: "address" }], [pm]), ORACLE_FLAGS);
      // The second pool uses non-default fee/spacing: the mirror must take the key from the hook's poolKey()
      const [fee, tickSpacing] = i === 0 ? [500, 10] : [3000, 60];
      const key: PoolKey = { currency0, currency1, fee, tickSpacing, hooks: hook };
      const o = orientationFor(key, weth, 18, 6);
      await send(c, pm, a.poolManager.abi, "initialize", [key, sqrtPriceX96FromPrice(price("2000"), o)]);
      await send(c, steerer, a.steerer.abi, "addLiquidityFullRange", [key, 10n ** 15n]);

      const dir = mkdtempSync(join(tmpdir(), "bot-deploy-"));
      const file = join(dir, "deployments.json");
      writeFileSync(
        file,
        JSON.stringify({
          chainId: 31337,
          rpcUrl: url,
          poolManager: pm,
          priceSteerer: steerer,
          demoWeth: weth,
          demoUsdc: usdc,
          underlyingOracle: hook,
        }),
      );
      const cfg = loadMirrorConfig({ DEPLOYMENTS_FILE: file, DEPLOYER_PRIVATE_KEY: ANVIL_KEY, MIRROR_THRESHOLD_BPS: "2" });
      const ctx = await setupMirror(cfg, log);
      assert.equal(ctx.targets.length, 1, "no underlyings: the single ETH pool from the flat keys");
      const eth = ctx.targets[0]!;
      assert.equal(eth.symbol, "ETH");
      assert.equal(eth.orientation.baseIsToken0, o.baseIsToken0);
      assert.deepEqual(eth.key, key);
      const pinned = loadMirrorConfig({
        DEPLOYMENTS_FILE: file,
        DEPLOYER_PRIVATE_KEY: ANVIL_KEY,
        UNDERLYING_POOL_FEE: String(fee === 500 ? 3000 : 500),
      });
      await assert.rejects(setupMirror(pinned, log), /differs from the oracle's/);

      let feed = "2701.35";
      eth.getPrice = async () => ({ quote: { symbol: "ETH", source: "coinbase", raw: feed, price: price(feed) }, failures: [] });

      const expectAt = async (s: string) => {
        const slot0 = await readSlot0(c.publicClient, pm, key);
        assert.equal(slot0.sqrtPriceX96, sqrtPriceX96FromPrice(price(s), o), `pool at ${s}`);
        assert.equal(formatRational(priceFromSqrtPriceX96(slot0.sqrtPriceX96, o), 2), s);
      };

      await testClient.increaseTime({ seconds: 1 });
      await testClient.mine({ blocks: 1 });
      const [up] = await mirrorTick(ctx);
      assert.equal(up!.decision?.action, "steer");
      assert.ok(up!.hash);
      await expectAt("2701.35");
      const [tx, receipt] = await Promise.all([
        c.publicClient.getTransaction({ hash: up!.hash }),
        c.publicClient.getTransactionReceipt({ hash: up!.hash }),
      ]);
      assert.ok(tx.gas >= steerGasLimit(receipt.gasUsed), "steer gas is padded");
      assert.equal(await read<bigint>(c, hook, a.sobHook.abi, "writes"), 1n, "hook wrote on the steer");

      feed = "2701.40";
      const [hold] = await mirrorTick(ctx);
      assert.equal(hold!.decision?.action, "hold");
      assert.equal(hold!.hash, undefined);
      await expectAt("2701.35");

      feed = "2650.07";
      const [down] = await mirrorTick(ctx);
      assert.equal(down!.decision?.action, "steer");
      await expectAt("2650.07");
    }
    assert.ok(lines.some((l) => l.includes("] steered ")));
  });

  await t.test("mirror: one process steers ETH and SOL pools listed in underlyings, with consecutive nonces", async () => {
    const pm = await deploy(c, a.poolManager, [me]);
    const steerer = await deploy(c, a.steerer, [pm, me]);
    const usdc = await deploy(c, a.demoToken, ["Demo USDC", "dUSDC", 6, 0n, 0n, me]);
    const assets = [
      { symbol: "ETH", decimals: 18, start: "2000", feed: "2701.35" },
      { symbol: "SOL", decimals: 9, start: "150", feed: "148.27" },
    ];
    const pools: { symbol: string; token: Address; oracle: Address; key: PoolKey; o: ReturnType<typeof orientationFor>; feed: string }[] = [];
    await send(c, usdc, a.demoToken.abi, "setMinter", [steerer, true]);
    for (const asset of assets) {
      const token = await deploy(c, a.demoToken, [`Demo ${asset.symbol}`, `d${asset.symbol}`, asset.decimals, 0n, 0n, me]);
      await send(c, token, a.demoToken.abi, "setMinter", [steerer, true]);
      const oracle = await deployHook(c, a.sobHook, encodeAbiParameters([{ type: "address" }], [pm]), ORACLE_FLAGS);
      const [currency0, currency1] = BigInt(token) < BigInt(usdc) ? [token, usdc] : [usdc, token];
      const key: PoolKey = { currency0, currency1, fee: 500, tickSpacing: 10, hooks: oracle };
      const o = orientationFor(key, token, asset.decimals, 6);
      await send(c, pm, a.poolManager.abi, "initialize", [key, sqrtPriceX96FromPrice(price(asset.start), o)]);
      await send(c, steerer, a.steerer.abi, "addLiquidityFullRange", [key, 10n ** 15n]);
      pools.push({ symbol: asset.symbol, token, oracle, key, o, feed: asset.feed });
    }
    const dir = mkdtempSync(join(tmpdir(), "bot-deploy-"));
    const file = join(dir, "deployments.json");
    writeFileSync(
      file,
      JSON.stringify({
        chainId: 31337,
        rpcUrl: url,
        poolManager: pm,
        priceSteerer: steerer,
        demoUsdc: usdc,
        underlyings: pools.map((p) => ({ symbol: p.symbol, token: p.token, oracle: p.oracle, pool: p.key, poolId: poolId(p.key) })),
      }),
    );
    const cfg = loadMirrorConfig({ DEPLOYMENTS_FILE: file, DEPLOYER_PRIVATE_KEY: ANVIL_KEY });
    const ctx = await setupMirror(cfg, log);
    assert.deepEqual(ctx.targets.map((x) => x.symbol), ["ETH", "SOL"]);
    for (const [i, p] of pools.entries()) {
      const target = ctx.targets[i]!;
      assert.deepEqual(target.key, p.key);
      assert.deepEqual(target.orientation, p.o);
      target.getPrice = async () => ({ quote: { symbol: p.symbol, source: "coinbase", raw: p.feed, price: price(p.feed) }, failures: [] });
    }
    const nonceBefore = await c.publicClient.getTransactionCount({ address: me });
    const results = await mirrorTick(ctx);
    assert.deepEqual(results.map((r) => [r.symbol, r.decision?.action, r.error]), [["ETH", "steer", undefined], ["SOL", "steer", undefined]]);
    const txs = await Promise.all(results.map((r) => c.publicClient.getTransaction({ hash: r.hash! })));
    assert.deepEqual(txs.map((x) => x.nonce), [nonceBefore, nonceBefore + 1]);
    for (const p of pools) {
      const slot0 = await readSlot0(c.publicClient, pm, p.key);
      assert.equal(slot0.sqrtPriceX96, sqrtPriceX96FromPrice(price(p.feed), p.o), `${p.symbol} pool at ${p.feed}`);
    }
    assert.ok(lines.some((l) => /\] steered symbol=SOL /.test(l)));
  });

  await t.test("keeper: create, settle, sweep and invalid fallback through the Task 3 scheduler pair", async () => {
    const QUOTE = { h0Wad: 2n * 10n ** 16n, gammaSWad: 5n * 10n ** 13n, lambdaWad: 10n ** 15n, qEpochMax: 100_000000n, pMinWad: 2n * 10n ** 16n };
    // period=1 so slot === block.timestamp: expiry stays "now + tenor" like the old fixed-openTime market did.
    const CONFIG = { period: 1, tenor: 60, window: 10, cutoffBuffer: 2, nSamples: 10, quote: QUOTE, maxBudget: 10_000000n, minBudget: 1_000000n, ticker: "ETH" };
    const oracle = await deploy(c, a.oracle, []);
    const lnSpot = lnWad(price("2701.347"));
    await send(c, oracle, a.oracle.abi, "set", [lnSpot, varE36FromAnnualVol("0.6"), true]);

    // MarketScheduler's constructor takes the hook's address, and the mock hook's constructor takes the scheduler's
    // address as owner: the scheduler is predicted from the deployer's next nonce, the hook is deployed with that as
    // owner, then the scheduler is deployed and lands at the predicted address. Task 3's SchedulerPair.sol does the
    // same dance with a CREATE2-mined hook (for its address flags); MockPredictionHook needs no flags, so a plain
    // CREATE (the next nonce) is enough here.
    const nonce = await c.publicClient.getTransactionCount({ address: me });
    const predicted = getContractAddress({ from: me, nonce: BigInt(nonce) + 1n });
    const hook = await deploy(c, a.hook, [predicted, "0x31d0220469e10c4E71834a79b1f276d740d3768F", 100_000000n]);
    const scheduler = await deploy(c, a.scheduler, [hook, oracle, CONFIG]);
    assert.equal(scheduler, predicted, "scheduler landed at the predicted nonce address");
    assert.equal(await read<Address>(c, hook, a.hook.abi, "owner"), scheduler, "hook owner is the scheduler");
    assert.equal(await schedulerPeriodFor(c.publicClient, scheduler, 60), 1, "the keeper reads the scheduler's own period");

    const keeper = new Keeper({
      clients: c,
      hook,
      scheduler,
      periodSec: 60,
      alignToPeriod: false,
      scanBack: 50,
      invalidAfterSec: 40,
      dryRun: false,
      txTimeoutMs: 10_000,
      log,
    });

    const now = (await c.publicClient.getBlock()).timestamp;
    const id = await keeper.createMarket(now);
    assert.equal(id, 0n);
    // `now` is read before open()'s transaction, which can land a block later, so openTime is derived from the
    // block that actually mined the MarketOpened event rather than from that pre-read clock.
    const [openedLog] = await c.publicClient.getContractEvents({
      address: scheduler,
      abi: marketSchedulerAbi,
      eventName: "MarketOpened",
      args: { marketId: id },
      fromBlock: 0n,
    });
    const openBlock = await c.publicClient.getBlock({ blockNumber: openedLog!.blockNumber });
    const openTx = await c.publicClient.getTransaction({ hash: openedLog!.transactionHash });
    const openReceipt = await c.publicClient.getTransactionReceipt({ hash: openedLog!.transactionHash });
    assert.ok(openTx.gas >= keeperGasLimit(openReceipt.gasUsed), "open() gas is padded");
    const cents = strikeCentsFromLnSpot(lnSpot);
    const stored = await read<{
      oracle: Address;
      lnStrikeWad: bigint;
      openTime: bigint;
      expiry: bigint;
      window: number;
      cutoffBuffer: number;
      nSamples: number;
      budget: bigint;
      quote: typeof QUOTE;
      sigmaMode: number;
      fixedVarE36: bigint;
      kernel: number;
      yesName: string;
      yesSymbol: string;
      noName: string;
      noSymbol: string;
    }>(c, hook, a.hook.abi, "marketParams", [0n]);
    assert.equal(stored.oracle, oracle);
    assert.equal(stored.lnStrikeWad, lnStrikeWadFromCents(cents), "strike is the scheduler's own MarketNames rounding");
    assert.equal(stored.openTime, openBlock.timestamp, "openTime is the block that mined open()'s transaction");
    // period=1 so slot === openTime; expiry = slot * period + tenor.
    assert.equal(stored.expiry, stored.openTime + 60n);
    assert.equal(stored.window, 10);
    assert.equal(stored.cutoffBuffer, 2);
    assert.equal(stored.nSamples, 10);
    assert.equal(stored.budget, 10_000000n, "min(maxBudget=10, vaultIdle/2=50)");
    assert.deepEqual(stored.quote, QUOTE);
    assert.equal(stored.sigmaMode, 0);
    assert.equal(stored.fixedVarE36, 0n);
    assert.equal(stored.kernel, 0);
    assert.equal(stored.yesSymbol, "ETHUP");
    assert.equal(stored.noSymbol, "ETHDOWN");
    assert.ok(stored.yesName.startsWith(`ETH > $${formatRational({ num: cents, den: 100n }, 2)}`), stored.yesName);
    const info0 = await read<{ expiry: bigint; status: number }>(c, hook, predictionHookAbi as Abi, "marketInfo", [0n]);
    assert.equal(info0.expiry, stored.openTime + 60n);
    assert.equal(keeper.tracked.has(0n), true);

    await keeper.settleAndSweep(now);
    assert.equal(keeper.tracked.get(0n)?.status, 1, "not due before expiry");

    await send(c, hook, a.hook.abi, "setOutstanding", [0n, 12_000000n, 3_000000n, 5_000000n]);
    await send(c, oracle, a.oracle.abi, "set", [lnWad(price("2710")), 0n, true]);
    await testClient.increaseTime({ seconds: 61 });
    await testClient.mine({ blocks: 1 });
    await keeperTick(keeper, { create: false, settle: true });
    const settled = await read<{ status: number; yesWon: boolean; bucket: bigint }>(c, hook, a.hook.abi, "marketInfo", [0n]);
    assert.equal(settled.status, 2);
    assert.equal(settled.yesWon, true);
    assert.equal(settled.bucket, 12_000000n, "surplus swept, winners still covered");
    assert.equal(await read<bigint>(c, hook, a.hook.abi, "vaultIdle"), 93_000000n);
    assert.equal(keeper.tracked.has(0n), false);

    const now1 = (await c.publicClient.getBlock()).timestamp;
    assert.equal(await keeper.createMarket(now1), 1n);
    await send(c, hook, a.hook.abi, "setBlockSettle", [true]);
    await testClient.increaseTime({ seconds: 65 });
    await testClient.mine({ blocks: 1 });
    await keeperTick(keeper, { create: false, settle: true });
    assert.equal(keeper.tracked.get(1n)?.status, 1, "settle blocked, invalid fallback not yet allowed");
    await testClient.increaseTime({ seconds: 40 });
    await testClient.mine({ blocks: 1 });
    await keeperTick(keeper, { create: false, settle: true });
    const invalid = await read<{ status: number; bucket: bigint }>(c, hook, a.hook.abi, "marketInfo", [1n]);
    assert.equal(invalid.status, 3);
    assert.equal(invalid.bucket, 0n);
    assert.equal(await read<bigint>(c, hook, a.hook.abi, "vaultIdle"), 93_000000n);

    assert.equal(await invalidAfterFor(c.publicClient, hook, 0), 31, "GRACE + 1");
    assert.equal(await invalidAfterFor(c.publicClient, hook, 100), 100);

    // open() is permissionless (no owner/keeper role, unlike the old createMarket): a dry run with no key and no
    // explicit sender still simulates successfully.
    const keyless = makeClients({ rpcUrl: url, chainId: 31337 });
    const dry = new Keeper({ ...keeper.opts, clients: keyless, dryRun: true });
    assert.equal(await dry.createMarket((await c.publicClient.getBlock()).timestamp), 2n, "no auth check: any account can simulate open()");
    assert.equal(await read<bigint>(c, hook, a.hook.abi, "marketCount"), 2n, "dry runs send nothing");
  });

  await t.test("createMarket: InsufficientIdle propagates and is not mistaken for AlreadyOpened", async () => {
    const oracle = await deploy(c, a.oracle, []);
    await send(c, oracle, a.oracle.abi, "set", [lnWad(price("2700")), varE36FromAnnualVol("0.6"), true]);
    const nonce = await c.publicClient.getTransactionCount({ address: me });
    const predicted = getContractAddress({ from: me, nonce: BigInt(nonce) + 1n });
    const hook = await deploy(c, a.hook, [predicted, "0x31d0220469e10c4E71834a79b1f276d740d3768F", 1_000000n]);
    const CONFIG = {
      period: 60,
      tenor: 120,
      window: 10,
      cutoffBuffer: 2,
      nSamples: 10,
      quote: { h0Wad: 2n * 10n ** 16n, gammaSWad: 5n * 10n ** 13n, lambdaWad: 10n ** 15n, qEpochMax: 100_000000n, pMinWad: 2n * 10n ** 16n },
      maxBudget: 10_000000n,
      minBudget: 5_000000n, // half of the 1 USDC vault (0.5) can never afford this
      ticker: "ETH",
    };
    const scheduler = await deploy(c, a.scheduler, [hook, oracle, CONFIG]);
    assert.equal(scheduler, predicted);
    const keeper = new Keeper({
      clients: c,
      hook,
      scheduler,
      periodSec: 60,
      alignToPeriod: false,
      scanBack: 50,
      invalidAfterSec: 3601,
      dryRun: true,
      txTimeoutMs: 10_000,
      log,
    });
    let submitted = false;
    const now = (await c.publicClient.getBlock()).timestamp;
    let threw: unknown;
    try {
      await keeper.createMarket(now, () => (submitted = true));
      assert.fail("expected InsufficientIdle");
    } catch (e) {
      threw = e;
    }
    assert.match(String(threw), /InsufficientIdle/);
    assert.equal(isAlreadyOpened(threw), false, "InsufficientIdle is not AlreadyOpened");
    assert.equal(submitted, false, "onSubmitted is not called for a real failure");
    assert.equal(await read<boolean>(c, scheduler, a.scheduler.abi, "canOpen"), false, "canOpen agrees");

    const before = lines.length;
    await keeperTick(keeper, { create: true, settle: false });
    await keeperTick(keeper, { create: true, settle: false });
    const refusals = lines.slice(before).filter((l) => l.includes("open() refused"));
    assert.equal(refusals.length, 1, "keeperTick warns once for the slot instead of failing every poll");
    assert.match(refusals[0]!, /WARN .*InsufficientIdle\(500000, 5000000\)/);
  });
});
