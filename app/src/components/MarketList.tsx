import { useState } from 'react'
import { formatCents, formatClock, formatCountdown, formatToken, formatUsd } from '../format.ts'
import { type AppMarket, cutoffOf, groupMarkets, hasPrices, marketPhase, strikeOf } from '../market.ts'
import type { Track } from '../sdk.ts'

interface Props {
  markets: AppMarket[]
  tracks: Track[]
  selectedId?: bigint
  onSelect: (id: bigint) => void
  now: number
  balances?: Map<string, bigint>
  loading: boolean
}

function Row({ m, selected, onSelect, now, balances }: { m: AppMarket; selected: boolean; onSelect: () => void; now: number; balances?: Map<string, bigint> }) {
  const phase = marketPhase(m.info, now)
  const yesBal = balances?.get(m.yes.address.toLowerCase()) ?? 0n
  const noBal = balances?.get(m.no.address.toLowerCase()) ?? 0n
  const priced = hasPrices(m.quote) ? m.quote : undefined
  const at = formatClock(m.info.expiry)
  let meta: string
  if (phase === 'trading') {
    meta = `at ${at} · closes in ${formatCountdown(cutoffOf(m.info) - now)}`
  } else if (phase === 'upcoming') {
    meta = `at ${at} · opens in ${formatCountdown(Number(m.info.openTime) - now)}`
  } else if (phase === 'closing') {
    meta = `at ${at} · averaging ${formatCountdown(Number(m.info.expiry) - now)}`
  } else if (phase === 'awaiting') {
    meta = `at ${at} · settling`
  } else {
    meta = `expired ${at}`
  }
  const winnerBal = phase === 'settled' ? (m.info.yesWon ? yesBal : noBal) : 0n
  return (
    <button type="button" className={`market-row${selected ? ' selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
      <span className="market-row-q num">{m.asset} above {formatUsd(strikeOf(m.info))}</span>
      <span className="market-row-right">
        {phase === 'settled' ? (
          <span className={`chip ${m.info.yesWon ? 'yes' : 'no'}`}>{m.info.yesWon ? 'YES won' : 'NO won'}</span>
        ) : phase === 'invalid' ? (
          <span className="chip warn">Invalid</span>
        ) : priced && phase === 'trading' ? (
          <span className="market-row-prob num" title="YES mid price">
            {formatCents(priced.midYes, priced.midYes < 10n ** 17n || priced.midYes > 9n * 10n ** 17n ? 1 : 0)}
          </span>
        ) : (
          <span className="chip">{phase === 'awaiting' ? 'Settling' : 'Closed'}</span>
        )}
      </span>
      <span className="market-row-meta num">
        <span>{m.track ? `${m.track.label} · ${meta}` : meta}</span>
        {winnerBal > 0n && <span className="chip accent">Redeem {formatToken(winnerBal)}</span>}
        {winnerBal === 0n && (yesBal > 0n || noBal > 0n) && phase !== 'settled' && (
          <span className="chip accent">
            {yesBal > 0n ? `${formatToken(yesBal)} YES` : ''}
            {yesBal > 0n && noBal > 0n ? ' · ' : ''}
            {noBal > 0n ? `${formatToken(noBal)} NO` : ''}
          </span>
        )}
      </span>
    </button>
  )
}

export function MarketList({ markets, tracks, selectedId, onSelect, now, balances, loading }: Props) {
  const [filter, setFilter] = useState<string>()
  const shown = filter ? markets.filter((m) => m.track?.scheduler === filter) : markets
  const groups = groupMarkets(shown, now)
  const sections: [string, AppMarket[], string][] = [
    ['Open', groups.open, 'No market is open right now. The keeper opens a new one every minute.'],
    ['Closed · awaiting settlement', groups.closed, 'Nothing waiting for settlement.'],
    ['Settled', groups.settled, 'No settled markets yet.'],
  ]
  return (
    <nav className="card markets" aria-label="Markets">
      {tracks.length > 1 && (
        <div className="track-tabs" role="tablist" aria-label="Tracks">
          {[undefined, ...tracks].map((t) => (
            <button
              key={t?.scheduler ?? 'all'}
              type="button"
              role="tab"
              aria-selected={filter === t?.scheduler}
              className={`tab${filter === t?.scheduler ? ' active' : ''}`}
              onClick={() => setFilter(t?.scheduler)}
            >
              {t ? `${t.asset} ${t.label}` : 'All'}
            </button>
          ))}
        </div>
      )}
      <div className="markets-scroll">
        {sections.map(([title, list, empty]) => (
          <div key={title} style={{ display: 'contents' }}>
            <div className="market-group-title">
              <span>{title}</span>
              <span>{list.length || ''}</span>
            </div>
            {list.length === 0 ? (
              <div className="empty">{loading ? 'Loading…' : empty}</div>
            ) : (
              list.map((m) => (
                <Row
                  key={m.id.toString()}
                  m={m}
                  selected={m.id === selectedId}
                  onSelect={() => onSelect(m.id)}
                  now={now}
                  balances={balances}
                />
              ))
            )}
          </div>
        ))}
      </div>
    </nav>
  )
}
