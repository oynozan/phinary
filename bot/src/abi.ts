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
  "function lastSlot() view returns (uint256)",
  "function hook() view returns (address)",
  "function oracle() view returns (address)",
  "error AlreadyOpened(uint256 slot)",
  "error InsufficientIdle(uint256 budget, uint256 minBudget)",
  "error InvalidConfig()",
  "event MarketOpened(uint256 indexed marketId, uint256 indexed slot, address indexed caller, uint256 budget, uint256 strikeCents)",
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

export const MarketStatus = { None: 0, Trading: 1, Settled: 2, Invalid: 3 } as const;
