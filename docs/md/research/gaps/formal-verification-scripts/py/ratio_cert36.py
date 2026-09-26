# Same certificate for a variant whose Horner accumulators carry 18 extra decimals (coefficients scaled by 1e18,
# z still WAD, divide by WAD each stage): n36 = n*1e18 approximately. The ratio n36/d36 is what enters c = e*n36/d36.
import sys
from fractions import Fraction as Fr
exec(open("ratio_cert.py").read().split("zmax=float")[0])   # reuse fl, bounds, certify
NC[:] = [c*10**18 for c in NC]; DC[:] = [c*10**18 for c in DC]
def rec(za, zb, minw):
    if certify(za, zb): return True, 1
    if zb - za <= minw: return False, 0
    m=(za+zb)//2
    a,ca=rec(za,m,minw)
    if not a: return False, ca
    b,cb=rec(m,zb,minw)
    return b, ca+cb
lo=0; hi=int(float(sys.argv[1])*W); step=int(float(sys.argv[2])*W)
z=lo; tot=0; ok=True
while z<hi:
    zb=min(z+step,hi)
    r,c=rec(z,zb,10**6); tot+=c
    if not r: print(f"FAIL near z={z/W:.9f}"); ok=False; break
    z=zb
print("36-decimal Horner: ratio certified non-increasing at every 1-wei step on [0,%.6f):"%(z/W), ok, "chunks", tot)
