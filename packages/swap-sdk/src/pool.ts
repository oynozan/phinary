import { type Address, encodeAbiParameters, type Hex, keccak256 } from 'viem'
import { PREDICTION_POOL_FEE, PREDICTION_TICK_SPACING } from './constants.ts'

export interface PoolKey {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a]
}

/** The {outcome token, USDC} pool the hook initialises for a market (SPEC §3.1). */
export function predictionPoolKey({ token, usdc, hook }: { token: Address; usdc: Address; hook: Address }): PoolKey {
  const [currency0, currency1] = sortCurrencies(token, usdc)
  return { currency0, currency1, fee: PREDICTION_POOL_FEE, tickSpacing: PREDICTION_TICK_SPACING, hooks: hook }
}

/** v4 `PoolId`: keccak256(abi.encode(PoolKey)). */
export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  )
}

/** `zeroForOne` for a swap that pays `tokenIn` into `key`. */
export function zeroForOneFor(key: PoolKey, tokenIn: Address): boolean {
  if (sameAddress(tokenIn, key.currency0)) {
    return true
  }
  if (sameAddress(tokenIn, key.currency1)) {
    return false
  }
  throw new Error(`token ${tokenIn} is not in pool ${key.currency0}/${key.currency1}`)
}

export function inputCurrency(key: PoolKey, zeroForOne: boolean): Address {
  return zeroForOne ? key.currency0 : key.currency1
}

export function outputCurrency(key: PoolKey, zeroForOne: boolean): Address {
  return zeroForOne ? key.currency1 : key.currency0
}
