import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { getAddress, zeroAddress } from "viem";
import { poolId } from "../src/pricing.ts";
import {
  BOT_DIR,
  loadDeployments,
  loadEnvFiles,
  loadKeeperConfig,
  loadMirrorConfig,
  mirrorTargets,
  parseDeployments,
  readPrivateKey,
  requireAddress,
} from "../src/config.ts";

const EXAMPLE = resolve(BOT_DIR, "config", "unichain-sepolia.example.json");
const UNDERLYINGS = resolve(BOT_DIR, "test", "vectors", "deployments-underlyings.json");
const KEY = `0x${"ab".repeat(32)}`;
const WETH = getAddress("0xe000000000000000000000000000000000000001");
const USDC = getAddress("0x1000000000000000000000000000000000000002");
const ORACLE = getAddress("0x0000000000000000000000000000000000001080");

test("example deployments carry the chain-1301 constants from SPEC 4", () => {
  const d = loadDeployments(EXAMPLE);
  assert.equal(d.chainId, 1301);
  assert.equal(d.poolManager, "0x00B036B58a818B1BC34d502D3fE730Db729e62AC");
  assert.equal(d.v4Quoter, "0x56DCD40A3F2d466F48e7F48bDBE5Cc9B92Ae4472");
  assert.equal(d.permit2, "0x000000000022D473030F116dDEE9F6B43aC78BA3");
  assert.equal(d.usdc, "0x31d0220469e10c4E71834a79b1f276d740d3768F");
  assert.equal(d.universalRouter.toLowerCase(), "0xf70536b3bcc1bd1a972dc186a2cf84cc6da6be5d");
  assert.equal(d.predictionHook, zeroAddress);
  assert.throws(() => requireAddress(d, "predictionHook"), /not deployed.*PREDICTION_HOOK/);
});

test("the underlying pool key is derived from sorted demo tokens when not given", () => {
  const d = parseDeployments({ demoWeth: WETH, demoUsdc: USDC, underlyingOracle: ORACLE, underlyingPoolFee: 500 });
  assert.deepEqual(d.underlyingPool, {
    currency0: USDC,
    currency1: WETH,
    fee: 500,
    tickSpacing: 10,
    hooks: ORACLE,
  });
  assert.equal(d.underlyingPoolExplicit, true);
  const defaults = parseDeployments({ demoWeth: WETH, demoUsdc: USDC, underlyingOracle: ORACLE });
  assert.equal(defaults.underlyingPoolExplicit, false);
  assert.equal(defaults.underlyingPool.fee, 500);
  assert.equal(defaults.underlyingPool.tickSpacing, 10);
});

test("nested contracts, explicit pool keys and env overrides", () => {
  const d = parseDeployments(
    {
      chainId: 31337,
      contracts: { priceSteerer: ORACLE, demoWeth: WETH, demoUsdc: USDC },
      underlyingPool: { currency0: USDC, currency1: WETH, fee: "3000", tickSpacing: 10, hooks: zeroAddress },
    },
    { PRICE_STEERER: WETH },
  );
  assert.equal(d.chainId, 31337);
  assert.equal(d.priceSteerer, WETH);
  assert.equal(d.underlyingPool.tickSpacing, 10);
  assert.equal(d.underlyingPool.hooks, zeroAddress);
  assert.throws(() => parseDeployments({ underlyingPool: { currency0: WETH, currency1: USDC, fee: 0, tickSpacing: 1 } }), /sorted/);
  assert.throws(() => parseDeployments({ poolManager: "0x1234" }), /poolManager is not an address/);
});

test("private keys are validated without echoing them", () => {
  assert.equal(readPrivateKey({}, ["A"]), undefined);
  assert.deepEqual(readPrivateKey({ B: KEY.slice(2) }, ["A", "B"]), { key: KEY, source: "B" });
  assert.deepEqual(readPrivateKey({ A: KEY, B: `0x${"cd".repeat(32)}` }, ["A", "B"])?.source, "A");
  const secret = "0xdeadbeefnotakey";
  try {
    readPrivateKey({ A: secret }, ["A"]);
    assert.fail("should throw");
  } catch (e) {
    assert.match(String(e), /A is not a 32-byte hex private key/);
    assert.ok(!String(e).includes(secret));
  }
});

