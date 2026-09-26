# Targeted hunt: crossings of c=floor(E*Nn/Dd) that happen INSIDE an E-plateau (drift-driven), where ratio up-ticks can flicker.
import sys, random
from hart import *
random.seed(int(sys.argv[2]) if len(sys.argv)>2 else 11)
lo_f,hi_f=[float(a) for a in sys.argv[1].split(",")]
N=int(sys.argv[3]) if len(sys.argv)>3 else 300
def E(z): return expWad(-(z*z//WAD//2))
def c(z):
    e,n,d=parts(z); return e*n//d
found=[]; plateaus=0; drift_cross=0; steps=0
for t in range(N):
    z=random.randint(int(lo_f*WAD),int(hi_f*WAD)); e0=E(z)
    # plateau [a,b] with E==e0 (E non-increasing in z)
    a=z; s=1
    while E(a-s)==e0: a-=s; s*=2
    lo,hi=a-s,a   # E(lo)!=e0, E(hi)==e0
    while hi-lo>1:
        m=(lo+hi)//2
        if E(m)==e0: hi=m
        else: lo=m
    a=hi
    b=z; s=1
    while E(b+s)==e0: b+=s; s*=2
    lo,hi=b,b+s
    while hi-lo>1:
        m=(lo+hi)//2
        if E(m)==e0: lo=m
        else: hi=m
    b=lo; plateaus+=1
    ka,kb=c(a),c(b)
    if ka==kb: continue
    # there may be several integer levels; bisect for each level crossing k -> k-1 inside the plateau
    for k in range(kb+1,ka+1):
        lo,hi=a,b   # c(lo)>=k, c(hi)<k
        while hi-lo>1:
            m=(lo+hi)//2
            if c(m)>=k: lo=m
            else: hi=m
        drift_cross+=1
        W=3000; prev=c(lo-W)
        for zz in range(lo-W+1,lo+W):
            cur=c(zz); steps+=1
            if cur>prev: found.append((zz-1,prev,cur))
            prev=cur
print(f"range [{lo_f},{hi_f}] plateaus {plateaus} drift-crossings {drift_cross} steps scanned {steps} violations {len(found)}")
for v in found[:8]:
    z=v[0]; print(f"  z={z} ({z/WAD:.18f}): tail(z)={v[1]} tail(z+1)={v[2]}  tail via hart.tail: {tail(z)} {tail(z+1)}")
