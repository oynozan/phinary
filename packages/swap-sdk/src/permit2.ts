import { type Address, type Client, encodeFunctionData, erc20Abi, type Hex } from 'viem'
import { readContract } from 'viem/actions'
import { permit2Abi } from './abi/index.ts'
import {
  MAX_UINT160,
  MAX_UINT256,
  PERMIT_EXPIRATION_SECONDS,
  PERMIT_SIG_DEADLINE_SECONDS,
  UNICHAIN_SEPOLIA,
} from './constants.ts'

export interface PermitDetails {
  token: Address
  amount: bigint
  expiration: number
  nonce: number
}

export interface PermitSingle {
  details: PermitDetails
  spender: Address
  sigDeadline: bigint
}

export const PERMIT2_DOMAIN_NAME = 'Permit2'

export const PERMIT_SINGLE_TYPES = {
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
} as const

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** A Permit2 `PermitSingle` granting the router an allowance, with the web app's defaults (max amount, 30 d, 30 min). */
export function buildPermitSingle(p: {
  token: Address
  nonce: number
  spender?: Address
  amount?: bigint
  now?: number
  expiration?: number
  sigDeadline?: bigint
}): PermitSingle {
  const now = p.now ?? nowSeconds()
  return {
    details: {
      token: p.token,
      amount: p.amount ?? MAX_UINT160,
      expiration: p.expiration ?? now + PERMIT_EXPIRATION_SECONDS,
      nonce: p.nonce,
    },
    spender: p.spender ?? UNICHAIN_SEPOLIA.universalRouter,
    sigDeadline: p.sigDeadline ?? BigInt(now + PERMIT_SIG_DEADLINE_SECONDS),
  }
}

/** EIP-712 typed data for `eth_signTypedData_v4`, identical to `AllowanceTransfer.getPermitData`. */
export function permitTypedData(
  permit: PermitSingle,
  opts: { chainId?: number; permit2?: Address } = {},
): {
  domain: { name: string; chainId: number; verifyingContract: Address }
  types: typeof PERMIT_SINGLE_TYPES
  primaryType: 'PermitSingle'
  message: PermitSingle
} {
  return {
    domain: {
      name: PERMIT2_DOMAIN_NAME,
      chainId: opts.chainId ?? UNICHAIN_SEPOLIA.chainId,
      verifyingContract: opts.permit2 ?? UNICHAIN_SEPOLIA.permit2,
    },
    types: PERMIT_SINGLE_TYPES,
    primaryType: 'PermitSingle',
    message: permit,
  }
}

export interface AllowanceState {
  /** ERC20 allowance from owner to Permit2. */
  erc20Allowance: bigint
  needsErc20Approval: boolean
  /** Permit2 allowance from owner to the router. */
  permit2Amount: bigint
  permit2Expiration: number
  permit2Nonce: number
  needsPermit: boolean
}

/** Reads ERC20 -> Permit2 and Permit2 -> router allowances for `amount` of `token`. */
export async function readAllowances(
  client: Client,
  p: { owner: Address; token: Address; amount: bigint; spender?: Address; permit2?: Address; now?: number },
): Promise<AllowanceState> {
  const permit2 = p.permit2 ?? UNICHAIN_SEPOLIA.permit2
  const spender = p.spender ?? UNICHAIN_SEPOLIA.universalRouter
  const now = p.now ?? nowSeconds()
  const [erc20Allowance, [permit2Amount, permit2Expiration, permit2Nonce]] = await Promise.all([
    readContract(client, { address: p.token, abi: erc20Abi, functionName: 'allowance', args: [p.owner, permit2] }),
    readContract(client, {
      address: permit2,
      abi: permit2Abi,
      functionName: 'allowance',
      args: [p.owner, p.token, spender],
    }),
  ])
  return {
    erc20Allowance,
    needsErc20Approval: erc20Allowance < p.amount,
    permit2Amount,
    permit2Expiration,
    permit2Nonce,
    needsPermit: permit2Amount < p.amount || permit2Expiration <= now + 60,
  }
}

export interface TxRequest {
  to: Address
  data: Hex
  value: bigint
}

/** `token.approve(Permit2, max)`. */
export function erc20ApproveTx({
  token,
  spender = UNICHAIN_SEPOLIA.permit2,
  amount = MAX_UINT256,
}: {
  token: Address
  spender?: Address
  amount?: bigint
}): TxRequest {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
    value: 0n,
  }
}

/** `Permit2.approve(token, router, amount, expiration)`: the on-chain alternative to a signed permit. */
export function permit2ApproveTx(p: {
  token: Address
  expiration: number
  spender?: Address
  amount?: bigint
  permit2?: Address
}): TxRequest {
  return {
    to: p.permit2 ?? UNICHAIN_SEPOLIA.permit2,
    data: encodeFunctionData({
      abi: permit2Abi,
      functionName: 'approve',
      args: [p.token, p.spender ?? UNICHAIN_SEPOLIA.universalRouter, p.amount ?? MAX_UINT160, p.expiration],
    }),
    value: 0n,
  }
}
