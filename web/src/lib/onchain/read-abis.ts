import { parseAbi } from "viem";

// Read-only subsets of the repository's Solidity interfaces.
export const underlyingOracleAbi = parseAbi([
    "function lnSpotSoBWad() view returns (int256)",
    "function varianceE36() view returns (uint256 varPerSecE36, bool warm)",
]);
export const schedulerReadAbi = parseAbi([
    "function hook() view returns (address)",
    "function oracle() view returns (address)",
    "function canOpen() view returns (bool)",
    "function nextOpenTime() view returns (uint256)",
]);
export const hookOwnershipAbi = parseAbi([
    "function owner() view returns (address)",
    "function keeper() view returns (address)",
]);
