import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { MarketStatus } from "../src/abi.ts";
import {
  isSettleDue,
  lnStrikeWadFromCents,
  strikeCentsFromLnSpot,
  sweepableAmount,
  varE36FromAnnualVol,
  type MarketInfo,
} from "../src/market.ts";
import { lnWad } from "../src/math.ts";

const ORACLE: Address = "0x00000000000000000000000000000000000000aa";

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
