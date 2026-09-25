import mpmath as mp, random
from hart import *
mp.mp.dps=40
worst=0; worst0=0; arg=None
for i in range(0, 70710):
    z=i*10**14
    ex=mp.ncdf(-mp.mpf(z)/WAD)*WAD
    e1=abs(tail36(z)-ex); e0=abs(tail(z)-ex)
    if e1>worst: worst,arg=e1,z/WAD
    worst0=max(worst0,e0)
print(f"max |tail36 - Phi(-z)| on [0,7.07) step 1e-4: {mp.nstr(worst,4)} wei at z={arg};  original WAD port: {mp.nstr(worst0,4)} wei")
print("cut error at SPLIT: Phi(-7.0710678)*1e18 =", mp.nstr(mp.ncdf(-mp.mpf('7.07106781186547'))*WAD,6), "wei")
print("junction original: tail(SPLIT-1)=",tail(SPLIT-1),"tail(SPLIT)=",tail(SPLIT))
