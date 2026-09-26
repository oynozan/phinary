"""(a) kappa_in, C(delta) and Q_safe per chain, from a band-follower replay on the REAL Binance path sampled at the chain's
oracle grid (Delta = 1 s Arbitrum, 2 s Base, 12 s Ethereum) and a GBM control at sigma = 0.52.

usage: python 02_attack_cost.py <arb|base|eth>

Model (identical to settlement-scripts/common.py:simulate_floor_attack, validated on L1 in the settlement report s2.4):
top-of-slot arbitrageurs clip the pool log-price into [X-f, X+f]; a committed attacker at the end of every slot lifts
it to the floor X-f+s; the oracle sample of the slot is the end-of-slot price. Cost is marked to the reference, LP
fee included, constant L (y_v = measured harmonic-mean virtual USDC reserve over the swap sample).
C scales linearly in n_w = w/Delta (stationary per-slot cost), so 2 h / 4 h costs are the per-slot cost x n_w.
Q_safe = committed-attacker bound of settlement-scripts/05_attack_econ.py (numerical optimum over shift and
moneyness at the cutoff tau = w + 5 min; spread 1 c/token; sd_G = sigma sqrt(tau - 2w/3))."""
import sys, numpy as np
from math import sqrt
sys.path.insert(0, "../settlement-scripts")
from common import simulate_floor_attack, YEAR
from importlib import import_module
ae = import_module("05_attack_econ")

chain = sys.argv[1]
z = np.load(f"data/grid_{chain}.npz")  # chain = grid tag (arb, base, base7, eth)
X, DELTA, yv, sig_real = z["X"], int(z["delta"]), float(z["yv_harm"]), float(z["sig"])
f = 5e-4
n30 = 1800 // DELTA
burn = max(50, 600 // DELTA)
L = burn + n30 + 1
starts = range(0, len(X) - L, n30 // 2)
XP = np.stack([X[s:s + L] - X[s] for s in starts])
s_in = [0.25 * f, 0.5 * f, 1.0 * f, 1.5 * f, 2.0 * f]
s_out = list(2 * f + np.linspace(0, 14 * 5e-4, 29)[1:])
s_all = s_in + s_out
print(f"=== {chain}: Delta={DELTA}s, n_w(30m)={n30}, y_v=${yv/1e6:.1f}M, realised sigma at Delta = {sig_real:.3f}, {XP.shape[0]} real windows ===")
real = simulate_floor_attack(None, DELTA, f, n30, s_all, burn=burn, X_paths=XP)
gbm = simulate_floor_attack(0.52, DELTA, f, n30, s_all, npaths=max(400, 600000 // n30), seed=7, burn=burn)
print(f"{'s/f':>5} {'shift bp':>8} {'real $':>10} {'GBM0.52 $':>10} {'kappa_real':>10} {'kappa_gbm':>9}")
for s in s_in + s_out[:6:2]:
    dr, cr = real[s][0], real[s][1] * yv; dg, cg = gbm[s][0], gbm[s][1] * yv
    kr = cr / (n30 * yv * dr * dr); kg = cg / (n30 * yv * dg * dg)
    print(f"{s/f:5.2f} {dr*1e4:8.2f} {cr:10,.0f} {cg:10,.0f} {kr:10.3f} {kg:9.3f}")


def curve(res, scale):
    d = np.array([0.0] + [res[s][0] for s in s_all]); c = np.array([0.0] + [res[s][1] * yv * scale for s in s_all])
    o = np.argsort(d); d, c = d[o], np.maximum.accumulate(c[o])
    return lambda x: np.interp(np.abs(x), d, c, right=np.inf)


print(f"\nC(delta) $ (real-path replay; GBM sigma 0.52 in brackets)")
dl = [2.5e-4, 5e-4, 1e-3, 2.5e-3]
print(f"{'w':>6} " + " ".join(f"{d*1e4:>18.1f}bp" for d in dl))
for wmin in (30, 120, 240):
    sc = wmin / 30
    cr, cg = curve(real, sc), curve(gbm, sc)
    print(f"{wmin:>4}m  " + " ".join(f"{float(cr(d)):>10,.0f} [{float(cg(d)):>8,.0f}]" for d in dl))

print(f"\nQ_safe $ (binary / ramp h=25bp / ramp h=100bp), committed attacker, spread 1c, sigma_G at 0.52; real-path curve [GBM curve]")
for wmin in (30, 120, 240):
    sc = wmin / 30
    tau = (wmin + 5) * 60 / YEAR; w = wmin * 60 / YEAR; sd = 0.52 * sqrt(tau - 2 * w / 3)
    cr, cg = curve(real, sc), curve(gbm, sc)
    qs = [(ae.q_safe(cr, h, sd, 0.01), ae.q_safe(cg, h, sd, 0.01)) for h in (0, 0.0025, 0.01)]
    k_w = float(cr(1e-4)) / 1e-8
    print(f"  w={wmin:>3}m sd_G={sd*1e4:5.1f}bp k_w(real)={k_w:.3g}/log^2  closed form 8*pi*s*k_w*sd^2 = {8*np.pi*0.01*k_w*sd*sd:,.0f}  | "
          + "  ".join(f"{a:>11,.0f} [{b:>11,.0f}]" for a, b in qs))
