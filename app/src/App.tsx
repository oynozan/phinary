import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Address, getAddress } from 'viem'
import { ChainClock, makeClients } from './chain.ts'
import { addressUrl, loadConfig, readSaved, writeSaved } from './config.ts'
import {
  backfillHistory,
  fetchBalances,
  fetchLive,
  fetchMarkets,
  fetchParams,
  type HistoryPoint,
  mergeHistory,
  usePolling,
  useTicker,
} from './data.ts'
import { formatClock, formatUsd, shortAddress } from './format.ts'
import { defaultMarketId, groupMarkets, hasPrices, marketPhase, strikeOf, withInfo } from './market.ts'
import { describeError, type ExecContext } from './trade.ts'
import {
  burnerConnection,
  type Connection,
  discoverWallets,
  type Eip1193Provider,
  hasBurner,
  type InjectedWallet,
  injectedConnection,
  requestAccounts,
  switchToAppChain,
} from './wallet.ts'
import { Activity, type ActivityItem } from './components/Activity.tsx'
import { DevPanel } from './components/DevPanel.tsx'
import { Header } from './components/Header.tsx'
import { MarketList } from './components/MarketList.tsx'
import { MarketView } from './components/MarketView.tsx'
import { ResolvePanel } from './components/ResolvePanel.tsx'
import { SetupCard } from './components/SetupCard.tsx'
import { type ActivityInput, TradePanel } from './components/TradePanel.tsx'

const LAST_WALLET_KEY = 'prediction.backup.wallet'
const ACTIVITY_KEY = 'prediction.backup.activity'
const THEME_KEY = 'prediction.backup.theme'

type Theme = 'auto' | 'light' | 'dark'

function applyTheme(theme: Theme) {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', theme)
  }
}

function loadActivity(): ActivityItem[] {
  try {
    const raw = readSaved(ACTIVITY_KEY)
    const parsed = raw ? (JSON.parse(raw) as ActivityItem[]) : []
    return Array.isArray(parsed) ? parsed.slice(0, 20) : []
  } catch {
    return []
  }
}

