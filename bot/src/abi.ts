import { parseAbi } from "viem";

/** Subset of src/interfaces/IPredictionHook.sol used by the keeper. test/abi.test.ts checks it against forge output. */
export const predictionHookAbi = parseAbi([
  "struct QuoteParams { uint64 h0Wad; uint64 gammaSWad; uint128 lambdaWad; uint128 qEpochMax; uint64 pMinWad; }",
  "struct MarketParams { address oracle; int256 lnStrikeWad; uint64 openTime; uint64 expiry; uint32 window; uint32 cutoffBuffer; uint32 nSamples; uint256 budget; QuoteParams quote; uint8 sigmaMode; uint256 fixedVarE36; uint8 kernel; string yesName; string yesSymbol; string noName; string noSymbol; }",
  "struct MarketInfo { address yes; address no; address oracle; int256 lnStrikeWad; uint64 openTime; uint64 expiry; uint32 window; uint32 cutoffBuffer; uint8 status; bool yesWon; uint256 bucket; uint256 outYes; uint256 outNo; uint256 invYes; uint256 invNo; }",
  "function createMarket(MarketParams p) returns (uint256 marketId)",
  "function settle(uint256 marketId)",
  "function settleInvalid(uint256 marketId)",
  "function sweep(uint256 marketId) returns (uint256 amount)",
  "function marketInfo(uint256 marketId) view returns (MarketInfo)",
  "function marketCount() view returns (uint256)",
  "function vaultIdle() view returns (uint256)",
  "function usdc() view returns (address)",
  "event MarketCreated(uint256 indexed marketId, address yes, address no, bytes32 yesPoolId, bytes32 noPoolId, int256 lnStrikeWad, uint64 expiry)",
  "event MarketSettled(uint256 indexed marketId, bool yesWon, int256 avgNormTickTimesWindow, bool invalid)",
  "event Swept(uint256 indexed marketId, uint256 amount)",
]);

/** Subset of src/interfaces/IMarketScheduler.sol used by the keeper: it opens markets by calling `open()`. */
export const marketSchedulerAbi = parseAbi([
  "function open() returns (uint256 marketId)",
  "function canOpen() view returns (bool)",
  "function nextOpenTime() view returns (uint256)",
  "function openDeadline(uint256 slot) view returns (uint256)",
  "function lastSlot() view returns (uint256)",
  "function marketOfSlot(uint256 slot) view returns (uint256)",
  "function hook() view returns (address)",
  "function gatekeeper() view returns (address)",
  "function oracle() view returns (address)",
  "function config() view returns ((uint32 period, uint32 tenor, uint32 window, uint32 cutoffBuffer, uint32 nSamples, (uint64 h0Wad, uint64 gammaSWad, uint128 lambdaWad, uint128 qEpochMax, uint64 pMinWad) quote, uint256 maxBudget, uint256 minBudget, string ticker) c)",
  "error AlreadyOpened(uint256 slot)",
  "error TooLate(uint256 slot)",
  "error InsufficientIdle(uint256 budget, uint256 minBudget)",
  "error InvalidConfig()",
  "event MarketOpened(uint256 indexed marketId, uint256 indexed slot, address indexed caller, uint256 budget, uint256 strikeCents)",
]);

/** Subset of src/interfaces/IMarketGatekeeper.sol, the hook's owner that forwards `createMarket` from its schedulers */
export const marketGatekeeperAbi = parseAbi([
  "function hook() view returns (address)",
  "function schedulers() view returns (address[])",
  "function schedulerCount() view returns (uint256)",
  "function isScheduler(address account) view returns (bool)",
  "function schedulerOf(uint256 marketId) view returns (address)",
  "error NotScheduler()",
  "error InvalidTracks()",
]);

