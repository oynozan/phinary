#!/usr/bin/env bash
# Guarded broadcasts to the real Unichain Sepolia (chain 1301): deploy, fund the vault, create a one-off market, deploy
# the scheduler-owned hook, renounce the oracle, or add another underlying price source.
#
#   script/sepolia.sh deploy               Deploy.s.sol -> deployments/unichain-sepolia.json
#   script/sepolia.sh fund                 Fund.s.sol, FUND_USDC (default 20) of the deployer's Circle USDC into the vault
#   script/sepolia.sh market               CreateMarket.s.sol with the keeper defaults (MARKET_* and QUOTE_* env)
#   script/sepolia.sh scheduler            DeployScheduler.s.sol, a MarketScheduler and the new PredictionHook it owns,
#                                          then record() checks both on-chain and only then updates the deployments file
#   script/sepolia.sh renounce-oracle      RenounceOracle.s.sol, the UnderlyingOracleHook loses its owner (IRREVERSIBLE)
#   script/sepolia.sh underlying           DeployUnderlying.s.sol, UNDERLYING_SYMBOL's demo token, oracle and pool at
#                                          UNDERLYING_PRICE_USD (default the Coinbase spot), then record() appends it
#                                          to `underlyings` once checked on-chain
#   script/sepolia.sh seed-underlying      SeedUnderlying.s.sol, demoLiquidity into UNDERLYING_SYMBOL's pool from the
#                                          PriceSteerer, signed by its owner MIRROR_PRIVATE_KEY (pause the mirror bot)
#   script/sepolia.sh renounce-underlying  RenounceUnderlyingOracle.s.sol, the oracle of UNDERLYING_SYMBOL (or
#                                          UNDERLYING_ORACLE) loses its owner (IRREVERSIBLE)
#
# Each command checks the RPC (chain 1301, not anvil), shows the signer's balances, simulates the script, and only then
# asks for a typed confirmation before broadcasting (or takes CONFIRM=<command> for a non-interactive, explicit opt-in).
# It refuses to run when CI is set.
# RPC: UNICHAIN_SEPOLIA_RPC (from .env, default https://sepolia.unichain.org). Signer: DEPLOYER_PRIVATE_KEY in .env,
# MIRROR_PRIVATE_KEY for seed-underlying.
# ALLOW_ANVIL=1 with UNICHAIN_SEPOLIA_RPC=<anvil fork> rehearses this exact flow into deployments/sepolia-rehearsal.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$PATH:$HOME/.foundry/bin"
CMD="${1:-}"
USDC=0x31d0220469e10c4E71834a79b1f276d740d3768F
CREATE2_FACTORY=0x4e59b44847b379578588920cA78FbF26c0B4956C
MIN_ETH_WEI="${MIN_DEPLOYER_ETH_WEI:-1000000000000000}"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

env_value() {
  [[ -f "$ROOT/.env" ]] || return 0
  sed -n "s/^$1=//p" "$ROOT/.env" | tail -n 1 | tr -d '"'"'"
}

json_field() {
  sed -nE "s/.*\"$1\": \"([^\"]+)\".*/\1/p" "$2" | head -n 1
}

