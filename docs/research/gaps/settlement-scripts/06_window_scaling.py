"""(b) Longer settlement window: scaling of C(delta) and of the committed-attacker OI cap with w (v3 5 bp source),
plus a pure-math check of the ramp closed form with f = 0."""
import numpy as np
from math import sqrt, log
from scipy.stats import norm
from common import YEAR, LN1
from importlib import import_module
ae = import_module("05_attack_econ")

sig = 0.52
print(f"{'w':>6} {'n_w':>5} {'sd_G(bp)':>8} {'C(2.5bp)':>9} {'C(5bp)':>9} {'C(10bp)':>9} {'C(30bp)':>10} | {'Q_safe binary':>13} {'ramp 50bp':>10} {'ramp 100bp':>10}")
for wmin, npaths in [(30, 3000), (60, 2000), (120, 1500), (240, 1000), (720, 400), (1440, 300)]:
    n_w = int(wmin * 60 / 12)
    C = ae.cost_curve(5e-4, 155.5e6, n_w, npaths=npaths)
    tau = (wmin + 5) * 60 / YEAR; w = wmin * 60 / YEAR; sd = sig * sqrt(tau - 2 * w / 3)
    q = [ae.q_safe(C, h, sd, 0.01) for h in [0, 0.005, 0.01]]
    print(f"{wmin:5d}m {n_w:5d} {sd*1e4:8.1f} {float(C(2.5e-4)):9,.0f} {float(C(5e-4)):9,.0f} {float(C(1e-3)):9,.0f} {float(C(3e-3)):10,.0f} | {q[0]:13,.0f} {q[1]:10,.0f} {q[2]:10,.0f}")

# ramp closed form vs exact discrete average of GBM samples (f = 0): isolates the formula from band effects
rng = np.random.default_rng(8); DT = 12.0; dt = DT / YEAR; sb = sig * sqrt(dt); n = 150; h = 0.0025
tau = 35 * 60 / YEAR; M = 600_000
print("\nramp h=25bp, f=0, tau=35m, w=30m: MC vs closed form")
for xm in [-1.0, 0.0, 0.7]:
    var = sig**2 * ((tau - n * dt) + dt * (n - 1) * (2 * n - 1) / (6 * n)); x = xm * sqrt(var)
    mu = x - 0.5 * sig**2 * (tau - n * dt + (n - 1) * dt / 2)
    pre = tau - n * dt
    X = x - 0.5 * sig**2 * pre + sig * sqrt(pre) * rng.standard_normal(M); S = np.zeros(M)
    for k in range(n):
        S += X; X = X - 0.5 * sb * sb + sb * rng.standard_normal(M)
    pay = np.clip((S / n + h) / (2 * h), 0, 1)
    print(f"  x/sd={xm:+.1f}: MC {pay.mean():.5f} +- {pay.std()/sqrt(M):.5f}  closed form {ae.ramp_price(mu, sqrt(var), h):.5f}")
