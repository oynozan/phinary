import { type Address, encodeAbiParameters, type Hex, keccak256 } from 'viem'

export const E6 = 1_000_000n
export const WAD = 10n ** 18n
export const SECONDS_PER_YEAR = 31_557_600
/** FiatToken v2.2 `balanceAndBlacklistStates` mapping slot (Circle USDC on 1301). */
export const FIAT_TOKEN_BALANCE_SLOT = 9n

export function fmtUnits(x: bigint, decimals: number, dp: number): string {
  const neg = x < 0n
  const abs = neg ? -x : x
  const unit = 10n ** BigInt(decimals)
  const scaled = (abs * 10n ** BigInt(dp) + unit / 2n) / unit
  const s = scaled.toString().padStart(dp + 1, '0')
  const body = dp === 0 ? s : `${s.slice(0, -dp)}.${s.slice(-dp)}`
  return neg && scaled !== 0n ? `-${body}` : body
}

export const fmtUsdc = (x: bigint): string => fmtUnits(x, 6, 2)
export const fmtTokens = (x: bigint): string => fmtUnits(x, 6, 4)
export const fmtWad = (x: bigint, dp = 4): string => fmtUnits(x, 18, dp)

/** Annualised volatility from per-second variance at 1e36. */
export function sigmaFromVarE36(varE36: bigint): number {
  return Math.sqrt((Number(varE36) / 1e36) * SECONDS_PER_YEAR)
}

export function usdFromLnWad(lnWad: bigint): number {
  return Math.exp(Number(lnWad) / 1e18)
}

/** Settlement TWAP in USD from the normalised tick-seconds sum over the window (IUnderlyingOracle). */
export function twapUsd(tickSeconds: bigint, windowSec: number, decimalsShift: number): number {
  return 1.0001 ** (Number(tickSeconds) / windowSec) * 10 ** decimalsShift
}

/** USDC paid per outcome token, WAD. */
export function avgPriceWad(usdc: bigint, tokens: bigint): bigint {
  return tokens === 0n ? 0n : (usdc * WAD) / tokens
}

export function fiatTokenBalanceSlot(account: Address, slot = FIAT_TOKEN_BALANCE_SLOT): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, slot]))
}

export interface LedgerSnapshot {
  /** IPredictionHook.Status: 1 Trading, 2 Settled, 3 Invalid. */
  status: number
  yesWon: boolean
  bucket: bigint
  outYes: bigint
  outNo: bigint
  invYes: bigint
  invNo: bigint
  yesSupply: bigint
  noSupply: bigint
  /** PoolManager ERC-6909 balances of the hook for the YES and NO token ids. */
  hookYesClaims: bigint
  hookNoClaims: bigint
  /** Sum of the YES and NO balances of every known trader, when they are the only holders. */
  holdersYes?: bigint
  holdersNo?: bigint
}

/** SPEC §3.2 per-market identities and the solvency post-condition. Returns the violations (empty when consistent). */
export function ledgerViolations(s: LedgerSnapshot): string[] {
  const v: string[] = []
  if (s.hookYesClaims !== s.invYes) v.push(`hook YES claims ${s.hookYesClaims} != invYes ${s.invYes}`)
  if (s.hookNoClaims !== s.invNo) v.push(`hook NO claims ${s.hookNoClaims} != invNo ${s.invNo}`)
  if (s.yesSupply - s.invYes !== s.outYes) v.push(`YES supply ${s.yesSupply} - invYes ${s.invYes} != outYes ${s.outYes}`)
  if (s.noSupply - s.invNo !== s.outNo) v.push(`NO supply ${s.noSupply} - invNo ${s.invNo} != outNo ${s.outNo}`)
  if (s.holdersYes !== undefined && s.holdersYes !== s.outYes) v.push(`traders hold ${s.holdersYes} YES, outYes ${s.outYes}`)
  if (s.holdersNo !== undefined && s.holdersNo !== s.outNo) v.push(`traders hold ${s.holdersNo} NO, outNo ${s.outNo}`)
  let required: bigint
  if (s.status === 1) required = s.outYes > s.outNo ? s.outYes : s.outNo
  else if (s.status === 2) required = s.yesWon ? s.outYes : s.outNo
  else required = (s.outYes + s.outNo + 1n) / 2n
  if (s.bucket < required) v.push(`insolvent: bucket ${s.bucket} < required ${required}`)
  return v
}

/** SPEC §3.2 global identity: sum of buckets plus vault idle equals the hook's USDC claims (>= with donations). */
export function globalViolation(buckets: readonly bigint[], vaultIdle: bigint, hookUsdcClaims: bigint): string | undefined {
  const total = buckets.reduce((a, b) => a + b, vaultIdle)
  if (total !== hookUsdcClaims) return `sum(bucket) + vaultIdle = ${total} but hook USDC claims = ${hookUsdcClaims}`
  return undefined
}
