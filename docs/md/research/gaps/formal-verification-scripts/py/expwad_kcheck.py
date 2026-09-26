# expWad (solady) monotonicity: (1) exhaustive check around every k-segment boundary in [-41.45, 0] (+-2e5 wei),
# (2) within-segment margin: internal r increases by >= min_dr per wei vs O(1) rounding jitter.
from hart import expWad, sdiv
from expwad_probe import internals
W=10**18
def kof(x): return internals(x)[0]
viol=0; checked=0; mindr=None; bnds=0
lo=-41446531673892822312
for k in range(kof(lo), 1):
    # first x with kof(x) >= k
    a,b=lo,0
    if kof(a)>=k: t=a
    else:
        while b-a>1:
            m=(a+b)//2
            if kof(m)>=k: b=m
            else: a=m
        t=b
    bnds+=1
    prev=expWad(max(t-200000,lo+1))
    for x in range(max(t-200000,lo+1)+1, min(t+200000,1)):
        cur=expWad(x); checked+=1
        if cur<prev: viol+=1
        prev=cur
    # within-segment internal slope at segment start
    r0=internals(t)[4]; r1=internals(t+1)[4]
    if kof(t+1)==kof(t):
        d=r1-r0; mindr=d if mindr is None else min(mindr,d)
print("k-boundaries",bnds,"steps checked",checked,"decreases",viol,"min internal dr per wei at boundaries",mindr)
