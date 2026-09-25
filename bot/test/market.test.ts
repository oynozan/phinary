import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { MarketStatus } from "../src/abi.ts";
import {
  buildMarketParams,
  expiryFor,
  formatClock,
  isSettleDue,
  lnStrikeWadFromCents,
  renderTemplate,
  strikeCentsFromLnSpot,
  sweepableAmount,
  validateTemplate,
  varE36FromAnnualVol,
  type MarketInfo,
  type MarketTemplate,
} from "../src/market.ts";
import { lnWad } from "../src/math.ts";

const ORACLE: Address = "0x00000000000000000000000000000000000000aa";

const TEMPLATE: MarketTemplate = {
  tenorSec: 60,
  windowSec: 10,
  cutoffBufferSec: 2,
  nSamples: 10,
  openDelaySec: 0,
  expiryAlignSec: 0,
  budget: 10_000000n,
  quote: {
    h0Wad: 2n * 10n ** 16n,
    gammaSWad: 5n * 10n ** 13n,
    lambdaWad: 10n ** 15n,
    qEpochMax: 100_000000n,
    pMinWad: 2n * 10n ** 16n,
  },
  sigmaMode: 0,
  fixedVarE36: varE36FromAnnualVol("0.6"),
  kernel: 0,
  timeZone: "UTC",
  nameTemplate: "{side} ETH>{strike} {time}",
  symbolTemplate: "{side}-{strike}-{hhmmss}",
};

test("strike is the oracle price rounded half up to the cent", () => {
  assert.equal(strikeCentsFromLnSpot(lnWad({ num: 270135n, den: 100n })), 270135n);
  assert.equal(strikeCentsFromLnSpot(lnWad({ num: 2701349n, den: 1000n })), 270135n);
  assert.equal(strikeCentsFromLnSpot(lnWad({ num: 2701341n, den: 1000n })), 270134n);
  const half = lnWad({ num: 2701345n, den: 1000n });
  assert.equal(strikeCentsFromLnSpot(half), 270135n);
  assert.equal(strikeCentsFromLnSpot(half - 1n), 270134n);
  assert.equal(strikeCentsFromLnSpot(lnWad({ num: 123456789n, den: 1000n })), 12345679n);
  assert.equal(strikeCentsFromLnSpot(lnWad({ num: 1n, den: 1000n })), 1n);
});

test("lnStrikeWad is ln of the rounded strike", () => {
  assert.equal(lnStrikeWadFromCents(270135n), 7901506927034071490n);
  assert.equal(lnStrikeWadFromCents(300000n), 8006367567650246743n);
});

test("fixed variance from annual vol matches SPEC 0 example", () => {
  assert.equal(varE36FromAnnualVol("0.6"), 11407711613050422085329682865n);
});

test("clock and templates", () => {
  const t = 1790346660n;
  assert.equal(formatClock(t, "UTC"), "14:31:00");
  assert.equal(formatClock(t, "Asia/Tokyo"), "23:31:00");
  assert.equal(renderTemplate("{side} ETH>{strike} {time}", "YES", "2701.35", "14:31:00"), "YES ETH>2701.35 14:31:00");
  assert.equal(renderTemplate("{side}-{strike}-{hhmmss}/{hhmm}", "NO", "2701.35", "14:31:00"), "NO-2701.35-143100/1431");
});

test("expiry is open + tenor, optionally aligned up", () => {
  assert.equal(expiryFor(1000n, { tenorSec: 60, expiryAlignSec: 0 }), 1060n);
  assert.equal(expiryFor(1000n, { tenorSec: 60, expiryAlignSec: 60 }), 1080n);
  assert.equal(expiryFor(1020n, { tenorSec: 60, expiryAlignSec: 60 }), 1080n);
});