/** PredictionHook's custom errors, so a revert inside `open()` or a stale-RPC `NotSettled` on sweep decodes by name */
export const predictionHookErrorsAbi = parseAbi([
  "error Unauthorized()",
  "error InvalidParams()",
  "error UnsupportedKernel()",
  "error UnknownMarket()",
  "error UnknownPool()",
  "error NotTradable()",
  "error MarketClosed()",
  "error NotSettled()",
  "error TooEarly()",
  "error OracleAvailable()",
  "error OutOfBand()",
  "error EpochCapExceeded()",
  "error Insolvent()",
  "error ZeroAmount()",
  "error InsufficientIdle()",
  "error InsufficientShares()",
  "error ForeignInitialize()",
  "error LiquidityDisabled()",
  "error DonateDisabled()",
]);

/** PredictionHook views outside the frozen interface (owner/keeper roles, the settleInvalid grace period). */
export const predictionHookAdminAbi = parseAbi([
  "function owner() view returns (address)",
  "function keeper() view returns (address)",
  "function GRACE() view returns (uint256)",
]);

/** Subset of src/interfaces/IUnderlyingOracle.sol. */
export const underlyingOracleAbi = parseAbi([
  "function lnSpotSoBWad() view returns (int256)",
  "function sobTick() view returns (int24 normTick, uint32 lastWriteTime)",
  "function varianceE36() view returns (uint256 varPerSecE36, bool warm)",
  "function decimalsShift() view returns (int16)",
]);

/** UnderlyingOracleHook view outside IUnderlyingOracle: the pool it is bound to. */
export const underlyingOracleHookAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function poolKey() view returns (PoolKey)",
]);

/** src/demo/PriceSteerer.sol. */
export const priceSteererAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function steer(PoolKey key, uint160 targetSqrtPriceX96) returns (int256 delta)",
  "function addLiquidity(PoolKey key, int24 tickLower, int24 tickUpper, uint128 liquidity) returns (int256)",
  "function addLiquidityFullRange(PoolKey key, uint128 liquidity) returns (int256)",
  "function owner() view returns (address)",
  "function poolManager() view returns (address)",
  "event Steered(bytes32 indexed id, uint160 fromSqrtPriceX96, uint160 toSqrtPriceX96, int128 amount0, int128 amount1)",
  "error TargetOutOfRange(uint160 targetSqrtPriceX96)",
  "error NativeCurrencyUnsupported()",
  "error Unauthorized()",
]);

export const poolManagerAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

/** Subset of src/interfaces/ISealedPoolOracle.sol used by the sealed bot */
export const sealedPoolOracleAbi = parseAbi([
  "struct BlockProof { bytes header; bytes[] accountProof; bytes[] slotProof; }",
  "function poke() returns (bool sealedRun)",
  "function prove(BlockProof p)",
  "function proveMany(BlockProof[] ps)",
  "function frontier() view returns (uint256)",
  "function snapshot() view returns (uint64 blockNumber, uint160 sqrtPriceX96, uint256 fg0, uint256 fg1, uint128 liquidity)",
  "function queueLength() view returns (uint256)",
  "function blockTimeOf(uint256 n) view returns (uint32)",
  "function oldestObservationTime() view returns (uint32)",
  "error NotNextBlock(uint256 expected, uint256 got)",
  "error BadTimestamp(uint256 expected, uint256 got)",
  "error StaleSpot(uint256 frontier, uint256 blockNumber)",
  "error NotStarted()",
  "error InvalidPool()",
  "event Sealed(uint256 fromBlock, uint256 toBlock, int24 normTick)",
  "event Queued(uint256 fromBlock, uint256 toBlock)",
  "event Proven(uint256 blockNumber, int24 normTick)",
]);

/** SealedPoolOracle outside the interface, its pool, the BlockHashes checkpoints and the proof errors */
export const sealedPoolOracleImplAbi = parseAbi([
  "function poolManager() view returns (address)",
  "function poolId() view returns (bytes32)",
  "function blockHashOf(uint256 n) view returns (bytes32 hash)",
  "function checkpointHeaders(bytes[] headersNewestFirst)",
  "error UnknownBlockHash(uint256 n)",
  "error BadHeader()",
  "error BadAccountProof()",
  "error BadStorageProof()",
  "error BlockTimeOutOfRange(uint256 n)",
  "event HeadersCheckpointed(uint256 oldest, uint256 newest)",
]);

export const MarketStatus = { None: 0, Trading: 1, Settled: 2, Invalid: 3 } as const;
