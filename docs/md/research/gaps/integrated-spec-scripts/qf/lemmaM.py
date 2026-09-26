"""Which quote-function theorems transfer to the discrete-Asian binary, the ramp payoff, and a Student-t kernel.
(1) Generalised Lemma M: g+(x) = P(x) + kap*P'(x). If P' is log-concave, the set where g+ decreases is a half-line [x0, inf)
    and 1 - P(x) < kap*P'(x) there, so g+ > 1 > 1 - p_min: the band halt covers every decreasing region (monotone in S).
    Numerical check of 'g+ decreasing => g+ > 1' (and the mirror for g-) on dense grids.
(2) Martingale / QV identity behind Theorem L's sum: E[P_cut] = P_0 and E[sum dP^2] = E[P_cut^2] - P_0^2 <= P_0(1-P_0) for the
    Asian mid evaluated each epoch up to the cutoff (GBM, discrete oracle samples).
(3) Per-epoch delta bound used by Q_epoch: binary Asian P' = phi(d)/sqrt(v) ; ramp P' <= 1/(2h)."""
import numpy as np
from scipy.stats import norm, t as tdist
from math import sqrt

def check(P, dP, d2P, xs, kaps, label):
    worst_up = np.inf; worst_dn = np.inf; nviol = 0; ncheck = 0; ex = None
    for kap in kaps:
        p = P(xs); dp = dP(xs); ddp = d2P(xs)
        gp = p + kap * dp; gpd = dp + kap * ddp
        gm = p - kap * dp; gmd = dp - kap * ddp
        dec_p = gpd < -1e-15; dec_m = gmd < -1e-15
        ncheck += dec_p.sum() + dec_m.sum()
        if dec_p.any():
            m = (gp[dec_p] - 1).min(); worst_up = min(worst_up, m)
            if m <= -0.02 and ex is None: ex = ('g+', kap, xs[dec_p][np.argmin(gp[dec_p])], gp[dec_p].min())
        if dec_m.any():
            m = (-gm[dec_m]).min(); worst_dn = min(worst_dn, m)
            if m <= -0.02 and ex is None: ex = ('g-', kap, xs[dec_m][np.argmax(gm[dec_m])], gm[dec_m].max())
        nviol += ((gp[dec_p] <= 1 - 0.02).sum() + (gm[dec_m] >= 0.02).sum())
    print(f'{label:62s} checked {ncheck:8d} decreasing points | min(g+ - 1) {worst_up:+.3e}  min(0 - g-) {worst_dn:+.3e} | '
          f'in-band decreasing points (monotonicity violations) {nviol}  example {ex}')
    return nviol

x = np.linspace(-40, 40, 160001)
kaps = [0.01, 0.03, 0.1, 0.3, 1, 3, 10]
# (a) Asian binary: P = Phi(x) in units of sqrt(v) -- identical to the European form in d
check(norm.cdf, norm.pdf, lambda z: -z * norm.pdf(z), x, kaps, 'Asian binary Phi(mu/sqrt v) (units of sqrt v)')
# (b) ramp, units of sqrt v; half-width hh = h/sqrt(v)
tot = 0
for hh in [0.05, 0.2, 0.5, 1, 2, 5, 10]:
    P = lambda z, hh=hh: ((z + hh) * norm.cdf(z + hh) + norm.pdf(z + hh) - (z - hh) * norm.cdf(z - hh) - norm.pdf(z - hh)) / (2 * hh)
    dP = lambda z, hh=hh: (norm.cdf(z + hh) - norm.cdf(z - hh)) / (2 * hh)
    d2P = lambda z, hh=hh: (norm.pdf(z + hh) - norm.pdf(z - hh)) / (2 * hh)
    tot += check(P, dP, d2P, x, kaps, f'ramp h/sqrt(v) = {hh}')
    # log-concavity of P' (the lemma's hypothesis): second difference of log P' <= 0
    xx = np.linspace(-25, 25, 20001); pv = dP(xx); xx = xx[pv > 1e-200]
    dPs = np.where(xx > 0, norm.sf(xx - hh) - norm.sf(xx + hh), norm.cdf(xx + hh) - norm.cdf(xx - hh)) / (2 * hh)
    xx = xx[dPs > 1e-250]; dPs = dPs[dPs > 1e-250]
    lp = np.log(dPs); d2 = np.diff(lp, 2)
    print(f'    ramp h/sqrt(v)={hh}: max second difference of log P\' = {d2.max():+.2e} (<= 0 => log-concave)')
