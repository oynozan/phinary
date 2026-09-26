#!/usr/bin/env bash
# Local demo environment on an anvil fork of Unichain Sepolia (chain id stays 1301).
#
#   1. anvil --fork-url $FORK_URL --block-time 1 --port $LOCAL_PORT (log and pid in deployments/.run/local/)
#   2. gives the deployer and local keeper and mirror accounts ETH, and the deployer Circle USDC (FiatToken balance slot)
#   3. forge script Deploy (at the live ETH price, with the MarketScheduler that owns the hook) and Fund ($FUND_USDC
#      into the hook vault) -> deployments/local.json
#   4. hands the PriceSteerer to the local mirror key, then starts the mirror and the keeper, which calls open()
#
# Stop everything with script/local-env-stop.sh. Nothing is sent to the real network: every transaction goes to anvil.
# Settings: LOCAL_PORT (8545), FORK_URL, FORK_BLOCK, FUND_USDC (500), DEPLOYER_USDC (10000), ETH_PRICE_USD (live
# Coinbase/Kraken price, else 2700), START_BOTS (1). The scheduler's SCHEDULER_*, MARKET_* and QUOTE_* settings pass
# through to Deploy (docs/md/RUNBOOK.md section 3).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$PATH:$HOME/.foundry/bin"

PORT="${LOCAL_PORT:-8545}"
RPC="http://127.0.0.1:$PORT"
FORK_URL="${FORK_URL:-https://sepolia.unichain.org}"
RUN="$ROOT/deployments/.run/local"
DEPLOYMENTS="$ROOT/deployments/local.json"
FUND_USDC="${FUND_USDC:-500}"
USDC=0x31d0220469e10c4E71834a79b1f276d740d3768F
# FiatToken v2.2 keeps balances in balanceAndBlacklistStates, storage slot 9
USDC_BALANCE_SLOT=9
# anvil account 0, used only when neither the environment nor .env has a deployer key
ANVIL_KEY_0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

log() { printf '\033[1m[local-env]\033[0m %s\n' "$*"; }
die() {
  printf '[local-env] error: %s\n' "$*" >&2
  exit 1
}

env_value() {
  [[ -f "$ROOT/.env" ]] || return 0
  sed -n "s/^$1=//p" "$ROOT/.env" | tail -n 1 | tr -d '"'"'"
}

usdc() {
  awk -v x="$1" 'BEGIN { printf "%.2f", x / 1e6 }'
}

usdc_units() {
  awk -v x="$1" 'BEGIN { if (x !~ /^[0-9]+(\.[0-9]+)?$/) exit 1; printf "%.0f", x * 1000000 }'
}

json() {
  node -e 'const d = require(process.argv[1]); console.log(process.argv[2].split(".").reduce((o, k) => o[k], d))' \
    "$DEPLOYMENTS" "$1"
}

command -v anvil >/dev/null && command -v forge >/dev/null && command -v cast >/dev/null ||
  die "foundry (anvil, forge, cast) not found in PATH or ~/.foundry/bin"
command -v node >/dev/null || die "node (>= 24) not found"
mkdir -p "$RUN"

if [[ -f "$RUN/anvil.pid" ]] && kill -0 "$(cat "$RUN/anvil.pid")" 2>/dev/null; then
  die "anvil already running (pid $(cat "$RUN/anvil.pid")), run script/local-env-stop.sh first"
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is in use by another process"
fi

# Signers: the .env deployer (forge and the bots read .env themselves) and a throwaway keeper that exists only here
if [[ -z "${DEPLOYER_PRIVATE_KEY:-}" && -z "$(env_value DEPLOYER_PRIVATE_KEY)" ]]; then
  log "no DEPLOYER_PRIVATE_KEY in the environment or .env, using anvil account 0"
  export DEPLOYER_PRIVATE_KEY="$ANVIL_KEY_0"
  DEPLOYER="$(cast wallet address --private-key "$ANVIL_KEY_0")"
else
  DEPLOYER="${DEPLOYER_ADDRESS:-$(env_value DEPLOYER_ADDRESS)}"
  [[ -n "$DEPLOYER" ]] || die "set DEPLOYER_ADDRESS next to DEPLOYER_PRIVATE_KEY in .env"