# After a failed scheduler broadcast or record, says what is on chain and how to finish, then exits
scheduler_recovery() {
  local what="$1" log="$2" pending="${DEPLOYMENTS%.json}.pending.json"
  local rpc_hint='--rpc-url "$UNICHAIN_SEPOLIA_RPC"'
  local rec="NETWORK=$NETWORK DEPLOYMENTS_FILE= forge script $SCRIPT --sig 'record()' $rpc_hint"
  echo >&2
  echo "$what. $DEPLOYMENTS is unchanged." >&2
  [[ -f "$pending" ]] || die "no staged pair at $pending, so nothing was deployed. Fix the error above and rerun script/sepolia.sh scheduler"
  local s h pm usdc salt s_code h_code
  s="$(json_field marketScheduler "$pending")"
  h="$(json_field predictionHook "$pending")"
  pm="$(json_field poolManager "$pending")"
  usdc="$(json_field usdc "$pending")"
  salt="$(sed -nE 's/.*hook salt: (0x[0-9a-fA-F]{64}).*/\1/p' "$log" 2>/dev/null | tail -n 1)"
  s_code="$(cast code "$s" --rpc-url "$RPC" 2>/dev/null)" || s_code=unknown
  h_code="$(cast code "$h" --rpc-url "$RPC" 2>/dev/null)" || h_code=unknown
  echo "Staged in $pending (UNICHAIN_SEPOLIA_RPC below is the RPC this run used):" >&2
  echo "  marketScheduler $s code $([[ "$s_code" == 0x ]] && echo none || echo "${s_code:0:10}...")" >&2
  echo "  predictionHook  $h code $([[ "$h_code" == 0x ]] && echo none || echo "${h_code:0:10}...")" >&2
  echo "  hook salt       ${salt:-not found, see the 'hook salt' line in $log}" >&2
  if [[ "$s_code" == unknown || "$h_code" == unknown ]]; then
    die "could not read the contract code, check both addresses by hand, then follow the matching case in script/sepolia.sh scheduler_recovery"
  elif [[ "$s_code" != 0x && "$h_code" != 0x ]]; then
    die "both contracts are on chain. Fix what the log reports if anything, then from $ROOT with the same env run: $rec"
  elif [[ "$s_code" == 0x && "$h_code" == 0x ]]; then
    die "neither contract is on chain. Delete $pending, check the signer nonce is settled, then rerun script/sepolia.sh scheduler"
  elif [[ "$s_code" != 0x ]]; then
    die "only the scheduler landed. Deploy its hook through the CREATE2 factory from $ROOT (any signer): cast send $CREATE2_FACTORY \"\$(cast concat-hex $salt \"\$(forge inspect src/PredictionHook.sol:PredictionHook bytecode)\" \"\$(cast abi-encode 'f(address,address,address)' $pm $usdc $s)\")\" --private-key \"\$DEPLOYER_PRIVATE_KEY\" $rpc_hint, check that $h now has code, then run: $rec"
  else
    die "only the hook landed and its owner $s can never be deployed now, so it is unusable. Delete $pending and rerun script/sepolia.sh scheduler"
  fi
}

# After a failed underlying broadcast or record, says what is on chain and how to finish, then exits
underlying_recovery() {
  local what="$1" pending="${DEPLOYMENTS%.json}.underlying.pending.json"
  local rec="NETWORK=$NETWORK DEPLOYMENTS_FILE= forge script $SCRIPT --sig 'record()' --rpc-url \"\$UNICHAIN_SEPOLIA_RPC\""
  echo >&2
  echo "$what. $DEPLOYMENTS is unchanged." >&2
  [[ -f "$pending" ]] || die "nothing was staged, so nothing was deployed. Fix the error above and rerun script/sepolia.sh underlying"
  local token oracle t_code o_code
  token="$(json_field token "$pending")"
  oracle="$(json_field oracle "$pending")"
  t_code="$(cast code "$token" --rpc-url "$RPC" 2>/dev/null)" || t_code=unknown
  o_code="$(cast code "$oracle" --rpc-url "$RPC" 2>/dev/null)" || o_code=unknown
  echo "Staged in $pending:" >&2
  echo "  token  $token code $([[ "$t_code" == 0x ]] && echo none || echo "${t_code:0:10}...")" >&2
  echo "  oracle $oracle code $([[ "$o_code" == 0x ]] && echo none || echo "${o_code:0:10}...")" >&2
  die "if all four transactions landed (token, oracle, pool initialise, setMinter), run from $ROOT with the same env: $rec. Otherwise delete $pending and rerun script/sepolia.sh underlying, a partial token or oracle just stays unused"
}

lower() {
  tr '[:upper:]' '[:lower:]' <<<"$1"
}

case "$CMD" in
  deploy) SCRIPT=script/Deploy.s.sol:Deploy ;;
  fund) SCRIPT=script/Fund.s.sol:Fund ;;
  market) SCRIPT=script/CreateMarket.s.sol:CreateMarket ;;
  scheduler) SCRIPT=script/DeployScheduler.s.sol:DeployScheduler ;;
  renounce-oracle) SCRIPT=script/RenounceOracle.s.sol:RenounceOracle ;;
  underlying) SCRIPT=script/DeployUnderlying.s.sol:DeployUnderlying ;;
  seed-underlying) SCRIPT=script/SeedUnderlying.s.sol:SeedUnderlying ;;
  renounce-underlying) SCRIPT=script/RenounceUnderlyingOracle.s.sol:RenounceUnderlyingOracle ;;
  *) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

[[ -z "${CI:-}" ]] || die "refusing to broadcast to Unichain Sepolia from CI"

