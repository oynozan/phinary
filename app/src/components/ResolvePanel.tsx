import { useState } from 'react'
import type { AppConfig } from '../config.ts'
import type { LiveState } from '../data.ts'
import { formatClock, formatToken, formatUsd, parseAmount, toInputString } from '../format.ts'
import { type Phase, strikeOf, windowStartOf } from '../market.ts'
import type { Market } from '../sdk.ts'
import { describeError, type ExecContext, executeRedeem, executeSettle, executeSwap, type Step } from '../trade.ts'
import type { Connection } from '../wallet.ts'
import { Steps, TxLink } from './Steps.tsx'
import type { ActivityInput } from './TradePanel.tsx'

interface Props {
  cfg: AppConfig
  market: Market
  phase: Phase
  live?: LiveState
  conn?: Connection
  exec?: ExecContext
  onConnect: () => void
  onSwitchChain: () => void
  onActivity: (a: ActivityInput) => void
  onTxDone: () => void
}

export function ResolvePanel(p: Props) {
  const { cfg, market, phase, live, conn, exec } = p
  const [steps, setSteps] = useState<Step[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: string } | undefined>()
  const [input, setInput] = useState('')

  const bal = live?.balances
  const yesWon = market.info.yesWon
  const settled = phase === 'settled'
  const invalid = phase === 'invalid'
  const winnerBal = bal ? (settled ? (yesWon ? bal.yes : bal.no) : 0n) : undefined
  const loserBal = bal ? (settled ? (yesWon ? bal.no : bal.yes) : 0n) : undefined
  const winnerName = yesWon ? 'YES' : 'NO'
  const typed = parseAmount(input)
  const redeemAmount = typed ?? winnerBal ?? 0n

  const run = async (label: string, fn: () => Promise<{ hash: string }>) => {
    setBusy(true)
    setResult(undefined)
    try {
      const res = await fn()
      setResult({ ok: true, text: label, hash: res.hash })
      p.onActivity({ label: `${label} · market #${market.id}`, hash: res.hash, status: 'success' })
      setInput('')
    } catch (err) {
      const text = describeError(err)
      setResult({ ok: false, text })
      p.onActivity({ label: `Market #${market.id}: ${text}`, status: 'failed' })
    } finally {
      setBusy(false)
      p.onTxDone()
    }
  }

  const redeemViaSwap = (isYes: boolean, amount: bigint, price: number) =>
    exec &&
    run(`Redeemed ${formatToken(amount)} ${isYes ? 'YES' : 'NO'} for ${formatUsd((Number(amount) / 1e6) * price)}`, () =>
      executeSwap(
        exec,
        { market, isYes, isBuy: false, amount, label: `Sell ${isYes ? 'YES' : 'NO'} at ${formatUsd(price)} through UniversalRouter` },
        setSteps,
      ),
    )

  const redeemDirect = (amount: bigint) =>
    exec && run(`Redeemed ${formatToken(amount)} tokens with hook.redeem()`, () => executeRedeem(exec, market, amount, setSteps))

  const settle = () => exec && run('Market settled', () => executeSettle(exec, market, setSteps))

  const walletGate = !conn ? (
    <button type="button" className="btn btn-lg btn-primary" onClick={p.onConnect}>
      Connect wallet
    </button>
  ) : !exec ? (
    <button type="button" className="btn btn-lg btn-warn" onClick={p.onSwitchChain}>
      Switch to Unichain Sepolia
    </button>
  ) : undefined

  return (
    <section className="card card-pad" aria-label="Settlement">
      {phase === 'closing' && (
        <>
          <h2 className="card-title">Trading closed</h2>
          <p className="secondary" style={{ margin: 0 }}>
            The hook stopped quoting at the cutoff. The outcome is the {market.info.window} s average ETH price from{' '}
            {formatClock(windowStartOf(market.info))} to {formatClock(market.info.expiry)} against the{' '}
            {formatUsd(strikeOf(market.info))} strike.
          </p>
        </>
      )}

      {phase === 'awaiting' && (
        <>
          <h2 className="card-title">Awaiting settlement</h2>
          <p className="secondary" style={{ margin: '0 0 14px' }}>
            The market expired at {formatClock(market.info.expiry)}. The keeper settles it within seconds; settlement is
            permissionless, so you can also do it yourself.
          </p>
          {walletGate ?? (
            <button type="button" className="btn btn-lg btn-primary" onClick={settle} disabled={busy}>
              {busy && <span className="spinner" />}
              Settle now
            </button>
          )}
        </>
      )}

      {settled && (
        <div className={`winner-banner ${yesWon ? 'yes' : 'no'}`}>
          <span style={{ fontSize: 26 }} aria-hidden>
            {yesWon ? '▲' : '▼'}
          </span>
          <span>
            {winnerName} won
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-2)' }}>
              Each {winnerName} token redeems for exactly $1.00
            </div>
          </span>
        </div>
      )}

      {invalid && (
        <div className="winner-banner invalid">
          <span>
            Invalid market
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-2)' }}>
              The oracle could not answer; YES and NO each redeem for $0.50
            </div>
          </span>
        </div>
      )}

      {(settled || invalid || phase === 'closing' || phase === 'awaiting') && conn && bal && (
        <div className="position" style={{ marginTop: 14 }}>
          <div className="position-cell">
            <div className="label">Your YES</div>
            <div className="value num yes-text">{formatToken(bal.yes)}</div>
          </div>
          <div className="position-cell">
            <div className="label">Your NO</div>
            <div className="value num no-text">{formatToken(bal.no)}</div>
          </div>
        </div>
      )}

      {settled && (
        <div style={{ marginTop: 14 }}>
          {walletGate ??
            (winnerBal && winnerBal > 0n ? (
              <>
                <div className="field" style={{ marginTop: 0 }}>
                  <div className="field-top">
                    <label htmlFor="redeem-amount">Redeem</label>
                    <button type="button" className="btn-link" onClick={() => setInput(toInputString(winnerBal))}>
                      Max {formatToken(winnerBal)}
                    </button>
                  </div>
                  <div className="field-main">
                    <input
                      id="redeem-amount"
                      className="amount-input"
                      inputMode="decimal"
                      placeholder={toInputString(winnerBal)}
                      value={input}
                      onChange={(e) => setInput(e.target.value.replace(/[^\d.,]/g, ''))}
                    />
                    <span className="unit">{winnerName}</span>
                  </div>
                </div>
                <div className="summary">
                  <div className="summary-row">
                    <span>You receive</span>
                    <span className="big num">{formatUsd(Number(redeemAmount) / 1e6)} USDC</span>
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
                  <button
                    type="button"
                    className={`btn btn-lg ${yesWon ? 'btn-yes' : 'btn-no'}`}
                    disabled={busy || redeemAmount === 0n || redeemAmount > winnerBal}
                    onClick={() => redeemViaSwap(yesWon, redeemAmount, 1)}
                  >
                    {busy && <span className="spinner" />}
                    Redeem via Uniswap swap
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy || redeemAmount === 0n || redeemAmount > winnerBal}
                    onClick={() => redeemDirect(redeemAmount)}
                  >
                    Redeem directly with hook.redeem()
                  </button>
                </div>
              </>
            ) : (
              <p className="secondary" style={{ margin: 0 }}>
                {loserBal && loserBal > 0n
                  ? `Your ${yesWon ? 'NO' : 'YES'} tokens expired worthless.`
                  : `You hold no ${winnerName} tokens in this market.`}
              </p>
            ))}
        </div>
      )}

      {invalid && (
        <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
          {walletGate ??
            ([true, false] as const).map((isYes) => {
              const b = bal ? (isYes ? bal.yes : bal.no) : 0n
              return (
                <button
                  key={String(isYes)}
                  type="button"
                  className="btn btn-lg btn-primary"
                  disabled={busy || b === 0n}
                  onClick={() => redeemViaSwap(isYes, b, 0.5)}
                >
                  Sell {formatToken(b)} {isYes ? 'YES' : 'NO'} at $0.50
                </button>
              )
            })}
        </div>
      )}

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
    </section>
  )
}
