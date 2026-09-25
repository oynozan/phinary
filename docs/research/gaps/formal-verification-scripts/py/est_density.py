import mpmath as mp
mp.mp.dps=30
# drift-driven integer crossings of c = E*R over [4.47,7.07]: integral of c(z)*(1/m(z) - z) dz, c in wei, z real
def c(z): return mp.ncdf(-z)*1e18
def minv(z): return mp.npdf(z)/mp.ncdf(-z)
tot=mp.quad(lambda z: c(z)*(minv(z)-z), [4.47,5,6,7.07])
tot5=mp.quad(lambda z: c(z)*(minv(z)-z), [5,6,7.07])
print("drift crossings [4.47,7.07]: %.3e ; [5,7.07]: %.3e"%(tot,tot5))
rate=61/2129
print("estimated violating steps (x %.4f): %.2e ; density per wei step %.2e"%(rate, tot5*rate, tot5*rate/2.07e18))
