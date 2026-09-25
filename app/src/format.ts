import { formatUnits, parseUnits } from 'viem'

const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatUsd(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '—' : usd2.format(value)
}

export function formatSignedUsd(value: number): string {
  const s = usd2.format(Math.abs(value))
  return value >= 0 ? `+${s}` : `−${s}`
}

/** A 6-decimal token amount with up to `maxDecimals` decimals and thousands separators. */
export function formatToken(amount: bigint | undefined, decimals = 6, maxDecimals = 2): string {
  if (amount === undefined) {
    return '—'
  }
  const n = Number(formatUnits(amount, decimals))
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxDecimals })
}

/** WAD price of an outcome token in cents, e.g. 0.5423e18 -> "54.2¢". */
export function formatCents(wad: bigint | undefined, digits = 1): string {
  if (wad === undefined) {
    return '—'
  }
  return `${(Number(wad) / 1e16).toFixed(digits)}¢`
}

export function formatPercent(fraction: number | undefined, digits = 0): string {
  return fraction === undefined || !Number.isFinite(fraction) ? '—' : `${(fraction * 100).toFixed(digits)}%`
}

/** m:ss below an hour, h:mm:ss above. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export function formatClock(unixSeconds: number | bigint): string {
  return clock.format(new Date(Number(unixSeconds) * 1000))
}

export function localTimeZoneName(): string {
  try {
    const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')
    return part?.value ?? ''
  } catch {
    return ''
  }
}

/** Parses a user-typed decimal amount; undefined for empty, malformed or non-positive input. */
export function parseAmount(input: string, decimals = 6): bigint | undefined {
  const v = input.trim().replace(/,/g, '')
  if (!/^\d*\.?\d*$/.test(v) || v === '' || v === '.') {
    return undefined
  }
  const [whole = '', frac = ''] = v.split('.')
  try {
    const amount = parseUnits(`${whole || '0'}.${frac.slice(0, decimals) || '0'}`, decimals)
    return amount > 0n ? amount : undefined
  } catch {
    return undefined
  }
}

export function toInputString(amount: bigint, decimals = 6): string {
  return formatUnits(amount, decimals)
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}
