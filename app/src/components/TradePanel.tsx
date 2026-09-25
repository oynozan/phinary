import { useState } from 'react'
import type { PublicClient } from 'viem'
import { hookErrorAbi } from '../abi.ts'
import type { AppConfig } from '../config.ts'
import { type LiveState, useDebounced, usePolling } from '../data.ts'
import { formatCents, formatCountdown, formatToken, formatUsd, parseAmount, toInputString } from '../format.ts'
import { cutoffOf, hasPrices, type Phase } from '../market.ts'
import { type Market, quoteExactIn } from '../sdk.ts'
import {
  confirmSeconds,
  describeError,
  type ExecContext,
  executeSwap,
  slippageFor,
  type Step,
  swapRoute,
} from '../trade.ts'
import type { Connection } from '../wallet.ts'
import { Steps, TxLink } from './Steps.tsx'

export interface ActivityInput {
  label: string
  hash?: string
  status: 'success' | 'failed'
  detail?: string
}

interface Props {
  cfg: AppConfig
  pub: PublicClient
  market: Market
  phase: Phase
  live?: LiveState
  now: number
  conn?: Connection
  exec?: ExecContext
  onConnect: () => void
  onSwitchChain: () => void
  onActivity: (a: ActivityInput) => void
  onTxDone: () => void
  onBusyChange?: (busy: boolean) => void
}

const BUY_PRESETS = [1, 2, 5]
const SLIPPAGE_CHOICES = [undefined, 100, 500, 2000] as const

