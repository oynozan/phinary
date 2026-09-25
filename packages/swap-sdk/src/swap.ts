import {
  type Abi,
  type Address,
  type Client,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  toHex,
} from 'viem'
import { estimateGas } from 'viem/actions'
import { universalRouterAbi } from './abi/index.ts'
import { Actions, Commands, FORBIDDEN_ROUTERS, MAX_UINT128, UNICHAIN_SEPOLIA } from './constants.ts'
import { toSwapError } from './errors.ts'
import type { PermitSingle, TxRequest } from './permit2.ts'
import { inputCurrency, outputCurrency, type PoolKey, sameAddress } from './pool.ts'

export type TradeType = 'EXACT_INPUT' | 'EXACT_OUTPUT'

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const

/** UR 2.0 / v4-periphery `IV4Router.ExactInputSingleParams` (5 fields, no minHopPriceX36). */
const EXACT_IN_SINGLE = [
  {
    type: 'tuple',
    components: [
      { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' },
      { name: 'hookData', type: 'bytes' },
    ],
  },
] as const

/** UR 2.0 `IV4Router.ExactOutputSingleParams` (5 fields). */
const EXACT_OUT_SINGLE = [
  {
    type: 'tuple',
    components: [
      { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountOut', type: 'uint128' },
      { name: 'amountInMaximum', type: 'uint128' },
      { name: 'hookData', type: 'bytes' },
    ],
  },
] as const

const CURRENCY_AMOUNT = [{ type: 'address' }, { type: 'uint256' }] as const

const PERMIT_SINGLE_PARAMS = [
  {
    type: 'tuple',
    components: [
      {
        name: 'details',
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' },
        ],
      },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
  },
  { type: 'bytes' },
] as const

export interface BuildSwapParams {
  poolKey: PoolKey
  zeroForOne: boolean
  tradeType: TradeType
  /** Exact input (EXACT_INPUT) or exact output (EXACT_OUTPUT). */
  amount: bigint
  /** Minimum output (EXACT_INPUT) or maximum input (EXACT_OUTPUT). */
  limit: bigint
  /** Unix seconds. */
  deadline: bigint
  hookData?: Hex
  /** Prepends PERMIT2_PERMIT; `permit.spender` must be the router. */
  permit?: { permit: PermitSingle; signature: Hex }
  router?: Address
}

export interface SwapTx extends TxRequest {
  commands: Hex
  inputs: Hex[]
  /** V4_SWAP payload: abi.encode(bytes actions, bytes[] params). */
  v4Actions: Hex
}

/** V4_SWAP input: [SWAP_EXACT_IN_SINGLE | SWAP_EXACT_OUT_SINGLE, SETTLE_ALL, TAKE_ALL]. */
export function encodeV4SingleSwap(p: Omit<BuildSwapParams, 'deadline' | 'permit' | 'router'>): Hex {
  if (p.amount <= 0n || p.amount > MAX_UINT128 || p.limit < 0n || p.limit > MAX_UINT128) {
    throw new Error('swap amounts must fit in uint128')
  }
  const tokenIn = inputCurrency(p.poolKey, p.zeroForOne)
  const tokenOut = outputCurrency(p.poolKey, p.zeroForOne)
  const hookData = p.hookData ?? '0x'
  const exactIn = p.tradeType === 'EXACT_INPUT'
  const swap = exactIn
    ? encodeAbiParameters(EXACT_IN_SINGLE, [
        { poolKey: p.poolKey, zeroForOne: p.zeroForOne, amountIn: p.amount, amountOutMinimum: p.limit, hookData },
      ])
    : encodeAbiParameters(EXACT_OUT_SINGLE, [
        { poolKey: p.poolKey, zeroForOne: p.zeroForOne, amountOut: p.amount, amountInMaximum: p.limit, hookData },
      ])
  const settle = encodeAbiParameters(CURRENCY_AMOUNT, [tokenIn, exactIn ? p.amount : p.limit])
  const take = encodeAbiParameters(CURRENCY_AMOUNT, [tokenOut, exactIn ? p.limit : p.amount])
  const actions = concatHex([
    toHex(exactIn ? Actions.SWAP_EXACT_IN_SINGLE : Actions.SWAP_EXACT_OUT_SINGLE, { size: 1 }),
    toHex(Actions.SETTLE_ALL, { size: 1 }),
    toHex(Actions.TAKE_ALL, { size: 1 }),
  ])
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swap, settle, take]])
}

/** PERMIT2_PERMIT input: abi.encode(PermitSingle, bytes signature). */
export function encodePermit2Permit(permit: PermitSingle, signature: Hex): Hex {
  return encodeAbiParameters(PERMIT_SINGLE_PARAMS, [permit, signature])
}

/** `UniversalRouter.execute(commands, inputs, deadline)` for a single-pool v4 swap (commands 0x10 or 0x0a10). */
export function buildSwap(p: BuildSwapParams): SwapTx {
  const router = p.router ?? UNICHAIN_SEPOLIA.universalRouter
  if (FORBIDDEN_ROUTERS.some((r) => sameAddress(r, router))) {
    throw new Error(`refusing UniversalRouter ${router}`)
  }
  const v4Actions = encodeV4SingleSwap(p)
  const cmds: number[] = []
  const inputs: Hex[] = []
  if (p.permit) {
    if (!sameAddress(p.permit.permit.spender, router)) {
      throw new Error('permit spender must be the router')
    }
    if (!sameAddress(p.permit.permit.details.token, inputCurrency(p.poolKey, p.zeroForOne))) {
      throw new Error('permit token must be the input token')
    }
    cmds.push(Commands.PERMIT2_PERMIT)
    inputs.push(encodePermit2Permit(p.permit.permit, p.permit.signature))
  }
  cmds.push(Commands.V4_SWAP)
  inputs.push(v4Actions)
  const commands = concatHex(cmds.map((c) => toHex(c, { size: 1 })))
  const data = encodeFunctionData({
    abi: universalRouterAbi,
    functionName: 'execute',
    args: [commands, inputs, p.deadline],
  })
  return { to: router, data, value: 0n, commands, inputs, v4Actions }
}

/** `eth_estimateGas` for a swap; a revert becomes a `PredictionSwapError` so the UI never shows a doomed swap. */
export async function estimateSwapGas(
  client: Client,
  { tx, account, extraErrors = [] }: { tx: TxRequest; account: Address; extraErrors?: Abi },
): Promise<bigint> {
  try {
    return await estimateGas(client, { account, to: tx.to, data: tx.data, value: tx.value })
  } catch (err) {
    throw toSwapError(err, extraErrors)
  }
}
