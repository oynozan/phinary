import assert from "node:assert/strict";
import { test } from "node:test";
import { divRound, formatRational, isqrt, lnWad, parseDecimal } from "../src/math.ts";

test("parseDecimal is exact and strict", () => {
  assert.deepEqual(parseDecimal("2701.345"), { num: 2701345n, den: 1000n });
  assert.deepEqual(parseDecimal(" 2692.90000000 "), { num: 269290000000n, den: 100000000n });
  assert.deepEqual(parseDecimal("7"), { num: 7n, den: 1n });
  for (const bad of ["", "-1", "1e3", "1.", ".5", "abc", "1,5", "NaN"]) {
    assert.throws(() => parseDecimal(bad), /not a plain decimal/, bad);
  }
});

test("formatRational rounds half away from zero", () => {
  assert.equal(formatRational({ num: 270135n, den: 100n }, 2), "2701.35");
  assert.equal(formatRational({ num: 2701345n, den: 1000n }, 2), "2701.35");
  assert.equal(formatRational({ num: 2701344n, den: 1000n }, 2), "2701.34");
  assert.equal(formatRational({ num: 1n, den: 3n }, 4), "0.3333");
  assert.equal(formatRational({ num: -5n, den: 2n }, 0), "-3");
  assert.equal(formatRational({ num: -1n, den: 1000n }, 2), "0.00");
});

test("isqrt is floor(sqrt)", () => {
  for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 40n, 2n ** 255n - 1n, 2n ** 192n]) {
    const r = isqrt(n);
    assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, n.toString());
  }
  assert.throws(() => isqrt(-1n));
});

test("divRound rounds to nearest, ties away from zero", () => {
  assert.equal(divRound(5n, 2n), 3n);
  assert.equal(divRound(-5n, 2n), -3n);
  assert.equal(divRound(4n, 3n), 1n);
  assert.equal(divRound(-4n, 3n), -1n);
});

test("lnWad matches mpmath (50 digits, rounded to nearest wei)", () => {
  const vectors: [bigint, bigint, bigint][] = [
    [270135n, 100n, 7901506927034071490n],
    [1n, 100n, -4605170185988091368n],
    [1n, 1n, 0n],
    [2n, 1n, 693147180559945309n],
    [100000n, 1n, 11512925464970228420n],
    [12345678n, 10000n, 7118476228297786293n],
    [300000n, 100n, 8006367567650246743n],
    [1n, 2n, -693147180559945309n],
    [5402691n, 2000n, 7901505261198934196n],
    [99999999n, 100n, 13815510547964274054n],
  ];
  for (const [num, den, expected] of vectors) {
    assert.equal(lnWad({ num, den }), expected, `ln(${num}/${den})`);
  }
  assert.throws(() => lnWad({ num: 0n, den: 1n }));
});