RPC="${UNICHAIN_SEPOLIA_RPC:-$(env_value UNICHAIN_SEPOLIA_RPC)}"
RPC="${RPC:-https://sepolia.unichain.org}"
ROLE=DEPLOYER
if [[ "$CMD" == seed-underlying ]]; then ROLE=MIRROR; fi
ADDR_VAR="${ROLE}_ADDRESS"
KEY_VAR="${ROLE}_PRIVATE_KEY"
SIGNER="${!ADDR_VAR:-$(env_value "$ADDR_VAR")}"
[[ -n "$SIGNER" ]] || die "$ADDR_VAR is not set (.env)"
[[ -n "${!KEY_VAR:-}" || -n "$(env_value "$KEY_VAR")" ]] || die "$KEY_VAR is not set (.env)"

CHAIN_ID="$(cast chain-id --rpc-url "$RPC")" || die "cannot reach $RPC"
[[ "$CHAIN_ID" == 1301 ]] || die "$RPC is chain $CHAIN_ID, expected 1301"
CLIENT="$(cast rpc web3_clientVersion --rpc-url "$RPC" 2>/dev/null || true)"
ANVIL=0
if [[ "$CLIENT" == *anvil* ]]; then
  [[ "${ALLOW_ANVIL:-0}" == 1 ]] || die "$RPC is an anvil node; use make local-env for forks"
  ANVIL=1
fi
NETWORK=unichain-sepolia
if [[ "$ANVIL" == 1 ]]; then NETWORK=sepolia-rehearsal; fi
[[ "$ANVIL" == 1 || -t 0 || "${CONFIRM:-}" == "$CMD" ]] || die "refusing to broadcast without an interactive terminal (or CONFIRM=$CMD)"
DEPLOYMENTS="$ROOT/deployments/$NETWORK.json"
RUN="$ROOT/deployments/.run/$NETWORK"
mkdir -p "$RUN"

ETH_WEI="$(cast balance "$SIGNER" --rpc-url "$RPC")"
USDC_RAW="$(cast call "$USDC" "balanceOf(address)(uint256)" "$SIGNER" --rpc-url "$RPC" | awk '{print $1}')"
echo "Unichain Sepolia via $RPC$([[ "$ANVIL" == 1 ]] && echo " (anvil fork, writes $NETWORK.json)")"
echo "  signer   $SIGNER ($ROLE)"
echo "  ETH      $(cast from-wei "$ETH_WEI")"
echo "  USDC     $(awk -v x="$USDC_RAW" 'BEGIN { printf "%.2f", x / 1e6 }') (Circle)"
awk -v a="$ETH_WEI" -v b="$MIN_ETH_WEI" 'BEGIN { exit !(a + 0 >= b + 0) }' ||
  die "the signer needs at least $(cast from-wei "$MIN_ETH_WEI") ETH on Unichain Sepolia (bridge or faucet first)"

