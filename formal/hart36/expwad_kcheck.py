"""HartX36 certificate, piece P2 (across segments): solady expWad is non-decreasing across every range-reduction
boundary k -> k+1 in [-41.45e18, 0], checked exhaustively for +-2e5 wei around each boundary with the bit-exact
emulation in sim/evm.py.

Origin: docs/md/research/gaps/formal-verification-scripts/py/expwad_kcheck.py.
Run:  python3 formal/hart36/expwad_kcheck.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sim"))
from evm import exp_wad, exp_wad_internals as internals  # noqa: E402

LO = -41446531673892822312
SPAN = 200_000


def kof(x):
    return internals(x)[0]


t0 = time.time()
viol = checked = bnds = 0
min_dr = None
for k in range(kof(LO), 1):
    a, b = LO, 0
    if kof(a) >= k:
        first = a
    else:
        while b - a > 1:
            m = (a + b) // 2
            if kof(m) >= k:
                b = m
            else:
                a = m
        first = b
    bnds += 1
    start = max(first - SPAN, LO + 1)
    prev = exp_wad(start)
    for x in range(start + 1, min(first + SPAN, 1)):
        cur = exp_wad(x)
        checked += 1
        if cur < prev:
            viol += 1
        prev = cur
    if kof(first + 1) == kof(first):
        d = internals(first + 1)[4] - internals(first)[4]
        min_dr = d if min_dr is None else min(min_dr, d)
cut = exp_wad(LO - 1) == 0 and exp_wad(LO) == 1
print(f"k-boundaries {bnds}, 1-wei steps checked {checked}, decreases {viol}, "
      f"min internal dr per wei at boundaries {min_dr}; cutoff expWad({LO - 1}) = 0, next = 1: {cut}")
ok = viol == 0 and cut
print(f"P2 across segments: {ok}; {time.time() - t0:.1f}s")
sys.exit(0 if ok else 1)
