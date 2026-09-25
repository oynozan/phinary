import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { type Account, createPublicClient, createTestClient, createWalletClient, defineChain, http } from 'viem'
import { unichainSepolia } from 'viem/chains'
import { UNICHAIN_SEPOLIA_RPC_URL } from '../../src/index.ts'

function anvilPath(): string {
  if (process.env['ANVIL']) return process.env['ANVIL']
  const fallback = join(userInfo().homedir, '.foundry/bin/anvil')
  return existsSync(fallback) ? fallback : 'anvil'
}

function forkClients(rpc: string, account: Account) {
  const chain = defineChain({ ...unichainSepolia, rpcUrls: { default: { http: [rpc] } } })
  const transport = http(rpc)
  return {
    chain,
    pub: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ chain, transport, account }),
    test: createTestClient({ chain, mode: 'anvil', transport }),
  }
}

export type AnvilFork = ReturnType<typeof forkClients> & { rpc: string; stop: () => void }

/** Starts anvil forking chain 1301 (`FORK_URL` overrides the RPC) on a random local port, with clients for `account`. */
export async function startAnvilFork(account: Account): Promise<AnvilFork> {
  const port = 18545 + Math.floor(Math.random() * 1000)
  const rpc = `http://127.0.0.1:${port}`
  const anvil: ChildProcess = spawn(
    anvilPath(),
    ['--fork-url', process.env['FORK_URL'] ?? UNICHAIN_SEPOLIA_RPC_URL, '--port', String(port), '--chain-id', '1301'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('anvil did not start')), 60_000)
    anvil.stdout?.on('data', (b: Buffer) => {
      if (b.toString().includes('Listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
    anvil.on('exit', (code) => reject(new Error(`anvil exited ${code}`)))
  })
  return { ...forkClients(rpc, account), rpc, stop: () => anvil.kill('SIGTERM') }
}