export function TradePanel(p: Props) {
  const { cfg, pub, market, phase, live, now, conn, exec } = p
  const [isBuy, setIsBuy] = useState(true)
  const [isYes, setIsYes] = useState(true)
  const [input, setInput] = useState('')
  const [slippage, setSlippage] = useState<number | undefined>(undefined)
  const [steps, setSteps] = useState<Step[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: string } | undefined>()

  const amount = parseAmount(input)
  const debounced = useDebounced(amount, 250)
  const tradable = phase === 'trading'
  const route = swapRoute(market, isYes, isBuy)
  const quoteKey = `${market.id}:${isYes}:${isBuy}:${debounced ?? ''}:${tradable}`
  const quote = usePolling(
    debounced && tradable
      ? () =>
          quoteExactIn(pub, {
            poolKey: route.poolKey,
            zeroForOne: route.zeroForOne,
            amount: debounced,
            quoter: cfg.contracts.v4Quoter,
            account: conn?.address,
            extraErrors: hookErrorAbi,
          })
      : undefined,
    1000,
    quoteKey,
  )
  const q = debounced === amount ? quote.data : undefined
  const quoteError = debounced === amount && !quote.data ? quote.error : undefined

  const bal = live?.balances
  const inBalance = bal ? (isBuy ? bal.usdc : isYes ? bal.yes : bal.no) : undefined
  const unitIn = isBuy ? 'USDC' : isYes ? 'YES' : 'NO'
  const unitOut = isBuy ? (isYes ? 'YES' : 'NO') : 'USDC'
  const insufficient = amount !== undefined && inBalance !== undefined && amount > inBalance
  const hq = hasPrices(live?.quote) ? live?.quote : undefined

  const slippageBps =
    q && amount
      ? slippageFor({
          market,
          isBuy,
          amountIn: q.amountIn,
          amountOut: q.amountOut,
          now,
          confirm: conn ? confirmSeconds(conn) : 5,
          fixedBps: slippage,
        })
      : undefined
  const avgPrice = q ? (isBuy ? Number(q.amountIn) / Number(q.amountOut) : Number(q.amountOut) / Number(q.amountIn)) : undefined
  const minOut = q && slippageBps !== undefined ? (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n : undefined

  const submit = async () => {
    if (!exec || !amount) {
      return
    }
    setBusy(true)
    p.onBusyChange?.(true)
    setResult(undefined)
    const side = isYes ? 'YES' : 'NO'
    try {
      const res = await executeSwap(exec, { market, isYes, isBuy, amount, slippageBps: slippage }, setSteps)
      const f = res.fill
      const text = f
        ? isBuy
          ? `Bought ${formatToken(f.qty)} ${side} for ${formatUsd(Number(f.usdc) / 1e6)} (avg ${formatCents(f.avgPriceWad)})`
          : `Sold ${formatToken(f.qty)} ${side} for ${formatUsd(Number(f.usdc) / 1e6)} (avg ${formatCents(f.avgPriceWad)})`
        : 'Swap confirmed'
      setResult({ ok: true, text, hash: res.hash })
      p.onActivity({ label: `${text} · market #${market.id}`, hash: res.hash, status: 'success' })
      setInput('')
    } catch (err) {
      const text = describeError(err)
      setResult({ ok: false, text })
      p.onActivity({ label: `${isBuy ? 'Buy' : 'Sell'} ${side} failed: ${text}`, status: 'failed' })
    } finally {
      setBusy(false)
      p.onBusyChange?.(false)
      p.onTxDone()
    }
  }

  let cta: { text: string; action?: () => void; disabled?: boolean; cls: string }
  if (!conn) {
    cta = { text: 'Connect wallet', action: p.onConnect, cls: 'btn-primary' }
  } else if (!exec) {
    cta = { text: 'Switch to Unichain Sepolia', action: p.onSwitchChain, cls: 'btn-warn' }
  } else if (phase === 'upcoming') {
    cta = { text: `Opens in ${formatCountdown(Number(market.info.openTime) - now)}`, disabled: true, cls: 'btn-primary' }
  } else if (!tradable) {
    cta = { text: 'Trading closed', disabled: true, cls: 'btn-primary' }
  } else if (!amount) {
    cta = { text: 'Enter an amount', disabled: true, cls: 'btn-primary' }
  } else if (insufficient) {
    cta = { text: `Insufficient ${unitIn}`, disabled: true, cls: 'btn-primary' }
  } else if (busy) {
    cta = { text: 'Working…', disabled: true, cls: isYes ? 'btn-yes' : 'btn-no' }
  } else {
    cta = {
      text: `${isBuy ? 'Buy' : 'Sell'} ${isYes ? 'YES' : 'NO'}`,
      action: submit,
      disabled: !!quoteError && !q,
      cls: isYes ? 'btn-yes' : 'btn-no',
    }
  }

  const priceOf = (yes: boolean) => {
    if (!hq) {
      return '—'
    }
    if (isBuy) {
      return formatCents(yes ? hq.askYes : hq.askNo)
    }
    return formatCents(yes ? hq.bidYes : hq.bidNo)
  }

  return (
    <section className="card card-pad" aria-label="Trade">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={isBuy} className={`tab${isBuy ? ' active' : ''}`} onClick={() => { setIsBuy(true); setInput('') }}>
          Buy
        </button>
        <button type="button" role="tab" aria-selected={!isBuy} className={`tab${!isBuy ? ' active' : ''}`} onClick={() => { setIsBuy(false); setInput('') }}>
          Sell
        </button>
      </div>

      <div className="outcomes">
        {[true, false].map((yes) => (
          <button
            key={String(yes)}
            type="button"
            className={`outcome ${yes ? 'yes' : 'no'}${isYes === yes ? ' active' : ''}`}
            onClick={() => setIsYes(yes)}
            aria-pressed={isYes === yes}
          >
            <span className="outcome-name">{yes ? 'YES' : 'NO'}</span>
            <span className="outcome-price num">
              {isBuy ? 'ask' : 'bid'} {priceOf(yes)}
            </span>
          </button>
        ))}
      </div>

      <div className="field">
        <div className="field-top">
          <label htmlFor="amount">{isBuy ? 'You pay' : 'You sell'}</label>
          {conn && (
            <span className="num">
              Balance {formatToken(inBalance)} {unitIn}
            </span>
          )}
        </div>
        <div className="field-main">
          <input
            id="amount"
            className="amount-input"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={input}
            onChange={(e) => setInput(e.target.value.replace(/[^\d.,]/g, ''))}
          />
          <span className="unit">{unitIn}</span>
        </div>
        <div className="presets">
          {isBuy &&
            BUY_PRESETS.map((v) => (
              <button key={v} type="button" className="btn btn-ghost btn-sm" onClick={() => setInput(String(v))}>
                ${v}
              </button>
            ))}
          {!isBuy &&
            [25, 50].map((pct) => (
              <button
                key={pct}
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!inBalance}
                onClick={() => inBalance && setInput(toInputString((inBalance * BigInt(pct)) / 100n))}
              >
                {pct}%
              </button>
            ))}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!inBalance}
            onClick={() => inBalance && setInput(toInputString(inBalance))}
          >
            Max
          </button>
        </div>
      </div>

      <div className="summary">
        <div className="summary-row">
          <span>You receive</span>
          <span className="big num">
            {q ? `${formatToken(q.amountOut)} ${unitOut}` : quote.data === undefined && amount && tradable && !quoteError ? <span className="skeleton" /> : '—'}
          </span>
        </div>
        <div className="summary-row">
          <span>Average price</span>
          <span className="num">{avgPrice === undefined ? '—' : `${(avgPrice * 100).toFixed(1)}¢ per ${isYes ? 'YES' : 'NO'}`}</span>
        </div>
        {isBuy && q && (
          <div className="summary-row">
            <span>If {isYes ? 'YES' : 'NO'} wins</span>
            <span className="num yes-text">
              {formatUsd(Number(q.amountOut) / 1e6)} (+{formatUsd(Number(q.amountOut - q.amountIn) / 1e6)})
            </span>
          </div>
        )}
        <div className="summary-row">
          <span className="slippage">
            Max slippage
            <select
              aria-label="Slippage"
              className="slippage-input"
              style={{ width: 'auto' }}
              value={slippage === undefined ? 'auto' : String(slippage)}
              onChange={(e) => setSlippage(e.target.value === 'auto' ? undefined : Number(e.target.value))}
            >
              {SLIPPAGE_CHOICES.map((s) => (
                <option key={String(s)} value={s === undefined ? 'auto' : String(s)}>
                  {s === undefined ? 'Auto' : `${s / 100}%`}
                </option>
              ))}
            </select>
          </span>
          <span className="num">
            {slippageBps === undefined ? '—' : `${(slippageBps / 100).toFixed(slippageBps < 1000 ? 1 : 0)}%`}
            {minOut !== undefined && <span className="muted"> · min {formatToken(minOut)}</span>}
          </span>
        </div>
      </div>

      {quoteError !== undefined && tradable && amount !== undefined && (
        <div className="notice error" style={{ marginTop: 12 }}>
          {describeError(quoteError)}
        </div>
      )}
      {tradable && cutoffOf(market.info) - now <= 8 && (
        <div className="notice warn" style={{ marginTop: 12 }}>
          Trading closes in {formatCountdown(cutoffOf(market.info) - now)}. A swap that lands after the cutoff reverts.
        </div>
      )}
      {conn && bal && bal.eth === 0n && (
        <div className="notice warn" style={{ marginTop: 12 }}>
          This account has no ETH on Unichain Sepolia for gas.
        </div>
      )}

      <div className="trade-cta">
        <button type="button" className={`btn btn-lg ${cta.cls}`} onClick={cta.action} disabled={cta.disabled}>
          {busy && <span className="spinner" />}
          {cta.text}
        </button>
      </div>

      <Steps steps={steps} cfg={cfg} />

      {result && (
        <div className={`notice ${result.ok ? 'success' : 'error'}`} style={{ marginTop: 12 }}>
          <span>
            {result.text}
            {result.hash && (
              <>
                {' '}
                · <TxLink cfg={cfg} hash={result.hash} />
              </>
            )}
          </span>
        </div>
      )}

      <p className="muted" style={{ fontSize: 12, margin: '14px 0 0' }}>
        Quoted by the Uniswap V4Quoter and executed by UniversalRouter 2.0 with Permit2. The hook prices every swap with
        Black-Scholes; there is no liquidity curve.
      </p>
    </section>
  )
}
