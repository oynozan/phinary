"""(c)/(e) Monte Carlo of the settlement statistic that the oracle actually produces:
GBM reference at 12 s blocks -> band-follower pool (fee band +-f, arbs at top of block) -> end-of-block pool price
-> FLOOR tick -> tickCumulative over [T-w, T] (left-endpoint samples: the tick after block at T-w ... T-12s)
-> integer settlement rule. Compared with European N(d2), continuous geometric-Asian and discrete geometric-Asian
closed forms. Checks the half-tick threshold C = floor(w*(kappa - s/2)) in both token orientations."""
import numpy as np
from math import log, sqrt, floor, ceil
from scipy.stats import norm
from common import YEAR, LN1

DT = 12.0


def euro(x, sig, tau):  # x = ln(S/K), tau in years
    return norm.cdf((x - 0.5 * sig**2 * tau) / (sig * np.sqrt(tau)))


def asian_c(x, sig, tau, w):
    return norm.cdf((x - 0.5 * sig**2 * (tau - w / 2)) / (sig * np.sqrt(tau - 2 * w / 3)))


def asian_d(x, sig, tau, n, dt=DT / YEAR, v_extra=0.0):
    """discrete left-endpoint geometric average of n samples at T-w, T-w+dt, ..., T-dt (w = n dt), tau >= w."""
    w = n * dt
    mean = x - 0.5 * sig**2 * (tau - w + (n - 1) * dt / 2)
    var = sig**2 * ((tau - w) + dt * (n - 1) * (2 * n - 1) / (6 * n)) + v_extra
    return norm.cdf(mean / np.sqrt(var))


def asian_in_c(Abar_known, frac_known, lnS_minus_lnK, sig, tau, w):
    """continuous in-window: known average part (time fraction frac_known, mean log-moneyness Abar_known)."""
    mean = frac_known * Abar_known + (tau / w) * lnS_minus_lnK - 0.5 * sig**2 * tau**2 / (2 * w)
    sd = sig * tau**1.5 / (sqrt(3) * w)
    return norm.cdf(mean / sd)


def asian_in_d(sum_known, n, k, x, sig, dt=DT / YEAR):
    """discrete in-window: sum_known = sum of fixed samples' log-moneyness, k remaining samples (the first is the
    current block's end-of-block price ~ current spot x)."""
    mean = (sum_known + k * x - 0.5 * sig**2 * dt * k * (k - 1) / 2) / n
    var = sig**2 * dt * (k - 1) * k * (2 * k - 1) / (6 * n**2)
    return norm.cdf(mean / np.sqrt(var)) if var > 0 else (mean > 0).astype(float)


def run(x0, sig, tau_s, w_s, f, npaths, rng, burn=20, K=5000.0, chunk=100_000):
    """returns hit-rates for several settlement rules, conditional on reference ln(S/K) = x0 at trading time."""
    n = int(w_s / DT); tau = tau_s / YEAR; w = w_s / YEAR; dt = DT / YEAR; sb = sig * sqrt(dt)
    kappa = log(K * 1e-12) / LN1               # up-orientation log-tick of the strike (native ETH / USDC v4 pool)
    C_up = floor(n * DT * (kappa - 0.5))        # recommended: YES iff D > C_up
    C_up_naive = floor(n * DT * kappa)          # no half-tick correction
    Kt02 = ceil(kappa)                          # report 02: YES iff D >= K_tick * w
    C_dn = floor(n * DT * (kappa + 0.5))        # flipped orientation (v3 USDC/WETH): YES iff -D3 > C_dn
    lnK12 = log(K * 1e-12)
    hits = np.zeros(5); tot = 0
    for c0 in range(0, npaths, chunk):
        m = min(chunk, npaths - c0)
        pre = tau - w - (burn + 1) * dt  # so that the first window sample is the end-of-block price at T-w
        X = x0 + lnK12 - 0.5 * sig**2 * pre + sig * sqrt(pre) * rng.standard_normal(m)
        Y = X + rng.uniform(-f, f, m) if f > 0 else X.copy()
        D = np.zeros(m, np.int64); D3 = np.zeros(m, np.int64); Gx = np.zeros(m)
        for k in range(burn + n):
            X = X - 0.5 * sb * sb + sb * rng.standard_normal(m)
            Y = np.clip(Y, X - f, X + f) if f > 0 else X
            if k >= burn:
                ell = Y / LN1
                D += np.floor(ell).astype(np.int64) * int(DT)
                D3 += np.floor(-ell).astype(np.int64) * int(DT)
                Gx += Y
        hits += np.array([(D > C_up).sum(), (D > C_up_naive).sum(), (D >= Kt02 * n * int(DT)).sum(),
                          (-D3 > C_dn).sum(), (Gx / n > lnK12).sum()])
        tot += m
    p = hits / tot
    return p, np.sqrt(p * (1 - p) / tot), n