fi
LOCAL_KEEPER_KEY="${LOCAL_KEEPER_KEY:-$(cast keccak "uniswap-prediction:local-keeper")}"
KEEPER="$(cast wallet address --private-key "$LOCAL_KEEPER_KEY")"
LOCAL_MIRROR_KEY="${LOCAL_MIRROR_KEY:-$(cast keccak "uniswap-prediction:local-mirror")}"
MIRROR="$(cast wallet address --private-key "$LOCAL_MIRROR_KEY")"

# Anvil

log "starting anvil (fork of $FORK_URL) on $RPC"
ANVIL_ARGS=(--fork-url "$FORK_URL" --block-time 1 --port "$PORT" --host 127.0.0.1)
if [[ -n "${FORK_BLOCK:-}" ]]; then ANVIL_ARGS+=(--fork-block-number "$FORK_BLOCK"); fi
nohup anvil "${ANVIL_ARGS[@]}" >"$RUN/anvil.log" 2>&1 &
echo $! >"$RUN/anvil.pid"
for _ in $(seq 1 90); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  kill -0 "$(cat "$RUN/anvil.pid")" 2>/dev/null || die "anvil exited, see $RUN/anvil.log"
  sleep 1
done
CHAIN_ID="$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" || die "anvil did not answer on $RPC, see $RUN/anvil.log"
[[ "$CHAIN_ID" == 1301 ]] || die "fork chain id is $CHAIN_ID, expected 1301"

# Balances

log "funding deployer $DEPLOYER, local keeper $KEEPER and local mirror $MIRROR with 100 ETH each"
for a in "$DEPLOYER" "$KEEPER" "$MIRROR"; do
  cast rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
done

DEPLOYER_USDC="${DEPLOYER_USDC:-10000}"
RAW_USDC="$(usdc_units "$DEPLOYER_USDC")" || die "DEPLOYER_USDC must be a decimal number"
cast rpc anvil_setStorageAt "$USDC" "$(cast index address "$DEPLOYER" "$USDC_BALANCE_SLOT")" \
  "$(cast to-uint256 "$RAW_USDC")" --rpc-url "$RPC" >/dev/null
GOT="$(cast call "$USDC" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
[[ "$GOT" == "$RAW_USDC" ]] || die "Circle USDC balance slot write failed (balanceOf=$GOT)"
log "deployer holds $DEPLOYER_USDC Circle USDC on the fork"

# Deploy and fund

PRICE="${ETH_PRICE_USD:-}"
if [[ -z "$PRICE" ]]; then
  PRICE="$(curl -fsS -m 5 https://api.coinbase.com/v2/prices/ETH-USD/spot 2>/dev/null |
    sed -nE 's/.*"amount":"([0-9]+(\.[0-9]+)?)".*/\1/p')" || true
fi
if [[ -z "$PRICE" ]]; then
  PRICE="$(curl -fsS -m 5 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD' 2>/dev/null |
    sed -nE 's/.*"c":\["([0-9]+(\.[0-9]+)?)".*/\1/p')" || true
fi
[[ "$PRICE" =~ ^[0-9]+(\.[0-9]+)?$ ]] || PRICE=2700
log "initial ETH price $PRICE USD"

log "forge build (log: $RUN/build.log)"
(cd "$ROOT" && forge build) >"$RUN/build.log" 2>&1 || die "forge build failed, see $RUN/build.log"

log "deploying (log: $RUN/deploy.log)"
(
  cd "$ROOT"
  NETWORK=local DEPLOYMENTS_FILE='' DEPLOYMENTS_RPC_URL="$RPC" ETH_PRICE_USD="$PRICE" KEEPER_ADDRESS="$KEEPER" \
    FOUNDRY_BROADCAST="$RUN/broadcast" forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast
) >"$RUN/deploy.log" 2>&1 || die "Deploy failed, see $RUN/deploy.log"
[[ -f "$DEPLOYMENTS" ]] || die "Deploy did not write $DEPLOYMENTS"
[[ "$(json deployer | tr 'A-F' 'a-f')" == "$(echo "$DEPLOYER" | tr 'A-F' 'a-f')" ]] ||
  die "DEPLOYER_ADDRESS does not match DEPLOYER_PRIVATE_KEY"

