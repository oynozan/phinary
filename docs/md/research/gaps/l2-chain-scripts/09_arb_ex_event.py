"""Arbitrum pool-vs-CEX statistics recomputed without 2026-09-24 18:35-21:05 UTC (the 06 event +-1 h), to separate
normal-regime behaviour from the tail event.  Same definitions as 01_pool_vs_cex.py."""
import json, gzip, calendar, numpy as np, pandas as pd
z = np.load("data/grid_arb.npz"); g, Y, X = z["grid"], z["Y"], z["X"]
bn = json.load(gzip.open("data/bn1s.json.gz", "rt")); bts = np.array([r[0] for r in bn]); bpx = np.log(np.array([r[1] for r in bn]))
def cex(t): return bpx[np.clip(np.searchsorted(bts, t - 1, side="right") - 1, 0, len(bpx) - 1)]
EV = (calendar.timegm((2026, 9, 24, 18, 35, 0)), calendar.timegm((2026, 9, 24, 21, 5, 0)))
ok = ~((g >= EV[0]) & (g <= EV[1]))
F = 5e-4
e = z["e"][ok]
print(f"arb ex-event: {ok.sum()} slots; deviation sd {e.std()*1e4:.2f} bp; |e|<=f {np.mean(np.abs(e)<=F):.1%}; |e|<=2f {np.mean(np.abs(e)<=2*F):.1%}; p1/p99 {np.percentile(e,1)*1e4:.1f}/{np.percentile(e,99)*1e4:.1f}")
for age in [0, 1, 2, 4, 12, 60]:
    x = Y - cex(g + age); x = x - pd.Series(x).rolling(3600, center=True, min_periods=900).median().values
    print(f"  SoB error age {age:>2}s: sd {np.nanstd(x[ok])*1e4:.2f} bp")
dy = np.diff(Y); okd = ok[1:] & ok[:-1]
print("  lead-lag (1 s returns): " + "  ".join(f"L={L:+d}:{np.corrcoef(dy[okd], np.diff(cex(g - L))[okd])[0,1]:+.3f}" for L in [-2, -1, 0, 1, 2, 4, 12]))
g12 = g[::12]; Y12 = Y[::12]; ok12 = ok[::12]; o2 = ok12[1:] & ok12[:-1]
print("  lead-lag (12 s returns): " + "  ".join(f"L={L:+d}:{np.corrcoef(np.diff(Y12)[o2], np.diff(cex(g12 - L))[o2])[0,1]:+.3f}" for L in [-12, 0, 12, 24, 60]))
for h in [1, 2, 4, 12, 60]:
    Yh, Xh, oh = Y[::h], X[::h], ok[::h]; m = oh[1:] & oh[:-1]
    print(f"  beta({h:>2}s) = {np.polyfit(np.diff(Xh)[m], np.diff(Yh)[m], 1)[0]:.3f}", end="")
print()
