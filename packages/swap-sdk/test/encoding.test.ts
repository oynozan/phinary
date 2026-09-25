import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type Address, getAddress, type Hex, hashTypedData } from 'viem'
import {
  buildPermitSingle,
  buildSwap,
  encodeV4SingleSwap,
  permitTypedData,
  type PoolKey,
  poolId,
  predictionPoolKey,
  UNICHAIN_SEPOLIA,
} from '../src/index.ts'
import { hasInterfaceSdks, loadUniswapSdks } from './helpers/uniswapSdks.ts'

const USDC = UNICHAIN_SEPOLIA.usdc
const LOW_TOKEN: Address = getAddress('0x1111111111111111111111111111111111111111')
const HIGH_TOKEN: Address = getAddress('0xeeee00000000000000000000000000000000abcd')
const HOOK: Address = getAddress('0x00000000000000000000000000000000c0de2aa8')
const SIG: Hex = `0x${'ab'.repeat(65)}`
const DEADLINE = 1_790_000_000n

interface Case {
  name: string
  key: PoolKey
  zeroForOne: boolean
  tradeType: 'EXACT_INPUT' | 'EXACT_OUTPUT'
  amount: bigint
  limit: bigint
  hookData: Hex
  withPermit: boolean
}

const buyLow = predictionPoolKey({ token: LOW_TOKEN, usdc: USDC, hook: HOOK })
const buyHigh = predictionPoolKey({ token: HIGH_TOKEN, usdc: USDC, hook: HOOK })

const cases: Case[] = [
  {
    name: 'buy exact-in, USDC is currency1',
    key: buyLow,
    zeroForOne: false,
    tradeType: 'EXACT_INPUT',
    amount: 10_000_000n,
    limit: 40_790_000n,
    hookData: '0x',
    withPermit: true,
  },
  {
    name: 'buy exact-in, USDC is currency0',
    key: buyHigh,
    zeroForOne: true,
    tradeType: 'EXACT_INPUT',
    amount: 10_000_000n,
    limit: 40_790_000n,
    hookData: '0x',
    withPermit: false,
  },
  {
    name: 'sell exact-in',
    key: buyLow,
    zeroForOne: true,
    tradeType: 'EXACT_INPUT',
    amount: 20_000_000n,
    limit: 7_326_000n,
    hookData: '0x',
    withPermit: true,
  },
  {
    name: 'buy exact-out',
    key: buyHigh,
    zeroForOne: true,
    tradeType: 'EXACT_OUTPUT',
    amount: 41_203_131n,
    limit: 10_100_000n,
    hookData: '0x',
    withPermit: true,
  },
  {
    name: 'sell exact-out with hookData',
    key: buyHigh,
    zeroForOne: false,
    tradeType: 'EXACT_OUTPUT',
    amount: 7_400_000n,
    limit: 20_200_000n,
    hookData: '0xdeadbeef',
    withPermit: false,
  },
]

