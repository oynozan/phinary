#!/usr/bin/env bash
# Writes test/vectors/unichain/pool-proof-<block>.json with a Unichain mainnet block header, its two parent headers, an
# eth_getProof of the deep hookless ETH/USDC v4 pool's slot0, and StateView's getSlot0 at that block to check it against.
#
#   script/fixtures/unichain-proof.sh <block>
#
# The RPC is UNICHAIN_RPC_URL, by default https://mainnet.unichain.org. Public endpoints only prove recent state, so run it
# for blocks a few dozen behind the head. It is read-only and needs no keys.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="$PATH:$HOME/.foundry/bin"
RPC="${UNICHAIN_RPC_URL:-https://mainnet.unichain.org}"
BLOCK="${1:?usage: unichain-proof.sh <block>}"

POOL_MANAGER=0x1F98400000000000000000000000000000000004
STATE_VIEW=0x86e8631a016f9068c3f085faf484ee3f5fdee8f2
POOL_ID=0x3258f413c7a88cda2fa8709a589d221a80f6574f63df5a5b6774485d8acc39d9
POOLS_SLOT=0x0000000000000000000000000000000000000000000000000000000000000006

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

[[ "$(cast chain-id --rpc-url "$RPC")" == "130" ]] || die "RPC is not Unichain mainnet (chain 130)"

# StateLibrary puts pools[poolId] at keccak256(poolId . 6), and slot0 is its first word
SLOT="$(cast keccak "$(cast concat-hex "$POOL_ID" "$POOLS_SLOT")")"

raw_header() {
  local n="$1" raw hash
  raw="$(cast block "$n" --raw --rpc-url "$RPC")"
  hash="$(cast block "$n" -f hash --rpc-url "$RPC")"
  [[ "$(cast keccak "$raw")" == "$hash" ]] || die "keccak(raw header) != hash for block $n"
  printf '%s' "$raw"
}

# Public endpoints balance across nodes with different proof windows, so a refusal is retried
pool_proof() {
  local tries=0
  until cast rpc eth_getProof "$POOL_MANAGER" "[\"$SLOT\"]" "$(cast to-hex "$BLOCK")" --rpc-url "$RPC" 2>/dev/null; do
    tries=$((tries + 1))
    ((tries < 30)) || die "eth_getProof for block $BLOCK refused 30 times"
    sleep 0.5
  done
}

# Newer cast wraps --json output in {"schema_version", "success", "data"}
unwrap() { jq 'if type == "object" and has("data") then .data else . end'; }

BLOCK_JSON="$(cast block "$BLOCK" --json --rpc-url "$RPC" | unwrap)"
HEADER="$(raw_header "$BLOCK")"
PARENT_1="$(raw_header "$((BLOCK - 1))")"
PARENT_2="$(raw_header "$((BLOCK - 2))")"
PROOF="$(pool_proof)"
SLOT0="$(cast call "$STATE_VIEW" 'getSlot0(bytes32)(uint160,int24,uint24,uint24)' "$POOL_ID" --block "$BLOCK" --json \
  --rpc-url "$RPC" | unwrap)"

[[ "$(jq -r '.storageProof[0].key' <<<"$PROOF")" == "$SLOT" ]] || die "storage proof key mismatch"

OUT_DIR="$ROOT/test/vectors/unichain"
OUT="$OUT_DIR/pool-proof-$BLOCK.json"
mkdir -p "$OUT_DIR"

jq -n \
  --argjson number "$BLOCK" \
  --argjson timestamp "$(cast to-dec "$(jq -r '.timestamp' <<<"$BLOCK_JSON")")" \
  --arg blockHash "$(jq -r '.hash' <<<"$BLOCK_JSON")" \
  --arg parentHash "$(jq -r '.parentHash' <<<"$BLOCK_JSON")" \
  --arg stateRoot "$(jq -r '.stateRoot' <<<"$BLOCK_JSON")" \
  --arg header "$HEADER" \
  --arg parent1 "$PARENT_1" \
  --arg parent2 "$PARENT_2" \
  --arg poolManager "$POOL_MANAGER" \
  --arg poolId "$POOL_ID" \
  --arg slot "$SLOT" \
  --argjson proof "$PROOF" \
  --argjson slot0 "$SLOT0" \
  '{
    number: $number,
    timestamp: $timestamp,
    blockHash: $blockHash,
    parentHash: $parentHash,
    stateRoot: $stateRoot,
    header: $header,
    ancestorHeaders: [$parent1, $parent2],
    poolManager: $poolManager,
    poolId: $poolId,
    slot: $slot,
    storageHash: $proof.storageHash,
    slotValue: $proof.storageProof[0].value,
    accountProof: $proof.accountProof,
    slotProof: $proof.storageProof[0].proof,
    sqrtPriceX96: $slot0[0],
    tick: ($slot0[1] | tonumber)
  }' >"$OUT"

printf 'wrote %s (sqrtPriceX96 %s, tick %s)\n' "${OUT#"$ROOT"/}" "$(jq -r '.sqrtPriceX96' "$OUT")" "$(jq -r '.tick' "$OUT")"
