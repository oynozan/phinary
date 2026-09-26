"""(b) Remedies: binary vs ramp (log call-spread) payoff, longer window, median vs cost-weighted mean of pools,
open-interest caps. Cost curves C(delta) come from the band-follower simulation (validated against the real
Binance path in 04). Attack models evaluated at the trading cutoff tau = w + 5 min (worst moneyness):
  M1 'committed': attacker holding Q chooses one shift delta at the cutoff knowing only the cutoff state.
  M2 'clairvoyant': attacker knows the unmanipulated settlement statistic G and picks delta ex post
      (upper bound for any adaptive attacker, since spreading a shift over the whole window is cheapest)."""
import numpy as np
from math import sqrt, log, floor
from scipy.stats import norm
from common import simulate_floor_attack, YEAR, LN1

sig, DT = 0.52, 12.0


def cost_curve(f, yv, n_w, smax_mult=14, npaths=3000, seed=3):
    s_list = list(np.linspace(0, 2 * f, 9)[1:]) + list(2 * f + np.linspace(0, smax_mult * 5e-4, 29)[1:])
    r = simulate_floor_attack(sig, DT, f, n_w, s_list, npaths=npaths, seed=seed)
    d = np.array([0.0] + [r[s][0] for s in s_list]); c = np.array([0.0] + [r[s][1] * yv for s in s_list])
    o = np.argsort(d); d, c = d[o], np.maximum.accumulate(c[o])
    return lambda x: np.interp(np.abs(x), d, c, right=np.inf)


def ramp_price(mu, sd, h):
    a, b = -h, h
    t1 = (mu - a) * norm.cdf((mu - a) / sd) + sd * norm.pdf((mu - a) / sd)
    t2 = (mu - b) * norm.cdf((mu - b) / sd) + sd * norm.pdf((mu - b) / sd)
    return (t1 - t2) / (2 * h)


def price_fn(h, sd):
    return (lambda x: norm.cdf(x / sd)) if h == 0 else (lambda x: ramp_price(x, sd, h))


def payoff_fn(h):
    return (lambda g: (g > 0).astype(float)) if h == 0 else (lambda g: np.clip((g + h) / (2 * h), 0, 1))


D = np.linspace(0, 0.006, 601)  # candidate shifts 0..60 bp


def m1_profit(Q, C, h, sd):
    P = price_fn(h, sd); best = 0.0
    CD = C(D)
    for x in np.linspace(-3 * sd, 0.5 * sd, 71):  # attacker long YES, shifts up
        g = Q * (P(x + D) - P(x)) - CD
        best = max(best, g.max())
    return best


def m2_loss(Q, C, h, sd, npts=4001):
    Pi = payoff_fn(h); CD = C(D); worst = 0.0
    G = np.linspace(-6 * sd, 6 * sd, npts)
    gain = np.max(Q * (Pi(G[:, None] + D[None, :]) - Pi(G[:, None])) - CD[None, :], axis=1)
    gain = np.maximum(gain, 0)
    for x in np.linspace(-1.5 * sd, 1.5 * sd, 31):
        wts = norm.pdf(G, x, sd); wts /= wts.sum()
        worst = max(worst, float((gain * wts).sum()))
    return worst


def q_safe(C, h, sd, spread):
    lo, hi = 0.0, 5e7
    for _ in range(40):
        mid = sqrt(max(lo, 1) * hi)
        if m1_profit(mid, C, h, sd) <= spread * mid: lo = mid
        else: hi = mid
    return lo


