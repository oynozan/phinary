"""Machine-checked (z3, unbounded integer arithmetic, QF_NIA) proofs of the integer lemmas behind QuoteMath and the
factored spread band. Each `prove` asserts the negation of the goal and expects UNSAT. floor/ceil are encoded by their
defining inequalities and isqrt by s^2 <= X < (s+1)^2. These are the MATH statements; the Solidity refinement is the
bit-exact vector suite (test/math/QuoteMath.t.sol) plus checked arithmetic (overflow reverts).

Origin: docs/research/gaps/formal-verification-scripts/py/z3_integer_lemmas.py (Lemma S, A, Theorem N, E1, E2),
extended with E1 at integer amounts through the NO mirror, E2 in the sell-first order, Theorem N for sell exact-out,
the composition step of the factored band and the T4(g) per-epoch extraction bound. For the band, e(z) >= 0 and
R(z) = n/d are non-increasing in z (formal/hart36); with C = KAPPA_SCALE and K = kappa*C the band evaluates
plusUp = ceil(e (n C + K d)/(d C)) and minusDn = floor(e (n C - K d)/(d C)). Both are non-increasing in z where
minusDn > 0, and the region R >= kappa is a half-line; outside it the band clamps to 0 or 1e18, so the clamped outputs
stay monotone.

Run:  uv run --with z3-solver python formal/z3_integer_lemmas.py
"""
import sys
import time

from z3 import And, Implies, Int, Ints, Not, SolverFor, sat, unsat

FAILED = []


def prove(name, hyps, goal, timeout=600, expect_cex=False):
    s = SolverFor("QF_NIA")
    s.set("timeout", timeout * 1000)
    s.add(*hyps)
    s.add(Not(goal))
    t = time.time()
    r = s.check()
    dt = time.time() - t
    tag = "PROVED" if r == unsat else ("COUNTEREXAMPLE" if r == sat else "UNKNOWN")
    print(f"{name:66s} {tag:15s} {dt:7.2f}s", flush=True)
    if r == sat:
        print("   model:", s.model())
    if (r == sat) != expect_cex or r not in (sat, unsat):
        FAILED.append(name)
    return r


beta, lam, R, s, q, D, A, A1, A2, q1, q2, I0, a, b, Q = Ints("beta lam R s q D A A1 A2 q1 q2 I0 a b Q")


def floordiv(x, n, y):
    return And(n * y <= x, x < n * (y + 1))


def ceildiv(x, n, y):
    return And(n * y >= x, x > n * (y - 1))


UNIT, WAD = 10**6, 10**18
DD = 2 * UNIT * WAD  # QuoteMath.D


def N(I_, q_, p):
    """Cost numerator of buying q_ from state I_ at base price p: lam q^2 + beta(I) q, beta(I) = 2e6 p + 2 lam I."""
    return lam * q_ * q_ + (2 * UNIT * p + 2 * lam * I_) * q_


def M(I_, q_, p):
    """Proceeds numerator of selling q_ from state I_ at base price p."""
    return (2 * UNIT * p + 2 * lam * I_) * q_ - lam * q_ * q_


print("== Lemma S: floor-isqrt of the exact discriminant is exact")
Hb = [beta > 0, lam > 0, R >= 0, s >= 0, s * s <= beta * beta + 4 * lam * R, beta * beta + 4 * lam * R < (s + 1) * (s + 1),
      floordiv(s - beta, 2 * lam, q)]
prove("Lemma S buy (exact-in): feasible", Hb, lam * q * q + beta * q <= R)
prove("Lemma S buy (exact-in): maximal", Hb, lam * (q + 1) * (q + 1) + beta * (q + 1) > R)
prove("Lemma S buy (exact-in): q >= 0", Hb, q >= 0)
Hs = [beta > 0, lam > 0, R >= 0, 4 * lam * R <= beta * beta, s >= 0, s * s <= beta * beta - 4 * lam * R,
      beta * beta - 4 * lam * R < (s + 1) * (s + 1), ceildiv(beta - s, 2 * lam, q)]
prove("Lemma S sell (exact-out): sufficient WITHOUT band (expect CEX)", Hs, beta * q - lam * q * q >= R, 120,
      expect_cex=True)
prove("Lemma S sell (exact-out): sufficient WITH band 2 lam q <= beta", Hs + [2 * lam * q <= beta],
      beta * q - lam * q * q >= R)