def run_pool_input(sig, f, tau_s, w_s, npaths, rng, lead=60, K=5000.0, chunk=100_000, spread_sd=2.0):
    """Calibration with the hook's actual input: the pool's own start-of-block price Y_t (not the CEX price).
    Paths start `lead` blocks before the trade time with random moneyness; returns arrays (x_ref, x_pool, outcome)."""
    n = int(w_s / DT); b = int((tau_s - w_s) / DT); dt = DT / YEAR; sb = sig * sqrt(dt)
    kappa = log(K * 1e-12) / LN1; C_up = floor(n * DT * (kappa - 0.5)); lnK12 = log(K * 1e-12)
    sd = sig * sqrt(tau_s / YEAR - 2 * w_s / YEAR / 3)
    XR, XP, O = [], [], []
    for c0 in range(0, npaths, chunk):
        m = min(chunk, npaths - c0)
        X = lnK12 + rng.uniform(-spread_sd, spread_sd, m) * sd
        Y = X + rng.uniform(-f, f, m)
        D = np.zeros(m, np.int64)
        for k in range(lead + b + n):
            X = X - 0.5 * sb * sb + sb * rng.standard_normal(m)
            Y = np.clip(Y, X - f, X + f)
            if k == lead - 1:
                XR.append(X - lnK12); XP.append(Y - lnK12)   # state at the end of the block before the trade = SoB
            if k >= lead + b:  # end-of-block samples at T-w ... T-12s (trade block = index lead, time t)
                D += np.floor(Y / LN1).astype(np.int64) * int(DT)
        O.append(D > C_up)
    return np.concatenate(XR), np.concatenate(XP), np.concatenate(O)


if __name__ == "__main__":
    rng = np.random.default_rng(2026)
    sig = 0.52
    print("rules: [R1] D > floor(w(kappa-1/2)) (recommended, up)  [R2] D > floor(w kappa) (no half-tick)  "
          "[R3] D >= ceil(kappa) w (report 02)  [R4] -D3 > floor(w(kappa+1/2)) (flipped v3 orientation)  [R0] continuous mean of pool log-price > ln K")
    for tau_min, w_min, f, npaths, xs in [(35, 30, 5e-4, 1_000_000, [-2, -1, -0.5, 0, 0.5, 1, 2]),
                                          (35, 30, 0.0, 1_000_000, [0, 1]),
                                          (65, 30, 5e-4, 600_000, [-1, 0, 1]),
                                          (35, 5, 5e-4, 1_000_000, [-1, 0, 1]),
                                          (35, 30, 3e-3, 600_000, [-1, 0, 1])]:
        tau = tau_min * 60 / YEAR; w = w_min * 60 / YEAR
        sd = sig * sqrt(tau - 2 * w / 3)
        print(f"\n=== tau={tau_min} min, w={w_min} min, f={f*1e4:.0f} bp, sigma={sig}, sd_G={sd*1e4:.1f} bp, {npaths:,} paths/point ===")
        print(f"{'x/sd':>5} | {'R1':>8} {'R2':>8} {'R3':>8} {'R4':>8} {'R0':>8} {'SE':>7} | {'euro':>8} {'asian_c':>8} {'asian_d':>8} | {'R1-asian_d (c)':>14}")
        for xm in xs:
            x = xm * sd
            p, se, n = run(x, sig, tau_min * 60, w_min * 60, f, npaths, rng)
            e, ac, ad = euro(x, sig, tau), asian_c(x, sig, tau, w), asian_d(x, sig, tau, n)
            print(f"{xm:5.1f} | {p[0]:8.5f} {p[1]:8.5f} {p[2]:8.5f} {p[3]:8.5f} {p[4]:8.5f} {se[0]:7.5f} | {e:8.5f} {ac:8.5f} {ad:8.5f} | {100*(p[0]-ad):+14.3f}")

    print("\n=== calibration with the hook's real input S = pool start-of-block price (tau = 35 min, w = 30 min) ===")
    for f in [5e-4, 1e-4, 3e-3]:
        tau_s, w_s = 35 * 60, 30 * 60; tau = tau_s / YEAR; w = w_s / YEAR; n = int(w_s / DT)
        xr, xp, o = run_pool_input(sig, f, tau_s, w_s, 1_000_000, rng)
        print(f"f = {f*1e4:.0f} bp: overall mean(outcome) - mean(formula):")
        for lab, x, vx in [("asian_d(S=CEX ref)", xr, 0.0), ("asian_d(S=pool)", xp, 0.0),
                           ("asian_d(S=pool)+f^2/3", xp, f * f / 3), ("asian_d(S=pool)-f^2/2", xp, -f * f / 2)]:
            P = asian_d(x, sig, tau, n, v_extra=vx)
            bins = np.digitize(P, [0.1, 0.3, 0.45, 0.55, 0.7, 0.9])
            rows = []
            for bi in range(7):
                sel = bins == bi
                if sel.sum() > 1000:
                    rows.append(f"{P[sel].mean():.3f}:{100*(o[sel].mean()-P[sel].mean()):+.2f}c")
            print(f"   {lab:24s} all {100*(o.mean()-P.mean()):+.3f}c | by bin (mean P : bias) " + "  ".join(rows))
