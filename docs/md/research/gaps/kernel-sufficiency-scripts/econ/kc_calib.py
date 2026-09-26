"""Paired calibration of the hook mid under P, OOS 2024-01..2026-09 (and IS 2021-2023): normal vs variance-matched t.
All strikes k in {-1.5..1.5} per non-overlapping listing (same markets as the backtest), mid in [p_min, 1-p_min].
Reports log loss, Brier, ECE (10 quantile bins), max bin error, and PAIRED differences with listing-clustered SEs
(moving-block bootstrap over listings, block = 1 week of listings, so overlapping-strike dependence is respected)."""
import numpy as np, lib, bt, engine as E
from scipy.special import ndtr, stdtr
A = bt.A; rng = np.random.default_rng(3)
def mids(tenor, kern, nu, sig, seas, t0, lnK):
    s = np.clip(A[sig][t0], 0.3, 2.0); var = s*s*tenor/lib.MPY
    if seas:
        yi = E.year_index(t0); rel = lib.how_of(t0)*60 + (t0 % 60)
        var = var*(A['SC'][yi, rel+tenor] - A['SC'][yi, rel])/tenor
    sd = np.sqrt(var); x = A['pool'][t0] - lnK
    z = (x - 0.5*sd*sd)/sd
    return ndtr(z) if kern == 'normal' else stdtr(nu, z/np.sqrt((nu-2)/nu))
def run(tenor, sig, seas, kernels, per):
    t0, lnK, _ = bt.markets(tenor, per[0], per[1])
    o = (A['pool'][t0 + tenor] > lnK).astype(float)
    P = {k: mids(tenor, kern, nu, sig, seas, t0, lnK) for k, (kern, nu) in kernels.items()}
    m = np.ones(len(t0), bool)
    for p in P.values(): m &= (p > 0.02) & (p < 0.98)
    lst = (t0 - t0.min())//max(tenor, 1)            # listing id
    wk = (t0 - bt.MON0)//10080
    uw, inv = np.unique(wk[m], return_inverse=True)
    out = {}
    for k, p in P.items():
        pp = np.clip(p[m], 1e-9, 1-1e-9); oo = o[m]
        ll = -(oo*np.log(pp) + (1-oo)*np.log(1-pp)); br = (pp-oo)**2
        q = np.quantile(pp, np.linspace(0, 1, 11)); b = np.clip(np.searchsorted(q, pp, side='right')-1, 0, 9)
        err = np.array([oo[b == g].mean() - pp[b == g].mean() for g in range(10)])
        out[k] = dict(ll=ll, br=br, ece=np.mean(np.abs(err))*100, mx=np.max(np.abs(err))*100, n=len(pp),
                      llw=np.bincount(inv, ll), brw=np.bincount(inv, br), cw=np.bincount(inv))
    return out, len(uw)
def ci_pair(xw, yw, cw, B=4000, block=4):
    n = len(cw); nb = int(np.ceil(n/block)); st = rng.integers(0, n-block+1, size=(B, nb)); idx = (st[:, :, None] + np.arange(block)).reshape(B, -1)[:, :n]
    d = (xw[idx].sum(1) - yw[idx].sum(1))/cw[idx].sum(1)
    return np.quantile(d, 0.025), np.quantile(d, 0.975)
SPEC = {1440: ('ewma1440', 0, {'normal': ('normal', None), 't4': ('t', 4.0), 't5': ('t', 5.0), 't6': ('t', 6.0)}),
        240: ('ewma240', 1, {'normal': ('normal', None), 't3.8': ('t', 3.8), 't4': ('t', 4.0)}),
        60: ('ewma240', 1, {'normal': ('normal', None), 't3.5': ('t', 3.5), 't4': ('t', 4.0)})}
for tenor, (sig, seas, K) in SPEC.items():
    for pn, per in (('OOS', ('2024-01-01', '2026-09-24')), ('IS', ('2021-01-01', '2024-01-01'))):
        out, nw = run(tenor, sig, seas, K, per)
        print(f'--- tenor {tenor} min, sigma {sig}{"+seas" if seas else ""}, {pn} {per}, weeks {nw}')
        for k, r in out.items():
            line = f'   {k:>6}: n {r["n"]:6d} logloss {r["ll"].mean():.5f} Brier {r["br"].mean():.5f} ECE {r["ece"]:.2f}pp max-bin {r["mx"]:.2f}pp'
            if k != 'normal':
                lo, hi = ci_pair(out['normal']['llw'], r['llw'], r['cw']); blo, bhi = ci_pair(out['normal']['brw'], r['brw'], r['cw'])
                line += f' | normal-{k}: dLL {out["normal"]["ll"].mean()-r["ll"].mean():+.5f} [{lo:+.5f},{hi:+.5f}] dBrier {out["normal"]["br"].mean()-r["br"].mean():+.5f} [{blo:+.5f},{bhi:+.5f}]'
            print(line, flush=True)
