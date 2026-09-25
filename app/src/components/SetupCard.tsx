import { useState } from 'react'
import { isAddress } from 'viem'
import type { AppConfig } from '../config.ts'
import { SAVED_HOOK_KEY, writeSaved } from '../config.ts'

export function SetupCard({ cfg, error }: { cfg: AppConfig; error?: string }) {
  const [value, setValue] = useState('')
  const valid = isAddress(value.trim(), { strict: false })
  const save = () => {
    writeSaved(SAVED_HOOK_KEY, value.trim())
    const url = new URL(window.location.href)
    url.searchParams.delete('hook')
    window.location.href = url.toString()
  }
  return (
    <section className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>
      <h1 className="mv-question" style={{ fontSize: 26 }}>
        {cfg.hook ? 'Cannot read the PredictionHook' : 'Point this page at a PredictionHook'}
      </h1>
      {error && (
        <div className="notice error" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}
      <p className="secondary">
        The hook address comes from <span className="mono">?hook=0x…</span>, <span className="mono">VITE_PREDICTION_HOOK</span>,
        or <span className="mono">deployments/unichain-sepolia.json</span> at build time. You can also save one in this
        browser:
      </p>
      <input
        className="setup-input"
        placeholder="0x… PredictionHook address"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="PredictionHook address"
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" disabled={!valid} onClick={save}>
          Save and reload
        </button>
        {cfg.hookSource === 'saved' && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              writeSaved(SAVED_HOOK_KEY, null)
              window.location.reload()
            }}
          >
            Forget saved hook
          </button>
        )}
      </div>
      <p className="muted mono" style={{ fontSize: 12, marginTop: 16, overflowWrap: 'anywhere' }}>
        RPC {cfg.rpcUrl} · chain {cfg.chainId}
      </p>
    </section>
  )
}
