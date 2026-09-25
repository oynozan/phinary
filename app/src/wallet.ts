import {
  type Address,
  type Chain,
  createWalletClient,
  custom,
  getAddress,
  type Hex,
  http,
  numberToHex,
  type WalletClient,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { AppConfig } from './config.ts'
import { readSaved, writeSaved } from './config.ts'

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

export interface InjectedWallet {
  id: string
  name: string
  icon?: string
  provider: Eip1193Provider
}

export interface Connection {
  kind: 'injected' | 'burner'
  name: string
  address: Address
  chainId: number
  wallet: WalletClient
  provider?: Eip1193Provider
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string }
  provider: Eip1193Provider
}

/** EIP-6963 wallets plus the legacy window.ethereum; MetaMask first. */
export function discoverWallets(onChange: (wallets: InjectedWallet[]) => void): () => void {
  const found = new Map<string, InjectedWallet>()
  const emit = () => {
    const list = [...found.values()]
    const legacy = (window as unknown as { ethereum?: Eip1193Provider & { isMetaMask?: boolean } }).ethereum
    if (legacy && !list.some((w) => w.provider === legacy)) {
      list.push({ id: 'injected', name: legacy.isMetaMask ? 'MetaMask' : 'Browser wallet', provider: legacy })
    }
    list.sort((a, b) => Number(b.id.includes('metamask')) - Number(a.id.includes('metamask')))
    onChange(list)
  }
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963Detail>).detail
    if (!detail?.provider || !detail.info) {
      return
    }
    found.set(detail.info.rdns || detail.info.uuid, {
      id: detail.info.rdns || detail.info.uuid,
      name: detail.info.name,
      icon: detail.info.icon,
      provider: detail.provider,
    })
    emit()
  }
  window.addEventListener('eip6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  emit()
  const late = window.setTimeout(emit, 500)
  return () => {
    window.removeEventListener('eip6963:announceProvider', onAnnounce)
    window.clearTimeout(late)
  }
}

export function injectedConnection(w: InjectedWallet, address: Address, chainId: number, chain: Chain): Connection {
  return {
    kind: 'injected',
    name: w.name,
    address,
    chainId,
    provider: w.provider,
    wallet: createWalletClient({ account: address, chain, transport: custom(w.provider) }),
  }
}

export async function requestAccounts(w: InjectedWallet): Promise<{ address: Address; chainId: number }> {
  const accounts = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[]
  const first = accounts[0]
  if (!first) {
    throw new Error('The wallet returned no account')
  }
  const chainId = Number(await w.provider.request({ method: 'eth_chainId' }))
  return { address: getAddress(first), chainId }
}

function errorCode(err: unknown): number | undefined {
  const e = err as { code?: number; data?: { originalError?: { code?: number } } }
  return e?.data?.originalError?.code ?? e?.code
}

export function addChainParams(cfg: AppConfig, chain: Chain) {
  return {
    chainId: numberToHex(cfg.chainId),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [cfg.rpcUrl],
    blockExplorerUrls: cfg.isLocalRpc ? undefined : [cfg.explorer],
  }
}

/** Switches the wallet to the app chain, adding it (or, for a local fork, its RPC) when the wallet does not know it. */
export async function switchToAppChain(provider: Eip1193Provider, cfg: AppConfig, chain: Chain): Promise<void> {
  const chainId = numberToHex(cfg.chainId)
  if (cfg.isLocalRpc) {
    // A wallet signs through its own RPC for a chain id, so the local fork's endpoint has to be registered first
    try {
      await provider.request({ method: 'wallet_addEthereumChain', params: [addChainParams(cfg, chain)] })
    } catch (err) {
      if (errorCode(err) === 4001) {
        throw err
      }
    }
  }
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
  } catch (err) {
    if (errorCode(err) !== 4902) {
      throw err
    }
    await provider.request({ method: 'wallet_addEthereumChain', params: [addChainParams(cfg, chain)] })
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
  }
}

const BURNER_KEY = 'prediction.backup.burner'

function burnerStorageKey(cfg: AppConfig): string {
  return `${BURNER_KEY}:${cfg.chainId}:${cfg.rpcUrl}`
}

export function hasBurner(cfg: AppConfig): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(readSaved(burnerStorageKey(cfg)) ?? '')
}

/** A throwaway key kept in this browser, for anvil forks only. */
export function burnerConnection(cfg: AppConfig, chain: Chain, fresh = false): Connection {
  let key = readSaved(burnerStorageKey(cfg)) as Hex | null
  if (fresh || !key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    key = generatePrivateKey()
    writeSaved(burnerStorageKey(cfg), key)
  }
  const account = privateKeyToAccount(key)
  return {
    kind: 'burner',
    name: 'Burner (local)',
    address: account.address,
    chainId: cfg.chainId,
    wallet: createWalletClient({ account, chain, transport: http(cfg.rpcUrl) }),
  }
}

export function forgetBurner(cfg: AppConfig): void {
  writeSaved(burnerStorageKey(cfg), null)
}

export function isUserRejection(err: unknown): boolean {
  let cur: unknown = err
  for (let i = 0; i < 6 && cur; i++) {
    const e = cur as { code?: number; name?: string; message?: string; cause?: unknown }
    if (e.code === 4001 || e.name === 'UserRejectedRequestError' || /user (rejected|denied)/i.test(e.message ?? '')) {
      return true
    }
    cur = e.cause
  }
  return false
}
