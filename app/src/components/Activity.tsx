import type { AppConfig } from '../config.ts'
import { TxLink } from './Steps.tsx'

export interface ActivityItem {
  id: number
  at: number
  label: string
  hash?: string
  status: 'success' | 'failed'
}

export function Activity({ items, cfg }: { items: ActivityItem[]; cfg: AppConfig }) {
  return (
    <section className="card card-pad" aria-label="Your activity">
      <h2 className="card-title">Your activity</h2>
      {items.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Swaps, redemptions and settlements you send from this page appear here with explorer links.
        </p>
      ) : (
        <ul className="activity">
          {items.slice(0, 8).map((a) => (
            <li key={a.id}>
              <span className={`dot ${a.status === 'failed' ? 'failed' : ''}`} />
              <span className="activity-label" title={a.label}>
                {a.label}
              </span>
              {a.hash ? <TxLink cfg={cfg} hash={a.hash} /> : <span />}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
