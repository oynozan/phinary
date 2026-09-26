import { keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { sealedPoolOracleImplAbi } from "./abi.ts";
import { sleep } from "./chain.ts";
import { verifiedHeader } from "./header.ts";
import { poolStateSlot } from "./pricing.ts";

/** EIP-2935 history contract, which BlockHashes reads past BLOCKHASH's 256 blocks */
export const HISTORY_ADDRESS: Address = "0x0000F90827F1C53a10cb7A02335B175320002935";

/** ISealedPoolOracle.BlockProof, an RLP header with the PoolManager account and slot0 storage proofs */
export interface BlockProof {
  header: Hex;
  accountProof: readonly Hex[];
  slotProof: readonly Hex[];
}

/** The pool a SealedPoolOracle reads */
export interface OracleTarget {
  poolManager: Address;
  poolId: Hex;
}

export type Reader = Pick<PublicClient, "request">;
/** One RPC, or a primary followed by fallbacks */
export type Readers = Reader | readonly Reader[];

export interface RetryOptions {
  /** Total tries across all readers, by default 4 or 2 per reader */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function readOracleTarget(client: PublicClient, oracle: Address): Promise<OracleTarget> {
  const [poolManager, poolId] = await Promise.all([
    client.readContract({ address: oracle, abi: sealedPoolOracleImplAbi, functionName: "poolManager" }),
    client.readContract({ address: oracle, abi: sealedPoolOracleImplAbi, functionName: "poolId" }),
  ]);
  return { poolManager, poolId };
}

/** Tries each reader in turn with backoff, public endpoints often answer a second try from another node */
export async function withFallback<T>(readers: Readers, fn: (r: Reader) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const list: readonly Reader[] = "request" in readers ? [readers] : readers;
  if (list.length === 0) throw new Error("no RPC to read from");
  const attempts = opts.attempts ?? Math.max(4, 2 * list.length);
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 4000;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(list[i % list.length]!);
    } catch (e) {
      last = e;
    }
    if (i + 1 < attempts) await sleep(Math.min(max, base * 2 ** Math.floor(i / list.length)));
  }
  throw last;
}

interface RpcProof {
  accountProof: Hex[];
  storageHash: Hex;
  storageProof: { key: Hex; value: Hex; proof: Hex[] }[];
}

/** Proof of `pools[poolId].slot0` at the end of `block`, each part checked against its root before it is used */
export async function buildBlockProof(
  client: Readers,
  oracle: OracleTarget,
  block: bigint,
  opts: RetryOptions = {},
): Promise<BlockProof> {
  const slot = poolStateSlot(oracle.poolId);
  return withFallback(
    client,
    async (r) => {
      const { block: b, header } = await verifiedHeader(r, block);
      const proof = (await r.request({
        method: "eth_getProof",
        params: [oracle.poolManager, [slot], toHex(block)],
      })) as RpcProof;
      const [first] = proof.accountProof;
      if (!first || keccak256(first) !== b.stateRoot.toLowerCase()) {
        throw new Error(`block ${block}: account proof does not start at the state root`);
      }
      const sp = proof.storageProof[0];
      if (!sp || BigInt(sp.key) !== BigInt(slot)) throw new Error(`block ${block}: no storage proof for slot0`);
      if (!sp.proof[0] || keccak256(sp.proof[0]) !== proof.storageHash.toLowerCase()) {
        throw new Error(`block ${block}: slot proof does not start at the storage root`);
      }
      if (BigInt(sp.value) === 0n) throw new Error(`block ${block}: pool is not initialized`);
      return { header, accountProof: proof.accountProof, slotProof: sp.proof };
    },
    opts,
  );
}
