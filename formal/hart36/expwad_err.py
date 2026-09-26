"""HartX36 certificate, piece P2 (rounding): rigorous bound on |r - F(t)| for solady expWad's internals, where
r = trunc(p/q) is the computed rational and F = P/Q the floor-free one. Every >> 96 floor errs in [0, 1); errors are
propagated through the Horner stages by magnitude. F_max is the exact maximum of F on the reduced range (F is increasing
there: G = P'Q - PQ' has no real root, checked here with an exact Sturm count), which closes the research caveat that
assumed F < 2^95 from observation.

Origin: docs/md/research/gaps/formal-verification-scripts/py/expwad_err.py.
Run:  uv run --with sympy python formal/hart36/expwad_err.py
"""
import math
import sys
from fractions import Fraction as Fr

import sympy as sp

T = 27458388733853736675570735564 + 10**12  # |t| <= T covers [T0, T1] of expwad_cert.py
S = 2**96
c1, c2, c3, c4, c5 = (1346386616545796478920950773328, 57155421227552351082224309758442,
                      94201549194550492254356042504812, 28719021644029726153956944680412240,
                      4385272521454847904659076985693276)
Y0 = T + c1
Ymax = Fr(Y0 * T, S) + c2
ey = 1
P1max = Ymax + T + c3
ep1 = ey
ep2 = Fr(P1max * ey + Ymax * ep1, S) + 1
eP = ep2 * T
eq = 0
for c in [50020603652535783019961831881945, 533845033583426703283633433725380, 3604857256930695427073651918091429,
          14423608567350463180887372962807573, 26449188498355588339934803723976023]:
    eq = Fr(eq * T, S) + 1

t = sp.symbols("t")
qx = t - 2855989394907223263936484059900
for c in [50020603652535783019961831881945, -533845033583426703283633433725380, 3604857256930695427073651918091429,
          -14423608567350463180887372962807573, 26449188498355588339934803723976023]:
    qx = qx * t / sp.Integer(S) + c
Qp = sp.Poly(sp.expand(qx), t)
y = (t + c1) * t / sp.Integer(S) + c2
Pp = sp.Poly(sp.expand(((y + t - c3) * y / sp.Integer(S) + c4) * t + c5 * sp.Integer(S)), t)
G = sp.Poly(sp.expand(Pp.as_expr().diff(t) * Qp.as_expr() - Pp.as_expr() * Qp.as_expr().diff(t)), t)
assert Qp.count_roots(-T, T) == 0 and Qp.eval(0) > 0, "Q must be positive on [-T, T]"
assert G.count_roots(-T, T) == 0 and G.eval(0) > 0, "F must be increasing on [-T, T]"


def to_fr(v):
    v = sp.Rational(v)
    return Fr(int(v.p), int(v.q))


crit = [r for r in sp.Poly(Qp.diff(t), t).real_roots() if -T <= r <= T]
cands = [Fr(-T), Fr(T)] + [to_fr(sp.Rational(sp.N(r, 60))) for r in crit]
Qmin = min(to_fr(Qp.eval(sp.Rational(c.numerator, c.denominator))) for c in cands)
Fmax = to_fr(Pp.eval(T)) / to_fr(Qp.eval(T))
assert Fmax < 2**95
err = (eP + Fmax * eq) / (Qmin - eq) + 1
print(f"eP ~ 2^{math.log2(eP):.1f}, eq = {float(eq):.3f}, Qmin ~ 2^{math.log2(Qmin):.1f}, "
      f"F_max = F(T) ~ 2^{math.log2(Fmax):.2f} (exact)")
print(f"rigorous |r - F| <= {float(err):.6f} internal units (vs >= 9.28e9 increase per wei step, expwad_cert.py)")
ok = err < 2
print(f"P2 rounding: {ok}")
sys.exit(0 if ok else 1)
