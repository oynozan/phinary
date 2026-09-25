import { useEffect, useRef, useState } from 'react'
import type { AppConfig } from '../config.ts'
import { addressUrl } from '../config.ts'
import { formatToken, formatUsd, shortAddress } from '../format.ts'
import type { Connection, InjectedWallet } from '../wallet.ts'

interface Props {
  cfg: AppConfig
  ethPrice?: number
  conn?: Connection
  chainOk: boolean
  usdcBalance?: bigint
  wallets: InjectedWallet[]
  connecting: boolean
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
  onConnect: (w: InjectedWallet) => void
  onBurner: () => void
  onSwitchChain: () => void
  onDisconnect: () => void
  rpcOk: boolean
}

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path d="M7 21.5c3.2 0 4.6-11 9-11s5.8 11 9 11" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="16" cy="10.5" r="2.2" fill="#fff" />
    </svg>
  )
}

export function Header(p: Props) {
  const { cfg, conn } = p
  const ref = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!p.menuOpen) {
      return
    }
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        p.setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [p.menuOpen, p.setMenuOpen])

  const copy = async () => {
    if (!conn) {
      return
    }
    try {
      await navigator.clipboard.writeText(conn.address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <header className="header">
      <div className="header-inner">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">ETH Binary Markets</div>
            <div className="brand-sub">Black-Scholes priced YES/NO on a Uniswap v4 hook</div>
          </div>
        </div>
        <div className="header-spacer" />
        <span className="pill header-net" title={cfg.rpcUrl}>
          <span className={`dot ${p.rpcOk ? '' : 'warn'}`} />
          {cfg.isLocalRpc ? 'Local fork' : 'Unichain Sepolia'}
        </span>
        <div className="header-eth">
          <span className="header-eth-label">ETH / USD</span>
          <span className="header-eth-value num">{formatUsd(p.ethPrice)}</span>
        </div>
        <div className="menu-wrap" ref={ref}>
          {conn ? (
            p.chainOk ? (
              <button type="button" className="btn btn-ghost" onClick={() => p.setMenuOpen(!p.menuOpen)}>
                <span className="num">{p.usdcBalance === undefined ? '' : `${formatToken(p.usdcBalance)} USDC`}</span>
                <span className="mono">{shortAddress(conn.address)}</span>
              </button>
            ) : (
              <button type="button" className="btn btn-warn" onClick={p.onSwitchChain}>
                Switch network
              </button>
            )
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={p.connecting}
              onClick={() => {
                if (p.wallets.length === 1 && !cfg.devTools) {
                  p.onConnect(p.wallets[0] as InjectedWallet)
                } else {
                  p.setMenuOpen(!p.menuOpen)
                }
              }}
            >
              {p.connecting && <span className="spinner" />}
              Connect wallet
            </button>
          )}
          {p.menuOpen && (
            <div className="menu" role="menu">
              {conn ? (
                <>
                  <div className="menu-note">
                    {conn.name} · <span className="mono">{shortAddress(conn.address)}</span>
                  </div>
                  <button type="button" className="menu-item" onClick={copy}>
                    {copied ? 'Copied' : 'Copy address'}
                  </button>
                  <a className="menu-item" href={addressUrl(cfg, conn.address)} target="_blank" rel="noreferrer">
                    View on Uniscan ↗
                  </a>
                  {!cfg.isLocalRpc && (
                    <a className="menu-item" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">
                      Get testnet USDC ↗
                    </a>
                  )}
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      p.onDisconnect()
                      p.setMenuOpen(false)
                    }}
                  >
                    Disconnect
                  </button>
                </>
              ) : (
                <>
                  {p.wallets.map((w) => (
                    <button key={w.id} type="button" className="menu-item" onClick={() => p.onConnect(w)}>
                      {w.icon && <img src={w.icon} alt="" />}
                      {w.name}
                    </button>
                  ))}
                  {p.wallets.length === 0 && (
                    <div className="menu-note">
                      No browser wallet found. Install{' '}
                      <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                        MetaMask
                      </a>
                      .
                    </div>
                  )}
                  {cfg.devTools && (
                    <button type="button" className="menu-item" onClick={p.onBurner}>
                      Burner wallet (local fork)
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
