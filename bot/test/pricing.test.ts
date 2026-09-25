import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRational } from "../src/math.ts";
import {
  decodeSlot0,
  deviationBps,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  orientationFor,
  poolId,
  poolStateSlot,
  priceFromSqrtPriceX96,
  sortTokens,
  sqrtPriceX96FromPrice,
  type Orientation,
  type PoolKey,
} from "../src/pricing.ts";

const WETH0: Orientation = { baseIsToken0: true, baseDecimals: 18, quoteDecimals: 6 };
const WETH1: Orientation = { baseIsToken0: false, baseDecimals: 18, quoteDecimals: 6 };
const p = (num: bigint, den = 1n) => ({ num, den });

test("sqrtPriceX96 targets match exact integer reference, both orientations", () => {
  const vectors: [bigint, bigint, bigint, bigint][] = [
    [270135n, 100n, 4117845161354031543958589n, 1524365654711174614159064650947598n],
    [200000n, 100n, 3543191142285914205922034n, 1771595571142957102961017161607260n],
    [1n, 1n, 79228162514264337593543n, 79228162514264337593543950336000000n],
    [100000n, 1n, 25054144837504793118641380n, 250541448375047931186413801569606n],
  ];
  for (const [num, den, s0, s1] of vectors) {
    assert.equal(sqrtPriceX96FromPrice(p(num, den), WETH0), s0);
    assert.equal(sqrtPriceX96FromPrice(p(num, den), WETH1), s1);
  }
});

test("same-decimals pool at price 1 is exactly 2^96", () => {
  const o = { baseIsToken0: true, baseDecimals: 6, quoteDecimals: 6 };
  assert.equal(sqrtPriceX96FromPrice(p(1n), o), 1n << 96n);
  assert.equal(sqrtPriceX96FromPrice(p(1n), { ...o, baseIsToken0: false }), 1n << 96n);
});

test("ETH up moves sqrtPrice up when WETH is currency0 and down when it is currency1", () => {
  const lo = p(270000n, 100n);
  const hi = p(270001n, 100n);
  assert.ok(sqrtPriceX96FromPrice(hi, WETH0) > sqrtPriceX96FromPrice(lo, WETH0));
  assert.ok(sqrtPriceX96FromPrice(hi, WETH1) < sqrtPriceX96FromPrice(lo, WETH1));
});

test("priceFromSqrtPriceX96 inverts the target to within flooring", () => {
  for (const o of [WETH0, WETH1]) {
    for (const cents of [1n, 99n, 270135n, 312345678n]) {
      const back = priceFromSqrtPriceX96(sqrtPriceX96FromPrice(p(cents, 100n), o), o);
      assert.equal(formatRational(back, 2), formatRational(p(cents, 100n), 2), `${cents} ${o.baseIsToken0}`);
    }
  }
});

test("deviationBps is measured on the human price", () => {
  for (const o of [WETH0, WETH1]) {
    const a = sqrtPriceX96FromPrice(p(2000n), o);
    const b = sqrtPriceX96FromPrice(p(2002n), o);
    assert.ok(Math.abs(deviationBps(a, b, o) - 10) < 0.02, `${deviationBps(a, b, o)}`);
    assert.ok(Math.abs(deviationBps(b, a, o) - 9.99) < 0.02, `${deviationBps(b, a, o)}`);
    assert.equal(deviationBps(a, a, o), 0);
  }
});

test("prices outside the v4 range are rejected", () => {
  const o = { baseIsToken0: true, baseDecimals: 0, quoteDecimals: 0 };
  assert.throws(() => sqrtPriceX96FromPrice(p(1n, 10n ** 40n), o), /outside/);
  assert.throws(() => sqrtPriceX96FromPrice(p(10n ** 40n), o), /outside/);
  assert.throws(() => sqrtPriceX96FromPrice(p(0n), o), /positive/);
  assert.ok(sqrtPriceX96FromPrice(p(1n), o) > MIN_SQRT_PRICE);
  assert.ok(sqrtPriceX96FromPrice(p(1n), o) < MAX_SQRT_PRICE);
});

test("poolId and the pools slot match cast", () => {
  const key: PoolKey = {
    currency0: "0x1000000000000000000000000000000000000000",
    currency1: "0xE000000000000000000000000000000000000000",
    fee: 3000,
    tickSpacing: -60,
    hooks: "0x00000000000000000000000000000000000000aa",
  };
  const id = poolId(key);
  assert.equal(id, "0x71f41b126446b4f34f4cdd65380a3268e3e7bccab62f193f5ff545b3c7b52895");
  assert.equal(poolStateSlot(id), "0x8c1517f48ba6d966df00a72c612b33342b86458b8f4c1d5a3bbccddaea8f015a");
});

test("decodeSlot0 unpacks price, signed tick and fees", () => {
  const sqrt = 4117845161354031543958589n;
  const tick = -195123;
  const word = (3000n << 208n) | (0n << 184n) | ((BigInt(tick) & 0xffffffn) << 160n) | sqrt;
  const s = decodeSlot0(`0x${word.toString(16).padStart(64, "0")}`);
  assert.deepEqual(s, { sqrtPriceX96: sqrt, tick, protocolFee: 0, lpFee: 3000 });
  const pos = decodeSlot0(`0x${((887271n << 160n) | 5n).toString(16).padStart(64, "0")}`);
  assert.equal(pos.tick, 887271);
});

test("orientationFor and sortTokens", () => {
  const a = "0x1000000000000000000000000000000000000000";
  const b = "0xE000000000000000000000000000000000000000";
  assert.deepEqual(sortTokens(b, a), [a, b]);
  const key: PoolKey = { currency0: a, currency1: b, fee: 3000, tickSpacing: 60, hooks: a };
  assert.equal(orientationFor(key, a.toLowerCase() as `0x${string}`, 18, 6).baseIsToken0, true);
  assert.equal(orientationFor(key, b, 18, 6).baseIsToken0, false);
  assert.throws(() => orientationFor(key, "0x0000000000000000000000000000000000000001", 18, 6), /not in pool/);
});
