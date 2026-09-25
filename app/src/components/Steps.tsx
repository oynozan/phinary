import type { AppConfig } from '../config.ts'
import { txUrl } from '../config.ts'
import { shortHash } from '../format.ts'
import type { Step } from '../trade.ts'

const ICON: Record<Step['status'], string> = {
  pending: '',
  active: '',
  done: '✓',
  skipped: '–',
  failed: '!',
}

export function TxLink({ cfg, hash }: { cfg: AppConfig; hash: string }) {
  return (
    <a href={txUrl(cfg, hash)} target="_blank" rel="noreferrer" className="mono" title={cfg.isLocalRpc ? 'Local fork transaction, not on the public explorer' : hash}>
      {shortHash(hash)} ↗
    </a>
  )
}

export function Steps({ steps, cfg }: { steps: Step[]; cfg: AppConfig }) {
  if (!steps.length) {
    return null
  }
  return (
    <ol className="steps" aria-label="Transaction steps">
      {steps.map((s, i) => (
        <li key={s.id} className={`step ${s.status}`}>
          <span className="step-icon" aria-hidden>
            {s.status === 'active' ? <span className="spinner" /> : ICON[s.status] || i + 1}
          </span>
          <span>
            <div className="step-label">{s.label}</div>
            {(s.detail || s.hash) && (
              <div className="step-detail">
                {s.detail}
                {s.detail && s.hash ? ' · ' : ''}
                {s.hash && <TxLink cfg={cfg} hash={s.hash} />}
              </div>
            )}
          </span>
        </li>
      ))}
    </ol>
  )
}
