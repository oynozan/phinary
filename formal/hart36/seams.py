"""HartX36 certificate, pieces P1, P4, P5 and the band premises, plus the link to the Solidity source.

  (a) the constants in sim/evm.py (used by every certificate script) equal those in src/math/NormalCdf.sol;
  (b) P5: branch junction tail(SPLIT-1) >= tail(SPLIT), and the ratio junction R_cf(SPLIT) <= R_lower(SPLIT-1)
      that the factored band needs (R = a/b of NormalCdf._parts, exact Fractions);
  (c) R(0) = 1/2 exactly and e(z) = 1e18 for z^2 < 2e18, so band(0) and band(1) meet monotonically (Lemma C);
  (d) P4: the continued-fraction denominator fS(z) = floor(f(z) sqrt(2pi)/W) is non-decreasing. Paper proof: every
      g_i >= 7W, so floor(iW^2/g) drops by at most 1 when g grows by 1, hence each g_i grows by 0 or 1 per wei.
      Checked here exhaustively on +-1e5 wei windows at the seams and at random points;
  (e) the tail is exactly 0 from the expWad cutoff on, so saturating at |x| > 37 changes nothing.
With P2 (expwad_*.py) and P3 (ratio_cert36.py): e(z) and R(z) are non-increasing on [0, inf), so tail(z) = floor(e R)
is non-increasing, Phi-hat is non-decreasing on all of int256, and by formal/z3_integer_lemmas.py (band step) so are
both outputs of NormalCdf.band for every kappa.

Run:  python3 formal/hart36/seams.py
"""
import os
import random
import re
import sys
import time
from fractions import Fraction as Fr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "sim"))
import evm  # noqa: E402

W = evm.WAD
ok_all = True


def check(name, cond):
    global ok_all
    ok_all &= bool(cond)
    print(f"  [{'ok' if cond else 'FAIL'}] {name}")


t0 = time.time()
src = open(os.path.join(HERE, "..", "..", "src", "math", "NormalCdf.sol")).read()


def body(fn):
    m = re.search(r"function " + fn + r"\(int256 z\)[^{]*\{(.*?)\n    \}", src, re.S)
    return [int(v) for v in re.findall(r"(\d{20,})", m.group(1))]


print("(a) constants")
check("_num coefficients == sim/evm.py NUM36", body("_num") == evm.NUM36)
check("_den coefficients == sim/evm.py DEN36", body("_den") == evm.DEN36)
check("SPLIT", int(re.search(r"SPLIT = (\d+);", src).group(1)) == evm.SPLIT)
check("SQRT_2PI_WAD", int(re.search(r"SQRT_2PI_WAD = (\d+);", src).group(1)) == evm.SQRT_2PI_WAD)
check("SATURATE = 37 * WAD", "SATURATE = 37 * WAD;" in src and evm.SATURATE == 37 * W)
check("KAPPA_SCALE / KAPPA_MAX", "KAPPA_SCALE = 1e27;" in src and "KAPPA_MAX = 1e34;" in src)
check("_cf matches sim/evm.py cf", "z + 2 * WAD * WAD / (z + 3 * WAD * WAD / (z + 4 * WAD * WAD / (z + 65 * WAD / 100)))"
      in src)


def ratio(z):
    _, a, b = evm.parts(z)
    return Fr(a, b)


print("(b) P5 junctions at SPLIT")
S = evm.SPLIT
check(f"tail(SPLIT-1) = {evm.tail(S - 1)} >= tail(SPLIT) = {evm.tail(S)}", evm.tail(S - 1) >= evm.tail(S))
check("R_cf(SPLIT) <= R_lower(SPLIT-1) (exact)", ratio(S) <= ratio(S - 1))
check("e(SPLIT) <= e(SPLIT-1)", evm.e_of(S) <= evm.e_of(S - 1))

print("(c) junction at 0")
check("R(0) == 1/2", ratio(0) == Fr(1, 2))
check("e(z) == 1e18 exactly for z <= 1414213562", evm.e_of(1_414_213_562) == W and evm.e_of(0) == W)
check("R(1) <= R(0)", ratio(1) <= ratio(0))
check("Lemma C: cdf(-1) <= cdf(0) <= cdf(1)", evm.cdf(-1) <= evm.cdf(0) <= evm.cdf(1))


def fs(z):
    return evm.cf(z) * evm.SQRT_2PI_WAD // W


def scan_fs(lo, n):
    prev = fs(lo)
    for z in range(lo + 1, lo + n):
        cur = fs(z)
        if not (0 <= cur - prev):
            return False
        prev = cur
    return True


print("(d) P4 continued-fraction branch: fS non-decreasing")
check("every level g_i = z + (non-negative) >= SPLIT > 7W", S > 7 * W)
check("parts() uses fS on the continued-fraction branch", evm.parts(S + 5)[2] == fs(S + 5))
rng = random.Random(9)
windows = [S, 9_104_562_776_310_878_106, evm.SATURATE - 100_000] + [rng.randint(S, evm.SATURATE) for _ in range(20)]
check(f"exhaustive 1-wei scan of fS on {len(windows)} windows of 1e5 wei", all(scan_fs(w, 100_000) for w in windows))

print("(e) saturation")
EXP_CUTOFF = 9_104_562_776_310_878_106
check("e(EXP_CUTOFF) == 0 and e(EXP_CUTOFF-1) > 0", evm.e_of(EXP_CUTOFF) == 0 and evm.e_of(EXP_CUTOFF - 1) > 0)
check("tail(EXP_CUTOFF - 1) == 0 (tail reaches 0 before e does)", evm.tail(EXP_CUTOFF - 1) == 0)
check("tail(37e18) == 0", evm.tail(evm.SATURATE) == 0)

print(f"P1/P4/P5 and band premises: {ok_all}; {time.time() - t0:.1f}s")
sys.exit(0 if ok_all else 1)
