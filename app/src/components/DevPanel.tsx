import { useState } from 'react'
import { type Address, parseEther, type PublicClient, type TestClient } from 'viem'
import type { AppConfig } from '../config.ts'
import { dealErc20, fundEth } from '../devtools.ts'
import { describeError } from '../trade.ts'
import type { Connection } from '../wallet.ts'

interface Props {
  cfg: AppConfig
  pub: PublicClient
  test?: TestClient<'anvil'>
  conn?: Connection
  usdc?: Address
  onBurner: (fresh: boolean) => void
  onFunded: () => void
}

export function DevPanel({ cfg, pub, test, conn, usdc, onBurner, onFunded }: Props) {
  const [status, setStatus] = useState<string>()
  const [busy, setBusy] = useState(false)

  const fund = async () => {
    if (!test || !conn || !usdc) {
      return
    }
    setBusy(true)
    setStatus('Funding…')
    try {
      await fundEth(test, conn.address, parseEther('10'))
      await dealErc20(pub, test, usdc, conn.address, 1_000_000_000n)
      setStatus('Funded 10 ETH and 1,000 USDC')
      onFunded()
    } catch (err) {
      setStatus(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="card card-pad dev">
      <summary>Local fork tools</summary>
      <div className="dev-body">
        <div className="muted mono" style={{ overflowWrap: 'anywhere' }}>
          RPC {cfg.rpcUrl} · chain {cfg.chainId}
        </div>
        <div className="dev-row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onBurner(false)}>
            Use burner wallet
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onBurner(true)}>
            New burner
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!conn || !test || !usdc || busy} onClick={fund}>
            Fund 10 ETH + 1,000 USDC
          </button>
        </div>
        {status && <div className="secondary">{status}</div>}
        <div className="muted">
          Funding uses anvil cheat codes and only works against an anvil RPC. MetaMask must sign through the same RPC:
          connect once and approve the "add network" prompt.
        </div>
      </div>
    </details>
  )
}