# (c) Student-t (variance matched), units of sd: P = F_nu(z/sc)
for nu in (3.5, 3.8, 5.0):
    sc = sqrt((nu - 2) / nu)
    P = lambda z, nu=nu, sc=sc: tdist.cdf(z / sc, nu)
    dP = lambda z, nu=nu, sc=sc: tdist.pdf(z / sc, nu) / sc
    d2P = lambda z, nu=nu, sc=sc: tdist.pdf(z / sc, nu) / sc * (-(nu + 1) * (z / sc) / (nu + (z / sc) ** 2)) / sc
    nv = check(P, dP, d2P, x, kaps, f'Student-t nu={nu} (variance-matched)')
    # largest kap with no in-band decreasing point
    lo = 0.0
    for kap in np.geomspace(0.005, 10, 400):
        gp = P(x) + kap * dP(x); gpd = dP(x) + kap * d2P(x)
        if ((gpd < -1e-15) & (gp <= 0.98)).any(): break
        lo = kap
    print(f'    t nu={nu}: largest kap (units of sd) with no in-band decreasing point = {lo:.3f}; '
          f'global monotone bound 2*sqrt(nu)*sc/(nu+1) = {2*sqrt(nu)*sc/(nu+1):.3f}')

# (2) martingale / QV of the Asian mid up to the cutoff (GBM, 60 s steps, discrete 12 s oracle samples in the formula)
rng = np.random.default_rng(3)
YEAR = 365 * 86400; sig = 0.6; w = 7200; dt = 12; n = w // dt; tau0 = 86400; cut = w + 300
we = dt * (n - 1) * (2 * n - 1) / (6 * n)
def price(x, tau):
    s2 = sig * sig / YEAR; mu = x - 0.5 * s2 * (tau - w + (n - 1) * dt / 2); v = s2 * ((tau - w) + we)
    return norm.cdf(mu / np.sqrt(v))
M = 40000; step = 60
x = np.zeros(M) + rng.normal(0, 0.02, M)       # random moneyness at listing
P0 = price(x, tau0); qv = np.zeros(M); P = P0.copy()
for tau in range(tau0 - step, cut - 1, -step):
    x = x - 0.5 * sig * sig * step / YEAR + sig * sqrt(step / YEAR) * rng.standard_normal(M)
    Pn = price(x, tau); qv += (Pn - P) ** 2; P = Pn
# continue to T with 12 s samples in the window to get the realised payoff
xs = x.copy(); tau = cut
while tau > w:
    xs = xs - 0.5 * sig * sig * dt / YEAR + sig * sqrt(dt / YEAR) * rng.standard_normal(M); tau -= dt
G = np.zeros(M)
for k in range(n):
    G += xs; xs = xs - 0.5 * sig * sig * dt / YEAR + sig * sqrt(dt / YEAR) * rng.standard_normal(M)
G /= n; pay = (G > 0).astype(float)
print(f'\nAsian mid martingale check (w=2h, cutoff w+5min, 1-min re-quotes): E[P_cut - P_0] = {np.mean(P - P0):+.5f} +- {np.std(P - P0)/sqrt(M):.5f}; '
      f'E[payoff - P_cut] = {np.mean(pay - P):+.5f} +- {np.std(pay - P)/sqrt(M):.5f}')
print(f'  E[sum dP^2] = {qv.mean():.5f}  vs  E[P_cut^2]-E[P_0^2] = {np.mean(P**2) - np.mean(P0**2):.5f}  <=  E[P_0(1-P_0)] = {np.mean(P0*(1-P0)):.5f}')
