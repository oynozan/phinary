/**
 * Trades on the live local fork (anvil, chain 1301) and checks the indexer's positions and trades
 * against on-chain balances. Needs the local stack running (deployments/local.json, a keeper opening
 * and settling markets) and `PONDER_NETWORK=local npx ponder dev` serving http://localhost:42069.
 * Skipped unless INDEXER_URL is set:
 *
 *   cd indexer && INDEXER_URL=http://localhost:42069 RPC_URL=http://127.0.0.1:8846 npx vitest run test/integration.test.ts
 */
import { createClient } from '@ponder/client'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  http,
  keccak256,
  numberToHex,
  pad,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { unichainSepolia } from 'viem/chains'

import { buildSwap, erc20ApproveTx, findPredictionRoute, listMarkets, permit2ApproveTx, predictionHookAbi, type Market, UNICHAIN_SEPOLIA } from '../../packages/swap-sdk/src/index.ts'
import { loadIndexerDeployment } from '../src/deployment.ts'
import * as schema from '../ponder.schema.ts'

const INDEXER_URL = process.env.INDEXER_URL
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8846'
const MNEMONIC = 'test test test test test test test test test test test junk'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Retries `fn` (which throws via `expect`) until it passes or `timeoutMs` elapses. */
async function waitFor(fn: () => Promise<void>, timeoutMs: number, intervalMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fn()
      return
    } catch (err) {
      if (Date.now() > deadline) {
        throw err
      }
      await sleep(intervalMs)
    }
  }
}

/**
 * Anvil "deal": finds the token's balance mapping slot by probing and writes `amount` to it (mirrors
 * app/src/devtools.ts). `pub`/`testClient` are untyped because the chain-specific client types built
 * with `defineChain` below (for Unichain's OP-stack transaction formatters) don't unify cleanly with
 * viem's generic `PublicClient`/`TestClient` parameter types.
 */
async function dealErc20(pub: any, testClient: any, token: Address, holder: Address, amount: bigint): Promise<void> {
  const balanceOf = () => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })
  const value = pad(numberToHex(amount), { size: 32 })
  for (let slot = 0n; slot < 64n; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, slot]))
    const before = await pub.getStorageAt({ address: token, slot: key })
    await testClient.setStorageAt({ address: token, index: key, value })
    if ((await balanceOf()) === amount) {
      return
    }
    await testClient.setStorageAt({ address: token, index: key, value: before ?? pad('0x0', { size: 32 }) })
  }
  throw new Error(`could not deal ${token} to ${holder} on the local fork`)
}

