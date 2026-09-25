/** A positive or negative rational number `num / den` with `den > 0`. */
export interface Rational {
  num: bigint;
  den: bigint;
}

export const WAD = 10n ** 18n;

/** Parses a plain decimal string such as "2701.345" exactly. Rejects exponents, signs and empty parts. */
export function parseDecimal(value: string): Rational {
  const s = value.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a plain decimal: ${JSON.stringify(value)}`);
  const int = m[1] ?? "0";
  const frac = m[2] ?? "";
  return { num: BigInt(int + frac), den: 10n ** BigInt(frac.length) };
}

/** Formats `num / den` with `decimals` fraction digits, rounded half up (half away from zero). */
export function formatRational(r: Rational, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const neg = r.num < 0n;
  const abs = neg ? -r.num : r.num;
  const scaled = (abs * scale * 2n + r.den) / (2n * r.den);
  const int = scaled / scale;
  const frac = (scaled % scale).toString().padStart(decimals, "0");
  const body = decimals > 0 ? `${int}.${frac}` : `${int}`;
  return neg && scaled !== 0n ? `-${body}` : body;
}

/** floor(sqrt(n)) for n >= 0. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length >> 1) + 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Division rounded to nearest, ties away from zero. `b > 0`. */
export function divRound(a: bigint, b: bigint): bigint {
  return a >= 0n ? (2n * a + b) / (2n * b) : -((-2n * a + b) / (2n * b));
}

const LN_SCALE = 10n ** 40n;

/** ln(m) for a fixed-point m in [1, 2] at LN_SCALE, via 2 atanh((m - 1) / (m + 1)). */
function lnMantissa(m: bigint): bigint {
  const z = ((m - LN_SCALE) * LN_SCALE) / (m + LN_SCALE);
  const z2 = (z * z) / LN_SCALE;
  let term = z;
  let sum = 0n;
  for (let k = 1n; term !== 0n; k += 2n) {
    sum += term / k;
    term = (term * z2) / LN_SCALE;
  }
  return 2n * sum;
}

const LN2 = lnMantissa(2n * LN_SCALE);

/** ln(num / den) in WAD, rounded to nearest. Accurate to well below 1 wei. */
export function lnWad(r: Rational): bigint {
  if (r.num <= 0n || r.den <= 0n) throw new Error("lnWad of non-positive value");
  let num = r.num;
  let den = r.den;
  let k = 0n;
  while (num >= 2n * den) {
    den *= 2n;
    k += 1n;
  }
  while (num < den) {
    num *= 2n;
    k -= 1n;
  }
  const m = (num * LN_SCALE) / den;
  const lnFixed = k * LN2 + lnMantissa(m);
  return divRound(lnFixed, LN_SCALE / WAD);
}