if __name__ == "__main__":
    # --- ramp closed form vs discrete oracle (band follower 5 bp) -------------------------------------
    from importlib import import_module
    pm = import_module("02_pricing_mc")
    rng = np.random.default_rng(5)
    tau_s, w_s, f, h = 35 * 60, 30 * 60, 5e-4, 0.0025
    n = int(w_s / DT); tau = tau_s / YEAR; dt = DT / YEAR; sb = sig * sqrt(dt)
    K = 5000.0; kappa = log(K * 1e-12) / LN1; lnK12 = log(K * 1e-12); hT = h / LN1
    Clo = n * DT * (kappa - 0.5 - hT); Chi = n * DT * (kappa - 0.5 + hT)
    print("=== ramp payoff (h = 25 bp): closed form vs discrete-oracle MC (f = 5 bp, tau = 35 min, w = 30 min) ===")
    for xm in [-1.0, 0.0, 0.7]:
        sdG = sig * sqrt(tau - 2 * n * dt / 3); x = xm * sdG; M = 600_000
        pre = tau - n * dt - 21 * dt
        X = x + lnK12 - 0.5 * sig**2 * pre + sig * sqrt(pre) * rng.standard_normal(M); Y = X + rng.uniform(-f, f, M)
        Dc = np.zeros(M, np.int64)
        for k in range(20 + n):
            X = X - 0.5 * sb * sb + sb * rng.standard_normal(M); Y = np.clip(Y, X - f, X + f)
            if k >= 20: Dc += np.floor(Y / LN1).astype(np.int64) * int(DT)
        pay = np.clip((Dc - Clo) / (Chi - Clo), 0, 1)
        var = sig**2 * ((tau - n * dt) + dt * (n - 1) * (2 * n - 1) / (6 * n)); mu = x - 0.5 * sig**2 * (tau - n * dt + (n - 1) * dt / 2)
        print(f"  x/sd={xm:+.1f}: MC {pay.mean():.5f} +- {pay.std()/sqrt(M):.5f}   closed form {ramp_price(mu, sqrt(var), h):.5f}   (binary {norm.cdf(mu/sqrt(var)):.5f})")

    # --- cost curves ----------------------------------------------------------------------------------
    cfgs = {
        "v3 5bp, w=30m": (5e-4, 155.5e6, 150),
        "v3 5bp, w=2h": (5e-4, 155.5e6, 600),
        "v3 5bp, w=4h": (5e-4, 155.5e6, 1200),
        "v3 1bp (f_eff 3bp), w=30m": (3e-4, 58.0e6, 150),
        "v3 30bp, w=30m": (3e-3, 199.1e6, 150),
    }
    C = {k: cost_curve(*v) for k, v in cfgs.items()}
    print("\n=== C(delta) in $ (band-follower sim, sigma=0.52, L1 12 s) ===")
    dl = [1e-4, 2.5e-4, 5e-4, 1e-3, 2e-3, 3e-3]
    print(f"{'source':34s} " + " ".join(f"{d*1e4:>8.1f}bp" for d in dl))
    for k in cfgs: print(f"{k:34s} " + " ".join(f"{float(C[k](d)):>10,.0f}" for d in dl))
    c5, c1, c30 = C["v3 5bp, w=30m"], C["v3 1bp (f_eff 3bp), w=30m"], C["v3 30bp, w=30m"]
    C["median(1bp,5bp,30bp), w=30m"] = lambda x: np.sort(np.stack([c5(x), c1(x), c30(x)]), 0)[:2].sum(0)
    # cost-weighted mean of 5bp and 1bp: weights fixed at creation, w_i proportional to curvature k_i = C_i(2bp)/(2bp)^2
    k5, k1 = float(c5(2e-4)) / 4e-8, float(c1(2e-4)) / 4e-8
    w5, w1 = k5 / (k5 + k1), k1 / (k5 + k1)

    def cmix(x):
        x = np.atleast_1d(np.abs(x)); out = np.empty_like(x, dtype=float)
        a = np.linspace(0, 1, 201)
        for i, dd in enumerate(x):
            # shift share a*dd/w5 on 5bp, (1-a)*dd/w1 on 1bp -> weighted mean moves by dd
            out[i] = np.min(c5(a * dd / w5) + c1((1 - a) * dd / w1))
        return out
    C[f"weighted mean 5bp/1bp ({w5:.2f}/{w1:.2f}), w=30m"] = cmix
    for k in list(C)[-2:]: print(f"{k:34s} " + " ".join(f"{float(np.atleast_1d(C[k](d))[0]):>10,.0f}" for d in dl))

    # --- attack economics -----------------------------------------------------------------------------
    print("\n=== M1 committed attacker: Q_safe (max gross OI per settlement window with attack profit <= spread paid), $ ===")
    hs = [0, 0.001, 0.0025, 0.005, 0.01]
    print(f"{'source':44s} {'sd_G bp':>7} " + " ".join(f"{('binary' if h==0 else f'ramp h={h*1e4:.0f}bp'):>14}" for h in hs))
    for k, Ck in C.items():
        wmin = 30 if "30m" in k else (120 if "2h" in k else 240)
        tau = (wmin + 5) * 60 / YEAR; w = wmin * 60 / YEAR; sd = sig * sqrt(tau - 2 * w / 3)
        row = [q_safe(Ck, h, sd, 0.01) for h in hs]
        print(f"{k:44s} {sd*1e4:7.1f} " + " ".join(f"{q:>14,.0f}" for q in row))
    print("   (spread paid by the attacker = 1c per token; worst-case moneyness at the cutoff tau = w + 5 min)")

    print("\n=== M2 clairvoyant upper bound on expected LP/counterparty loss, % of Q, worst moneyness at cutoff ===")
    for k in ["v3 5bp, w=30m", "v3 5bp, w=4h", f"weighted mean 5bp/1bp ({w5:.2f}/{w1:.2f}), w=30m"]:
        Ck = C[k]; wmin = 30 if "30m" in k else 240
        tau = (wmin + 5) * 60 / YEAR; w = wmin * 60 / YEAR; sd = sig * sqrt(tau - 2 * w / 3)
        for h in [0, 0.0025, 0.01]:
            row = [100 * m2_loss(Q, Ck, h, sd) / Q for Q in [1e4, 1e5, 1e6]]
            print(f"  {k:40s} {('binary' if h==0 else f'ramp h={h*1e4:.0f}bp'):>12}: Q=$10k {row[0]:6.2f}%  Q=$100k {row[1]:6.2f}%  Q=$1M {row[2]:6.2f}%")
