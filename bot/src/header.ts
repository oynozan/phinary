import { keccak256, pad, size, toHex, toRlp, type Hash, type Hex, type PublicClient, type RpcBlock } from "viem";

type Kind = "quantity" | "bytes" | number;

/** Header fields in RLP order, each a quantity, raw bytes or bytes of a fixed size */
const REQUIRED: readonly (readonly [string, Kind])[] = [
  ["parentHash", 32],
  ["sha3Uncles", 32],
  ["miner", 20],
  ["stateRoot", 32],
  ["transactionsRoot", 32],
  ["receiptsRoot", 32],
  ["logsBloom", 256],
  ["difficulty", "quantity"],
  ["number", "quantity"],
  ["gasLimit", "quantity"],
  ["gasUsed", "quantity"],
  ["timestamp", "quantity"],
  ["extraData", "bytes"],
  ["mixHash", 32],
  ["nonce", 8],
];

/** Fields added by London, Shanghai, Cancun and Prague (Isthmus), which older blocks lack */
const OPTIONAL: readonly (readonly [string, Kind])[] = [
  ["baseFeePerGas", "quantity"],
  ["withdrawalsRoot", 32],
  ["blobGasUsed", "quantity"],
  ["excessBlobGas", "quantity"],
  ["parentBeaconBlockRoot", 32],
  ["requestsHash", 32],
];

function field(name: string, kind: Kind, value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`block ${name} is not hex`);
  const hex = value as Hex;
  if (kind === "quantity") {
    const n = BigInt(hex);
    if (n === 0n) return "0x";
    const digits = n.toString(16);
    return `0x${digits.length % 2 ? "0" : ""}${digits}`;
  }
  const even: Hex = hex.length % 2 ? `0x0${hex.slice(2)}` : hex;
  if (kind === "bytes") return even;
  if (size(even) > kind) throw new Error(`block ${name} is longer than ${kind} bytes`);
  return pad(even, { size: kind });
}

/** RLP header as the chain hashes it, the 21 Isthmus fields minus trailing ones the block lacks */
export function encodeHeader(block: RpcBlock): Hex {
  const b = block as unknown as Record<string, unknown>;
  const has = (k: string) => b[k] !== undefined && b[k] !== null;
  const fields = REQUIRED.map(([name, kind]) => {
    if (!has(name)) throw new Error(`block has no ${name}`);
    return field(name, kind, b[name]);
  });
  let missing: string | undefined;
  for (const [name, kind] of OPTIONAL) {
    if (!has(name)) {
      missing ??= name;
      continue;
    }
    if (missing) throw new Error(`block has ${name} but no ${missing}`);
    fields.push(field(name, kind, b[name]));
  }
  return toRlp(fields);
}

type RequestClient = Pick<PublicClient, "request">;

/** Raw JSON-RPC block without transactions, so header fields keep their hex encoding */
export async function getRpcBlock(client: RequestClient, n: bigint): Promise<RpcBlock> {
  const block = (await client.request({ method: "eth_getBlockByNumber", params: [toHex(n), false] })) as RpcBlock | null;
  if (!block) throw new Error(`block ${n} not found`);
  return block;
}

export interface VerifiedHeader {
  block: RpcBlock;
  /** RLP header whose keccak256 is `hash` */
  header: Hex;
  hash: Hash;
}

/** Block `n` and its rebuilt header, which must hash to the block hash the RPC reported */
export async function verifiedHeader(client: RequestClient, n: bigint): Promise<VerifiedHeader> {
  const block = await getRpcBlock(client, n);
  if (block.number === null || BigInt(block.number) !== n) throw new Error(`asked for block ${n}, got ${block.number}`);
  const header = encodeHeader(block);
  const hash = keccak256(header);
  if (block.hash === null || hash !== block.hash.toLowerCase()) {
    throw new Error(`rebuilt header of block ${n} does not hash to ${block.hash} (got ${hash})`);
  }
  return { block, header, hash };
}
