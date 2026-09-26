import type { HistoryPoint, LiveState, MarketParamsLite } from '../data.ts'
import { formatCents, formatClock, formatCountdown, formatPercent, formatSignedUsd, formatUsd, localTimeZoneName } from '../format.ts'
import {
  type AppMarket,
  cutoffOf,
  hasPrices,
  marketPhase,
  type Phase,
  questionText,
  sigmaAnnual,
  strikeOf,
  trackName,
  windowStartOf,
} from '../market.ts'
import type { Market } from '../sdk.ts'
import { WAD } from '../sdk.ts'
import { Sparkline } from './Sparkline.tsx'

interface Props {
  market: AppMarket
  live?: LiveState
  params?: MarketParamsLite
  history: HistoryPoint[]
  now: number
}

const PHASE_LABEL: Record<Phase, string> = {
  upcoming: 'Opening soon',
  trading: 'Trading',
  closing: 'Trading closed',
  awaiting: 'Awaiting settlement',
  settled: 'Settled',
  invalid: 'Invalid',
}

function Countdown({ market, phase, now }: { market: Market; phase: Phase; now: number }) {
  const info = market.info
  const expiry = Number(info.expiry)
  const windowStart = windowStartOf(info)
  let label: string
  let value: string
  let urgent = false
  switch (phase) {
    case 'upcoming':
      label = 'Opens in'
      value = formatCountdown(Number(info.openTime) - now)
      break
    case 'trading':
      label = 'Trading closes in'
      value = formatCountdown(cutoffOf(info) - now)
      urgent = cutoffOf(info) - now <= 10
      break
    case 'closing':
      label = now < windowStart ? 'Averaging starts in' : 'Averaging ends in'
      value = formatCountdown((now < windowStart ? windowStart : expiry) - now)
      break
    case 'awaiting':
      label = 'Expired'
      value = `+${formatCountdown(now - expiry)}`
      break
    case 'settled':
      label = 'Result'
      value = info.yesWon ? 'YES' : 'NO'
      break
    case 'invalid':
      label = 'Result'
      value = '50 / 50'
      break
  }
  return (
    <div className="countdown" aria-live="off">
      <div className="countdown-label">{label}</div>
      <div
        className={`countdown-value num${urgent ? ' urgent' : ''}${phase === 'settled' ? (info.yesWon ? ' yes-text' : ' no-text') : ''}`}
      >
        {value}
      </div>
    </div>
  )
}

function Timeline({ market, now }: { market: Market; now: number }) {
  const info = market.info
  const open = Number(info.openTime)
  const cutoff = cutoffOf(info)
  const wStart = windowStartOf(info)
  const expiry = Number(info.expiry)
  const segs = [
    { cls: 'trading', a: open, b: cutoff, title: 'Trading' },
    { cls: 'buffer', a: cutoff, b: wStart, title: 'Cutoff buffer' },
    { cls: 'window', a: wStart, b: expiry, title: 'Settlement averaging window' },
  ].filter((s) => s.b > s.a)
  return (
    <div className="timeline">
      <div className="timeline-bar" role="presentation">
        {segs.map((s) => {
          const fill = Math.min(1, Math.max(0, (now - s.a) / (s.b - s.a)))
          return (
            <div key={s.cls} className={`timeline-seg ${s.cls}`} style={{ flexGrow: s.b - s.a }} title={s.title}>
              <div className="timeline-fill" style={{ width: `${fill * 100}%` }} />
            </div>
          )
        })}
      </div>
      <div className="timeline-labels num">
        <span>Open {formatClock(open)}</span>
        <span>Cutoff {formatClock(cutoff)}</span>
        <span>Expiry {formatClock(expiry)}</span>
      </div>
    </div>
  )
}