log "funding the vault with $FUND_USDC USDC (log: $RUN/fund.log)"
(
  cd "$ROOT"
  NETWORK=local DEPLOYMENTS_FILE='' FUND_USDC="$FUND_USDC" FOUNDRY_BROADCAST="$RUN/broadcast" \
    forge script script/Fund.s.sol:Fund --rpc-url "$RPC" --broadcast
) >"$RUN/fund.log" 2>&1 || die "Fund failed, see $RUN/fund.log"

HOOK="$(json predictionHook)"
IDLE="$(cast call "$HOOK" "vaultIdle()(uint256)" --rpc-url "$RPC" | awk '{print $1}')"
SCHEDULER="$(json marketScheduler)"
# config() is (period, tenor, window, cutoffBuffer, nSamples, (quote), maxBudget, minBudget, ticker)
SCHEDULER_CONFIG="$(cast call "$SCHEDULER" \
  "config()((uint32,uint32,uint32,uint32,uint32,(uint64,uint64,uint128,uint128,uint64),uint256,uint256,string))" \
  --rpc-url "$RPC")" || die "MarketScheduler config() read failed"
read -r PERIOD TENOR _ _ _ MAX_BUDGET MIN_BUDGET _ < <(
  sed -E 's/ \[[^]]*\]//g; s/, \([^()]*\)//' <<<"$SCHEDULER_CONFIG" | tr -d '()"' | tr ',' ' '
)

# The mirror gets its own signer so deployer-signed scripts (make market-local) never race it for nonces
STEERER="$(json priceSteerer)"
cast rpc anvil_impersonateAccount "$DEPLOYER" --rpc-url "$RPC" >/dev/null
cast send "$STEERER" "transferOwnership(address)" "$MIRROR" --unlocked --from "$DEPLOYER" --rpc-url "$RPC" >/dev/null
cast rpc anvil_stopImpersonatingAccount "$DEPLOYER" --rpc-url "$RPC" >/dev/null
[[ "$(cast call "$STEERER" "owner()(address)" --rpc-url "$RPC")" == "$MIRROR" ]] ||
  die "PriceSteerer ownership transfer to the local mirror signer failed"
log "PriceSteerer owner is now the local mirror signer $MIRROR"

# Bots

if [[ "${START_BOTS:-1}" == 1 ]]; then
  log "starting bots"
  : >"$RUN/mirror.log"
  : >"$RUN/keeper.log"
  RPC_URL="$RPC" MIRROR_PRIVATE_KEY="$LOCAL_MIRROR_KEY" KEEPER_PRIVATE_KEY="$LOCAL_KEEPER_KEY" \
    "$ROOT/script/bots.sh" start local
fi

cat <<SUMMARY

Local environment is up
  RPC               $RPC (chain 1301, anvil pid $(cat "$RUN/anvil.pid"), 1 s blocks)
  deployments       $DEPLOYMENTS
  PredictionHook    $HOOK (vault idle $(usdc "$IDLE") USDC)
  MarketScheduler   $SCHEDULER (owns the hook, no admin, open() is permissionless)
  UnderlyingOracle  $(json underlyingOracle)
  PriceSteerer      $(json priceSteerer)
  demo WETH, USDC   $(json demoWeth), $(json demoUsdc)
  deployer          $DEPLOYER (oracle owner, LP)
  keeper            $KEEPER (local-only key, calls open(), settle and sweep)
  mirror            $MIRROR (local-only key, PriceSteerer owner)
  logs              $RUN/{anvil,deploy,fund,mirror,keeper}.log

The keeper calls the scheduler's open() once per $PERIOD s slot of block time. Each market expires $TENOR s after its
slot starts, with a budget of min($(usdc "$MAX_BUDGET") USDC, vault idle / 2), and open() refuses below $(usdc "$MIN_BUDGET") USDC.
  script/bots.sh status local     bot state and last log lines
  script/bots.sh logs local       follow the bot logs
  make rehearse                   scripted Alice/Bob demo through UniversalRouter 2.0
  make local-stop                 stop the bots and anvil
SUMMARY
