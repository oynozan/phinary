"""HartX36 certificate, piece P2 (within a k-segment): solady expWad's internal rational r = trunc(p/q) strictly
increases with x inside each range-reduction segment, on the whole non-zero negative domain [-41.45e18, 0].

Exact (floor-free) pipeline in the reduced argument t (2^96 fixed point):
  y = (t + c1) t / 2^96 + c2;  p1 = y + t - c3;  P = (p1 y / 2^96 + c4) t + c5 2^96;  Q = Horner(t) without floors;  F = P/Q
Checks: (i) the reduced range [T0, T1] from exact segment ends; (ii) P, Q and G = P'Q - PQ' have no real root on it (exact
Sturm counts) and are positive at 0; (iii) a rigorous lower bound on F' = G/Q^2 (Taylor enclosure on 64 chunks) times the
minimum step of t per wei of x. expwad_err.py bounds all floors by ~1 unit, far below this increase.

Origin: docs/md/research/gaps/formal-verification-scripts/py/expwad_cert.py; internals from sim/evm.py.
Run:  uv run --with sympy python formal/hart36/expwad_cert.py
"""
import os
import sys
import time

import sympy as sp

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sim"))
from evm import exp_wad_internals as internals  # noqa: E402

t0 = time.time()
t = sp.symbols("t")
S96 = sp.Integer(2) ** 96
c1, c2, c3, c4, c5 = (1346386616545796478920950773328, 57155421227552351082224309758442,
                      94201549194550492254356042504812, 28719021644029726153956944680412240,
                      4385272521454847904659076985693276)
y = (t + c1) * t / S96 + c2
p1 = y + t - c3
P = sp.expand((p1 * y / S96 + c4) * t + c5 * S96)
q = t - 2855989394907223263936484059900
for c in [50020603652535783019961831881945, -533845033583426703283633433725380, 3604857256930695427073651918091429,
          -14423608567350463180887372962807573, 26449188498355588339934803723976023]:
    q = q * t / S96 + c
Q = sp.expand(q)

L = 54916777467707473351141471128
LO_X = -41446531673892822312


def kof(x):
    return internals(x)[0]


ends = [LO_X, 0]
for k in range(kof(LO_X), 1):
    a, b = LO_X, 0
    if kof(a) >= k:
        ends.append(a)
        continue
    while b - a > 1:
        m = (a + b) // 2
        if kof(m) >= k:
            b = m
        else:
            a = m
    ends += [a, b]
xs = [internals(e)[1] for e in ends]
T0, T1 = min(xs), max(xs)
print("(i)   reduced-argument range [T0, T1] =", T0, T1, " (L/2 =", L // 2, ")")
Pp, Qp = sp.Poly(P, t), sp.Poly(Q, t)
G = sp.Poly(sp.expand(sp.diff(P, t) * Q - P * sp.diff(Q, t)), t)
iv = (sp.Rational(T0), sp.Rational(T1))
roots = (Pp.count_roots(*iv), Qp.count_roots(*iv), G.count_roots(*iv))
signs = (sp.sign(Pp.eval(0)), sp.sign(Qp.eval(0)), sp.sign(G.eval(0)))
print("(ii)  real roots in range: P", roots[0], " Q", roots[1], " G = P'Q - PQ'", roots[2],
      "| signs at 0: P", signs[0], "Q", signs[1], "G", signs[2])


def poly_bounds(poly, a, b):
    """Rigorous enclosure of poly on [a, b] via the Taylor expansion at the midpoint."""
    m = (a + b) / 2
    h = (b - a) / 2
    cs = sp.Poly(poly.as_expr().subs(t, t + m), t).all_coeffs()[::-1]
    rad = sum(abs(c) * h**i for i, c in enumerate(cs) if i > 0)
    return cs[0] - rad, cs[0] + rad


mins = []
N = 64
a0 = sp.Rational(T0)
step = (sp.Rational(T1) - sp.Rational(T0)) / N
for i in range(N):
    lo, hi = a0 + i * step, a0 + (i + 1) * step
    gl, _ = poly_bounds(G, lo, hi)
    _, qh = poly_bounds(Q, lo, hi)
    mins.append(gl / qh**2)
m = min(mins)
MIN_T_STEP = 79228162514  # min increase of t per wei of x inside a segment (floor(2^78 / 5^18))
print("(iii) rigorous lower bound on F' over range:", sp.N(m, 6),
      " => min increase of F per 1-wei step of x >=", sp.N(m * MIN_T_STEP, 6), "internal units")
ok = roots == (0, 0, 0) and signs == (1, 1, 1) and m > 0 and 2 ** 78 // 5 ** 18 == MIN_T_STEP
print(f"P2 within-segment: {ok}; {time.time() - t0:.1f}s")
sys.exit(0 if ok else 1)
