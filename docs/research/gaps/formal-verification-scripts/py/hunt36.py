# Re-run the targeted crossing hunt on the X36 variant (lower branch) and on the continued-fraction branch.
import sys, random
from hart import *
random.seed(int(sys.argv[1])); N=int(sys.argv[2]); mode=sys.argv[3]
def E(z): return expWad(-(z*z//WAD//2))
if mode=="x36":
    lo_f,hi_f=5.0,7.07
    def c(z): e,n,d=parts36(z); return e*n//d
else:
    lo_f,hi_f=7.0711,9.1
    c=cf_tail
viol=0; cross=0; steps=0
for t in range(N):
    z=random.randint(int(lo_f*WAD),int(hi_f*WAD)); e0=E(z)
    if e0==0: continue
    a=z; s=1
    while E(a-s)==e0: a-=s; s*=2
    lo,hi=a-s,a
    while hi-lo>1:
        m=(lo+hi)//2
        if E(m)==e0: hi=m
        else: lo=m
    a=hi; b=z; s=1
    while E(b+s)==e0: b+=s; s*=2
    lo,hi=b,b+s
    while hi-lo>1:
        m=(lo+hi)//2
        if E(m)==e0: lo=m
        else: hi=m
    b=lo
    ka,kb=c(a),c(b)
    for k in range(kb+1,ka+1):
        lo,hi=a,b
        while hi-lo>1:
            m=(lo+hi)//2
            if c(m)>=k: lo=m
            else: hi=m
        cross+=1; W_=3000; prev=c(lo-W_)
        for zz in range(lo-W_+1,lo+W_):
            cur=c(zz); steps+=1
            if cur>prev: viol+=1
            prev=cur
print(mode,"drift-crossings",cross,"steps",steps,"violations",viol)
