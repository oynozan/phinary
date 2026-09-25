import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type Abi, type Address, erc20Abi, type Hex, parseAbi, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  buildPermitSingle,
  buildSwap,
  erc20ApproveTx,
  estimateSwapGas,
  type PoolKey,
  PredictionSwapError,
  permitTypedData,
  quoteExactIn,
  quoteExactOut,
  readAllowances,
  sortCurrencies,
  UNICHAIN_SEPOLIA,
  universalRouterAbi,
} from '../src/index.ts'
import { type AnvilFork, startAnvilFork } from './helpers/anvil.ts'

/**
 * End-to-end against the real UniversalRouter 2.0, V4Quoter, Permit2 and PoolManager bytecode on an anvil fork of
 * chain 1301, using a hookless pool we create. Needs network access and anvil: `SWAP_SDK_FORK=1 node --test test/fork.e2e.test.ts`.
 */
const enabled = process.env['SWAP_SDK_FORK'] === '1'
const here = dirname(fileURLToPath(import.meta.url))
const mock = JSON.parse(readFileSync(join(here, 'fixtures/MockERC20.json'), 'utf8')) as { abi: Abi; bytecode: Hex }
// A fresh EOA: anvil's well-known accounts carry EIP-7702 delegations on 1301, which makes Permit2 use ERC-1271.
const account = privateKeyToAccount(generatePrivateKey())
const MODIFY_LIQUIDITY_TEST: Address = '0x5fa728C0A5cfd51BEe4B060773f50554c0C8A7AB'

const poolManagerAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function initialize(PoolKey key, uint160 sqrtPriceX96) returns (int24 tick)',
])
const modifyLiquidityAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct ModifyLiquidityParams { int24 tickLower; int24 tickUpper; int256 liquidityDelta; bytes32 salt; }',
  'function modifyLiquidity(PoolKey key, ModifyLiquidityParams params, bytes hookData) payable returns (int256 delta)',
])

