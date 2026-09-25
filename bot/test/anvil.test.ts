import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  concatHex,
  createTestClient,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  numberToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { predictionHookAbi } from "../src/abi.ts";
import { makeClients, readSlot0, type Clients } from "../src/chain.ts";
import { loadMarketTemplate, loadMirrorConfig } from "../src/config.ts";
import { hookOperator, invalidAfterFor, Keeper, keeperTick } from "../src/keeper.ts";
import { createLogger } from "../src/log.ts";
import { buildMarketParams, varE36FromAnnualVol } from "../src/market.ts";
import { formatRational, lnWad, type Rational } from "../src/math.ts";
import { mirrorTick, setupMirror, steerGasLimit } from "../src/mirror.ts";
import { orientationFor, sqrtPriceX96FromPrice, priceFromSqrtPriceX96, type PoolKey } from "../src/pricing.ts";
import { loadArtifact, type Artifact } from "./helpers/artifacts.ts";

/** Anvil's first default account (public test key). */
const ANVIL_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function findAnvil(): string | undefined {
  const dirs = [process.env.ANVIL_BIN ? resolve(process.env.ANVIL_BIN, "..") : "", resolve(homedir(), ".foundry", "bin")];
  dirs.push(...(process.env.PATH ?? "").split(":"));
  return dirs.map((d) => resolve(d, "anvil")).find((p) => existsSync(p));
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? res(addr.port) : rej(new Error("no port"))));
    });
  });
}

async function waitForRpc(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("anvil did not start");
}

const ARTIFACTS = {
  poolManager: ["PoolManager.sol", "PoolManager"],
  demoToken: ["DemoToken.sol", "DemoToken"],
  steerer: ["PriceSteerer.sol", "PriceSteerer"],
  hook: ["MockPredictionHook.sol", "MockPredictionHook"],
  oracle: ["MockUnderlyingOracle.sol", "MockUnderlyingOracle"],
  sobHook: ["MockSobHook.sol", "MockSobHook"],
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

async function deploy(c: Clients, art: Artifact, args: readonly unknown[]): Promise<Address> {
  const hash = await c.walletClient!.deployContract({ abi: art.abi, bytecode: art.bytecode, args } as never);
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
  assert.ok(receipt.contractAddress);
  return getAddress(receipt.contractAddress);
}

async function send(c: Clients, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<void> {
  const hash = await c.walletClient!.writeContract({ address, abi, functionName, args } as never);
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", functionName);
}

function read<T>(c: Clients, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return c.publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>;
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
  const port = await freePort();
  const proc = spawn(anvil, ["--port", String(port), "--silent", "--disable-code-size-limit"], { stdio: "ignore" });
  t.after(() => proc.kill());
  const url = `http://127.0.0.1:${port}`;
  await waitForRpc(url);

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
      assert.equal(ctx.orientation.baseIsToken0, o.baseIsToken0);
      assert.deepEqual(ctx.key, key);
      const pinned = loadMirrorConfig({
        DEPLOYMENTS_FILE: file,
        DEPLOYER_PRIVATE_KEY: ANVIL_KEY,
        UNDERLYING_POOL_FEE: String(fee === 500 ? 3000 : 500),
      });
      await assert.rejects(setupMirror(pinned, log), /differs from the oracle's/);

      let feed = "2701.35";
      ctx.getPrice = async () => ({ quote: { source: "coinbase", raw: feed, price: price(feed) }, failures: [] });

      const expectAt = async (s: string) => {
        const slot0 = await readSlot0(c.publicClient, pm, key);
        assert.equal(slot0.sqrtPriceX96, sqrtPriceX96FromPrice(price(s), o), `pool at ${s}`);
        assert.equal(formatRational(priceFromSqrtPriceX96(slot0.sqrtPriceX96, o), 2), s);
      };

      await testClient.increaseTime({ seconds: 1 });
      await testClient.mine({ blocks: 1 });
      const up = await mirrorTick(ctx);
      assert.equal(up.decision.action, "steer");
      assert.ok(up.hash);
      await expectAt("2701.35");
      const [tx, receipt] = await Promise.all([
        c.publicClient.getTransaction({ hash: up.hash }),
        c.publicClient.getTransactionReceipt({ hash: up.hash }),
      ]);
      assert.ok(tx.gas >= steerGasLimit(receipt.gasUsed), "steer gas is padded");
      assert.equal(await read<bigint>(c, hook, a.sobHook.abi, "writes"), 1n, "hook wrote on the steer");

      feed = "2701.40";
      const hold = await mirrorTick(ctx);
      assert.equal(hold.decision.action, "hold");
      assert.equal(hold.hash, undefined);
      await expectAt("2701.35");

      feed = "2650.07";
      const down = await mirrorTick(ctx);
      assert.equal(down.decision.action, "steer");
      await expectAt("2650.07");
    }
    assert.ok(lines.some((l) => l.includes("] steered ")));
  });

  await t.test("keeper: create, settle, sweep, invalid fallback, budget guard", async () => {
    const template = loadMarketTemplate({});
    const oracle = await deploy(c, a.oracle, []);
    const lnSpot = lnWad(price("2701.347"));
    await send(c, oracle, a.oracle.abi, "set", [lnSpot, varE36FromAnnualVol("0.6"), true]);
    const hook = await deploy(c, a.hook, ["0x31d0220469e10c4E71834a79b1f276d740d3768F", 100_000000n]);
    const keeper = new Keeper({
      clients: c,
      hook,
      oracle,
      template,
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
    const stored = await read<unknown>(c, hook, a.hook.abi, "marketParams", [0n]);
    assert.deepEqual(stored, buildMarketParams(oracle, lnSpot, now, template).params, "struct round-trips through Solidity");
    const info0 = await read<{ expiry: bigint; status: number }>(c, hook, predictionHookAbi as Abi, "marketInfo", [0n]);
    assert.equal(info0.expiry, now + 60n);
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

    assert.equal(await hookOperator(c.publicClient, hook), me, "owner when no keeper is set");
    assert.equal(await invalidAfterFor(c.publicClient, hook, 0), 31, "GRACE + 1");
    assert.equal(await invalidAfterFor(c.publicClient, hook, 100), 100);
    const keyless = makeClients({ rpcUrl: url, chainId: 31337 });
    const dry = new Keeper({ ...keeper.opts, clients: keyless, dryRun: true, sender: me });
    assert.equal(await dry.createMarket((await c.publicClient.getBlock()).timestamp), 2n, "dry run simulates as the owner");
    const stranger = new Keeper({ ...keeper.opts, clients: keyless, dryRun: true, sender: "0x000000000000000000000000000000000000dEaD" });
    await assert.rejects(stranger.createMarket((await c.publicClient.getBlock()).timestamp), /reverted/, "simulates as `sender`");
    assert.equal(await read<bigint>(c, hook, a.hook.abi, "marketCount"), 2n, "dry runs send nothing");

    const greedy = new Keeper({ ...keeper.opts, template: { ...template, budget: 1_000_000000n } });
    assert.equal(await greedy.createMarket((await c.publicClient.getBlock()).timestamp), undefined);
    assert.ok(lines.some((l) => l.includes("vault idle below market budget")));

    await greedy.refresh();
    assert.equal(greedy.tracked.size, 0);
    assert.deepEqual([...greedy.done].sort(), [0n, 1n]);
  });
});
