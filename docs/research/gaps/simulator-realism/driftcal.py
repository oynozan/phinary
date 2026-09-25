"""Directional (drift) mispricing: (i) Thales trades - realised UP frequency minus Thales odds, token-weighted, and net flow direction;
(ii) 1d simulator markets - mean(1{UP} - hook mid at listing) by period (the per-token P&L of an UP-biased flow)."""
import pickle, numpy as np, math, sys, os
rows = pickle.load(open('rows.pkl', 'rb'))
cov = [r for r in rows if 'up_th' in r]
o = np.array([1.0 if r['res'] == 0 else 0.0 for r in cov]); p = np.array([r['up_th'] for r in cov]); q = np.array([r['q_up'] for r in cov]); w = np.abs(q)
print(f"Thales trades: token-weighted mean(1{{UP}} - Thales odds) = {100*np.average(o - p, weights=w):+.2f} pp; unweighted {100*np.mean(o-p):+.2f} pp; net trader UP-equivalent tokens {q.sum():+.0f} of gross {w.sum():.0f}")
for k in ('ETH', 'BTC'):
    m = np.array([r['key'] == k for r in cov]); print(f"   {k}: mean(1{{UP}} - odds) {100*np.average((o-p)[m], weights=w[m]):+.2f} pp, net UP tokens {q[m].sum():+.0f}")
# model edge split: net-direction component vs the rest
edge = q*(p - o); print(f"   model edge at mid ${edge.sum():+.0f}; of which from buyers of UP-equivalent ${edge[q > 0].sum():+.0f}, DOWN-equivalent ${edge[q < 0].sum():+.0f}")
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, '..', 'econ')); os.chdir(os.path.join(HERE, '..', 'econ'))
import bt, lib, engine as E
from scipy.stats import t as T
t0, lnK, _ = bt.markets(1440); A = bt.A; nu = 5.0; sc = math.sqrt((nu-2)/nu)
sd = A['ewma1440'][t0]*math.sqrt(1440/lib.MPY); mid = T.cdf((A['pool'][t0] - lnK - 0.5*sd*sd)/(sd*sc), nu); out = (A['pool'][t0+1440] > lnK).astype(float)
for name, a, b in (('IS 2021-23', '2021-01-01', '2024-01-01'), ('OOS 2024-26', '2024-01-01', '2026-09-25'), ('Thales era', '2023-05-09', '2025-02-04'), ('2022', '2022-01-01', '2023-01-01'), ('2024', '2024-01-01', '2025-01-01')):
    m = (t0 >= lib.minute_of(a)) & (t0 < lib.minute_of(b))
    d = out[m] - mid[m]; days = t0[m]//1440
    ud, inv = np.unique(days, return_inverse=True); dm = np.bincount(inv, weights=d)/np.bincount(inv)
    print(f"1d markets {name}: mean(1{{UP}} - mid) {100*d.mean():+.2f} pp (day-clustered SE {100*dm.std()/math.sqrt(len(dm)):.2f}); ETH log return over period {100*(A['cex'][lib.minute_of(b)-1]-A['cex'][lib.minute_of(a)]):+.0f}%")