export function App() {
  const cfg = useMemo(loadConfig, [])
  const { chain, pub, test } = useMemo(() => makeClients(cfg), [cfg])
  const clock = useMemo(() => new ChainClock(), [])
  useTicker(250)
  const now = clock.estimate()

  const [theme, setTheme] = useState<Theme>(() => (readSaved(THEME_KEY) as Theme | null) ?? 'auto')
  useEffect(() => {
    applyTheme(theme)
    writeSaved(THEME_KEY, theme === 'auto' ? null : theme)
  }, [theme])

  /* Wallet */

  const [wallets, setWallets] = useState<InjectedWallet[]>([])
  const [conn, setConn] = useState<Connection>()
  const [connecting, setConnecting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [walletError, setWalletError] = useState<string>()
  const autoTried = useRef(false)

  useEffect(() => discoverWallets(setWallets), [])

  const connectInjected = useCallback(
    async (w: InjectedWallet) => {
      setMenuOpen(false)
      setConnecting(true)
      setWalletError(undefined)
      try {
        const { address, chainId } = await requestAccounts(w)
        let current = chainId
        if (chainId !== cfg.chainId || cfg.isLocalRpc) {
          try {
            await switchToAppChain(w.provider, cfg, chain)
            current = Number(await w.provider.request({ method: 'eth_chainId' }))
          } catch (err) {
            setWalletError(`Could not switch network: ${describeError(err)}`)
          }
        }
        setConn(injectedConnection(w, address, current, chain))
        writeSaved(LAST_WALLET_KEY, w.id)
      } catch (err) {
        setWalletError(describeError(err))
      } finally {
        setConnecting(false)
      }
    },
    [cfg, chain],
  )

  const connectBurner = useCallback(
    (fresh = false) => {
      setMenuOpen(false)
      setWalletError(undefined)
      setConn(burnerConnection(cfg, chain, fresh))
      writeSaved(LAST_WALLET_KEY, 'burner')
    },
    [cfg, chain],
  )

  const switchChain = useCallback(async () => {
    if (!conn?.provider) {
      return
    }
    setWalletError(undefined)
    try {
      await switchToAppChain(conn.provider, cfg, chain)
    } catch (err) {
      setWalletError(`Could not switch network: ${describeError(err)}`)
    }
  }, [conn, cfg, chain])

  const disconnect = useCallback(() => {
    setConn(undefined)
    writeSaved(LAST_WALLET_KEY, null)
  }, [])

  useEffect(() => {
    if (autoTried.current || conn) {
      return
    }
    const last = readSaved(LAST_WALLET_KEY)
    if (last === 'burner' && cfg.devTools && hasBurner(cfg)) {
      autoTried.current = true
      setConn(burnerConnection(cfg, chain))
      return
    }
    const w = wallets.find((x) => x.id === last)
    if (!w) {
      return
    }
    autoTried.current = true
    void (async () => {
      try {
        const accounts = (await w.provider.request({ method: 'eth_accounts' })) as string[]
        const first = accounts[0]
        if (first) {
          const chainId = Number(await w.provider.request({ method: 'eth_chainId' }))
          setConn(injectedConnection(w, getAddress(first), chainId, chain))
        }
      } catch {
        /* stay disconnected */
      }
    })()
  }, [wallets, conn, cfg, chain])

  const provider: Eip1193Provider | undefined = conn?.provider
  useEffect(() => {
    if (!provider || !conn) {
      return
    }
    const w: InjectedWallet = { id: 'current', name: conn.name, provider }
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined
      const first = accounts?.[0]
      setConn((c) => (c && first ? injectedConnection(w, getAddress(first), c.chainId, chain) : undefined))
    }
    const onChain = (...args: unknown[]) => {
      const id = Number(args[0] as string)
      setConn((c) => (c ? injectedConnection(w, c.address, id, chain) : c))
    }
    provider.on?.('accountsChanged', onAccounts)
    provider.on?.('chainChanged', onChain)
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts)
      provider.removeListener?.('chainChanged', onChain)
    }
  }, [provider, conn?.name, chain])

  const chainOk = !!conn && conn.chainId === cfg.chainId
  const exec: ExecContext | undefined = useMemo(
    () => (conn && chainOk ? { cfg, pub, chain, conn, now: () => clock.estimate() } : undefined),
    [conn, chainOk, cfg, pub, chain, clock],
  )

  /* Chain data */

  const hook = cfg.hook
  const marketsPoll = usePolling(hook ? () => fetchMarkets(pub, cfg, hook, clock) : undefined, 3000, `markets:${hook}`)
  const markets = marketsPoll.data?.markets ?? []
  const usdc: Address | undefined = marketsPoll.data?.usdc

  const [selectedId, setSelectedId] = useState<bigint | undefined>(() => {
    const raw = new URLSearchParams(window.location.search).get('market')
    return raw && /^\d+$/.test(raw) ? BigInt(raw) : undefined
  })
  useEffect(() => {
    if (!markets.length) {
      return
    }
    if (selectedId === undefined || !markets.some((m) => m.id === selectedId)) {
      const fallback = defaultMarketId(markets, clock.estimate())
      if (fallback !== undefined && fallback !== selectedId) {
        setSelectedId(fallback)
      }
    }
  }, [markets, selectedId, clock])

  const selected = markets.find((m) => m.id === selectedId)
  const live = usePolling(
    selected && usdc ? () => fetchLive(pub, cfg, selected, usdc, conn?.address, clock) : undefined,
    1000,
    `live:${selected?.id}:${conn?.address}:${usdc}`,
  )
  const liveData = live.data && selected && live.data.marketId === selected.id ? live.data : undefined
  const current = selected && liveData ? withInfo(selected, liveData.info) : selected
  const phase = current ? marketPhase(current.info, now) : undefined

  const params = usePolling(selected ? () => fetchParams(pub, selected) : undefined, 60_000, `params:${selected?.id}`)

  const balances = usePolling(
    conn && markets.length
      ? () => fetchBalances(pub, cfg, conn.address, markets.flatMap((m) => [m.yes.address, m.no.address]))
      : undefined,
    4000,
    `bal:${conn?.address}:${markets.map((m) => m.id).join(',')}`,
  )

  /* Price history */

  const history = useRef(new Map<string, HistoryPoint[]>())
  useEffect(() => {
    if (!liveData) {
      return
    }
    const key = liveData.marketId.toString()
    const point: HistoryPoint = { t: liveData.blockTs }
    if (hasPrices(liveData.quote)) {
      point.mid = Number(liveData.quote.midYes) / 1e18
    }
    if (liveData.ethPrice !== undefined) {
      point.eth = liveData.ethPrice
    }
    history.current.set(key, mergeHistory(history.current.get(key) ?? [], [point]))
  }, [liveData])

  useEffect(() => {
    if (!selected) {
      return
    }
    const key = selected.id.toString()
    if ((history.current.get(key)?.length ?? 0) > 3) {
      return
    }
    let cancelled = false
    backfillHistory(pub, cfg, selected)
      .then((pts) => {
        if (!cancelled && pts.length) {
          history.current.set(key, mergeHistory(pts, history.current.get(key) ?? []))
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [selected?.id, pub, cfg])

  /* Activity */

  const [activity, setActivity] = useState<ActivityItem[]>(loadActivity)
  const onActivity = useCallback((a: ActivityInput) => {
    setActivity((list) => {
      const next = [{ ...a, id: Date.now() + Math.random(), at: Date.now() }, ...list].slice(0, 20)
      writeSaved(ACTIVITY_KEY, JSON.stringify(next))
      return next
    })
  }, [])
  const refreshAll = useCallback(() => {
    marketsPoll.refresh()
    live.refresh()
    balances.refresh()
  }, [marketsPoll.refresh, live.refresh, balances.refresh])

  // Keeps the trade panel mounted while its swap is in flight, even if the market passes its cutoff meanwhile
  const [tradeBusyId, setTradeBusyId] = useState<bigint>()

  /* Render */

  if (!hook) {
    return (
      <>
        <Header
          cfg={cfg}
          conn={conn}
          chainOk={chainOk}
          wallets={wallets}
          connecting={connecting}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          onConnect={connectInjected}
          onBurner={() => connectBurner(false)}
          onSwitchChain={switchChain}
          onDisconnect={disconnect}
          rpcOk
        />
        <SetupCard cfg={cfg} />
      </>
    )
  }

  const rpcOk = !marketsPoll.error || marketsPoll.data !== undefined
  const newestTrading = groupMarkets(markets, now).open.find((m) => marketPhase(m.info, now) === 'trading')
  const showJump = current && phase !== 'trading' && phase !== 'upcoming' && newestTrading && newestTrading.id !== current.id
  const ethPrice = liveData?.ethPrice ?? marketsPoll.data?.ethPrice
  const showTrade = phase === 'trading' || phase === 'upcoming' || (current !== undefined && tradeBusyId === current.id)
  const panelProps = {
    cfg,
    live: liveData,
    conn,
    exec,
    onConnect: () => (wallets.length === 1 && !cfg.devTools ? void connectInjected(wallets[0] as InjectedWallet) : setMenuOpen(true)),
    onSwitchChain: switchChain,
    onActivity,
    onTxDone: refreshAll,
  }

  return (
    <>
      <Header
        cfg={cfg}
        ethPrice={ethPrice}
        conn={conn}
        chainOk={chainOk}
        usdcBalance={liveData?.balances?.usdc}
        wallets={wallets}
        connecting={connecting}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        onConnect={connectInjected}
        onBurner={() => connectBurner(false)}
        onSwitchChain={switchChain}
        onDisconnect={disconnect}
        rpcOk={rpcOk}
      />

      <main className="page">
        <div className="col markets-col">
          <MarketList
            markets={markets}
            selectedId={selectedId}
            onSelect={setSelectedId}
            now={now}
            balances={balances.data}
            loading={!marketsPoll.data && !marketsPoll.error}
          />
        </div>

        <div className="col">
          {cfg.warnings.map((w) => (
            <div key={w} className="notice warn">
              {w}
            </div>
          ))}
          {marketsPoll.error !== undefined && (
            <div className="notice error">
              Cannot read markets from {cfg.rpcUrl}: {describeError(marketsPoll.error)}
            </div>
          )}
          {showJump && newestTrading && (
            <div className="notice">
              <span className="dot live" style={{ marginTop: 6 }} />
              <span style={{ flex: 1 }}>
                A new market is open: ETH above {formatUsd(strikeOf(newestTrading.info))} at {formatClock(newestTrading.info.expiry)}.
              </span>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setSelectedId(newestTrading.id)}>
                Go to live market
              </button>
            </div>
          )}
          {current ? (
            <MarketView
              market={current}
              live={liveData}
              params={params.data}
              history={history.current.get(current.id.toString()) ?? []}
              now={now}
            />
          ) : (
            <section className="card card-pad">
              <h1 className="mv-question" style={{ fontSize: 24 }}>
                {marketsPoll.data ? 'No markets yet' : 'Loading markets…'}
              </h1>
              <p className="secondary">
                {marketsPoll.data
                  ? 'The keeper creates a 1-minute market every minute. This page refreshes on its own.'
                  : `Reading the PredictionHook at ${shortAddress(hook)}.`}
              </p>
            </section>
          )}
        </div>

        <div className="col sticky-col">
          {walletError && (
            <div className="notice error">
              <span style={{ flex: 1 }}>{walletError}</span>
              <button type="button" className="btn-link" onClick={() => setWalletError(undefined)}>
                Dismiss
              </button>
            </div>
          )}
          {current && phase && (showTrade ? (
            <TradePanel
              key={`t${current.id}`}
              {...panelProps}
              pub={pub}
              market={current}
              phase={phase}
              now={now}
              onBusyChange={(busy) => setTradeBusyId(busy ? current.id : undefined)}
            />
          ) : (
            <ResolvePanel key={`r${current.id}`} {...panelProps} market={current} phase={phase} />
          ))}
          <Activity items={activity} cfg={cfg} />
          {cfg.devTools && (
            <DevPanel cfg={cfg} pub={pub} test={test} conn={conn} usdc={usdc} onBurner={connectBurner} onFunded={refreshAll} />
          )}
        </div>
      </main>

      <footer className="footer">
        <span>
          Hook{' '}
          <a href={addressUrl(cfg, hook)} target="_blank" rel="noreferrer" className="mono">
            {shortAddress(hook)}
          </a>
        </span>
        <span>
          UniversalRouter <span className="mono">{shortAddress(cfg.contracts.universalRouter)}</span>
        </span>
        <span>
          V4Quoter <span className="mono">{shortAddress(cfg.contracts.v4Quoter)}</span>
        </span>
        <span>Reads and writes go straight to the chain; no Uniswap servers.</span>
        <span className="header-spacer" />
        <button
          type="button"
          className="btn-link"
          onClick={() => setTheme(theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto')}
        >
          Theme: {theme}
        </button>
      </footer>
    </>
  )
}
