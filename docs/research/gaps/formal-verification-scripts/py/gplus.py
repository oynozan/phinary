# Integer E4 / Lemma M: naive g+ = Phi^(d) + k*phi^(d) (two separately rounded terms of opposite slope for d>0)
# vs factored g+ = 1 - floor(e*(R36 - kappa)) on d>0 (both factors >=0 and non-increasing on the enabled set).
import random
from hart import *
SQ=2506628274631000502
def phi_hat(d): return expWad(-(d*d//WAD//2))*WAD//SQ
def Phi_hat36(d): return (WAD - tail36(d)) if d>0 else tail36(-d)
def g_naive(d,k): return Phi_hat36(d) + k*phi_hat(d)//WAD
def g_fact(d,k):
    # d>0: 1 - e*(n36/d36 - k/sqrt(2pi)) with one final floor; computed as e*(n36*SQ - k*d36*1e? )/(d36*SQ)
    e,n,dd=parts36(d)
    num=e*(n*SQ - k*dd)          # e*(R - kappa)*dd*SQ  (R = n/dd, kappa = k/SQ in WAD units)
    h=num//(dd*SQ) if num>=0 else -((-num)//(dd*SQ))   # only used where num>=0 (enabled region)
    return WAD - h
random.seed(5)
for k in [5*10**17, 2*10**18, 10**17]:
    vn=vf=tot=0
    for _ in range(40):
        d0=random.randint(1, int(min(WAD*WAD//k, 7*WAD)*0.9))
        pn=g_naive(d0,k); pf=g_fact(d0,k)
        for d in range(d0+1,d0+5000):
            cn=g_naive(d,k); cf=g_fact(d,k); tot+=1
            if cn<pn: vn+=1
            if cf<pf and WAD-cf>0: vf+=1
            pn,pf=cn,cf
    print(f"k={k/1e18}: steps {tot}, naive decreases {vn}, factored decreases (enabled region) {vf}")
