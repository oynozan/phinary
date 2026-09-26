"""(c) Exact integer thresholds for K = $5,000, w = 1800 s, both orientations (mpmath, 50 digits)."""
from mpmath import mp, log, floor, ceil, mpf
mp.dps = 50
K = mpf(5000); w = 1800; one = mpf('1.0001')
k_up = log(K * mpf(10)**-12) / log(one)      # native ETH (currency0) / USDC (currency1): raw price = K*1e-12
k_v3 = log(mpf(10)**12 / K) / log(one)       # v3 USDC (token0) / WETH (token1): raw price = 1e12/K
print("kappa (up orientation)          ", k_up)
print("kappa (v3 USDC/WETH orientation)", k_v3)
print("UP:   YES iff D > floor(w*(kappa-1/2)) =", floor(w * (k_up - mpf(1) / 2)), " (mean tick threshold", k_up - mpf(1) / 2, ")")
print("V3:   YES iff D < ceil(w*(kappa-1/2))  =", ceil(w * (k_v3 - mpf(1) / 2)))
print("no half-tick (D > floor(w kappa)) fires on average at G ~", mpf(10)**-(-12) * one**(k_up + mpf(1) / 2))
print("report 02 rule (D >= ceil(kappa) w): tick price", mpf(10)**12 * one**ceil(k_up), " average effective strike", mpf(10)**12 * one**(ceil(k_up) + mpf(1) / 2))
