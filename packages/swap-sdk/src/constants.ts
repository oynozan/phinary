import type { Address } from 'viem'

/** Unichain Sepolia. */
export const UNICHAIN_SEPOLIA_CHAIN_ID = 1301

/** Uniswap v4 "Stack A" on chain 1301 (docs/research/interface-fork/unichain-sepolia.md). Never mix with Stack B. */
export interface ChainContracts {
  chainId: number
  poolManager: Address
  v4Quoter: Address
  /** UniversalRouter 2.0: 5-field ExactInputSingleParams (no minHopPriceX36). */
  universalRouter: Address
  permit2: Address
  usdc: Address
  multicall3: Address
}

export const UNICHAIN_SEPOLIA: ChainContracts = {
  chainId: UNICHAIN_SEPOLIA_CHAIN_ID,
  poolManager: '0x00B036B58a818B1BC34d502D3fE730Db729e62AC',
  v4Quoter: '0x56DCD40A3F2d466F48e7F48bDBE5Cc9B92Ae4472',
  universalRouter: '0xf70536B3bcC1bD1a972dc186A2cf84cC6da6Be5D',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  usdc: '0x31d0220469e10c4E71834a79b1f276d740d3768F',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
}

/** Public RPC that the Uniswap web app CSP already allows (`https://*.drpc.org/`). */
export const UNICHAIN_SEPOLIA_RPC_URL = 'https://unichain-sepolia.drpc.org'
export const UNICHAIN_SEPOLIA_EXPLORER = 'https://sepolia.uniscan.xyz'

/** UniversalRouter 2.1.1 on 1301 is wired to the other PoolManager (Stack B). Refuse it. */
export const FORBIDDEN_ROUTERS: readonly Address[] = ['0x8B844f885672f333Bc0042cB669255f93a4C1E6b']

/** Every PredictionHook pool: fee 0, tickSpacing 60 (SPEC §3.1). */
export const PREDICTION_POOL_FEE = 0
export const PREDICTION_TICK_SPACING = 60

export const USDC_DECIMALS = 6
export const OUTCOME_DECIMALS = 6
export const WAD = 10n ** 18n

/** UniversalRouter command bytes (universal-router/contracts/libraries/Commands.sol). */
export const Commands = {
  PERMIT2_PERMIT: 0x0a,
  V4_SWAP: 0x10,
} as const

/** V4Router action bytes (v4-periphery/src/libraries/Actions.sol). */
export const Actions = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f,
} as const

export const MAX_UINT160 = 2n ** 160n - 1n
export const MAX_UINT256 = 2n ** 256n - 1n
export const MAX_UINT128 = 2n ** 128n - 1n

/** Permit2 allowance lifetime and signature lifetime used by the Uniswap web app. */
export const PERMIT_EXPIRATION_SECONDS = 30 * 24 * 60 * 60
export const PERMIT_SIG_DEADLINE_SECONDS = 30 * 60