test("buildMarketParams produces the 1-minute demo market", () => {
  const now = 1790346600n;
  const lnSpot = lnWad({ num: 270134712n, den: 100000n });
  const { params, strike, strikeCents } = buildMarketParams(ORACLE, lnSpot, now, TEMPLATE);
  assert.equal(strike, "2701.35");
  assert.equal(strikeCents, 270135n);
  assert.deepEqual(params, {
    oracle: ORACLE,
    lnStrikeWad: 7901506927034071490n,
    openTime: now,
    expiry: now + 60n,
    window: 10,
    cutoffBuffer: 2,
    nSamples: 10,
    budget: 10_000000n,
    quote: {
      h0Wad: 20000000000000000n,
      gammaSWad: 50000000000000n,
      lambdaWad: 1000000000000000n,
      qEpochMax: 100_000000n,
      pMinWad: 20000000000000000n,
    },
    sigmaMode: 0,
    fixedVarE36: 0n,
    kernel: 0,
    yesName: "YES ETH>2701.35 14:31:00",
    yesSymbol: "YES-2701.35-143100",
    noName: "NO ETH>2701.35 14:31:00",
    noSymbol: "NO-2701.35-143100",
  });
});

test("fixed sigma mode passes the variance through", () => {
  const { params } = buildMarketParams(ORACLE, 0n, 0n, { ...TEMPLATE, sigmaMode: 1 });
  assert.equal(params.sigmaMode, 1);
  assert.equal(params.fixedVarE36, 11407711613050422085329682865n);
});

test("template validation rejects unusable markets", () => {
  const bad: Partial<MarketTemplate>[] = [
    { tenorSec: 0 },
    { windowSec: 0, nSamples: 0 },
    { windowSec: 50, cutoffBufferSec: 10 },
    { nSamples: 11 },
    { budget: 0n },
    { quote: { ...TEMPLATE.quote, pMinWad: 5n * 10n ** 17n } },
    { quote: { ...TEMPLATE.quote, h0Wad: 1n << 64n } },
    { quote: { ...TEMPLATE.quote, qEpochMax: 0n } },
    { sigmaMode: 2 },
    { sigmaMode: 1, fixedVarE36: 0n },
    { kernel: 1 },
    { kernel: 3 },
    { timeZone: "Not/AZone" },
  ];
  for (const b of bad) assert.throws(() => validateTemplate({ ...TEMPLATE, ...b }), Error, JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  validateTemplate(TEMPLATE);
});

const INFO: MarketInfo = {
  yes: ORACLE,
  no: ORACLE,
  oracle: ORACLE,
  lnStrikeWad: 0n,
  openTime: 100n,
  expiry: 160n,
  window: 10,
  cutoffBuffer: 2,
  status: MarketStatus.Trading,
  yesWon: false,
  bucket: 25_000000n,
  outYes: 12_000000n,
  outNo: 7_000000n,
  invYes: 0n,
  invNo: 0n,
};

test("sweepableAmount follows SPEC 3.5", () => {
  assert.equal(sweepableAmount(INFO), 0n);
  assert.equal(sweepableAmount({ ...INFO, status: MarketStatus.Settled, yesWon: true }), 13_000000n);
  assert.equal(sweepableAmount({ ...INFO, status: MarketStatus.Settled, yesWon: false }), 18_000000n);
  assert.equal(sweepableAmount({ ...INFO, status: MarketStatus.Invalid }), 15_500000n);
  assert.equal(sweepableAmount({ ...INFO, status: MarketStatus.Invalid, outNo: 7_000001n }), 15_499999n);
  assert.equal(sweepableAmount({ ...INFO, status: MarketStatus.Settled, yesWon: true, bucket: 12_000000n }), 0n);
});

test("settle is due at expiry for trading markets only", () => {
  assert.equal(isSettleDue(INFO, 159n), false);
  assert.equal(isSettleDue(INFO, 160n), true);
  assert.equal(isSettleDue({ ...INFO, status: MarketStatus.Settled }, 200n), false);
});
