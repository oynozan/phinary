#!/usr/bin/env bash
# Mutation meta-suite for src/PredictionHook.sol: each mutant must make the offline hook suite fail.
# Runs in a scratch copy of the project, so the working tree is never modified.
# Usage: test/hook/mutation.sh [scratch-dir]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${1:-$(mktemp -d)}"
export PATH="$PATH:$HOME/.foundry/bin"
export FOUNDRY_FUZZ_RUNS=64 FOUNDRY_INVARIANT_RUNS=16 FOUNDRY_INVARIANT_DEPTH=60

mkdir -p "$WORK"
rsync -a --delete --exclude out --exclude cache --exclude lib --exclude .git "$ROOT/" "$WORK/proj/"
ln -sfn "$(cd "$ROOT/lib" && pwd -P)" "$WORK/proj/lib"
SRC="$WORK/proj/src/PredictionHook.sol"
cp "$SRC" "$WORK/original.sol"

MUTANTS=(
  "if (b < hi) revert Insolvent();|||"
  "price = isBuy ? ask : bid;|||price = isBuy ? bid : ask;"
  "price = WAD - bid;|||price = WAD - ask;"
  "int256 f = isYes == isBuy ? flow + dq : flow - dq;|||int256 f = flow + dq;"
  "int256 flow = m.epochTs == block.timestamp ? int256(m.epochFlow) : int256(0);|||int256 flow = 0;"
  "_checkBand(pMin, price, lam, isYes ? f : -f);|||"
  "> m.qEpochMax) revert EpochCapExceeded();|||> m.qEpochMax * 2) revert EpochCapExceeded();"
  "m.invYes = inv - fromInv;|||m.invYes = inv;"
  "if (st == Status.Settled) return (amt, amt);|||if (st == Status.Settled) return (amt, amt + 1);"
  "(q, cash) = exactIn ? (amt, amt / 2) : (amt * 2, amt);|||(q, cash) = exactIn ? (amt, (amt + 1) / 2) : (amt * 2, amt);"
  "bool yesWon = d * 1e18 > m.settleThreshold;|||bool yesWon = d * 1e18 >= m.settleThreshold;"
  "if (block.timestamp <= m.expiry + GRACE) revert TooEarly();|||if (block.timestamp <= m.expiry) revert TooEarly();"
  "shares = assets * (totalShares + SHARE_OFFSET) / (navPlus() + 1);|||shares = assets * (totalShares + SHARE_OFFSET) / (navMinus() + 1);"
  "assets = shares * (navMinus() + 1) / (totalShares + SHARE_OFFSET);|||assets = shares * (navPlus() + 1) / (totalShares + SHARE_OFFSET);"
  "        m.bucket -= payout;|||"
  "            : toBeforeSwapDelta(-amtOut.toInt128(), amtIn.toInt128());|||            : toBeforeSwapDelta(-amtOut.toInt128(), (amtIn + 1).toInt128());"
  "hi = st == Status.Settled ? (m.yesWon ? y : n) : (y + n + 1) / 2;|||hi = st == Status.Settled ? (m.yesWon ? y : n) : (y + n) / 2;"
  "&& block.timestamp + m.window + m.cutoffBuffer < m.expiry;|||&& block.timestamp + m.window < m.expiry;"
)

killed=0
survived=()
cd "$WORK/proj"
for i in "${!MUTANTS[@]}"; do
  from="${MUTANTS[$i]%%|||*}"
  to="${MUTANTS[$i]#*|||}"
  cp "$WORK/original.sol" "$SRC"
  if ! grep -qF -- "$from" "$SRC"; then
    echo "mutant $i: pattern not found: $from"
    survived+=("$i (stale pattern)")
    continue
  fi
  FROM="$from" TO="$to" perl -0pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$SRC"
  rm -rf cache/invariant
  if forge test --match-path "test/hook/*" --no-match-path "test/hook/UniversalRouterFork.t.sol" >"$WORK/mutant_$i.log" 2>&1; then
    echo "mutant $i SURVIVED: $from"
    survived+=("$i")
  elif grep -q "Compiler run failed" "$WORK/mutant_$i.log"; then
    echo "mutant $i does not compile: $from"
    survived+=("$i (no compile)")
  else
    echo "mutant $i killed"
    killed=$((killed + 1))
  fi
done
cp "$WORK/original.sol" "$SRC"

echo "killed $killed / ${#MUTANTS[@]}"
if [ "${#survived[@]}" -ne 0 ]; then
  echo "survivors: ${survived[*]}"
  exit 1
fi
