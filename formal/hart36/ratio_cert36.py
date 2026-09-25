"""HartX36 certificate, piece P3: the integer Horner ratio num(z)/den(z) of src/math/NormalCdf.sol is non-increasing
at EVERY 1-wei step z -> z+1 on [0, SPLIT), proven chunk by chunk with exact rational interval bounds (no floats).

Bounds (z >= 0 integer, W = 1e18, all quantities non-negative):
  h_{k+1}(z) = floor(h_k z / W) + C_{k+1};  p_k = exact real Horner;  0 <= p_k - h_k <= E_k,  E_{k+1} = E_k z/W + 1
  delta_{k+1} = h_{k+1}(z+1) - h_{k+1}(z) = floor(a) - floor(b) in {floor(a-b), floor(a-b)+1},  a-b = (h_k(z) + delta_k (z+1))/W
  => floor(((p_k - E_k) + L_k (z+1))/W) <= delta_{k+1} <= floor((p_k + U_k (z+1))/W) + 1
Sufficient for n(z+1)/d(z+1) <= n(z)/d(z) on a chunk [za, zb]:  U_n * max d <= min n * L_d (uppers at zb, lowers at za).
Every bound is monotone in z on a chunk, so evaluating uppers at zb and lowers at za is sound.

Origin: docs/research/gaps/formal-verification-scripts/py/ratio_cert.py + ratio_cert36.py; constants from sim/evm.py
(bit-exact vs the Solidity) and checked against the Solidity source by formal/hart36/seams.py.
Run:  python3 formal/hart36/ratio_cert36.py
"""
import os
import sys
import time
from fractions import Fraction as Fr

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sim"))
from evm import DEN36, NUM36, SPLIT, WAD as W  # noqa: E402


def fl(x):
    return x.numerator // x.denominator


def bounds(C, za, zb):
    """(min h at za, max h at zb, lower bound on the last step, upper bound on the last step)."""
    p_lo = Fr(C[0])
    p_hi = Fr(C[0])
    e_hi = Fr(0)
    lo_step = 0
    hi_step = 0
    for c in C[1:]:
        l_new = fl(((p_lo - e_hi) + lo_step * (za + 1)) / W)
        u_new = fl((p_hi + hi_step * (zb + 1)) / W) + 1
        lo_step, hi_step = max(l_new, 0), u_new
        p_lo = p_lo * za / W + c
        p_hi = p_hi * zb / W + c
        e_hi = e_hi * zb / W + 1
    return p_lo - e_hi, p_hi, lo_step, hi_step


def certify(za, zb):
    n_min, _, _, u_n = bounds(NUM36, za, zb)
    _, d_max, l_d, _ = bounds(DEN36, za, zb)
    return u_n * d_max <= n_min * l_d


def rec(za, zb, minw):
    if certify(za, zb):
        return True, 1
    if zb - za <= minw:
        return False, 0
    m = (za + zb) // 2
    ok, ca = rec(za, m, minw)
    if not ok:
        return False, ca
    ok, cb = rec(m, zb, minw)
    return ok, ca + cb


def run(hi):
    step = W // 100
    z, chunks, ok = 0, 0, True
    while z < hi:
        zb = min(z + step, hi)
        r, c = rec(z, zb, 10**6)
        chunks += c
        if not r:
            print(f"FAIL near z = {z / W:.9f}")
            ok = False
            break
        z = zb
    return ok, chunks, z


if __name__ == "__main__":
    t0 = time.time()
    ok, chunks, _ = run(SPLIT)
    print(f"P3: num36/den36 non-increasing at every 1-wei step on [0, SPLIT = {SPLIT}): {ok}; "
          f"{chunks} exact chunks; {time.time() - t0:.1f}s")
    # negative control: the plain-WAD port (coefficients / 1e18) is not certifiable past z ~ 4.4658
    NUM36[:] = [c // 10**18 for c in NUM36]
    DEN36[:] = [c // 10**18 for c in DEN36]
    ok_wad, _, reached = run(SPLIT)
    print(f"negative control, plain-WAD Horner: certified on the whole range: {ok_wad} (stops near z = {reached / W:.4f})")
    sys.exit(0 if ok and not ok_wad else 1)
