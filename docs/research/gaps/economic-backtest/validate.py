"""Validation of the simulator itself on synthetic GBM (known truth)."""
import numpy as np, lib, engine as E, bt, math
from scipy.stats import norm
rng = np.random.default_rng(3)
N = lib.N; sig = 0.6
dt = 1/lib.MPY
cex = np.log(3000) + np.cumsum(rng.normal(-0.5*sig*sig*dt, sig*np.sqrt(dt), N))
pool = lib.band_path(cex, 5e-4)
sigH = np.full(N, sig); sigA = np.full(N, sig)
Q = E.emp_tables(pool, sigA)
out = {}
for tenor in (1440, 60):
    t0, lnK, le = bt.markets(tenor)
    # recompute strikes on the synthetic path
    sdr = sig*np.sqrt(tenor/lib.MPY); t0u = t0[::7]
    lnK = (pool[t0u][:, None] + bt.KS[None, :]*sdr).ravel()
    yidx = E.year_index(t0).astype(np.int64); ttab = E.t_table(5.0)
    for name, kw in [('noise+lat, lag0', dict(tail=0, dir=0)), ('all agents', dict()), ('lat only lag1', dict(tail=0, dir=0, lag=1))]:
        c = dict(bt.DEF); c.update(kw)
        P = bt.pvec(c, tenor); o = np.zeros((len(t0), 9))
        E.run_hook(t0, tenor, lnK, cex, pool, sigH, sigA, ttab, Q, yidx, A_SC := bt.A['SC'], P, 11, o)
        n = len(t0)
        print(f"tenor {tenor} {name:>18}: min market pnl {o[:, :3].sum(1).min():+.4f}  per-market LP pnl lat {o[:,0].mean():+.5f}±{o[:,0].std()/np.sqrt(n):.5f} tail {o[:,1].mean():+.5f}±{o[:,1].std()/np.sqrt(n):.5f} dir {o[:,2].mean():+.5f}±{o[:,2].std()/np.sqrt(n):.5f} noise {o[:,3].mean():+.5f}±{o[:,3].std()/np.sqrt(n):.5f} (vol {o[:,7].mean():.3f}) | vols lat {o[:,4].mean():.3f} tail {o[:,5].mean():.3f}")
    # noise expected = sum over trades of spread (+ lam*q/2); compute expected spread averaged over active steps
