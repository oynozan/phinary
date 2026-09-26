"""
05 - Realized-variance estimator statistics for sigma estimated from the underlying Uniswap pool.
"""
import numpy as np
from scipy.stats import norm, chi2
from math import sqrt, log

rng = np.random.default_rng(11)
YEAR = 365 * 86400
LN_TICK = log(1.0001)


def rv_stats(sig, W, dts, mu=0.0, npaths=20000):
    """dts: array of sampling intervals (seconds) summing to W. Returns mean/var of sigma2_hat = RV/W (annualised)."""
    dts = np.asarray(dts, float) / YEAR
    m = mu - 0.5 * sig**2
    r = m * dts + sig * np.sqrt(dts) * rng.standard_normal((npaths, len(dts)))
    s2 = (r**2).sum(1) / dts.sum()
    return s2


if __name__ == "__main__":
    sig = 0.8
    W = 86400  # 1-day window
    print("=== (a) unbiasedness & variance, 1-day window, sigma=0.8 ===")
    for label, dts in [
        ("regular 5-min (n=288)", np.full(288, 300.0)),
        ("regular 1-min (n=1440)", np.full(1440, 60.0)),
        ("irregular Exp(5min) swap-driven", None),
        ("irregular heavy (Pareto) gaps", None),
    ]:
        if dts is None:
            if "Exp" in label:
                g = rng.exponential(300, 2000)
            else:
                g = (rng.pareto(1.5, 2000) + 1) * 100
            c = np.cumsum(g)
            g = g[c < W]
            dts = np.append(g, W - g.sum())
        s2 = rv_stats(sig, W, dts)
        n = len(dts)
        theo_var = 2 * sig**4 * np.sum((dts / YEAR) ** 2) / (W / YEAR) ** 2
        print(f"{label:34s} n={n:5d}: E[s2]={s2.mean():.5f} (true {sig**2:.5f}), Var[s2]={s2.var():.3e}, "
              f"theory 2s^4 sum(dt^2)/W^2={theo_var:.3e}, 2s^4/n={2*sig**4/n:.3e}; rel SE(sigma_hat)={np.std(np.sqrt(s2))/sig:.4f} vs 1/sqrt(2n)={1/sqrt(2*n):.4f}")

    print("\n=== drift contamination: mu=+300%/yr (extreme), regular 5-min ===")
    s2 = rv_stats(sig, W, np.full(288, 300.0), mu=3.0)
    print(f"E[s2]={s2.mean():.6f} vs sigma^2={sig**2}; theoretical bias m^2*dt = {(3.0-0.32)**2*300/YEAR:.2e}")

    print("\n=== (b) chi-square CI coverage (regular sampling, zero drift), 95% nominal ===")
    for n in [24, 96, 288, 1440]:
        dts = np.full(n, W / n)
        s2 = rv_stats(sig, W, dts, npaths=40000)
        lo = s2 * n / chi2.ppf(0.975, n)
        hi = s2 * n / chi2.ppf(0.025, n)
        cov = np.mean((lo <= sig**2) & (sig**2 <= hi))
        print(f"n={n:5d}: coverage={cov:.4f}; typical 95% CI for sigma: [{sqrt(n/chi2.ppf(0.975,n)):.3f}, {sqrt(n/chi2.ppf(0.025,n)):.3f}] x sigma_hat")

    print("\n=== (c) tick quantisation (slot0.tick = floor(log_1.0001 P)) ===")
    npaths = 2000
    dt = 12
    nb = W // dt
    x = np.cumsum(-0.5 * sig**2 * dt / YEAR + sig * sqrt(dt / YEAR) * rng.standard_normal((npaths, nb)), 1) + log(4000)
    for every in [1, 5, 25, 300]:
        xs = x[:, ::every]
        ticks = np.floor(xs / LN_TICK)
        rv_true = (np.diff(xs, axis=1) ** 2).sum(1)
        rv_tick = ((np.diff(ticks, axis=1) * LN_TICK) ** 2).sum(1)
        print(f"sample every {every*dt:>5}s: E[RV_tick]/E[RV_exact] = {rv_tick.mean()/rv_true.mean():.4f}  (predicted 1 + ln(1.0001)^2/6 / (sig^2 dt) = {1 + LN_TICK**2/6/(sig**2*every*dt/YEAR):.4f})")

    print("\n=== (d) microstructure: pool price = CEX GBM reflected into a no-arb band of half-width gamma (fee) ===")
    for fee_bps in [5, 30]:
        gam = fee_bps * 1e-4
        p = x[:, 0].copy()
        pool = np.empty_like(x)
        for k in range(nb):
            dev = x[:, k] - p
            p = np.where(dev > gam, x[:, k] - gam, np.where(dev < -gam, x[:, k] + gam, p))
            pool[:, k] = p
        for every in [1, 5, 25, 300]:
            ps = pool[:, ::every]
            xs = x[:, ::every]
            rvp = (np.diff(ps, axis=1) ** 2).sum(1) / ((xs.shape[1] - 1) * every * dt / YEAR)
            rvx = (np.diff(xs, axis=1) ** 2).sum(1) / ((xs.shape[1] - 1) * every * dt / YEAR)
            print(f"fee={fee_bps:>2}bp sample {every*dt:>5}s: E[s2_pool]/sigma^2-1={rvp.mean()/0.64-1:+.3%} (exact-CEX-sampled: {rvx.mean()/0.64-1:+.3%}); sqrt-ratio={np.sqrt(rvp.mean()/0.64):.4f}")

    print("\n=== (e) price error from sigma estimation error: SE(P) ~ |vega| * sigma/sqrt(2n) = n(d2)|d1|/sqrt(2n) ===")
    for K_over_S in [1.0, 1.05, 1.1, 1.25]:
        for Td in [1, 7, 30]:
            T = Td / 365
            d1 = (log(1 / K_over_S) + 0.5 * sig**2 * T) / (sig * sqrt(T))
            d2 = d1 - sig * sqrt(T)
            vega = norm.pdf(d2) * abs(d1)  # per unit relative vol change (dP/dln sigma)
            print(f"K/S={K_over_S:.2f} T={Td:>2}d: P={norm.cdf(d2):.4f} |dP/dln(sig)|={vega:.4f}; SE(P) with n=288 (1d@5min): {vega/sqrt(576):.4f}; n=2016 (7d@5min): {vega/sqrt(4032):.4f}; 10% vol error -> {vega*0.1:.4f}")

    print("\n=== (f) EWMA sigma^2_t = lam sigma^2_{t-1} + (1-lam) r_t^2/dt : effective n and SE ===")
    for lam in [0.94, 0.97, 0.99, 0.997]:
        neff = (1 + lam) / (1 - lam)
        print(f"lambda={lam}: n_eff=(1+lam)/(1-lam)={neff:.0f}, rel SE(sigma_hat) ~ 1/sqrt(2 n_eff) = {1/sqrt(2*neff):.3f}")
