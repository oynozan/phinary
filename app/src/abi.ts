import { parseAbi } from 'viem'

/** PredictionHook and UnderlyingOracleHook custom errors, so reverts decode by name. */
export const hookErrorAbi = parseAbi([
  'error Band()',
  'error DonateDisabled()',
  'error EpochCapExceeded()',
  'error ForeignInitialize()',
  'error HookNotImplemented()',
  'error Insolvent()',
  'error InsufficientIdle()',
  'error InsufficientShares()',
  'error InvalidParams()',
  'error InvalidPool()',
  'error LiquidityDisabled()',
  'error MarketClosed()',
  'error NotPoolManager()',
  'error NotSettled()',
  'error NotTradable()',
  'error OracleAvailable()',
  'error OutOfBand()',
  'error TooEarly()',
  'error TooLate()',
  'error Unauthorized()',
  'error UnknownMarket()',
  'error UnknownPool()',
  'error Unreachable()',
  'error UnsupportedKernel()',
  'error ZeroAmount()',
  'error ZeroVariance()',
  'error ObservationUnavailable(uint32 t)',
  'error FutureTime(uint32 t)',
  'error CheckpointUnavailable(uint32 grid)',
  'error NotBound()',
])

export const oracleAbi = parseAbi([
  'function lnSpotSoBWad() view returns (int256)',
  'function cumulativeAt(uint32 t) view returns (int56)',
  'function decimalsShift() view returns (int16)',
])

export const multicall3Abi = parseAbi([
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
])
