import { concat, encodeAbiParameters, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { isqrt, type Rational } from "./math.ts";

export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const POOLS_SLOT = 6n;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** How the ETH-like base token and the USD-like quote token sit in a v4 pool. */
export interface Orientation {
  baseIsToken0: boolean;
  baseDecimals: number;
  quoteDecimals: number;
}

export function orientationFor(key: PoolKey, base: Address, baseDecimals: number, quoteDecimals: number): Orientation {
  const b = base.toLowerCase();
  if (key.currency0.toLowerCase() === b) return { baseIsToken0: true, baseDecimals, quoteDecimals };
  if (key.currency1.toLowerCase() === b) return { baseIsToken0: false, baseDecimals, quoteDecimals };
  throw new Error(`base token ${base} is not in pool ${key.currency0}/${key.currency1}`);
}

/** Floored sqrtPriceX96 for a human `price` (quote per base); inverted when the quote token is currency0. */
export function sqrtPriceX96FromPrice(price: Rational, o: Orientation): bigint {
  if (price.num <= 0n || price.den <= 0n) throw new Error("price must be positive");
  const baseScale = 10n ** BigInt(o.baseDecimals);
  const quoteScale = 10n ** BigInt(o.quoteDecimals);
  const ratioX192 = o.baseIsToken0
    ? (price.num * quoteScale * Q192) / (price.den * baseScale)
    : (price.den * baseScale * Q192) / (price.num * quoteScale);
  const sqrtPriceX96 = isqrt(ratioX192);
  if (sqrtPriceX96 <= MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) {
    throw new Error(`price ${price.num}/${price.den} maps outside the v4 sqrtPrice range`);
  }
  return sqrtPriceX96;
}

/** Exact human price (quote per base) represented by a pool sqrtPriceX96. */
export function priceFromSqrtPriceX96(sqrtPriceX96: bigint, o: Orientation): Rational {
  if (sqrtPriceX96 <= 0n) throw new Error("sqrtPrice must be positive");
  const baseScale = 10n ** BigInt(o.baseDecimals);
  const quoteScale = 10n ** BigInt(o.quoteDecimals);
  const sq = sqrtPriceX96 * sqrtPriceX96;
  return o.baseIsToken0
    ? { num: sq * baseScale, den: Q192 * quoteScale }
    : { num: Q192 * baseScale, den: sq * quoteScale };
}

/** |target - current| / current of the human price, in basis points (fractional). */
export function deviationBps(currentSqrtPriceX96: bigint, targetSqrtPriceX96: bigint, o: Orientation): number {
  const c2 = currentSqrtPriceX96 * currentSqrtPriceX96;
  const t2 = targetSqrtPriceX96 * targetSqrtPriceX96;
  const [numer, denom] = o.baseIsToken0 ? [t2, c2] : [c2, t2];
  const diff = numer > denom ? numer - denom : denom - numer;
  return Number((diff * 1_000_000n) / denom) / 100;
}

export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** Storage slot of `pools[id].slot0` in the PoolManager (StateLibrary._getPoolStateSlot). */
export function poolStateSlot(id: Hex): Hex {
  return keccak256(concat([id, pad(toHex(POOLS_SLOT), { size: 32 })]));
}

export interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
}

export function decodeSlot0(word: Hex): Slot0 {
  const v = BigInt(word);
  const rawTick = Number((v >> 160n) & 0xffffffn);
  return {
    sqrtPriceX96: v & ((1n << 160n) - 1n),
    tick: rawTick >= 0x800000 ? rawTick - 0x1000000 : rawTick,
    protocolFee: Number((v >> 184n) & 0xffffffn),
    lpFee: Number((v >> 208n) & 0xffffffn),
  };
}

export function sortTokens(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}