export NETWORK DEPLOYMENTS_FILE=''
case "$CMD" in
  deploy)
    if [[ -f "$DEPLOYMENTS" ]]; then
      echo "  note     $DEPLOYMENTS exists and will be overwritten by a fresh stack"
    fi
    if [[ -z "${ETH_PRICE_USD:-}" ]]; then
      ETH_PRICE_USD="$(curl -fsS -m 5 https://api.coinbase.com/v2/prices/ETH-USD/spot |
        sed -nE 's/.*"amount":"([0-9]+(\.[0-9]+)?)".*/\1/p')" || true
      [[ -n "$ETH_PRICE_USD" ]] || die "could not fetch the ETH price, set ETH_PRICE_USD"
    fi
    DEPLOYMENTS_RPC_URL="${DEPLOYMENTS_RPC_URL:-https://sepolia.unichain.org}"
    if [[ "$ANVIL" == 1 ]]; then DEPLOYMENTS_RPC_URL="$RPC"; fi
    export ETH_PRICE_USD DEPLOYMENTS_RPC_URL
    echo "  price    ETH_PRICE_USD=$ETH_PRICE_USD, keeper ${KEEPER_ADDRESS:-$SIGNER}"
    ;;
  fund)
    export FUND_USDC="${FUND_USDC:-20}"
    [[ -f "$DEPLOYMENTS" ]] || die "missing $DEPLOYMENTS, deploy first"
    echo "  deposit  $FUND_USDC USDC into $(sed -nE 's/.*"predictionHook": "([^"]+)".*/\1/p' "$DEPLOYMENTS")"
    ;;
  market)
    [[ -f "$DEPLOYMENTS" ]] || die "missing $DEPLOYMENTS, deploy first"
    ;;
  scheduler)
    [[ -f "$DEPLOYMENTS" ]] || die "missing $DEPLOYMENTS, deploy first"
    echo "  replaces predictionHook $(sed -nE 's/.*"predictionHook": "([^"]+)".*/\1/p' "$DEPLOYMENTS") (moves to legacyPredictionHooks)"
    echo "  note     stop the keeper first, no other signer transaction may land between the scheduler and the hook"
    ;;
  renounce-oracle)
    [[ -f "$DEPLOYMENTS" ]] || die "missing $DEPLOYMENTS, deploy first"
    echo "  oracle   $(sed -nE 's/.*"underlyingOracle": "([^"]+)".*/\1/p' "$DEPLOYMENTS") loses its owner for good (IRREVERSIBLE)"
    ;;
  underlying)
    [[ -f "$DEPLOYMENTS" ]] || die "missing $DEPLOYMENTS, deploy first"
    [[ -n "${UNDERLYING_SYMBOL:-}" ]] || die "set UNDERLYING_SYMBOL, e.g. UNDERLYING_SYMBOL=SOL"
    [[ ! -f "${DEPLOYMENTS%.json}.underlying.pending.json" ]] || underlying_recovery "A staged underlying awaits record()"
    if [[ -z "${UNDERLYING_PRICE_USD:-}" ]]; then
      UNDERLYING_PRICE_USD="$(curl -fsS -m 5 "https://api.coinbase.com/v2/prices/${UNDERLYING_SYMBOL}-USD/spot" |
        sed -nE 's/.*"amount":"([0-9]+(\.[0-9]+)?)".*/\1/p')" || true
      [[ -n "$UNDERLYING_PRICE_USD" ]] || die "could not fetch the $UNDERLYING_SYMBOL price, set UNDERLYING_PRICE_USD"
    fi
    export UNDERLYING_SYMBOL UNDERLYING_PRICE_USD
    echo "  new      $UNDERLYING_SYMBOL at $UNDERLYING_PRICE_USD USD as ${UNDERLYING_TOKEN_SYMBOL:-d$UNDERLYING_SYMBOL}, paired with demoUsdc $(json_field demoUsdc "$DEPLOYMENTS")"
    echo "  note     four transactions, no other transaction from $SIGNER may land in between"
    ;;
  seed-underlying)
    [[ -f "$DEPLOYMENTS" ]] || die "missing $DEPLOYMENTS, deploy first"
    [[ -n "${UNDERLYING_SYMBOL:-}" ]] || die "set UNDERLYING_SYMBOL, e.g. UNDERLYING_SYMBOL=SOL"
    STEERER="$(json_field priceSteerer "$DEPLOYMENTS")"
    OWNER="$(cast call "$STEERER" 'owner()(address)' --rpc-url "$RPC")" || die "cannot read the owner of PriceSteerer $STEERER"
    [[ "$(lower "$OWNER")" == "$(lower "$SIGNER")" ]] ||
      die "PriceSteerer $STEERER is owned by $OWNER, not by the signer $SIGNER ($ADDR_VAR)"
    echo "  seed     $UNDERLYING_SYMBOL pool with demoLiquidity through PriceSteerer $STEERER${UNDERLYING_PRICE_USD:+, steered to $UNDERLYING_PRICE_USD USD first}"
    echo "  note     pause the mirror bot first, it signs with the same key"
    ;;
  renounce-underlying)
    [[ -f "$DEPLOYMENTS" ]] || die "missing $DEPLOYMENTS, deploy first"
    [[ -n "${UNDERLYING_ORACLE:-}${UNDERLYING_SYMBOL:-}" ]] || die "set UNDERLYING_SYMBOL=<symbol> or UNDERLYING_ORACLE=<address>"
    echo "  oracle   ${UNDERLYING_ORACLE:-the $UNDERLYING_SYMBOL oracle} loses its owner for good (IRREVERSIBLE)"
    ;;
esac

echo
echo "Simulating $SCRIPT ..."
SIM="$RUN/$CMD.simulation.log"
(cd "$ROOT" && forge script "$SCRIPT" --rpc-url "$RPC") >"$SIM" 2>&1 || {
  tail -n 30 "$SIM" >&2
  die "simulation failed (full log $SIM)"
}
sed -n '/== Logs ==/,/^$/p' "$SIM"
grep -E 'Estimated (total gas|amount)' "$SIM" || true
rm -f "$ROOT/deployments/$NETWORK.dry-run.json"

echo
if [[ "${CONFIRM:-}" == "$CMD" ]]; then
  answer="$CMD"
  echo "Broadcast '$CMD' confirmed by CONFIRM=$CMD"
else
  read -r -p "Broadcast '$CMD' to Unichain Sepolia (chain 1301)? Type $CMD to confirm: " answer
