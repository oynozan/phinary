"""(e) Trading inside the settlement window: accuracy of the continuous vs discrete in-window formulas and why
in-window trading is unsafe (in-band manipulation reach vs remaining uncertainty)."""
import numpy as np
from math import sqrt
from scipy.stats import norm
from common import YEAR
from importlib import import_module
pm = import_module("02_pricing_mc")

rng = np.random.default_rng(99)
sig, DT = 0.52, 12.0; dt = DT / YEAR; sb = sig * sqrt(dt); n = 150; w = n * dt
print("=== in-window pricing: n=150 samples (30 min, 12 s), sigma=0.52, f=0 (pure math check) ===")
print(f"{'k left':>6} {'MC':>8} {'SE':>7} {'discrete':>9} {'continuous':>11}")
for k, target in [(75, 0.4), (25, 0.4), (10, 0.4), (5, 0.4), (2, 0.4)]:
    # choose the known part so that the discrete price is ~target with current log-moneyness x=0
    var = sig**2 * dt * (k - 1) * k * (2 * k - 1) / (6 * n**2)
    mean_needed = norm.ppf(target) * sqrt(var)
    sum_known = mean_needed * n + 0.5 * sig**2 * dt * k * (k - 1) / 2   # x = 0
    M = 1_000_000
    x = np.zeros(M); s = np.full(M, sum_known)
    for j in range(k):
        s += x                                     # sample j = end-of-block price at t + j*dt (j=0: current block)
        x = x - 0.5 * sb * sb + sb * rng.standard_normal(M)
    hit = (s / n > 0).mean()
    tau = (k) * dt  # time until T measured from the current block (samples at 0..k-1)
    frac_known = (n - k) / n
    cont = pm.asian_in_c(sum_known / (n - k), frac_known, 0.0, sig, tau, w)
    disc = pm.asian_in_d(sum_known, n, k, 0.0, sig)
    print(f"{k:6d} {hit:8.4f} {sqrt(hit*(1-hit)/M):7.4f} {float(disc):9.4f} {float(cont):11.4f}")

print("\n=== leverage of in-band manipulation inside the window (5 bp pool, L1) ===")
print(f"{'k left':>6} {'sd of remaining mean (bp)':>26} {'in-band reach f*k/n (bp)':>25} {'reach/sd':>9} {'max dP from reach (c)':>22}")
f = 5e-4
for k in [150, 75, 25, 10, 5, 2, 1]:
    sd = sb * sqrt((k - 1) * k * (2 * k - 1) / 6) / n
    reach = f * k / n
    dP = (2 * norm.cdf(reach / (2 * sd)) - 1) if sd > 0 else 1.0
    print(f"{k:6d} {sd*1e4:26.3f} {reach*1e4:25.3f} {reach/sd if sd>0 else float('inf'):9.2f} {100*dP:22.1f}")