describe.skipIf(!INDEXER_URL)('indexer integration', () => {
  test(
    'positions, trades and snapshots match on-chain state after trading, transferring and settling',
    async () => {
      const deployment = loadIndexerDeployment({ PONDER_NETWORK: 'local', PONDER_RPC_URL_1301: RPC_URL })
      const usdc = UNICHAIN_SEPOLIA.usdc
      const chain = defineChain({ ...unichainSepolia, rpcUrls: { default: { http: [RPC_URL] } } })
      const transport = http(RPC_URL)
      // A fast poll interval matters here: the market's trading window is ~48s, `pickMarket` only
      // requires 25s of it left, and viem's default 4s poll makes `waitForTransactionReceipt` eat
      // into that margin across several sequential transactions.
      const pub = createPublicClient({ chain, transport, pollingInterval: 250 })
      const testClient = createTestClient({ chain, mode: 'anvil', transport })
      const wallet = createWalletClient({ chain, transport })

      const alice = mnemonicToAccount(MNEMONIC, { addressIndex: 3 })
      const bob = mnemonicToAccount(MNEMONIC, { addressIndex: 4 })

      const balanceOf = (token: Address, owner: Address) =>
        pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })

      async function send(account: typeof alice, tx: { to: Address; data: Hex; value?: bigint }) {
        const hash = await wallet.sendTransaction({ account, chain, to: tx.to, data: tx.data, value: tx.value ?? 0n })
        const receipt = await pub.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') {
          throw new Error(`transaction ${hash} reverted`)
        }
        return receipt
      }

      async function approveForRouter(account: typeof alice, token: Address) {
        const now = Number((await pub.getBlock()).timestamp)
        await send(account, erc20ApproveTx({ token }))
        await send(account, permit2ApproveTx({ token, expiration: now + 30 * 24 * 60 * 60 }))
      }

      // The local fork also runs the demo's own trading bots against the same vault, so a swap can
      // occasionally revert (e.g. `Insolvent()`) if a bot's trade in the same block briefly pushes the
      // vault's solvency check the wrong way; the same swap normally succeeds moments later. Retrying a
      // few times is safe: a reverted transaction changes no state.
      async function swap(account: typeof alice, params: { poolKey: Market['yes']['poolKey']; zeroForOne: boolean; amount: bigint }) {
        let lastErr: unknown
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            const now = Number((await pub.getBlock()).timestamp)
            const tx = buildSwap({
              poolKey: params.poolKey,
              zeroForOne: params.zeroForOne,
              tradeType: 'EXACT_INPUT',
              amount: params.amount,
              limit: 0n,
              deadline: BigInt(now + 300),
            })
            return await send(account, tx)
          } catch (err) {
            lastErr = err
            await sleep(500)
          }
        }
        throw lastErr
      }

      /** The newest 1m-track market with at least 25s of trading left; waits for the keeper's next one otherwise. */
      async function pickMarket(): Promise<Market> {
        const deadline = Date.now() + 90_000
        for (;;) {
          const now = Number((await pub.getBlock()).timestamp)
          const markets = await listMarkets(pub, { hook: deployment.hook, limit: 8 })
          const candidate = markets
            .filter((m) => m.status === 'Trading' && m.quote?.tradable)
            .filter((m) => Number(m.info.expiry - m.info.openTime) <= 120)
            .filter((m) => Number(m.cutoff) - now >= 25)
            .sort((a, b) => Number(b.id - a.id))[0]
          if (candidate) {
            return candidate
          }
          if (Date.now() > deadline) {
            throw new Error('no market with at least 25s of trading left within 90s: is the local keeper running?')
          }
          await sleep(1000)
        }
      }

      // --- Setup: fund Alice with ETH and Circle USDC via anvil cheats ---
      await testClient.setBalance({ address: alice.address, value: 10n ** 18n })
      await testClient.setBalance({ address: bob.address, value: 10n ** 18n })
      await dealErc20(pub, testClient, usdc, alice.address, 7_000_000n)

      const market = await pickMarket()

      // --- 1. Alice buys UP for 5 USDC, and DOWN for 2 USDC ---
      await approveForRouter(alice, usdc)

      const buyUp = findPredictionRoute([market], { tokenIn: usdc, tokenOut: market.yes.address })
      if (!buyUp) throw new Error('no route to buy UP')
      await swap(alice, { poolKey: buyUp.poolKey, zeroForOne: buyUp.zeroForOne, amount: 5_000_000n })
      const upAfterBuy = await balanceOf(market.yes.address, alice.address)

      const buyDown = findPredictionRoute([market], { tokenIn: usdc, tokenOut: market.no.address })
      if (!buyDown) throw new Error('no route to buy DOWN')
      await swap(alice, { poolKey: buyDown.poolKey, zeroForOne: buyDown.zeroForOne, amount: 2_000_000n })

      // --- 2. Alice sells half her UP ---
      await approveForRouter(alice, market.yes.address)
      const half = upAfterBuy / 2n
      const sellUp = findPredictionRoute([market], { tokenIn: market.yes.address, tokenOut: usdc })
      if (!sellUp) throw new Error('no route to sell UP')
      await swap(alice, { poolKey: sellUp.poolKey, zeroForOne: sellUp.zeroForOne, amount: half })

      // --- 3. Alice transfers 1 UP to Bob ---
      const oneUp = 1_000_000n
      await send(alice, {
        to: market.yes.address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [bob.address, oneUp] }),
      })

      // --- 4. Wait for settlement, then Alice claims the winning side by swap ---
      let info = await pub.readContract({
        address: deployment.hook,
        abi: predictionHookAbi,
        functionName: 'marketInfo',
        args: [market.id],
      })
      const settleDeadline = Date.now() + 150_000
      while (info.status === 1) {
        if (Date.now() > settleDeadline) {
          throw new Error(`market ${market.id} did not settle within 150s`)
        }
        await sleep(2000)
        info = await pub.readContract({
          address: deployment.hook,
          abi: predictionHookAbi,
          functionName: 'marketInfo',
          args: [market.id],
        })
      }

      const winningToken = info.yesWon ? market.yes.address : market.no.address
      const held = await balanceOf(winningToken, alice.address)
      if (held > 0n) {
        await approveForRouter(alice, winningToken)
        const claim = findPredictionRoute([market], { tokenIn: winningToken, tokenOut: usdc })
        if (!claim) throw new Error('no route to claim the winning side')
        await swap(alice, { poolKey: claim.poolKey, zeroForOne: claim.zeroForOne, amount: held })
      }

      // --- 5. Poll the indexer and assert ---
      const client = createClient(`${INDEXER_URL}/sql`, { schema })

      await waitFor(async () => {
        for (const [account, side, token] of [
          [alice.address, 'UP', market.yes.address],
          [alice.address, 'DOWN', market.no.address],
          [bob.address, 'UP', market.yes.address],
          [bob.address, 'DOWN', market.no.address],
        ] as const) {
          const onChain = await balanceOf(token, account)
          const rows = await client.db
            .select()
            .from(schema.position)
            .where(
              and(
                eq(schema.position.account, account.toLowerCase() as Address),
                eq(schema.position.marketId, market.id),
                eq(schema.position.side, side),
              ),
            )
          const indexed = rows.reduce((sum, row) => sum + row.qty, 0n)
          expect(indexed, `${account} ${side} indexed qty`).toBe(onChain)
        }

        const bobReceived = await client.db
          .select()
          .from(schema.position)
          .where(
            and(
              eq(schema.position.account, bob.address.toLowerCase() as Address),
              eq(schema.position.marketId, market.id),
              eq(schema.position.side, 'UP'),
              eq(schema.position.origin, 'received'),
            ),
          )
        expect(bobReceived.length).toBe(1)
        expect(bobReceived[0]?.cost).toBe(0n)

        const aliceTrades = await client.db
          .select()
          .from(schema.trade)
          .where(and(eq(schema.trade.marketId, market.id), eq(schema.trade.account, alice.address.toLowerCase() as Address)))
        expect(aliceTrades.length).toBeGreaterThan(0)
        for (const t of aliceTrades) {
          expect(t.attributedBy).toBe('transfer')
        }

        const marketRows = await client.db.select().from(schema.market).where(eq(schema.market.id, market.id))
        expect(marketRows[0]?.status).not.toBe('trading')

        const snapshots = await client.db.select().from(schema.priceSnapshot).where(eq(schema.priceSnapshot.marketId, market.id))
        expect(snapshots.some((s) => s.midUp > 0n && s.midUp < 10n ** 18n)).toBe(true)
      }, 30_000)
    },
    240_000,
  )
})