prove("Lemma S sell (exact-out): minimal", Hs + [2 * lam * q <= beta, q > 0],
      beta * (q - 1) - lam * (q - 1) * (q - 1) < R)
prove("sellExactIn on the branch: proceeds numerator >= 0", [lam >= 0, q >= 0, 2 * lam * q <= beta],
      beta * q - lam * q * q >= 0)

print("== Lemma A and Theorem N: no split advantage")
prove("Lemma A: N(I,q1) + N(I+q1,q2) == N(I,q1+q2)", [], N(I0, q1, a) + N(I0 + q1, q2, a) == N(I0, q1 + q2, a))
prove("Lemma A (sell): M(I,q1) + M(I-q1,q2) == M(I,q1+q2)", [], M(I0, q1, b) + M(I0 - q1, q2, b) == M(I0, q1 + q2, b))
c1, c2, c12, N1, N2 = Ints("c1 c2 c12 N1 N2")
prove("Thm N exact-out buy: ceil + ceil >= ceil(sum)", [D > 0, ceildiv(N1, D, c1), ceildiv(N2, D, c2),
      ceildiv(N1 + N2, D, c12)], c1 + c2 >= c12)
prove("Thm N exact-in sell: floor + floor <= floor(sum)", [D > 0, floordiv(N1, D, c1), floordiv(N2, D, c2),
      floordiv(N1 + N2, D, c12)], c1 + c2 <= c12)
beta0 = 2 * UNIT * a + 2 * lam * I0
Hn = [lam > 0, D > 0, a > 0, beta0 > 0, q1 >= 0, q2 >= 0, Q >= 0, A1 >= 0, A2 >= 0,
      N(I0, q1, a) <= A1 * D, N(I0 + q1, q2, a) <= A2 * D,
      N(I0, Q, a) <= (A1 + A2) * D, N(I0, Q + 1, a) > (A1 + A2) * D]
prove("Thm N exact-in buy: q1 + q2 <= q(A1 + A2)", Hn, q1 + q2 <= Q)
# exact-out sell: q1 sufficient for A1 at I, q2 sufficient for A2 at I-q1, both on the branch; Q minimal for A1+A2
betaS = 2 * UNIT * b + 2 * lam * I0
Hso = [lam > 0, b > 0, betaS > 0, q1 >= 0, q2 >= 0, Q >= 1, A1 >= 0, A2 >= 0,
       M(I0, q1, b) >= A1 * DD, M(I0 - q1, q2, b) >= A2 * DD,
       2 * lam * q1 <= betaS, 2 * lam * q2 <= betaS - 2 * lam * q1,
       M(I0, Q - 1, b) < (A1 + A2) * DD, 2 * lam * Q <= betaS]
prove("Thm N exact-out sell: q1 + q2 >= q(A1 + A2)", Hso, q1 + q2 >= Q)

print("== E2: a same-epoch round trip never profits")
cost, back = Ints("cost back")
He = [lam >= 0, q > 0, b <= a, ceildiv(N(I0, q, a), DD, cost), floordiv(M(I0 + q, q, b), DD, back)]
prove("E2 buy then sell: floor(M_b(I+q,q)/D) <= ceil(N_a(I,q)/D)", He, back <= cost)
prove("E2 identity: N_a(I,q) - M_b(I+q,q) == 2e6 (a-b) q", [], N(I0, q, a) - M(I0 + q, q, b) == 2 * UNIT * (a - b) * q)
He2 = [lam >= 0, q > 0, b <= a, floordiv(M(I0, q, b), DD, back), ceildiv(N(I0 - q, q, a), DD, cost)]
prove("E2 sell then buy: floor(M_b(I,q)/D) <= ceil(N_a(I-q,q)/D)", He2, back <= cost)
prove("E2 loss >= spread: cost - back >= (a-b) q / 1e18", He + [a - b >= 0], (cost - back) * WAD >= (a - b) * q)

print("== E1: complete sets through the NO mirror (NO buy at 1-bid, NO sell at 1-ask, state -I) never beat par")
cY, cN = Ints("cY cN")
He1 = [lam >= 0, q >= 0, b <= a, ceildiv(N(I0, q, a), DD, cY)]
prove("E1 buy, same state: ceil(N_a(I,q)/D) + ceil(N_{1-b}(-I,q)/D) >= q",
      He1 + [ceildiv(N(-I0, q, WAD - b), DD, cN)], cY + cN >= q)
