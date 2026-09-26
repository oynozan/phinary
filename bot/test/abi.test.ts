import assert from "node:assert/strict";
import { test } from "node:test";
import type { Abi, AbiParameter } from "viem";
import {
  marketSchedulerAbi,
  poolManagerAbi,
  predictionHookAbi,
  predictionHookAdminAbi,
  priceSteererAbi,
  sealedPoolOracleAbi,
  sealedPoolOracleImplAbi,
  underlyingOracleAbi,
  underlyingOracleHookAbi,
} from "../src/abi.ts";
import { loadArtifact } from "./helpers/artifacts.ts";

function shape(params: readonly AbiParameter[] | undefined): unknown {
  return (params ?? []).map((p) => {
    const c = (p as { components?: readonly AbiParameter[] }).components;
    const indexed = (p as { indexed?: boolean }).indexed;
    return { type: p.type, ...(c ? { components: shape(c) } : {}), ...(indexed ? { indexed } : {}) };
  });
}

type Item = { type: string; name?: string; inputs?: readonly AbiParameter[]; outputs?: readonly AbiParameter[]; stateMutability?: string };

function assertSubset(ours: Abi, file: string, contract: string) {
  const art = loadArtifact(file, contract);
  if (!art) return false;
  const theirs = art.abi as readonly Item[];
  for (const item of ours as readonly Item[]) {
    if (!("name" in item) || !item.name) continue;
    const match = theirs.find((t) => t.type === item.type && t.name === item.name);
    assert.ok(match, `${contract} has no ${item.type} ${item.name}`);
    assert.deepEqual(shape(item.inputs), shape(match.inputs), `${contract}.${item.name} inputs`);
    if (item.type === "function") {
      assert.deepEqual(shape(item.outputs), shape(match.outputs), `${contract}.${item.name} outputs`);
      assert.equal(item.stateMutability, match.stateMutability, `${contract}.${item.name} mutability`);
    }
  }
  return true;
}

test("TypeScript ABIs match the Solidity sources (forge artifacts)", (t) => {
  const checked = [
    assertSubset(predictionHookAbi, "IPredictionHook.sol", "IPredictionHook"),
    assertSubset(underlyingOracleAbi, "IUnderlyingOracle.sol", "IUnderlyingOracle"),
    assertSubset(priceSteererAbi, "PriceSteerer.sol", "PriceSteerer"),
    assertSubset(poolManagerAbi, "PoolManager.sol", "PoolManager"),
    assertSubset(marketSchedulerAbi, "IMarketScheduler.sol", "IMarketScheduler"),
    assertSubset(sealedPoolOracleAbi, "ISealedPoolOracle.sol", "ISealedPoolOracle"),
    assertSubset(sealedPoolOracleImplAbi, "SealedPoolOracle.sol", "SealedPoolOracle"),
  ];
  if (checked.some((c) => !c)) t.skip("run `forge build` in the repo root to check every ABI");
});

test("implementation-only ABIs match PredictionHook and UnderlyingOracleHook when they are built", (t) => {
  const checked = [
    assertSubset(predictionHookAdminAbi, "PredictionHook.sol", "PredictionHook"),
    assertSubset(underlyingOracleHookAbi, "UnderlyingOracleHook.sol", "UnderlyingOracleHook"),
    assertSubset(underlyingOracleHookAbi, "MockSobHook.sol", "MockSobHook"),
  ];
  if (checked.some((c) => !c)) t.diagnostic("PredictionHook or UnderlyingOracleHook is not in this build; not checked");
});
