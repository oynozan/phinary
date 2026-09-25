import type { Address } from "viem";
import { formatRational, lnWad, parseDecimal, WAD } from "./math.ts";
import { MarketStatus } from "./abi.ts";

export const SECONDS_PER_YEAR = 31_557_600n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export interface QuoteParams {
  h0Wad: bigint;
  gammaSWad: bigint;
  lambdaWad: bigint;
  qEpochMax: bigint;
  pMinWad: bigint;
}

/** Mirrors IPredictionHook.MarketParams as viem encodes it (uint<=48 as number, wider as bigint). */
export interface MarketParams {
  oracle: Address;
  lnStrikeWad: bigint;
  openTime: bigint;
  expiry: bigint;
  window: number;
  cutoffBuffer: number;
  nSamples: number;
  budget: bigint;
  quote: QuoteParams;
  sigmaMode: number;
  fixedVarE36: bigint;
  kernel: number;
  yesName: string;
  yesSymbol: string;
  noName: string;
  noSymbol: string;
}

export interface MarketTemplate {
  tenorSec: number;
  windowSec: number;
  cutoffBufferSec: number;
  nSamples: number;
  openDelaySec: number;
  /** When > 0, expiry is rounded up to a multiple of this many seconds. */
  expiryAlignSec: number;
  budget: bigint;
  quote: QuoteParams;
  sigmaMode: number;
  fixedVarE36: bigint;
  kernel: number;
  timeZone: string;
  nameTemplate: string;
  symbolTemplate: string;
}

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

export function formatCents(cents: bigint): string {
  return formatRational({ num: cents, den: 100n }, 2);
}

/** Per-second variance at 1e36 from an annualised volatility such as "0.6". */
export function varE36FromAnnualVol(vol: string): bigint {
  const v = parseDecimal(vol);
  return (v.num * v.num * 10n ** 36n) / (v.den * v.den * SECONDS_PER_YEAR);
}

/** HH:MM:SS of a unix timestamp in an IANA time zone. */
export function formatClock(unixSec: bigint, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Number(unixSec) * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Fills {side} {strike} {time} {hhmmss} {hhmm} placeholders. */
export function renderTemplate(template: string, side: "YES" | "NO", strike: string, clock: string): string {
  const hhmmss = clock.replaceAll(":", "");
  return template
    .replaceAll("{side}", side)
    .replaceAll("{strike}", strike)
    .replaceAll("{time}", clock)
    .replaceAll("{hhmmss}", hhmmss)
    .replaceAll("{hhmm}", hhmmss.slice(0, 4));
}

export function expiryFor(openTime: bigint, t: Pick<MarketTemplate, "tenorSec" | "expiryAlignSec">): bigint {
  const raw = openTime + BigInt(t.tenorSec);
  if (t.expiryAlignSec <= 0) return raw;
  const a = BigInt(t.expiryAlignSec);
  return ((raw + a - 1n) / a) * a;
}

export function validateTemplate(t: MarketTemplate): void {
  const fail = (msg: string) => {
    throw new Error(`invalid market template: ${msg}`);
  };
  if (!Number.isInteger(t.tenorSec) || t.tenorSec <= 0) fail("tenor must be a positive integer");
  if (!Number.isInteger(t.windowSec) || t.windowSec < 1) fail("window must be a positive integer");
  if (!Number.isInteger(t.cutoffBufferSec) || t.cutoffBufferSec < 0) fail("cutoffBuffer must be >= 0");
  if (t.windowSec + t.cutoffBufferSec >= t.tenorSec) fail("window + cutoffBuffer must be shorter than the tenor");
  if (!Number.isInteger(t.nSamples) || t.nSamples < 0) fail("nSamples must be a non-negative integer");
  if (t.nSamples > t.windowSec) fail("nSamples cannot exceed window seconds");
  if (!Number.isInteger(t.openDelaySec) || t.openDelaySec < 0) fail("openDelay must be >= 0");
  if (t.budget <= 0n) fail("budget must be positive");
  const q = t.quote;
  if (q.h0Wad < 0n || q.h0Wad > U64_MAX) fail("h0 out of uint64 range");
  if (q.gammaSWad < 0n || q.gammaSWad > U64_MAX) fail("gammaS out of uint64 range");
  if (q.lambdaWad < 0n || q.lambdaWad > U128_MAX) fail("lambda out of uint128 range");
  if (q.qEpochMax <= 0n || q.qEpochMax > U128_MAX) fail("qEpochMax must be positive");
  if (q.pMinWad <= 0n || q.pMinWad >= WAD / 2n) fail("pMin must be in (0, 0.5)");
  if (t.sigmaMode !== 0 && t.sigmaMode !== 1) fail("sigmaMode must be 0 (oracle) or 1 (fixed)");
  if (t.sigmaMode === 1 && t.fixedVarE36 <= 0n) fail("sigmaMode 1 needs a positive fixed variance");
  if (t.kernel !== 0) fail("kernel must be 0 (Gaussian); PredictionHook reverts UnsupportedKernel otherwise");
  new Intl.DateTimeFormat("en-GB", { timeZone: t.timeZone });
}

export interface BuiltMarket {
  params: MarketParams;
  strikeCents: bigint;
  strike: string;
}

export function buildMarketParams(oracle: Address, lnSpotWad: bigint, blockTimestamp: bigint, t: MarketTemplate): BuiltMarket {
  validateTemplate(t);
  const strikeCents = strikeCentsFromLnSpot(lnSpotWad);
  const strike = formatCents(strikeCents);
  const openTime = blockTimestamp + BigInt(t.openDelaySec);
  const expiry = expiryFor(openTime, t);
  const clock = formatClock(expiry, t.timeZone);
  return {
    strikeCents,
    strike,
    params: {
      oracle,
      lnStrikeWad: lnStrikeWadFromCents(strikeCents),
      openTime,
      expiry,
      window: t.windowSec,
      cutoffBuffer: t.cutoffBufferSec,
      nSamples: t.nSamples,
      budget: t.budget,
      quote: { ...t.quote },
      sigmaMode: t.sigmaMode,
      fixedVarE36: t.sigmaMode === 1 ? t.fixedVarE36 : 0n,
      kernel: t.kernel,
      yesName: renderTemplate(t.nameTemplate, "YES", strike, clock),
      yesSymbol: renderTemplate(t.symbolTemplate, "YES", strike, clock),
      noName: renderTemplate(t.nameTemplate, "NO", strike, clock),
      noSymbol: renderTemplate(t.symbolTemplate, "NO", strike, clock),
    },
  };
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
