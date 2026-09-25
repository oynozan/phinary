import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  type Abi,
  type Address,
  concat,
  encodeDeployData,
  erc20Abi,
  getContractAddress,
  type Hex,
  keccak256,
  numberToHex,
  pad,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  buildPermitSingle,
  buildSwap,
  erc20ApproveTx,
  estimateSwapGas,
  findPredictionRoute,
  listMarkets,
  type Market,
  PredictionSwapError,
  permitTypedData,
  quoteExactIn,
  maxInWithSlippage,
  minOutWithSlippage,
  quoteExactOut,
  readAllowances,
  resolveOutcomeToken,
  sameAddress,
  type SwapTx,
  UNICHAIN_SEPOLIA,
} from '../src/index.ts'
import { type AnvilFork, startAnvilFork } from './helpers/anvil.ts'

/**
 * End-to-end against a real PredictionHook build on an anvil fork of chain 1301: the deployed V4Quoter,
 * UniversalRouter 2.0, Permit2 and PoolManager, with the hook CREATE2-mined to its flag address.
 *   SWAP_SDK_HOOK_OUT=<forge out/ with PredictionHook.sol, MockOracle.sol, MockUSDC.sol> node --test test/hook.e2e.test.ts
 */
const out = process.env['SWAP_SDK_HOOK_OUT']
const CREATE2_DEPLOYER: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const ALL_HOOK_FLAGS = (1n << 14n) - 1n
const E6 = 1_000_000n
const WAD = 10n ** 18n
/** Quotes run at the latest block and swaps land in a later one; the hook reprices with tau every block. */
const SLIPPAGE_BPS = 100
const PERMISSION_BITS = [
  'beforeInitialize',
  'afterInitialize',
  'beforeAddLiquidity',
  'afterAddLiquidity',
  'beforeRemoveLiquidity',
  'afterRemoveLiquidity',
  'beforeSwap',
  'afterSwap',
  'beforeDonate',
  'afterDonate',
  'beforeSwapReturnDelta',
  'afterSwapReturnDelta',
  'afterAddLiquidityReturnDelta',
  'afterRemoveLiquidityReturnDelta',
] as const

interface Artifact {
  abi: Abi
  bytecode: { object: Hex }
  deployedBytecode: { object: Hex }
}

function artifact(name: string): Artifact {
  return JSON.parse(readFileSync(join(out ?? '', `${name}.sol/${name}.json`), 'utf8')) as Artifact
}

