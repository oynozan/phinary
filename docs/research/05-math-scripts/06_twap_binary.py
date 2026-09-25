"""
06 - Binary on the geometric average (tick-TWAP) over the final window w vs European binary.
Closed forms (r = 0, log-drift m = b - sigma^2/2 with b = 0 under Q):
  before window (tau >= w):  d2G = [ln(S/K) + m (tau - w/2)] / (sigma sqrt(tau - 2w/3))
  inside window (tau < w):   ln G ~ N( (A + tau ln S + m tau^2/2)/w , sigma^2 tau^3 / (3 w^2) ),  A = int_{T-w}^{t} ln S_u du
"""
import numpy as np
from scipy.stats import norm
from math import sqrt, log

rng = np.random.default_rng(3)
YEAR = 365 * 86400


def euro(S, K, sig, tau, b=0.0):
    m = b - 0.5 * sig**2
    return norm.cdf((np.log(S / K) + m * tau) / (sig * np.sqrt(tau)))


def geo_before(S, K, sig, tau, w, b=0.0):
    m = b - 0.5 * sig**2
    return norm.cdf((np.log(S / K) + m * (tau - w / 2)) / (sig * np.sqrt(tau - 2 * w / 3)))


def geo_inside(S, K, sig, tau, w, A, b=0.0):
    m = b - 0.5 * sig**2
    mean = (A + tau * np.log(S) + m * tau**2 / 2) / w
    sd = sig * tau**1.5 / (sqrt(3) * w)
    return norm.cdf((mean - log(K)) / sd)


def mc_before(S, K, sig, tau, w, n=200000, steps=600):
    m = -0.5 * sig**2
    x0 = log(S) + m * (tau - w) + sig * sqrt(tau - w) * rng.standard_normal(n)
    dt = w / steps
    inc = m * dt + sig * sqrt(dt) * rng.standard_normal((n, steps))
    path = np.concatenate([x0[:, None], x0[:, None] + np.cumsum(inc, 1)], 1)
    avg = (path[:, :-1] + path[:, 1:]).sum(1) * 0.5 / steps  # trapezoid on log price
    hit = avg > log(K)
    return hit.mean(), hit.std() / sqrt(n)


if __name__ == "__main__":
    print("=== MC verification of the closed forms ===")
    for S, K, sig, Th, wm in [(4000, 4000, 0.8, 1, 30), (4000, 4040, 0.8, 24, 30), (4000, 3950, 1.2, 1, 5)]:
        tau = Th * 3600 / YEAR
        w = wm * 60 / YEAR
        p_mc, se = mc_before(S, K, sig, tau, w)
        print(f"S={S} K={K} sig={sig} T={Th}h w={wm}min: closed-form geo={geo_before(S,K,sig,tau,w):.5f}  MC={p_mc:.5f} +- {se:.5f}   (euro={euro(S,K,sig,tau):.5f})")
    # inside-window check: t = T - 10min, w = 30 min, 20 min already elapsed with running log-avg a (A = a*20min)
    sig, w, tau = 0.8, 30 * 60 / YEAR, 10 * 60 / YEAR
    S, K = 4000.0, 4000.0
    a = log(3990.0)
    A = a * (w - tau)
    n, steps = 200000, 600
    dt = tau / steps
    inc = -0.5 * sig**2 * dt + sig * sqrt(dt) * rng.standard_normal((n, steps))
    path = np.concatenate([np.full((n, 1), log(S)), log(S) + np.cumsum(inc, 1)], 1)
    I = (path[:, :-1] + path[:, 1:]).sum(1) * 0.5 * dt
    G = (A + I) / w
    hit = G > log(K)
    print(f"inside window (10min left, running geo-avg 3990, S=4000, K=4000): closed-form={geo_inside(S,K,sig,tau,w,A):.5f} MC={hit.mean():.5f} +- {hit.std()/sqrt(n):.5f}")

    print("\n=== |P_geo - P_euro| at t=0 : ATM value and max over spot (S/K in [0.8,1.25]) ===")
    grid = 4000 * np.exp(np.linspace(log(0.8), log(1.25), 4001))
    print(f"{'sigma':>5} {'T':>4} {'w':>6} | {'ATM euro':>9} {'ATM geo':>9} {'diff':>9} | {'max|diff|':>9} {'at S/K':>7} | {'sigma_eff/sigma':>15}")
    for sig in [0.4, 0.8, 1.2]:
        for Th, lab in [(1, "1h"), (24, "1d"), (168, "7d")]:
            for wm in [5, 30]:
                tau = Th * 3600 / YEAR
                w = wm * 60 / YEAR
                pe = euro(grid, 4000, sig, tau)
                pg = geo_before(grid, 4000, sig, tau, w)
                d = np.abs(pg - pe)
                i = int(np.argmax(d))
                print(f"{sig:5.1f} {lab:>4} {wm:>4}m | {euro(4000,4000,sig,tau):9.5f} {geo_before(4000,4000,sig,tau,w):9.5f} {geo_before(4000,4000,sig,tau,w)-euro(4000,4000,sig,tau):+9.5f} | {d[i]:9.5f} {grid[i]/4000:7.4f} | {sqrt(1-2*w/(3*tau)):15.4f}")

    print("\n=== floor(tick) bias of the tick-TWAP: E[floor] = x/ln(1.0001) - 1/2  => settlement price biased by ~0.5 tick ===")
    xs = rng.uniform(log(3000), log(5000), 1_000_000)
    t = np.floor(xs / log(1.0001))
    print("mean(tick*ln(1.0001) - ln S) =", float(np.mean(t * log(1.0001) - xs)), " vs -ln(1.0001)/2 =", -log(1.0001) / 2)
