# How often does the integer ratio Nn/Dd tick UP over a 1-wei step, and by how much (relative)?
from hart import *
import random
random.seed(3)
for zf in [float(a) for a in __import__("sys").argv[1].split(",")]:
    up=0; tot=0; worst=0.0; minmargin=None
    base=int(zf*WAD)+random.randint(0,10**12)
    _,n0,d0=parts(base)
    for z in range(base+1,base+200001):
        _,n1,d1=parts(z); tot+=1
        lhs=n1*d0-n0*d1   # >0  <=> ratio increased
        if lhs>0:
            up+=1; worst=max(worst,lhs/(n0*d1))
        n0,d0=n1,d1
    print(f"z~{zf}: ratio-up steps {up}/{tot}, max relative up-tick {worst:.3e}")