test("bot configs need a key unless dry-running", () => {
  const env = { DEPLOYMENTS_FILE: EXAMPLE };
  assert.throws(() => loadMirrorConfig({ ...env }), /MIRROR_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY/);
  const dry = loadMirrorConfig({ ...env, DRY_RUN: "1" });
  assert.equal(dry.privateKey, undefined);
  assert.equal(dry.rpcUrl, "https://sepolia.unichain.org");
  assert.deepEqual(dry.sources, ["coinbase", "kraken", "binanceus"]);
  const m = loadMirrorConfig({ ...env, DEPLOYER_PRIVATE_KEY: KEY, MIRROR_SOURCES: "kraken, binanceus", RPC_URL: "http://x" });
  assert.equal(m.privateKey?.source, "DEPLOYER_PRIVATE_KEY");
  assert.deepEqual(m.sources, ["kraken", "binanceus"]);
  assert.equal(m.rpcUrl, "http://x");
  const listed = loadMirrorConfig({ ...env, DRY_RUN: "1", RPC_URL: " https://a.example , https://b.example/v2/k, " });
  assert.equal(listed.rpcUrl, "https://a.example,https://b.example/v2/k", "primary first, fallbacks in order");
  assert.throws(() => loadMirrorConfig({ ...env, DRY_RUN: "1", RPC_URL: "https://a.example,wss://b" }), /RPC_URL must be comma-separated/);
  assert.throws(() => loadMirrorConfig({ ...env, DRY_RUN: "1", MIRROR_SOURCES: "ftx" }), /unknown sources: ftx/);
  const k = loadKeeperConfig({ ...env, KEEPER_PRIVATE_KEY: KEY, DEPLOYER_PRIVATE_KEY: `0x${"cd".repeat(32)}` });
  assert.equal(k.privateKey?.source, "KEEPER_PRIVATE_KEY");
  assert.equal(k.periodSec, 60);
  assert.equal(k.alignToPeriod, true);
  assert.equal(k.invalidAfterSec, 3601, "past PredictionHook.GRACE (1 h)");
});

test("loadEnvFiles never overrides variables that are already set", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, "A=from-file\nB=from-file\n# comment\n");
  const env: Record<string, string | undefined> = { A: "preset" };
  assert.deepEqual(loadEnvFiles([file, join(dir, "missing.env")], env), [file]);
  assert.equal(env.A, "preset");
  assert.equal(env.B, "from-file");
});

const r = (num: bigint, den = 1n) => ({ num, den });

test("without underlyings the mirror has one ETH target from the flat keys, as before", () => {
  const d = parseDeployments({ demoWeth: WETH, demoUsdc: USDC, underlyingOracle: ORACLE });
  assert.equal(d.underlyings, undefined);
  const [eth, ...rest] = mirrorTargets(d);
  assert.equal(rest.length, 0);
  assert.deepEqual(eth, {
    symbol: "ETH",
    token: WETH,
    oracle: ORACLE,
    key: d.underlyingPool,
    keyExplicit: false,
    minPrice: r(100n),
    maxPrice: r(100000n),
  });
  // The ETH-sized legacy bounds still apply to ETH, and the per-symbol ones win over them
  const legacy = mirrorTargets(d, { MIRROR_MIN_PRICE: "500", MIRROR_MAX_PRICE: "9000.5" })[0]!;
  assert.deepEqual([legacy.minPrice, legacy.maxPrice], [r(500n), r(90005n, 10n)]);
  const own = mirrorTargets(d, { MIRROR_MIN_PRICE: "500", MIRROR_ETH_MIN_PRICE: "700" })[0]!;
  assert.deepEqual(own.minPrice, r(700n));
  assert.throws(() => mirrorTargets(d, { MIRROR_ETH_MIN_PRICE: "10", MIRROR_ETH_MAX_PRICE: "5" }), /must be below/);
  assert.throws(() => mirrorTargets(d, { MIRROR_ETH_MIN_PRICE: "-1" }), /MIRROR_ETH_MIN_PRICE must be a plain decimal/);

  const cfg = loadMirrorConfig({ DEPLOYMENTS_FILE: EXAMPLE, DRY_RUN: "1" });
  assert.deepEqual(cfg.targets.map((t) => t.symbol), ["ETH"]);
});

