#!/usr/bin/env bash
# Stops what script/local-env.sh started (bots, then anvil). Logs stay in deployments/.run/local/, and
# CLEAN=1 also removes them together with deployments/local.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/deployments/.run/local"

"$ROOT/script/bots.sh" stop local

if [[ -f "$RUN/anvil.pid" ]]; then
  pid="$(cat "$RUN/anvil.pid")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid"; fi
    echo "anvil stopped (pid $pid)"
  else
    echo "anvil not running"
  fi
  rm -f "$RUN/anvil.pid"
else
  echo "anvil not running"
fi

if [[ "${CLEAN:-0}" == 1 ]]; then
  rm -rf "$RUN" "$ROOT/deployments/local.json"
  echo "removed $RUN and deployments/local.json"
fi
