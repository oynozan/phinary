"""Latency-arb LP loss from the engine vs the semi-analytic formula (05 sec 4.5): sum_j E[((|gap_j|-s_j)^+)^2]/(2 lam)."""
import numpy as np, lib, engine as E, bt, math
from scipy.stats import norm
rng = np.random.default_rng(5); N = lib.N; sig = 0.6; dt = 1/lib.MPY
cex = np.log(3000) + np.cumsum(rng.normal(-0.5*sig*sig*dt, sig*np.sqrt(dt), N)); pool = cex.copy()
sigH = np.full(N, sig); Q = E.emp_tables(pool, sigH)
tenor = 1440; cut = 60
t0 = np.arange(lib.minute_of('2021-01-01'), N - 3000, 1440).astype(np.int64); lnK = pool[t0].copy()   # ATM at listing
yidx = E.year_index(t0).astype(np.int64)
c = dict(bt.DEF); c.update(tail=0, dir=0, lag=1, cut=cut, noise_trades=0, budget=1e9, cdelta=0.0, s=0.002, pmin=0.0)
P = bt.pvec(c, tenor); o = np.zeros((len(t0), 9))
E.run_hook(t0, tenor, lnK, cex, pool, sigH, sigH, E.t_table(5.0), Q, yidx, bt.A['SC'], P, 1, o)
print('engine: mean LP pnl vs latency arb per market', o[:,0].mean(), '+-', o[:,0].std()/np.sqrt(len(t0)), 'n', len(t0))
# semi-analytic via MC over the same law: gap_j = P(x_j) - P(x_{j-1}) with x the log-moneyness; E over GBM paths
M = 20000; lam = c['lam']; s = c['s']; tot = 0.0
x = np.zeros(M)  # ln(S/K) at listing = 0
xs = [x.copy()]
for j in range(1, tenor - cut):
    x = x + rng.normal(-0.5*sig*sig*dt, sig*np.sqrt(dt), M); xs.append(x.copy())
acc = np.zeros(M)
for j in range(1, tenor - cut):
    tau = (tenor - j)/lib.MPY; sd = sig*np.sqrt(tau)
    pn = norm.cdf((xs[j] - 0.5*sd*sd)/sd); po = norm.cdf((xs[j-1] - 0.5*sd*sd)/sd)
    e = np.maximum(np.abs(pn - po) - s - 0.001, 0); acc += e**2/(2*lam) + 0.001*e/lam     # arb profit = lam q^2/2 + m q
lvr = acc.mean(); print('semi-analytic expected LVR (the LP loss):', lvr, '+-', acc.std()/np.sqrt(M))
