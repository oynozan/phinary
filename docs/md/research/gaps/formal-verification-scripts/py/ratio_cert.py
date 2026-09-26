# Rigorous certificate: the integer Horner ratio Nn(z)/Dd(z) of the WAD Hart port is non-increasing at EVERY 1-wei step
# z -> z+1 for z in [0, zmax), proven chunk by chunk with exact rational interval bounds (no floating point).
# Bounds (z >= 0 integer, W = 1e18, all quantities non-negative):
#   h_{k+1}(z) = floor(h_k z / W) + C_{k+1};  p_k = exact real Horner;  0 <= p_k - h_k <= E_k,  E_{k+1} = E_k z/W + 1
#   delta_{k+1} = h_{k+1}(z+1) - h_{k+1}(z) = floor(a) - floor(b) in {floor(a-b), floor(a-b)+1},  a-b = (h_k(z) + delta_k (z+1))/W
#   => floor(((p_k-E_k) + L_k (z+1))/W) <= delta_{k+1} <= floor((p_k + U_k (z+1))/W) + 1
# Sufficient for ratio non-increase: U_N * Dmax <= Nmin * L_D  (then dN*D <= N*dD).
# Every bound is monotone in z on a chunk [za, zb], so evaluating uppers at zb and lowers at za is sound.
import sys
from fractions import Fraction as Fr
W=10**18
NC=[35262496599891100,700383064443688000,6373962203531650000,33912866078383000000,112079291497871000000,221213596169931000000,220206867912376000000]
DC=[88388347648318400,1755667163182640000,16064177579207000000,86780732202946100000,296564248779674000000,637333633378831000000,793826512519948000000,440413735824752000000]
def fl(x): return x.numerator//x.denominator
def bounds(C, za, zb):
    # returns (h_min at za, h_max at zb, Lfinal, Ufinal) for the Horner with coefficients C
    p_lo=Fr(C[0]); p_hi=Fr(C[0]); E_hi=Fr(0); L=0; U=0
    for c in C[1:]:
        # step bounds use the stage-k values
        L_new = fl(((p_lo - E_hi) + L*(za+1)) / W)      # lower uses za-values; E upper at zb
        U_new = fl((p_hi + U*(zb+1)) / W) + 1
        L, U = max(L_new,0), U_new
        p_lo = p_lo*za/W + c; p_hi = p_hi*zb/W + c
        E_hi = E_hi*zb/W + 1
    return p_lo - E_hi, p_hi, L, U
def certify(za, zb):
    Nmin,Nmax,LN,UN = bounds(NC,za,zb)
    Dmin,Dmax,LD,UD = bounds(DC,za,zb)
    return UN*Dmax <= Nmin*LD
zmax=float(sys.argv[1]); step=int(float(sys.argv[2])*W)
z=0; ok=True; chunks=0
while z < int(zmax*W):
    zb=min(z+step, int(zmax*W))
    if not certify(z, zb):
        # refine this chunk
        s=(zb-z)//16
        if s < 10**6:
            print(f"FAIL: cannot certify at z ~ {z/W:.6f} (chunk width {zb-z})"); ok=False; break
        sub=z; good=True
        while sub<zb:
            e=min(sub+s,zb)
            if not certify(sub,e): print(f"FAIL at z ~ {sub/W:.6f} width {e-sub}"); good=False; break
            sub=e; chunks+=1
        if not good: ok=False; break
    else: chunks+=1
    z=zb
print("certified ratio non-increasing on [0,%s):"%(z/W), ok, "chunks", chunks)

def rec(za, zb, minw):
    if certify(za, zb): return True, 1
    if zb - za <= minw: return False, 0
    m=(za+zb)//2
    a,ca=rec(za,m,minw)
    if not a: return False, ca
    b,cb=rec(m,zb,minw)
    return b, ca+cb
if len(sys.argv)>3:
    lo=int(float(sys.argv[3])*W); hi=int(zmax*W)
    z=lo; tot=0
    while z<hi:
        zb=min(z+step,hi)
        r,c=rec(z,zb,10**9); tot+=c
        if not r: print(f"recursive FAIL near z={z/W:.9f}"); break
        z=zb
    print("recursive certificate from",lo/W,"reached",z/W,"chunks",tot)
