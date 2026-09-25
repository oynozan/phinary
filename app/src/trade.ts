import {
  type Address,
  BaseError,
  type Chain,
  encodeFunctionData,
  type Hex,
  parseEventLogs,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'
import { hookErrorAbi } from './abi.ts'
import type { AppConfig } from './config.ts'
import {
  autoSlippageBps,
  buildPermitSingle,
  buildSwap,
  erc20ApproveTx,
  estimateSwapGas,
  gasWithHeadroom,
  type Market,
  minOutWithSlippage,
  type PermitSingle,
  PredictionSwapError,
  permitTypedData,
  type PoolKey,
  predictionHookAbi,
  type SwapTx,
  quoteExactIn,
  readAllowances,
  sameAddress,
  toSwapError,
  zeroForOneFor,
} from './sdk.ts'
import { windowStartOf } from './market.ts'
import { type Connection, isUserRejection } from './wallet.ts'

const MAX_QUOTE_ATTEMPTS = 3

export type StepId = 'approve' | 'permit' | 'swap' | 'redeem' | 'settle'
export type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed'

export interface Step {
  id: StepId
  label: string
  status: StepStatus
  hash?: Hex
  detail?: string
}

export interface ExecContext {
  cfg: AppConfig
  pub: PublicClient
  chain: Chain
  conn: Connection
  /** Chain time in seconds. */
  now: () => number
}

export interface SwapRequest {
  market: Market
  isYes: boolean
  isBuy: boolean
  /** Exact input: USDC for a buy, outcome tokens for a sell. */
  amount: bigint
  /** Undefined means auto (sized to the market's time to its averaging window). */
  slippageBps?: number
  label?: string
}

export interface TradeFill {
  qty: bigint
  usdc: bigint
  avgPriceWad: bigint
}

export interface SwapResult {
  hash: Hex
  receipt: TransactionReceipt
  fill?: TradeFill
  slippageBps: number
}

export class StepError extends Error {
  readonly hash?: Hex
  constructor(message: string, hash?: Hex, cause?: unknown) {
    super(message, { cause })
    this.name = 'StepError'
    this.hash = hash
  }
}

export function otherCurrency(key: PoolKey, token: Address): Address {
  return sameAddress(key.currency0, token) ? key.currency1 : key.currency0
}

export interface SwapRoute {
  poolKey: PoolKey
  tokenIn: Address
  tokenOut: Address
  zeroForOne: boolean
}

export function swapRoute(market: Market, isYes: boolean, isBuy: boolean): SwapRoute {
  const token = isYes ? market.yes : market.no
  const usdc = otherCurrency(token.poolKey, token.address)
  const tokenIn = isBuy ? usdc : token.address
  return {
    poolKey: token.poolKey,
    tokenIn,
    tokenOut: isBuy ? token.address : usdc,
    zeroForOne: zeroForOneFor(token.poolKey, tokenIn),
  }
}

/** Seconds a quote must survive: wallet confirmation plus a block. */
export function confirmSeconds(conn: Pick<Connection, 'kind'>): number {
  return conn.kind === 'burner' ? 2 : 5
}

/** Slippage for an exact-in trade; settled and invalid markets pay a fixed price, so none is needed. */
export function slippageFor(p: {
  market: Market
  isBuy: boolean
  amountIn: bigint
  amountOut: bigint
  now: number
  confirm: number
  fixedBps?: number
}): number {
  if (p.market.status !== 'Trading') {
    return 0
  }
  if (p.fixedBps !== undefined) {
    return p.fixedBps
  }
  return autoSlippageBps({
    exactIn: true,
    isBuy: p.isBuy,
    amountIn: p.amountIn,
    amountOut: p.amountOut,
    secondsToWindow: windowStartOf(p.market.info) - p.now,
    confirmSeconds: p.confirm,
  })
}

export function describeError(err: unknown): string {
  if (isUserRejection(err)) {
    return 'Rejected in the wallet'
  }
  if (err instanceof PredictionSwapError) {
    return err.revert?.name && err.code !== 'UNKNOWN' ? `${err.message} (${err.revert.name})` : err.message
  }
  if (err instanceof StepError) {
    return err.message
  }
  if (err instanceof BaseError) {
    return err.shortMessage
  }
  return err instanceof Error ? err.message : String(err)
}

export function tradeFill(receipt: TransactionReceipt, hook: Address): TradeFill | undefined {
  const logs = parseEventLogs({ abi: predictionHookAbi, logs: receipt.logs, eventName: 'Trade' })
  const log = logs.find((l) => sameAddress(l.address, hook))
  if (!log) {
    return undefined
  }
  return { qty: log.args.qty, usdc: log.args.usdcAmount, avgPriceWad: log.args.avgPriceWad }
}

async function sendAndWait(
  ctx: ExecContext,
  tx: { to: Address; data: Hex; value?: bigint; gas?: bigint },
  revertMessage = 'Transaction reverted on chain',
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const { conn, chain, pub } = ctx
  const hash = await conn.wallet.sendTransaction({
    account: conn.wallet.account ?? conn.address,
    chain,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gas: tx.gas,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 })
  if (receipt.status !== 'success') {
    throw new StepError(revertMessage, hash)
  }
  return { hash, receipt }
}

/** Exact-in swap via UniversalRouter 2.0: approve Permit2 if needed, sign a PermitSingle if needed, re-quote, execute */
export async function executeSwap(
  ctx: ExecContext,
  req: SwapRequest,
  onSteps: (steps: Step[]) => void,
): Promise<SwapResult> {
  const { cfg, pub, conn } = ctx
  const { market, amount } = req
  const route = swapRoute(market, req.isYes, req.isBuy)
  const tokenLabel = req.isBuy ? 'USDC' : req.isYes ? 'YES' : 'NO'
  const steps: Step[] = [
    { id: 'approve', label: `Allow Permit2 to use ${tokenLabel}`, status: 'pending' },
    { id: 'permit', label: 'Sign Permit2 allowance for the router', status: 'pending' },
    { id: 'swap', label: req.label ?? 'Swap through UniversalRouter', status: 'pending' },
  ]
  const update = (id: StepId, patch: Partial<Step>) => {
    const i = steps.findIndex((s) => s.id === id)
    steps[i] = { ...(steps[i] as Step), ...patch }
    onSteps([...steps])
  }
  onSteps([...steps])
  let current: StepId = 'approve'
  try {
    const now = Math.floor(ctx.now())
    const allowance = await readAllowances(pub, {
      owner: conn.address,
      token: route.tokenIn,
      amount,
      permit2: cfg.contracts.permit2,
      spender: cfg.contracts.universalRouter,
      now,
    })

    if (allowance.needsErc20Approval) {
      update('approve', { status: 'active', detail: 'Confirm in your wallet' })
      const { hash } = await sendAndWait(
        ctx,
        erc20ApproveTx({ token: route.tokenIn, spender: cfg.contracts.permit2 }),
      )
      update('approve', { status: 'done', hash, detail: undefined })
    } else {
      update('approve', {
        status: 'skipped',
        detail: req.isBuy ? 'Already approved' : 'Outcome tokens pre-approve Permit2',
      })
    }

    current = 'permit'
    let permit: { permit: PermitSingle; signature: Hex } | undefined
    if (allowance.needsPermit) {
      update('permit', { status: 'active', detail: 'Sign in your wallet (no gas)' })
      const single = buildPermitSingle({
        token: route.tokenIn,
        nonce: allowance.permit2Nonce,
        spender: cfg.contracts.universalRouter,
        now: Math.floor(ctx.now()),
      })
      const typed = permitTypedData(single, { chainId: cfg.chainId, permit2: cfg.contracts.permit2 })
      const signature = await conn.wallet.signTypedData({
        account: conn.wallet.account ?? conn.address,
        ...typed,
      })
      permit = { permit: single, signature }
      update('permit', { status: 'done', detail: 'Signed' })
    } else {
      update('permit', { status: 'skipped', detail: 'Router already has an allowance' })
    }

    current = 'swap'
    update('swap', { status: 'active', detail: 'Re-quoting' })
    const extraErrors = hookErrorAbi
    let tx: SwapTx | undefined
    let gas = 0n
    let slippageBps = 0
    // The price can move between quote and simulation; nothing is signed yet, so re-quote a couple of times
    for (let attempt = 1; ; attempt++) {
      const q = await quoteExactIn(pub, {
        poolKey: route.poolKey,
        zeroForOne: route.zeroForOne,
        amount,
        quoter: cfg.contracts.v4Quoter,
        account: conn.address,
        extraErrors,
      })
      const nowSwap = Math.floor(ctx.now())
      slippageBps = slippageFor({
        market,
        isBuy: req.isBuy,
        amountIn: amount,
        amountOut: q.amountOut,
        now: nowSwap,
        confirm: confirmSeconds(conn),
        fixedBps: req.slippageBps,
      })
      tx = buildSwap({
        poolKey: route.poolKey,
        zeroForOne: route.zeroForOne,
        tradeType: 'EXACT_INPUT',
        amount,
        limit: minOutWithSlippage(q.amountOut, slippageBps),
        deadline: BigInt(nowSwap + 300),
        permit,
        router: cfg.contracts.universalRouter,
      })
      try {
        gas = await estimateSwapGas(pub, { tx, account: conn.address, extraErrors })
        break
      } catch (err) {
        if (!(err instanceof PredictionSwapError) || err.code !== 'SLIPPAGE' || attempt >= MAX_QUOTE_ATTEMPTS) {
          throw err
        }
        update('swap', { detail: `Price moved, re-quoting (${attempt + 1}/${MAX_QUOTE_ATTEMPTS})` })
      }
    }
    update('swap', { detail: 'Confirm in your wallet' })
    const { hash, receipt } = await sendAndWait(
      ctx,
      { to: tx.to, data: tx.data, value: tx.value, gas: gasWithHeadroom(gas) },
      'Swap reverted on chain: the price moved past the slippage limit or trading closed. Try again.',
    )
    const fill = tradeFill(receipt, market.hook)
    update('swap', { status: 'done', hash, detail: undefined })
    return { hash, receipt, fill, slippageBps }
  } catch (err) {
    const hash = err instanceof StepError ? err.hash : undefined
    update(current, { status: 'failed', hash, detail: describeError(err) })
    for (const s of steps) {
      if (s.status === 'pending') {
        s.status = 'skipped'
      }
    }
    onSteps([...steps])
    throw err
  }
}

async function simulateHookCall(
  ctx: ExecContext,
  hook: Address,
  functionName: 'redeem' | 'settle',
  args: readonly [bigint] | readonly [bigint, bigint],
): Promise<{ to: Address; data: Hex; gas: bigint }> {
  const data = encodeFunctionData({ abi: predictionHookAbi, functionName, args } as never)
  try {
    const gas = await ctx.pub.estimateGas({ account: ctx.conn.address, to: hook, data })
    return { to: hook, data, gas: gasWithHeadroom(gas) }
  } catch (err) {
    throw toSwapError(err, hookErrorAbi)
  }
}

/** `hook.redeem(marketId, amount)`: burns winning tokens and pays USDC without a swap. */
export async function executeRedeem(
  ctx: ExecContext,
  market: Market,
  amount: bigint,
  onSteps: (steps: Step[]) => void,
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  return singleStep(ctx, onSteps, 'redeem', 'Redeem with hook.redeem()', () =>
    simulateHookCall(ctx, market.hook, 'redeem', [market.id, amount]),
  )
}

/** Permissionless `hook.settle(marketId)` once the market has expired. */
export async function executeSettle(
  ctx: ExecContext,
  market: Market,
  onSteps: (steps: Step[]) => void,
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  return singleStep(ctx, onSteps, 'settle', 'Settle the market from the oracle TWAP', () =>
    simulateHookCall(ctx, market.hook, 'settle', [market.id]),
  )
}

async function singleStep(
  ctx: ExecContext,
  onSteps: (steps: Step[]) => void,
  id: StepId,
  label: string,
  build: () => Promise<{ to: Address; data: Hex; gas: bigint }>,
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  onSteps([{ id, label, status: 'active', detail: 'Simulating' }])
  try {
    const tx = await build()
    onSteps([{ id, label, status: 'active', detail: 'Confirm in your wallet' }])
    const res = await sendAndWait(ctx, tx)
    onSteps([{ id, label, status: 'done', hash: res.hash }])
    return res
  } catch (err) {
    onSteps([
      { id, label, status: 'failed', hash: err instanceof StepError ? err.hash : undefined, detail: describeError(err) },
    ])
    throw err
  }
}