test("an underlyings list becomes one target per asset, each with its own token, pool and price band", () => {
  const cfg = loadMirrorConfig({ DEPLOYMENTS_FILE: UNDERLYINGS, DRY_RUN: "1", MIRROR_MIN_PRICE: "500" });
  const d = cfg.deployments;
  assert.equal(d.underlyings?.length, 2);
  const [eth, sol] = cfg.targets;
  assert.equal(cfg.targets.length, 2);
  assert.equal(eth!.symbol, "ETH");
  assert.equal(eth!.token, WETH);
  assert.equal(eth!.keyExplicit, true);
  assert.deepEqual(eth!.minPrice, r(500n), "legacy MIRROR_MIN_PRICE is ETH's");
  assert.equal(sol!.symbol, "SOL");
  assert.equal(sol!.token, getAddress("0x0500000000000000000000000000000000000003"));
  assert.equal(sol!.oracle, getAddress("0x0000000000000000000000000000000000002080"));
  assert.deepEqual(sol!.key, {
    currency0: sol!.token,
    currency1: USDC,
    fee: 3000,
    tickSpacing: 60,
    hooks: sol!.oracle,
  });
  assert.equal(poolId(sol!.key), "0x67214df79c10f9f5ad2c7f94b1562ae36c45d4a8c425e70144182c0d80eec1dc");
  assert.deepEqual([sol!.minPrice, sol!.maxPrice], [r(5n), r(2000n)], "SOL's own band, not ETH's");

  const env = { MIRROR_SOL_MIN_PRICE: "20", MIRROR_SOL_MAX_PRICE: "900" };
  const tuned = mirrorTargets(d, env);
  assert.deepEqual([tuned[1]!.minPrice, tuned[1]!.maxPrice], [r(20n), r(900n)]);
  assert.deepEqual(tuned[0]!.minPrice, r(100n));
  assert.deepEqual(mirrorTargets(d, { MIRROR_SYMBOLS: "sol" }).map((t) => t.symbol), ["SOL"]);
  assert.throws(() => mirrorTargets(d, { MIRROR_SYMBOLS: "ETH,BTC" }), /MIRROR_SYMBOLS has BTC/);
});

test("underlyings entries are validated", () => {
  const good = JSON.parse(readFileSync(UNDERLYINGS, "utf8")) as { underlyings: Record<string, unknown>[] };
  const withEntry = (patch: (e: Record<string, unknown>) => void) => {
    const json = structuredClone(good);
    patch(json.underlyings[1]!);
    return json;
  };
  assert.throws(() => parseDeployments({ underlyings: [] }), /non-empty array/);
  assert.throws(() => parseDeployments(withEntry((e) => (e.symbol = "eth"))), /ETH twice/);
  assert.throws(() => parseDeployments(withEntry((e) => (e.token = WETH))), /token .* is not in its pool/);
  assert.throws(() => parseDeployments(withEntry((e) => (e.oracle = ORACLE))), /pool.hooks .* is not its oracle/);
  assert.throws(() => parseDeployments(withEntry((e) => (e.poolId = `0x${"00".repeat(32)}`))), /does not match its pool key/);
  assert.throws(
    () => parseDeployments(withEntry((e) => ((e.pool as Record<string, unknown>).currency0 = "0xffff000000000000000000000000000000000000"))),
    /sorted/,
  );
  const doge = parseDeployments(withEntry((e) => (e.symbol = "DOGE")));
  assert.throws(() => mirrorTargets(doge), /no default price band for DOGE: set MIRROR_DOGE_MIN_PRICE/);
  assert.equal(mirrorTargets(doge, { MIRROR_DOGE_MIN_PRICE: "0.01", MIRROR_DOGE_MAX_PRICE: "10" })[1]!.symbol, "DOGE");
});
