import { erc20Abi, parseAbi } from 'viem'
import { hookErrorsAbi } from './hookErrors.generated.ts'
import { outcomeTokenAbi } from './outcomeToken.generated.ts'
import { predictionHookAbi } from './predictionHook.generated.ts'

export { erc20Abi, hookErrorsAbi, outcomeTokenAbi, predictionHookAbi }

const POOL_KEY =
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }'

/** V4Quoter (v4-periphery src/lens/V4Quoter.sol); QuoteExactSingleParams is 4 fields on every deployment. */
export const v4QuoterAbi = parseAbi([
  POOL_KEY,
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
  'function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn, uint256 gasEstimate)',
  'error UnexpectedRevertBytes(bytes revertData)',
  'error QuoteSwap(uint256 amount)',
  'error NotEnoughLiquidity(bytes32 poolId)',
  'error NotSelf()',
  'error UnexpectedCallSuccess()',
])

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'function execute(bytes commands, bytes[] inputs) payable',
  'function poolManager() view returns (address)',
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error ETHNotAccepted()',
  'error TransactionDeadlinePassed()',
  'error LengthMismatch()',
  'error InvalidEthSender()',
  'error InvalidCommandType(uint256 commandType)',
  'error BalanceTooLow()',
  'error FromAddressIsNotOwner()',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)',
  'error DeltaNotPositive(address currency)',
  'error DeltaNotNegative(address currency)',
  'error InsufficientBalance()',
  'error InputLengthMismatch()',
  'error UnsupportedAction(uint256 action)',
  'error ContractLocked()',
  'error NotPoolManager()',
])

export const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
  'error ExcessiveInvalidation()',
  'error InvalidNonce()',
  'error SignatureExpired(uint256 signatureDeadline)',
  'error InvalidSignature()',
  'error InvalidSigner()',
  'error InvalidSignatureLength()',
  'error InvalidContractSignature()',
])

/** PoolManager and hook-call errors that can surface through V4Quoter or UniversalRouter (v4-core). */
export const poolManagerErrorsAbi = parseAbi([
  'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
  'error HookCallFailed()',
  'error HookAddressNotValid(address hooks)',
  'error InvalidHookResponse()',
  'error HookDeltaExceedsSwapAmount()',
  'error PoolNotInitialized()',
  'error CurrencyNotSettled()',
  'error ManagerLocked()',
  'error SwapAmountCannotBeZero()',
  'error NonzeroNativeValue()',
  'error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)',
  'error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96)',
  'error SafeCastOverflow()',
])
