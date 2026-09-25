import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Hex } from "viem";
import { REPO_DIR } from "../../src/config.ts";

export const OUT_DIR = resolve(REPO_DIR, "out");

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

export function artifactPath(file: string, contract: string): string {
  return resolve(OUT_DIR, file, `${contract}.json`);
}

/** Forge artifact, or undefined when `forge build` has not been run. */
export function loadArtifact(file: string, contract: string): Artifact | undefined {
  const p = artifactPath(file, contract);
  if (!existsSync(p)) return undefined;
  const json = JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}
