import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createPublicClient, fromRlp, http, keccak256, type Hex, type RpcBlock } from "viem";
import { BOT_DIR, REPO_DIR } from "../src/config.ts";
import { encodeHeader, getRpcBlock, verifiedHeader } from "../src/header.ts";

const OFFLINE = process.env.OFFLINE === "1";

/** Task 6 fixture with `cast block 59663450 --raw` on Unichain mainnet and its hash */
const FIXTURE = JSON.parse(
  readFileSync(resolve(REPO_DIR, "test", "vectors", "unichain", "pool-proof-59663450.json"), "utf8"),
) as { number: number; blockHash: Hex; header: Hex };

/** eth_getBlockByNumber("0x38e645a", false) from https://mainnet.unichain.org without transactions */
const BLOCK = JSON.parse(readFileSync(resolve(BOT_DIR, "test", "vectors", "unichain-block-59663450.json"), "utf8")) as RpcBlock;

const OPTIONAL = ["baseFeePerGas", "withdrawalsRoot", "blobGasUsed", "excessBlobGas", "parentBeaconBlockRoot", "requestsHash"] as const;

function without(block: RpcBlock, ...keys: string[]): RpcBlock {
  const copy: Record<string, unknown> = { ...block };
  for (const k of keys) delete copy[k];
  return copy as unknown as RpcBlock;
}

test("encodeHeader equals `cast block --raw` for the Task 6 fixture block (offline)", () => {
  assert.equal(BLOCK.hash, FIXTURE.blockHash);
  assert.equal(BigInt(BLOCK.number!), BigInt(FIXTURE.number));
  const rlp = encodeHeader(BLOCK);
  assert.equal(rlp, FIXTURE.header);
  assert.equal(keccak256(rlp), FIXTURE.blockHash);
  assert.equal((fromRlp(rlp, "hex") as Hex[]).length, 21, "all 21 Isthmus fields");
});

test("encodeHeader omits trailing fields the block lacks and refuses a gap", () => {
  for (let i = 0; i <= OPTIONAL.length; i++) {
    const dropped = OPTIONAL.slice(OPTIONAL.length - i);
    const fields = fromRlp(encodeHeader(without(BLOCK, ...dropped)), "hex") as Hex[];
    assert.equal(fields.length, 21 - i, `without ${dropped.join(", ") || "nothing"}`);
  }
  const nulled = { ...BLOCK, requestsHash: null } as unknown as RpcBlock;
  assert.equal((fromRlp(encodeHeader(nulled), "hex") as Hex[]).length, 20, "null counts as absent");
  assert.throws(() => encodeHeader(without(BLOCK, "parentBeaconBlockRoot")), /requestsHash.*parentBeaconBlockRoot/);
  assert.throws(() => encodeHeader(without(BLOCK, "stateRoot")), /stateRoot/);
});

test("encodeHeader writes quantities minimally and fixed-size fields at their size", () => {
  const fields = fromRlp(encodeHeader(BLOCK), "hex") as Hex[];
  assert.equal(fields[7], "0x", "difficulty 0 is the empty string");
  assert.equal(fields[8], "0x038e645a", "number");
  assert.equal(fields[14], "0x0000000000000000", "nonce keeps its 8 bytes");
  assert.equal(fields[15], "0x07a120", "baseFeePerGas");
  assert.equal(fields[18], "0x", "excessBlobGas 0");
  const odd = fromRlp(encodeHeader({ ...BLOCK, gasUsed: "0x00958a8", nonce: "0x0" } as RpcBlock), "hex") as Hex[];
  assert.equal(odd[10], "0x0958a8", "leading zeros stripped, odd length padded");
  assert.equal(odd[14], "0x0000000000000000", "short nonce padded to 8 bytes");
  assert.throws(() => encodeHeader({ ...BLOCK, stateRoot: `${BLOCK.stateRoot}00` } as RpcBlock), /stateRoot/);
});

test("verifiedHeader throws when the rebuilt header does not hash to the block hash", async () => {
  const fake = (block: RpcBlock) => ({ request: async () => block }) as unknown as Parameters<typeof verifiedHeader>[0];
  const ok = await verifiedHeader(fake(BLOCK), BigInt(FIXTURE.number));
  assert.equal(ok.header, FIXTURE.header);
  assert.equal(ok.hash, FIXTURE.blockHash);
  await assert.rejects(verifiedHeader(fake({ ...BLOCK, gasUsed: "0x1" } as RpcBlock), BigInt(FIXTURE.number)), /does not hash to/);
  await assert.rejects(verifiedHeader(fake(BLOCK), BigInt(FIXTURE.number) + 1n), /asked for block/);
});

const LIVE = [
  { name: "Unichain mainnet", url: "https://mainnet.unichain.org", chainId: 130 },
  { name: "Unichain Sepolia", url: "https://sepolia.unichain.org", chainId: 1301 },
];

for (const net of LIVE) {
  test(`keccak256(encodeHeader(block)) is the hash of 5 recent ${net.name} blocks`, { skip: OFFLINE && "OFFLINE=1" }, async () => {
    const client = createPublicClient({ transport: http(net.url, { retryCount: 3, timeout: 15_000 }) });
    assert.equal(await client.getChainId(), net.chainId);
    const head = await client.getBlockNumber();
    const blocks = await Promise.all([1n, 2n, 3n, 4n, 5n].map((i) => getRpcBlock(client, head - i)));
    for (const block of blocks) {
      assert.equal(keccak256(encodeHeader(block)), block.hash, `${net.name} block ${BigInt(block.number!)}`);
    }
  });
}