describe(
  'hook e2e: PredictionHook through V4Quoter and UniversalRouter 2.0 on a 1301 fork',
  { skip: !out && 'set SWAP_SDK_HOOK_OUT' },
  () => {
    const hookArt = out ? artifact('PredictionHook') : undefined
    const hookAbi = hookArt?.abi ?? []
    const hookErrors = hookAbi.filter((x) => x.type === 'error') as Abi
    const account = privateKeyToAccount(generatePrivateKey())
    let fork: AnvilFork
    let pub: AnvilFork['pub']
    let wallet: AnvilFork['wallet']
    let test: AnvilFork['test']
    let usdc: Address
    let hook: Address
    let market: Market
    const gasUsed: Record<string, bigint> = {}
    const drift: Record<string, bigint> = {}

    async function send(tx: { to: Address; data: Hex; value?: bigint }, label?: string): Promise<void> {
      const hash = await wallet.sendTransaction({ ...tx, account, chain: fork.chain })
      const r = await pub.waitForTransactionReceipt({ hash })
      assert.equal(r.status, 'success', label)
      if (label) gasUsed[label] = r.gasUsed
    }

    async function write(address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<void> {
      const hash = await wallet.writeContract({ address, abi, functionName, args, account, chain: fork.chain } as never)
      assert.equal((await pub.waitForTransactionReceipt({ hash })).status, 'success', functionName)
    }

    async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
      const a = artifact(name)
      const hash = await wallet.deployContract({
        abi: a.abi,
        bytecode: a.bytecode.object,
        args,
        account,
        chain: fork.chain,
      } as never)
      const r = await pub.waitForTransactionReceipt({ hash })
      assert.ok(r.contractAddress, name)
      return r.contractAddress
    }

    async function chainNow(): Promise<number> {
      return Number((await pub.getBlock()).timestamp)
    }

    const balance = (t: Address) =>
      pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })

    /** Signs a PermitSingle when Permit2 does not yet allow the router, then builds `execute([PERMIT2_PERMIT,] V4_SWAP)`. */
    async function swapTx(p: {
      tokenIn: Address
      tokenOut: Address
      exactIn: boolean
      amount: bigint
      limit: bigint
    }): Promise<SwapTx> {
      const route = findPredictionRoute([market], p)
      assert.ok(route)
      const now = await chainNow()
      const maxIn = p.exactIn ? p.amount : p.limit
      const allowance = await readAllowances(pub, { owner: account.address, token: p.tokenIn, amount: maxIn, now })
      assert.equal(allowance.needsErc20Approval, false)
      let permit
      if (allowance.needsPermit) {
        const single = buildPermitSingle({ token: p.tokenIn, nonce: allowance.permit2Nonce, now })
        permit = { permit: single, signature: await account.signTypedData(permitTypedData(single)) }
      }
      return buildSwap({
        poolKey: route.poolKey,
        zeroForOne: route.zeroForOne,
        tradeType: p.exactIn ? 'EXACT_INPUT' : 'EXACT_OUTPUT',
        amount: p.amount,
        limit: p.limit,
        deadline: BigInt(now + 600),
        permit,
      })
    }

    function routeOf(tokenIn: Address, tokenOut: Address) {
      const r = findPredictionRoute([market], { tokenIn, tokenOut })
      assert.ok(r)
      return r
    }

    before(async () => {
      fork = await startAnvilFork(account)
      ;({ pub, wallet, test } = fork)
      await test.setBalance({ address: account.address, value: 10n ** 20n })
      assert.ok(await pub.getCode({ address: CREATE2_DEPLOYER }), 'deterministic deployer missing on the fork')

      usdc = await deploy('MockUSDC')
      const oracleArt = artifact('MockOracle')
      const oracle = await deploy('MockOracle')
      const lnK = BigInt(Math.round(Math.log(3000) * 1e18))
      await write(oracle, oracleArt.abi, 'setLnSpot', [lnK])
      await write(oracle, oracleArt.abi, 'setVar', [360000000000000000000000000000000000n / 31557600n])
      await write(oracle, oracleArt.abi, 'setFlatTick', [80_000])

      const probe = '0x000000000000000000000000000000000000c0de' as Address
      const perms = (await pub.readContract({
        address: probe,
        abi: hookAbi,
        functionName: 'getHookPermissions',
        stateOverride: [{ address: probe, code: hookArt?.deployedBytecode.object }],
      } as never)) as Record<(typeof PERMISSION_BITS)[number], boolean>
      const flags = PERMISSION_BITS.reduce((f, name, i) => (perms[name] ? f | (1n << BigInt(13 - i)) : f), 0n)
      const init = encodeDeployData({
        abi: hookAbi,
        bytecode: hookArt?.bytecode.object as Hex,
        args: [UNICHAIN_SEPOLIA.poolManager, usdc, account.address],
      })
      const initHash = keccak256(init)
      let salt: Hex = '0x'
      for (let i = 0n; ; i++) {
        salt = pad(numberToHex(i), { size: 32 })
        hook = getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt, bytecodeHash: initHash })
        if ((BigInt(hook) & ALL_HOOK_FLAGS) === flags) break
      }
      await send({ to: CREATE2_DEPLOYER, data: concat([salt, init]) }, 'deployHook')
      assert.ok(await pub.getCode({ address: hook }), 'hook not deployed')

      const mockUsdcAbi = artifact('MockUSDC').abi
      await write(usdc, mockUsdcAbi, 'mint', [account.address, 10_000_000n * E6])
      await write(usdc, mockUsdcAbi, 'approve', [hook, 1_000_000n * E6])
      await write(hook, hookAbi, 'deposit', [1_000_000n * E6])
      const now = await chainNow()
      await write(hook, hookAbi, 'createMarket', [
        {
          oracle,
          lnStrikeWad: lnK,
          openTime: BigInt(now),
          expiry: BigInt(now + 86_400),
          window: 3600,
          cutoffBuffer: 300,
          nSamples: 1800,
          budget: 100_000n * E6,
          quote: {
            h0Wad: (2n * WAD) / 100n,
            gammaSWad: (5n * WAD) / 10_000n,
            lambdaWad: (2n * WAD) / 100_000n,
            qEpochMax: 50_000n * E6,
            pMinWad: (2n * WAD) / 100n,
          },
          sigmaMode: 0,
          fixedVarE36: 0n,
          kernel: 0,
          yesName: 'ETH above 3000 YES',
          yesSymbol: 'YES',
          noName: 'ETH above 3000 NO',
          noSymbol: 'NO',
        },
      ])
      const markets = await listMarkets(pub, { hook })
      assert.equal(markets.length, 1)
      market = markets[0] as Market
    })

    after(() => {
      fork?.stop()
    })

    it('reads the market registry, pool keys and quote from the hook', async () => {
      assert.equal(market.id, 1n)
      assert.equal(market.status, 'Trading')
      assert.ok(market.quote?.tradable)
      assert.ok((market.quote?.askYes ?? 0n) > (market.quote?.bidYes ?? 0n))
      for (const t of [market.yes, market.no]) {
        assert.ok(sameAddress(t.poolKey.currency0, usdc) || sameAddress(t.poolKey.currency1, usdc))
        assert.ok(sameAddress(t.poolKey.hooks, hook))
        const resolved = await resolveOutcomeToken(pub, { token: t.address, hook })
        assert.deepEqual(resolved?.poolKey, t.poolKey)
      }
    })

    it('first-time buy exact-in: ERC20 approve, signed PERMIT2_PERMIT + V4_SWAP, receives at least the slippage bound', async () => {
      const amount = 100n * E6
      const route = routeOf(usdc, market.yes.address)
      const q = await quoteExactIn(pub, {
        poolKey: route.poolKey,
        zeroForOne: route.zeroForOne,
        amount,
        account: account.address,
      })
      assert.ok(q.amountOut > amount, 'a near-the-money YES costs less than 1 USDC')
      await send(erc20ApproveTx({ token: usdc }))
      const limit = minOutWithSlippage(q.amountOut, SLIPPAGE_BPS)
      const tx = await swapTx({ tokenIn: usdc, tokenOut: market.yes.address, exactIn: true, amount, limit })
      assert.equal(tx.commands, '0x0a10')
      await estimateSwapGas(pub, { tx, account: account.address, extraErrors: hookErrors })
      const [u0, y0] = [await balance(usdc), await balance(market.yes.address)]
      await send(tx, 'firstBuyWithPermit')
      assert.equal(u0 - (await balance(usdc)), amount)
      const got = (await balance(market.yes.address)) - y0
      assert.ok(got >= limit)
      drift['firstBuyWithPermit'] = got - q.amountOut
      assert.ok(
        (gasUsed['firstBuyWithPermit'] ?? 0n) < 1_000_000n,
        `first buy used ${gasUsed['firstBuyWithPermit']} gas`,
      )
    })

    it('buy exact-out on the other outcome pays at most the slippage bound', async () => {
      const amount = 50n * E6
      const route = routeOf(usdc, market.no.address)
      const q = await quoteExactOut(pub, { poolKey: route.poolKey, zeroForOne: route.zeroForOne, amount })
      const limit = maxInWithSlippage(q.amountIn, SLIPPAGE_BPS)
      const tx = await swapTx({ tokenIn: usdc, tokenOut: market.no.address, exactIn: false, amount, limit })
      const [u0, n0] = [await balance(usdc), await balance(market.no.address)]
      await send(tx, 'firstNoBuy')
      const paid = u0 - (await balance(usdc))
      assert.ok(paid <= limit)
      drift['firstNoBuy'] = q.amountIn - paid
      assert.equal((await balance(market.no.address)) - n0, amount)
    })

    it('sells an OutcomeToken with only a signed permit (infinite Permit2 allowance, no approve tx)', async () => {
      const amount = 20n * E6
      const allowance = await readAllowances(pub, {
        owner: account.address,
        token: market.yes.address,
        amount,
        now: await chainNow(),
      })
      assert.equal(allowance.needsErc20Approval, false)
      assert.equal(allowance.needsPermit, true)
      const route = routeOf(market.yes.address, usdc)
      const q = await quoteExactIn(pub, { poolKey: route.poolKey, zeroForOne: route.zeroForOne, amount })
      const limit = minOutWithSlippage(q.amountOut, SLIPPAGE_BPS)
      const tx = await swapTx({ tokenIn: market.yes.address, tokenOut: usdc, exactIn: true, amount, limit })
      assert.equal(tx.commands, '0x0a10')
      const [u0, y0] = [await balance(usdc), await balance(market.yes.address)]
      await send(tx, 'sellWithPermit')
      assert.equal(y0 - (await balance(market.yes.address)), amount)
      const got = (await balance(usdc)) - u0
      assert.ok(got >= limit)
      drift['sellWithPermit'] = got - q.amountOut
    })

    it('sell exact-out without a permit', async () => {
      const amount = 5n * E6
      const route = routeOf(market.yes.address, usdc)
      const q = await quoteExactOut(pub, { poolKey: route.poolKey, zeroForOne: route.zeroForOne, amount })
      const limit = maxInWithSlippage(q.amountIn, SLIPPAGE_BPS)
      const tx = await swapTx({ tokenIn: market.yes.address, tokenOut: usdc, exactIn: false, amount, limit })
      assert.equal(tx.commands, '0x10')
      const u0 = await balance(usdc)
      await send(tx)
      assert.equal((await balance(usdc)) - u0, amount)
    })

    it('decodes hook reverts by name from V4Quoter and from UniversalRouter gas estimation', async () => {
      const route = routeOf(usdc, market.yes.address)
      const huge = 10_000_000n * E6
      await assert.rejects(
        quoteExactIn(pub, {
          poolKey: route.poolKey,
          zeroForOne: route.zeroForOne,
          amount: huge,
          extraErrors: hookErrors,
        }),
        (e: unknown) =>
          e instanceof PredictionSwapError &&
          e.revert?.hook === hook &&
          ['EpochCapExceeded', 'OutOfBand', 'Band', 'Insolvent'].includes(e.revert?.name ?? '') &&
          e.code !== 'UNKNOWN',
      )
      const tx = await swapTx({ tokenIn: usdc, tokenOut: market.yes.address, exactIn: true, amount: huge, limit: 0n })
      await assert.rejects(
        estimateSwapGas(pub, { tx, account: account.address, extraErrors: hookErrors }),
        (e: unknown) => e instanceof PredictionSwapError && e.revert?.hook === hook && e.revert?.name !== undefined,
      )
    })

    it('at the cutoff trading is refused with a named MARKET_CLOSED error', async () => {
      await test.setNextBlockTimestamp({ timestamp: market.cutoff })
      await test.mine({ blocks: 1 })
      const route = routeOf(usdc, market.yes.address)
      await assert.rejects(
        quoteExactIn(pub, {
          poolKey: route.poolKey,
          zeroForOne: route.zeroForOne,
          amount: E6,
          extraErrors: hookErrors,
        }),
        (e: unknown) =>
          e instanceof PredictionSwapError && e.code === 'MARKET_CLOSED' && e.revert?.name === 'NotTradable',
      )
    })

    it('after settlement the winning token sells for exactly 1 USDC each; the losing one is refused', async () => {
      await test.setNextBlockTimestamp({ timestamp: market.info.expiry })
      await test.mine({ blocks: 1 })
      await write(hook, hookAbi, 'settle', [market.id])
      const [settled] = await listMarkets(pub, { hook })
      assert.equal(settled?.status, 'Settled')
      const winner = settled?.info.yesWon ? market.yes : market.no
      const loser = settled?.info.yesWon ? market.no : market.yes
      const amount = 3n * E6
      const route = routeOf(winner.address, usdc)
      const q = await quoteExactIn(pub, { poolKey: route.poolKey, zeroForOne: route.zeroForOne, amount })
      assert.equal(q.amountOut, amount)
      const tx = await swapTx({ tokenIn: winner.address, tokenOut: usdc, exactIn: true, amount, limit: amount })
      const u0 = await balance(usdc)
      await send(tx, 'redeemSell')
      assert.equal((await balance(usdc)) - u0, amount)
      const lose = routeOf(loser.address, usdc)
      await assert.rejects(
        quoteExactIn(pub, { poolKey: lose.poolKey, zeroForOne: lose.zeroForOne, amount, extraErrors: hookErrors }),
        (e: unknown) =>
          e instanceof PredictionSwapError && e.revert?.name === 'MarketClosed' && e.code === 'MARKET_CLOSED',
      )
    })

    it('reports gas used', (t) => {
      for (const [label, gas] of Object.entries(gasUsed)) t.diagnostic(`${label}: ${gas} gas`)
      for (const [label, d] of Object.entries(drift)) t.diagnostic(`${label}: executed minus quoted ${d} (1e-6 units)`)
      assert.ok(gasUsed['firstBuyWithPermit'])
    })
  },
)