describe(
  'fork e2e: quote and swap through UniversalRouter 2.0 on chain 1301',
  { skip: !enabled && 'set SWAP_SDK_FORK=1' },
  () => {
    let fork: AnvilFork | undefined
    let chain: AnvilFork['chain']
    let pub: AnvilFork['pub']
    let wallet: AnvilFork['wallet']
    let key: PoolKey
    let tokenA: Address
    let tokenB: Address

    async function send(tx: { to: Address; data: Hex; value?: bigint }): Promise<void> {
      const hash = await wallet.sendTransaction({ ...tx, chain })
      const r = await pub.waitForTransactionReceipt({ hash })
      assert.equal(r.status, 'success')
    }

    async function deployToken(symbol: string): Promise<Address> {
      const hash = await wallet.deployContract({
        abi: mock.abi,
        bytecode: mock.bytecode,
        args: [symbol, symbol, 6],
        chain,
      })
      const r = await pub.waitForTransactionReceipt({ hash })
      assert.ok(r.contractAddress)
      const mintHash = await wallet.writeContract({
        address: r.contractAddress,
        abi: mock.abi,
        functionName: 'mint',
        args: [account.address, 10n ** 15n],
        chain,
      })
      await pub.waitForTransactionReceipt({ hash: mintHash })
      return r.contractAddress
    }

    const balance = (t: Address) =>
      pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })

    before(async () => {
      fork = await startAnvilFork(account)
      ;({ chain, pub, wallet } = fork)
      await fork.test.setBalance({
        address: account.address,
        value: 10n ** 20n,
      })
      ;[tokenA, tokenB] = sortCurrencies(await deployToken('TKA'), await deployToken('TKB'))
      key = { currency0: tokenA, currency1: tokenB, fee: 0, tickSpacing: 60, hooks: zeroAddress }
      const init = await wallet.writeContract({
        address: UNICHAIN_SEPOLIA.poolManager,
        abi: poolManagerAbi,
        functionName: 'initialize',
        args: [key, 2n ** 96n],
        chain,
      })
      await pub.waitForTransactionReceipt({ hash: init })
      for (const t of [tokenA, tokenB]) await send(erc20ApproveTx({ token: t, spender: MODIFY_LIQUIDITY_TEST }))
      const add = await wallet.writeContract({
        address: MODIFY_LIQUIDITY_TEST,
        abi: modifyLiquidityAbi,
        functionName: 'modifyLiquidity',
        args: [
          key,
          { tickLower: -6000, tickUpper: 6000, liquidityDelta: 10n ** 12n, salt: `0x${'00'.repeat(32)}` },
          '0x',
        ],
        chain,
      })
      assert.equal((await pub.waitForTransactionReceipt({ hash: add })).status, 'success')
    })

    after(() => {
      fork?.stop()
    })

    it('first-time exact-in swap: ERC20 approve, signed PERMIT2_PERMIT + V4_SWAP, output equals the quote', async () => {
      assert.equal(
        await pub.readContract({
          address: UNICHAIN_SEPOLIA.universalRouter,
          abi: universalRouterAbi,
          functionName: 'poolManager',
        }),
        UNICHAIN_SEPOLIA.poolManager,
      )
      const amountIn = 10_000_000n
      const q = await quoteExactIn(pub, { poolKey: key, zeroForOne: true, amount: amountIn, account: account.address })
      assert.ok(q.amountOut > 0n && q.amountOut < amountIn)

      const before0 = await readAllowances(pub, { owner: account.address, token: tokenA, amount: amountIn })
      assert.equal(before0.needsErc20Approval, true)
      assert.equal(before0.needsPermit, true)
      await send(erc20ApproveTx({ token: tokenA }))

      const block = await pub.getBlock()
      const permit = buildPermitSingle({ token: tokenA, nonce: before0.permit2Nonce, now: Number(block.timestamp) })
      const signature = await account.signTypedData(permitTypedData(permit))
      const tx = buildSwap({
        poolKey: key,
        zeroForOne: true,
        tradeType: 'EXACT_INPUT',
        amount: amountIn,
        limit: q.amountOut,
        deadline: block.timestamp + 600n,
        permit: { permit, signature },
      })
      assert.equal(tx.commands, '0x0a10')
      const gas = await estimateSwapGas(pub, { tx, account: account.address })
      assert.ok(gas > 100_000n)

      const [a0, b0] = [await balance(tokenA), await balance(tokenB)]
      await send(tx)
      assert.equal(a0 - (await balance(tokenA)), amountIn)
      assert.equal((await balance(tokenB)) - b0, q.amountOut)

      const after0 = await readAllowances(pub, { owner: account.address, token: tokenA, amount: amountIn })
      assert.equal(after0.needsPermit, false)
      assert.equal(after0.permit2Nonce, before0.permit2Nonce + 1)
    })

    it('repeat exact-out swap without a permit pays exactly the quoted input', async () => {
      const amountOut = 3_000_000n
      const q = await quoteExactOut(pub, { poolKey: key, zeroForOne: true, amount: amountOut })
      const block = await pub.getBlock()
      const tx = buildSwap({
        poolKey: key,
        zeroForOne: true,
        tradeType: 'EXACT_OUTPUT',
        amount: amountOut,
        limit: q.amountIn,
        deadline: block.timestamp + 600n,
      })
      assert.equal(tx.commands, '0x10')
      const [a0, b0] = [await balance(tokenA), await balance(tokenB)]
      await send(tx)
      assert.equal(a0 - (await balance(tokenA)), q.amountIn)
      assert.equal((await balance(tokenB)) - b0, amountOut)
    })

    it('gas estimation surfaces slippage and deadline reverts as typed errors', async () => {
      const amountIn = 1_000_000n
      const q = await quoteExactIn(pub, { poolKey: key, zeroForOne: true, amount: amountIn })
      const block = await pub.getBlock()
      const greedy = buildSwap({
        poolKey: key,
        zeroForOne: true,
        tradeType: 'EXACT_INPUT',
        amount: amountIn,
        limit: q.amountOut + 1n,
        deadline: block.timestamp + 600n,
      })
      await assert.rejects(
        estimateSwapGas(pub, { tx: greedy, account: account.address }),
        (e: unknown) => e instanceof PredictionSwapError && e.code === 'SLIPPAGE',
      )
      const late = buildSwap({
        poolKey: key,
        zeroForOne: true,
        tradeType: 'EXACT_INPUT',
        amount: amountIn,
        limit: 0n,
        deadline: block.timestamp - 10n,
      })
      await assert.rejects(
        estimateSwapGas(pub, { tx: late, account: account.address }),
        (e: unknown) => e instanceof PredictionSwapError && e.code === 'DEADLINE',
      )
    })

    it('an uninitialised pool quotes as NO_ROUTE', async () => {
      const missing = { ...key, fee: 3000 }
      await assert.rejects(
        quoteExactIn(pub, { poolKey: missing, zeroForOne: true, amount: 1_000n }),
        (e: unknown) =>
          e instanceof PredictionSwapError && e.code === 'NO_ROUTE' && e.revert?.name === 'PoolNotInitialized',
      )
    })
  },
)
