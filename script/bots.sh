#!/usr/bin/env bash
# Starts, stops and inspects the bots (bot/src/mirror.ts, bot/src/keeper.ts, bot/src/sealed.ts) for one deployments file.
#
#   script/bots.sh start  <network> [mirror|keeper|sealed|all]   background processes, logs in deployments/.run/<network>/
#   script/bots.sh stop   <network> [mirror|keeper|sealed|all]
#   script/bots.sh status <network>
#   script/bots.sh logs   <network>                               tail -f the logs
#
# <network> selects deployments/<network>.json (local, unichain-sepolia). `all` is the demo pair, mirror and keeper; the
# sealed-oracle poker and prover starts only on its own, since it needs SEALED_ORACLE (or `sealedOracle` in the file).
# Keys come from the environment or from bot/.env and the repo .env (DEPLOYER_PRIVATE_KEY, MIRROR_PRIVATE_KEY,
# KEEPER_PRIVATE_KEY, SEALED_KEY); they are never printed. Every other bot setting (RPC_URL, KEEPER_POLL_MS,
# SEALED_BATCH, ...) passes through from the environment, see bot/.env.example.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD="${1:-}"
NETWORK="${2:-}"
WHICH="${3:-all}"

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

[[ -n "$CMD" && -n "$NETWORK" ]] || usage
case "$WHICH" in mirror | keeper | sealed) BOTS=("$WHICH") ;; all) BOTS=(mirror keeper) ;; *) usage ;; esac

DEPLOYMENTS="$ROOT/deployments/$NETWORK.json"
RUN="$ROOT/deployments/.run/$NETWORK"
mkdir -p "$RUN"

pid_of() {
  local f="$RUN/$1.pid"
  [[ -f "$f" ]] || return 1
  local pid
  pid="$(cat "$f")"
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

start_one() {
  local bot="$1" pid
  if pid="$(pid_of "$bot")"; then
    echo "$bot already running (pid $pid)"
    return 0
  fi
  [[ -f "$DEPLOYMENTS" ]] || { echo "missing $DEPLOYMENTS (deploy first)" >&2; exit 1; }
  [[ -d "$ROOT/bot/node_modules" ]] || { echo "bot dependencies missing: (cd bot && npm ci)" >&2; exit 1; }
  (
    cd "$ROOT/bot"
    DEPLOYMENTS_FILE="$DEPLOYMENTS" nohup node "src/$bot.ts" >>"$RUN/$bot.log" 2>&1 &
    echo $! >"$RUN/$bot.pid"
  )
  sleep 1
  if pid="$(pid_of "$bot")"; then
    echo "$bot started (pid $pid), log $RUN/$bot.log"
  else
    echo "$bot exited on start-up, last log lines:" >&2
    tail -n 20 "$RUN/$bot.log" >&2
    exit 1
  fi
}

stop_one() {
  local bot="$1" pid
  if pid="$(pid_of "$bot")"; then
    kill "$pid"
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
    echo "$bot stopped (pid $pid)"
  else
    echo "$bot not running"
  fi
  rm -f "$RUN/$bot.pid"
}

case "$CMD" in
  start) for b in "${BOTS[@]}"; do start_one "$b"; done ;;
  stop) for b in "${BOTS[@]}"; do stop_one "$b"; done ;;
  status)
    for b in mirror keeper sealed; do
      # The sealed bot is optional: list it once it has run on this network
      [[ "$b" != sealed || -f "$RUN/$b.log" || -f "$RUN/$b.pid" ]] || continue
      if pid="$(pid_of "$b")"; then echo "$b running (pid $pid)"; else echo "$b stopped"; fi
      if [[ -f "$RUN/$b.log" ]]; then tail -n 2 "$RUN/$b.log" | sed 's/^/    /'; fi
    done
    ;;
  logs)
    LOGS=()
    for b in mirror keeper sealed; do
      if [[ -f "$RUN/$b.log" ]]; then LOGS+=("$RUN/$b.log"); fi
    done
    ((${#LOGS[@]} > 0)) || { echo "no logs in $RUN" >&2; exit 1; }
    tail -n 20 -f "${LOGS[@]}"
    ;;
  *) usage ;;
esac
