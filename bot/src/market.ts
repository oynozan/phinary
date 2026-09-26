import type { Address } from "viem";
import { lnWad, parseDecimal } from "./math.ts";
import { MarketStatus } from "./abi.ts";

export const SECONDS_PER_YEAR = 31_557_600n;

export interface MarketInfo {
  yes: Address;
  no: Address;
  oracle: Address;
  lnStrikeWad: bigint;
  openTime: bigint;
  expiry: bigint;
  window: number;
  cutoffBuffer: number;
  status: number;
  yesWon: boolean;
  bucket: bigint;
  outYes: bigint;
  outNo: bigint;
  invYes: bigint;
  invNo: bigint;
}

/** USD strike in cents: the oracle's start-of-block price rounded half up to the cent, exact in the WAD input. */
export function strikeCentsFromLnSpot(lnSpotWad: bigint): bigint {
  let cents = BigInt(Math.max(1, Math.round(Math.exp(Number(lnSpotWad) / 1e18) * 100)));
  while (cents > 1n && lnSpotWad < lnWad({ num: 2n * cents - 1n, den: 200n })) cents -= 1n;
  while (lnSpotWad >= lnWad({ num: 2n * cents + 1n, den: 200n })) cents += 1n;
  return cents;
}

export function lnStrikeWadFromCents(cents: bigint): bigint {
  return lnWad({ num: cents, den: 100n });
}

/** Per-second variance at 1e36 from an annualised volatility such as "0.6". */
export function varE36FromAnnualVol(vol: string): bigint {
  const v = parseDecimal(vol);
  return (v.num * v.num * 10n ** 36n) / (v.den * v.den * SECONDS_PER_YEAR);
}

/** USDC that `sweep` would return to the vault now (SPEC 3.5). */
export function sweepableAmount(m: MarketInfo): bigint {
  let owed: bigint;
  if (m.status === MarketStatus.Settled) owed = m.yesWon ? m.outYes : m.outNo;
  else if (m.status === MarketStatus.Invalid) owed = (m.outYes + m.outNo + 1n) / 2n;
  else return 0n;
  return m.bucket > owed ? m.bucket - owed : 0n;
}

export function isSettleDue(m: MarketInfo, now: bigint): boolean {
  return m.status === MarketStatus.Trading && now >= m.expiry;
}
