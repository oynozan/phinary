#!/usr/bin/env bash
# Runs every machine check in formal/ and records the outputs in formal/out/ (exit != 0 if any check fails).
#   z3_integer_lemmas.py      QuoteMath Lemma S/A, Theorem N, E1 (NO mirror), E2, factored-band step (z3, QF_NIA)
#   hart36/ratio_cert36.py    P3  Horner ratio num/den non-increasing at every wei on [0, SPLIT) (+ WAD-port control)
#   hart36/expwad_cert.py     P2  expWad increasing inside each range-reduction segment (Sturm + Taylor enclosure)
#   hart36/expwad_err.py      P2  rounding of expWad internals <= ~1 unit (vs >= 9.28e9 increase per wei)
#   hart36/expwad_kcheck.py   P2  expWad non-decreasing across all 61 segment boundaries (exhaustive, ~1 min)
#   hart36/seams.py           P1/P4/P5, band premises, constants == src/math/NormalCdf.sol
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p formal/out
status=0
run() {
  local name=$1
  shift
  echo "== $name"
  if "$@" 2>&1 | tee "formal/out/$name.txt"; then :; else status=1; fi
}
run z3_integer_lemmas uv run --with z3-solver python formal/z3_integer_lemmas.py
run ratio_cert36 python3 formal/hart36/ratio_cert36.py
run expwad_cert uv run --with sympy python formal/hart36/expwad_cert.py
run expwad_err uv run --with sympy python formal/hart36/expwad_err.py
run expwad_kcheck python3 formal/hart36/expwad_kcheck.py
run seams python3 formal/hart36/seams.py
echo
if [ $status -eq 0 ]; then echo "formal: all checks passed"; else echo "formal: FAILED"; fi
exit $status