fi
[[ "$answer" == "$CMD" ]] || die "aborted, nothing was sent"

cd "$ROOT"
if [[ "$ANVIL" == 1 ]]; then export FOUNDRY_BROADCAST="$RUN/broadcast"; fi
if [[ "$CMD" == scheduler ]]; then
  BLOG="$RUN/scheduler.broadcast.log"
  forge script "$SCRIPT" --rpc-url "$RPC" --broadcast --slow 2>&1 | tee "$BLOG" ||
    scheduler_recovery "The scheduler broadcast failed" "$BLOG"
elif [[ "$CMD" == underlying ]]; then
  forge script "$SCRIPT" --rpc-url "$RPC" --broadcast --slow 2>&1 | tee "$RUN/underlying.broadcast.log" ||
    underlying_recovery "The underlying broadcast failed"
else
  forge script "$SCRIPT" --rpc-url "$RPC" --broadcast --slow
fi
if [[ "$CMD" == deploy ]]; then
  echo
  echo "Next: make fund-sepolia FUND_USDC=<amount>, then make bots and node packages/swap-sdk/scripts/vendor-interface.mjs"
fi
if [[ "$CMD" == scheduler ]]; then
  # The deployments file changes only once record() has read the pair back from the chain
  echo
  echo "Recording: checking the pair on-chain before $DEPLOYMENTS changes ..."
  REC="$RUN/scheduler.record.log"
  for attempt in 1 2 3 4 5 6; do
    if forge script "$SCRIPT" --sig 'record()' --rpc-url "$RPC" >"$REC" 2>&1; then break; fi
    if [[ "$attempt" == 6 ]]; then
      tail -n 30 "$REC" >&2
      scheduler_recovery "record() failed (log $REC)" "$BLOG"
    fi
    sleep 5
  done
  sed -n '/== Logs ==/,/^$/p' "$REC"
  echo "Next: settle and sweep the old hook's markets, move the vault USDC into the new hook, then script/sepolia.sh renounce-oracle"
fi
if [[ "$CMD" == underlying ]]; then
  # The deployments file changes only once record() has read the stack back from the chain
  echo
  echo "Recording: checking the $UNDERLYING_SYMBOL stack on-chain before $DEPLOYMENTS changes ..."
  REC="$RUN/underlying.record.log"
  for attempt in 1 2 3 4 5 6; do
    if forge script "$SCRIPT" --sig 'record()' --rpc-url "$RPC" >"$REC" 2>&1; then break; fi
    if [[ "$attempt" == 6 ]]; then
      tail -n 30 "$REC" >&2
      underlying_recovery "record() failed (log $REC)"
    fi
    sleep 5
  done
  sed -n '/== Logs ==/,/^$/p' "$REC"
  echo "Next: pause the mirror bot, then UNDERLYING_SYMBOL=$UNDERLYING_SYMBOL script/sepolia.sh seed-underlying"
fi
if [[ "$CMD" == renounce-underlying ]]; then
  ORACLE="$(sed -nE 's/^ +oracle: (0x[0-9a-fA-F]{40}).*/\1/p' "$SIM" | head -n 1)"
  [[ -n "$ORACLE" ]] || die "could not read the oracle address from $SIM, check owner() by hand"
  for attempt in 1 2 3 4 5 6; do
    OWNER="$(cast call "$ORACLE" 'owner()(address)' --rpc-url "$RPC" 2>/dev/null || true)"
    if [[ "$OWNER" == 0x0000000000000000000000000000000000000000 ]]; then break; fi
    if [[ "$attempt" == 6 ]]; then die "oracle $ORACLE still reports owner ${OWNER:-unknown} on chain after the broadcast"; fi
    sleep 5
  done
  echo
  echo "Checked on chain: oracle $ORACLE owner() is the zero address"
fi
if [[ "$CMD" == renounce-oracle ]]; then
  # forge asserts owner() == 0 only in its local simulation, so read it back from the chain
  ORACLE="$(json_field underlyingOracle "$DEPLOYMENTS")"
  for attempt in 1 2 3 4 5 6; do
    OWNER="$(cast call "$ORACLE" 'owner()(address)' --rpc-url "$RPC" 2>/dev/null || true)"
    if [[ "$OWNER" == 0x0000000000000000000000000000000000000000 ]]; then break; fi
    if [[ "$attempt" == 6 ]]; then die "oracle $ORACLE still reports owner ${OWNER:-unknown} on chain after the broadcast"; fi
    sleep 5
  done
  echo
  echo "Checked on chain: oracle $ORACLE owner() is the zero address"
fi