prove("E1 buy, sequential: ... + ceil(N_{1-b}(-(I+q),q)/D) >= q",
      He1 + [ceildiv(N(-(I0 + q), q, WAD - b), DD, cN)], cY + cN >= q)
pY, pN = Ints("pY pN")
Hs1 = [lam >= 0, q >= 0, b <= a, floordiv(M(I0, q, b), DD, pY)]
prove("E1 sell, same state: floor(M_b(I,q)/D) + floor(M_{1-a}(-I,q)/D) <= q",
      Hs1 + [floordiv(M(-I0, q, WAD - a), DD, pN)], pY + pN <= q)
prove("E1 sell, sequential: ... + floor(M_{1-a}(-(I-q),q)/D) <= q",
      Hs1 + [floordiv(M(-(I0 - q), q, WAD - a), DD, pN)], pY + pN <= q)
prove("E1 identity: N_a(I,q) - M_b(I,q) == 2e6(a-b)q + 2 lam q^2", [],
      N(I0, q, a) - M(I0, q, b) == 2 * UNIT * (a - b) * q + 2 * lam * q * q)

print("== Factored band (NormalCdf.band): one step of the composition argument")
# z1 <= z2 means e1 >= e2 >= 0 and n1/d1 >= n2/d2
e1, e2, n1, n2, d1, d2, K, C, u1, u2 = Ints("e1 e2 n1 n2 d1 d2 K C u1 u2")
Hband = [C > 0, K >= 0, d1 > 0, d2 > 0, n1 >= 0, n2 >= 0, e2 >= 0, e1 >= e2, n1 * d2 >= n2 * d1]
prove("band plus side: ceil(e(R+k)) non-increasing in z",
      Hband + [ceildiv(e1 * (n1 * C + K * d1), d1 * C, u1), ceildiv(e2 * (n2 * C + K * d2), d2 * C, u2)], u1 >= u2)
prove("band minus side: floor(e(R-k)) non-increasing where positive",
      Hband + [floordiv(e1 * (n1 * C - K * d1), d1 * C, u1), floordiv(e2 * (n2 * C - K * d2), d2 * C, u2), u2 > 0],
      u1 >= u2)
prove("band minus side: sign region is a half-line (R2 >= k => R1 >= k)",
      Hband + [n2 * C - K * d2 >= 0], n1 * C - K * d1 >= 0)

print("== T4(g): one epoch against fair value F extracts at most ((F - a)+)^2 / (2 lam) (USDC units, lam WAD/token)")
# profit * 2 lam 1e12 <= edge^2 * 1e18 with profit in 1e-6 USDC scaled by 1e18: buys F q - c 1e18, sells p 1e18 - F q
Fv, c1, c2, p1, p2 = Ints("Fv c1 c2 p1 p2")
Hx = [lam > 0, q1 >= 0, q2 >= 0, a >= 0, b >= 0, Fv >= 0]
LAM_SCALE = 2 * 10**12
Hxb = Hx + [ceildiv(N(0, q1, a), DD, c1), ceildiv(N(q1, q2, a), DD, c2)]
prove("T4(g) buys (two exact-out fills): profit <= (F-a)^2/(2 lam)", Hxb,
      (Fv * (q1 + q2) - (c1 + c2) * WAD) * LAM_SCALE * lam <= (Fv - a) * (Fv - a) * WAD)
prove("T4(g) buys: half the bound, (F-a)^2/(4 lam) (expect CEX)", Hxb,
      (Fv * (q1 + q2) - (c1 + c2) * WAD) * 2 * LAM_SCALE * lam <= (Fv - a) * (Fv - a) * WAD, 120, expect_cex=True)
prove("T4(g) buys: F <= a => no profit", Hxb + [Fv <= a], Fv * (q1 + q2) - (c1 + c2) * WAD <= 0)
Hxs = Hx + [floordiv(M(0, q1, b), DD, p1), floordiv(M(-q1, q2, b), DD, p2)]
prove("T4(g) sells (two exact-in fills): profit <= (b-F)^2/(2 lam)", Hxs,
      ((p1 + p2) * WAD - Fv * (q1 + q2)) * LAM_SCALE * lam <= (b - Fv) * (b - Fv) * WAD)
prove("T4(g) sells: F >= b => no profit", Hxs + [Fv >= b], (p1 + p2) * WAD - Fv * (q1 + q2) <= 0)

print()
if FAILED:
    print("FAILED:", FAILED)
    sys.exit(1)
print("all lemmas: expected result")