describe(
  'UniversalRouter 2.0 encoding matches @uniswap/universal-router-sdk + @uniswap/v4-sdk (URVersion.V2_0)',
  { skip: !hasInterfaceSdks && 'interface/node_modules missing' },
  () => {
    const { ur, v4, permit2, core, ethers } = hasInterfaceSdks
      ? loadUniswapSdks()
      : ({} as ReturnType<typeof loadUniswapSdks>)

    it('pins the same router address as the SDK for chain 1301', () => {
      assert.equal(
        ur.UNIVERSAL_ROUTER_ADDRESS(ur.UniversalRouterVersion.V2_0, 1301).toLowerCase(),
        UNICHAIN_SEPOLIA.universalRouter.toLowerCase(),
      )
      assert.equal(permit2.PERMIT2_ADDRESS.toLowerCase(), UNICHAIN_SEPOLIA.permit2.toLowerCase())
    })

    for (const c of cases) {
      it(c.name, () => {
        const exactIn = c.tradeType === 'EXACT_INPUT'
        const tokenIn = c.zeroForOne ? c.key.currency0 : c.key.currency1
        const tokenOut = c.zeroForOne ? c.key.currency1 : c.key.currency0
        const permit = buildPermitSingle({ token: tokenIn, nonce: 3, now: 1_790_000_000 })

        const planner = new v4.V4Planner()
        const sdkKey = { ...c.key }
        if (exactIn) {
          planner.addAction(
            v4.Actions.SWAP_EXACT_IN_SINGLE,
            [
              {
                poolKey: sdkKey,
                zeroForOne: c.zeroForOne,
                amountIn: c.amount.toString(),
                amountOutMinimum: c.limit.toString(),
                hookData: c.hookData,
              },
            ],
            v4.URVersion.V2_0,
          )
          planner.addAction(v4.Actions.SETTLE_ALL, [tokenIn, c.amount.toString()])
          planner.addAction(v4.Actions.TAKE_ALL, [tokenOut, c.limit.toString()])
        } else {
          planner.addAction(
            v4.Actions.SWAP_EXACT_OUT_SINGLE,
            [
              {
                poolKey: sdkKey,
                zeroForOne: c.zeroForOne,
                amountOut: c.amount.toString(),
                amountInMaximum: c.limit.toString(),
                hookData: c.hookData,
              },
            ],
            v4.URVersion.V2_0,
          )
          planner.addAction(v4.Actions.SETTLE_ALL, [tokenIn, c.limit.toString()])
          planner.addAction(v4.Actions.TAKE_ALL, [tokenOut, c.amount.toString()])
        }
        const routes = new ur.RoutePlanner()
        if (c.withPermit) {
          routes.addCommand(ur.CommandType.PERMIT2_PERMIT, [
            {
              details: {
                token: permit.details.token,
                amount: permit.details.amount.toString(),
                expiration: permit.details.expiration.toString(),
                nonce: permit.details.nonce.toString(),
              },
              spender: permit.spender,
              sigDeadline: permit.sigDeadline.toString(),
            },
            SIG,
          ])
        }
        routes.addCommand(ur.CommandType.V4_SWAP, [planner.finalize()])
        const sdk = ur.SwapRouter.encodePlan(routes, ethers.BigNumber.from(0), { deadline: DEADLINE.toString() })

        const ours = buildSwap({
          poolKey: c.key,
          zeroForOne: c.zeroForOne,
          tradeType: c.tradeType,
          amount: c.amount,
          limit: c.limit,
          hookData: c.hookData,
          deadline: DEADLINE,
          permit: c.withPermit ? { permit, signature: SIG } : undefined,
        })

        assert.equal(ours.v4Actions, planner.finalize())
        assert.equal(ours.commands, routes.commands)
        assert.deepEqual(ours.inputs, routes.inputs)
        assert.equal(ours.data, sdk.calldata)
        assert.equal(ours.to, UNICHAIN_SEPOLIA.universalRouter)

        const parsed = ur.CommandParser.parseCalldata(ours.data)
        assert.deepEqual(
          parsed.commands.map((x: { commandName: string }) => x.commandName),
          c.withPermit ? ['PERMIT2_PERMIT', 'V4_SWAP'] : ['V4_SWAP'],
        )
        const v4cmd = parsed.commands.at(-1)
        assert.deepEqual(
          v4cmd.params.map((a: { name: string }) => a.name),
          [exactIn ? 'SWAP_EXACT_IN_SINGLE' : 'SWAP_EXACT_OUT_SINGLE', 'SETTLE_ALL', 'TAKE_ALL'],
        )
      })
    }

    it('commands byte is 0x10 without a permit and 0x0a10 with one', () => {
      const base = {
        poolKey: buyLow,
        zeroForOne: false,
        tradeType: 'EXACT_INPUT' as const,
        amount: 1n,
        limit: 0n,
        deadline: DEADLINE,
      }
      assert.equal(buildSwap(base).commands, '0x10')
      const permit = buildPermitSingle({ token: USDC, nonce: 0 })
      assert.equal(buildSwap({ ...base, permit: { permit, signature: SIG } }).commands, '0x0a10')
    })

    it('PermitSingle typed data matches AllowanceTransfer.getPermitData and hashes identically', () => {
      const permit = buildPermitSingle({ token: USDC, nonce: 7, now: 1_790_000_000 })
      const td = permitTypedData(permit)
      const sdk = permit2.AllowanceTransfer.getPermitData(
        {
          details: {
            token: USDC,
            amount: permit.details.amount.toString(),
            expiration: permit.details.expiration,
            nonce: 7,
          },
          spender: permit.spender,
          sigDeadline: permit.sigDeadline.toString(),
        },
        permit2.PERMIT2_ADDRESS,
        1301,
      )
      assert.deepEqual(td.domain, sdk.domain)
      assert.deepEqual(td.types, sdk.types)
      const sdkHash = ethers.utils._TypedDataEncoder.hash(sdk.domain, sdk.types, sdk.values)
      assert.equal(hashTypedData(td), sdkHash)
    })

    it('poolId matches v4-sdk Pool.getPoolId', () => {
      const a = new core.Token(1301, LOW_TOKEN, 6)
      const b = new core.Token(1301, USDC, 6)
      assert.equal(poolId(buyLow), v4.Pool.getPoolId(a, b, 0, 60, HOOK))
    })
  },
)

describe('encoding guards', () => {
  it('rejects the Stack B router and a permit for the wrong spender or token', () => {
    const base = {
      poolKey: buyLow,
      zeroForOne: false,
      tradeType: 'EXACT_INPUT' as const,
      amount: 1n,
      limit: 0n,
      deadline: DEADLINE,
    }
    assert.throws(() => buildSwap({ ...base, router: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b' }), /refusing/)
    const wrongSpender = buildPermitSingle({ token: USDC, nonce: 0, spender: HOOK })
    assert.throws(() => buildSwap({ ...base, permit: { permit: wrongSpender, signature: SIG } }), /spender/)
    const wrongToken = buildPermitSingle({ token: LOW_TOKEN, nonce: 0 })
    assert.throws(() => buildSwap({ ...base, permit: { permit: wrongToken, signature: SIG } }), /input token/)
  })

  it('rejects amounts outside uint128', () => {
    assert.throws(() =>
      encodeV4SingleSwap({ poolKey: buyLow, zeroForOne: true, tradeType: 'EXACT_INPUT', amount: 0n, limit: 0n }),
    )
    assert.throws(() =>
      encodeV4SingleSwap({
        poolKey: buyLow,
        zeroForOne: true,
        tradeType: 'EXACT_INPUT',
        amount: 1n << 128n,
        limit: 0n,
      }),
    )
  })
})
