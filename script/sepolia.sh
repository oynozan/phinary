#!/usr/bin/env bash
# Guarded broadcasts to the real Unichain Sepolia (chain 1301): deploy, fund the vault, create a one-off market, deploy
# the scheduler-owned hook, or renounce the oracle.
#
#   script/sepolia.sh deploy           Deploy.s.sol -> deployments/unichain-sepolia.json
#   script/sepolia.sh fund             Fund.s.sol, FUND_USDC (default 20) of the deployer's Circle USDC into the vault
#   script/sepolia.sh market           CreateMarket.s.sol with the keeper defaults (MARKET_* and QUOTE_* env)
#   script/sepolia.sh scheduler        DeployScheduler.s.sol, a MarketScheduler and the new PredictionHook it owns, then
#                                      record() checks both on-chain and only then updates the deployments file
#   script/sepolia.sh renounce-oracle  RenounceOracle.s.sol, the UnderlyingOracleHook loses its owner (IRREVERSIBLE)
#
# Each command checks the RPC (chain 1301, not anvil), shows the signer's balances, simulates the script, and only then
# asks for a typed confirmation before broadcasting (or takes CONFIRM=<command> for a non-interactive, explicit opt-in).
# It refuses to run when CI is set.
# RPC: UNICHAIN_SEPOLIA_RPC (from .env, default https://sepolia.unichain.org). Signer: DEPLOYER_PRIVATE_KEY in .env.
# ALLOW_ANVIL=1 with UNICHAIN_SEPOLIA_RPC=<anvil fork> rehearses this exact flow into deployments/sepolia-rehearsal.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$PATH:$HOME/.foundry/bin"
CMD="${1:-}"
USDC=0x31d0220469e10c4E71834a79b1f276d740d3768F
MIN_ETH_WEI="${MIN_DEPLOYER_ETH_WEI:-1000000000000000}"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

env_value() {
  [[ -f "$ROOT/.env" ]] || return 0
  sed -n "s/^$1=//p" "$ROOT/.env" | tail -n 1 | tr -d '"'"'"
}

case "$CMD" in
  deploy) SCRIPT=script/Deploy.s.sol:Deploy ;;
  fund) SCRIPT=script/Fund.s.sol:Fund ;;
  market) SCRIPT=script/CreateMarket.s.sol:CreateMarket ;;
  scheduler) SCRIPT=script/DeployScheduler.s.sol:DeployScheduler ;;
  renounce-oracle) SCRIPT=script/RenounceOracle.s.sol:RenounceOracle ;;
  *) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

[[ -z "${CI:-}" ]] || die "refusing to broadcast to Unichain Sepolia from CI"

RPC="${UNICHAIN_SEPOLIA_RPC:-$(env_value UNICHAIN_SEPOLIA_RPC)}"
RPC="${RPC:-https://sepolia.unichain.org}"
DEPLOYER="${DEPLOYER_ADDRESS:-$(env_value DEPLOYER_ADDRESS)}"
[[ -n "$DEPLOYER" ]] || die "DEPLOYER_ADDRESS is not set (.env)"
[[ -n "${DEPLOYER_PRIVATE_KEY:-}" || -n "$(env_value DEPLOYER_PRIVATE_KEY)" ]] || die "DEPLOYER_PRIVATE_KEY is not set (.env)"

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

ETH_WEI="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"
USDC_RAW="$(cast call "$USDC" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')"
echo "Unichain Sepolia via $RPC$([[ "$ANVIL" == 1 ]] && echo " (anvil fork, writes $NETWORK.json)")"
echo "  signer   $DEPLOYER"
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
    echo "  price    ETH_PRICE_USD=$ETH_PRICE_USD, keeper ${KEEPER_ADDRESS:-$DEPLOYER}"
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
forge script "$SCRIPT" --rpc-url "$RPC" --broadcast --slow
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
      die "record failed and $DEPLOYMENTS is unchanged (full log $REC). Once the pair checks out, rerun from $ROOT with the same env: NETWORK=$NETWORK DEPLOYMENTS_FILE= forge script $SCRIPT --sig 'record()' --rpc-url $RPC"
    fi
    sleep 5
  done
  sed -n '/== Logs ==/,/^$/p' "$REC"
  echo "Next: settle and sweep the old hook's markets, move the vault USDC into the new hook, then script/sepolia.sh renounce-oracle"
fi