export function MarketView({ market, live, params, history, now }: Props) {
  const info = market.info
  const phase = marketPhase(info, now)
  const strike = strikeOf(info)
  const expiryClock = formatClock(info.expiry)
  const quote = live?.quote
  const priced = hasPrices(quote) ? quote : undefined
  const eth = live?.spot
  const asset = market.asset
  const diff = eth === undefined ? undefined : eth - strike
  const sigma = quote ? sigmaAnnual(quote.varE36) : undefined
  const midYes = priced ? Number(priced.midYes) / 1e18 : undefined
  const tz = localTimeZoneName()
  const windowSec = info.window
  const midPoints = history.filter((p) => p.mid !== undefined).map((p) => ({ t: p.t, v: p.mid as number }))
  const ethPoints = history.filter((p) => p.eth !== undefined).map((p) => ({ t: p.t, v: p.eth as number }))
  const tau = Math.max(0, Number(info.expiry) - now)
  const t0 = Number(info.openTime)
  const t1 = Number(info.expiry)
  const avg = live?.windowAvg
  const showWindow = phase === 'closing' || phase === 'awaiting'

  return (
    <section className="card card-pad" aria-labelledby="market-question">
      <div className="mv-top">
        <div style={{ minWidth: 0, flex: '1 1 380px' }}>
          <div className="mv-eyebrow">
            <span className={`chip ${phase === 'trading' ? 'accent' : phase === 'settled' ? (info.yesWon ? 'yes' : 'no') : phase === 'invalid' ? 'warn' : ''}`}>
              {phase === 'trading' && <span className="dot live" />}
              {PHASE_LABEL[phase]}
            </span>
            <span className="chip">{trackName(market)}</span>
            <span>Market #{market.id.toString()}</span>
            <span>·</span>
            <span>{tz ? `times in ${tz}` : 'local time'}</span>
          </div>
          <h1 className="mv-question" id="market-question">
            {questionText(strike, expiryClock, asset)}
          </h1>
          <p className="mv-rule">
            Settles <b className="yes-text">YES</b> if the average {asset} price from {formatClock(windowStartOf(info))} to{' '}
            {expiryClock} ({windowSec} s geometric TWAP of our Uniswap v4 {asset}/USDC pool) is above {formatUsd(strike)}.
            Each winning token pays 1 USDC.
          </p>
        </div>
        <Countdown market={market} phase={phase} now={now} />
      </div>

      <Timeline market={market} now={now} />

      <div className="stats">
        <div className="stat">
          <div className="stat-label">{asset} price (oracle)</div>
          <div className="stat-value num">{eth === undefined ? <span className="skeleton" /> : formatUsd(eth)}</div>
          <div className={`stat-sub num ${diff === undefined ? '' : diff > 0 ? 'yes-text' : 'no-text'}`}>
            {diff === undefined ? 'start-of-block price' : `${formatSignedUsd(diff)} vs strike`}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Chance of YES</div>
          <div className="stat-value num">{midYes === undefined ? '—' : formatPercent(midYes, 1)}</div>
          <div className="stat-sub">
            {midYes === undefined ? (phase === 'trading' ? 'pricing…' : 'quotes stop at the cutoff') : 'Black-Scholes mid'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Volatility σ</div>
          <div className="stat-value num">{sigma === undefined ? '—' : formatPercent(sigma, 0)}</div>
          <div className="stat-sub">
            annualised · {params ? (params.sigmaMode === 0 ? 'from pool oracle' : 'fixed') : 'oracle'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Time to expiry τ</div>
          <div className="stat-value num">{formatCountdown(tau)}</div>
          <div className="stat-sub">
            {windowSec} s window{params ? ` · ${params.nSamples} samples` : ''}
          </div>
        </div>
      </div>

      {showWindow && (
        <div className="notice" style={{ marginTop: 12 }}>
          <span className="dot warn live" style={{ marginTop: 6 }} />
          <span>
            {avg ? (
              <>
                Settlement average so far ({Math.min(avg.seconds, windowSec)} of {windowSec} s):{' '}
                <b className="num">{formatUsd(avg.price)}</b>,{' '}
                {avg.price > strike ? (
                  <b className="yes-text">above the strike, YES is ahead</b>
                ) : (
                  <b className="no-text">not above the strike, NO is ahead</b>
                )}
                .
              </>
            ) : (
              <>Trading is closed. The averaging window starts at {formatClock(windowStartOf(info))}.</>
            )}
          </span>
        </div>
      )}

      <div className="charts">
        <div className="chart-card">
          <div className="chart-head">
            <span className="chart-title">YES mid price</span>
            <span className="chart-now num">{priced ? formatCents(priced.midYes) : '—'}</span>
          </div>
          <Sparkline
            points={midPoints}
            t0={t0}
            t1={t1}
            yDomain={[0, 1]}
            reference={{ value: 0.5, label: '50¢' }}
            marker={{ t: cutoffOf(info), label: 'cutoff' }}
            color="var(--chart-line)"
            format={(v) => `${(v * 100).toFixed(1)}¢`}
            formatTime={formatClock}
            label="YES mid price over time"
          />
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <span className="chart-title">{asset} price vs strike</span>
            <span className="chart-now num">{formatUsd(eth)}</span>
          </div>
          <Sparkline
            points={ethPoints}
            t0={t0}
            t1={t1}
            reference={{ value: strike, label: `strike ${formatUsd(strike)}` }}
            marker={{ t: windowStartOf(info), label: 'window' }}
            color="var(--chart-eth)"
            format={(v) => formatUsd(v)}
            formatTime={formatClock}
            label={`${asset} price over time`}
          />
        </div>
      </div>

      <div className="board">
        <div className="board-side yes">
          <div className="board-head">
            <span className="board-name yes-text">YES</span>
            <span className="muted board-caption" style={{ fontSize: 12 }}>
              pays $1 if above
            </span>
          </div>
          <div className="board-mid num">{priced ? formatCents(priced.midYes) : '—'}</div>
          <div className="board-row num">
            <span>
              Bid <b>{priced ? formatCents(priced.bidYes) : '—'}</b>
            </span>
            <span>
              Ask <b>{priced ? formatCents(priced.askYes) : '—'}</b>
            </span>
          </div>
        </div>
        <div className="board-side no">
          <div className="board-head">
            <span className="board-name no-text">NO</span>
            <span className="muted board-caption" style={{ fontSize: 12 }}>
              pays $1 if not above
            </span>
          </div>
          <div className="board-mid num">{priced ? formatCents(WAD - priced.midYes) : '—'}</div>
          <div className="board-row num">
            <span>
              Bid <b>{priced ? formatCents(priced.bidNo) : '—'}</b>
            </span>
            <span>
              Ask <b>{priced ? formatCents(priced.askNo) : '—'}</b>
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}
