"""Calibrate a partial-reversion follower to each real pool: every slot, arbitrageurs remove a fraction rho of the
excess beyond the fee band (rho = 1 is the band follower of 02_attack_cost.py).  Fit rho by the robust (MAD) tracking
error between the model path driven by Binance and the real pool's oracle samples, over 1 h de-meaned deviations.
The 2026-09-24 19:35-20:05 UTC Arbitrum event is excluded from the fit (reported separately in 06)."""
import numpy as np, pandas as pd, calendar
f = 5e-4
EV = (calendar.timegm((2026, 9, 24, 19, 35, 0)), calendar.timegm((2026, 9, 24, 20, 5, 0)))
def follow(X, rho):
    Y = np.empty_like(X); y = X[0]
    for i in range(len(X)):
        x = X[i]
        if y > x + f: y -= rho * (y - x - f)
        elif y < x - f: y += rho * (x - f - y)
        Y[i] = y
    return Y
for tag in ["arb", "base7", "eth"]:
    z = np.load(f"data/grid_{tag}.npz"); X, Yp, g, D = z["X"], z["Y"], z["grid"], int(z["delta"])
    k = max(1, 3600 // D)
    basis = pd.Series(Yp - X).rolling(k, center=True, min_periods=k // 4).median().values
    Xa = X + basis  # reference in pool units
    keep = ~((g >= EV[0]) & (g <= EV[1]))
    e_real = (Yp - Xa)[keep]
    mad = lambda v: 1.4826 * np.median(np.abs(v - np.median(v)))
    res = []
    for rho in [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0]:
        Ym = follow(Xa, rho)
        te = (Yp - Ym)[keep]
        res.append((rho, mad(te), np.std(te), np.std((Ym - Xa)[keep])))
    best = min(res, key=lambda r: r[1])
    print(f"=== {tag} (Delta {D} s): real deviation sd {np.std(e_real)*1e4:.2f} bp (MAD {mad(e_real)*1e4:.2f}); rho fit by tracking-error MAD:")
    for rho, m, s, sm in res: print(f"   rho={rho:4.2f}/slot: tracking MAD {m*1e4:5.2f} bp, sd {s*1e4:5.2f} bp; model deviation sd {sm*1e4:5.2f} bp" + ("   <- best" if rho == best[0] else ""))

# second family: full reversion (rho = 1) but an effective band f_eff >= f (arbs need edge beyond the LP fee)
print("\nfull-reversion band follower with effective band f_eff:")
for tag in ["arb", "base7", "eth"]:
    z = np.load(f"data/grid_{tag}.npz"); X, Yp, g, D = z["X"], z["Y"], z["grid"], int(z["delta"])
    k = max(1, 3600 // D)
    Xa = X + pd.Series(Yp - X).rolling(k, center=True, min_periods=k // 4).median().values
    keep = ~((g >= EV[0]) & (g <= EV[1]))
    mad = lambda v: 1.4826 * np.median(np.abs(v - np.median(v)))
    out = []
    for fe in [4e-4, 5e-4, 6e-4, 7e-4, 8e-4]:
        f = fe; Ym = follow(Xa, 1.0); te = (Yp - Ym)[keep]; out.append((fe, mad(te), np.std(te)))
    f = 5e-4
    b = min(out, key=lambda r: r[1])
    print(f"  {tag}: " + "  ".join(f"f_eff={fe*1e4:.0f}bp MAD {m*1e4:.2f} sd {s*1e4:.2f}" + ("*" if fe == b[0] else "") for fe, m, s in out))
