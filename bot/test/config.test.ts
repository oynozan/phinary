import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { getAddress, zeroAddress } from "viem";
import {
  BOT_DIR,
  envUnits,
  loadDeployments,
  loadEnvFiles,
  loadKeeperConfig,
  loadMarketTemplate,
  loadMirrorConfig,
  parseDeployments,
  readPrivateKey,
  requireAddress,
} from "../src/config.ts";

const EXAMPLE = resolve(BOT_DIR, "config", "unichain-sepolia.example.json");
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

test("envUnits parses human decimals exactly", () => {
  assert.equal(envUnits({ X: "0.00005" }, "X", "0", 18), 50000000000000n);
  assert.equal(envUnits({}, "X", "10", 6), 10_000000n);
  assert.throws(() => envUnits({ X: "0.0000001" }, "X", "0", 6), /more than 6 decimals/);
  assert.throws(() => envUnits({ X: "-1" }, "X", "0", 6), /non-negative decimal/);
});

test("market template defaults are the 1-minute demo parameters", () => {
  const t = loadMarketTemplate({});
  assert.equal(t.tenorSec, 60);
  assert.equal(t.windowSec, 10);
  assert.equal(t.cutoffBufferSec, 2);
  assert.equal(t.nSamples, 10);
  assert.equal(t.quote.h0Wad, 2n * 10n ** 16n, "PLAN 10: h0 = 2 cents");
  assert.equal(t.quote.gammaSWad, 5n * 10n ** 13n);
  assert.equal(t.quote.pMinWad, 2n * 10n ** 16n);
  assert.equal(t.sigmaMode, 0);
  assert.equal(t.kernel, 0);
  const custom = loadMarketTemplate({ MARKET_TENOR_SEC: "300", MARKET_WINDOW_SEC: "60", FIXED_VAR_E36: "123", SIGMA_MODE: "1" });
  assert.equal(custom.tenorSec, 300);
  assert.equal(custom.fixedVarE36, 123n);
  assert.throws(() => loadMarketTemplate({ MARKET_WINDOW_SEC: "59" }), /shorter than the tenor/);
  assert.throws(() => loadMarketTemplate({ SIGMA_MODE: "2" }), /SIGMA_MODE/);
  assert.throws(() => loadMarketTemplate({ MARKET_WINDOW_SEC: "0" }), /MARKET_WINDOW_SEC/);
  assert.throws(() => loadMarketTemplate({ KERNEL: "1" }), /UnsupportedKernel/);
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
