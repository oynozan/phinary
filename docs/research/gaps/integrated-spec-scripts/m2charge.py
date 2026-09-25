"""M2 clairvoyant settlement-manipulation charge for the frozen spec: attacker builds a one-sided position Q at the strike
(bought from the vault, so the vault is short Q) and pushes the w-window TWAP ex post when profitable. Net attacker gain (M2 as in
the settlement report) and the gross transfer the vault actually loses. Worst moneyness at the cutoff over [-1.5, 1.5] sd."""
import sys, pickle, numpy as np
from scipy.stats import norm
from math import sqrt
import spec
CC = pickle.load(open('out/costcurves.pkl', 'rb'))
def m2(Q, C, sd, npts=4001):
    Dg = np.linspace(0, 0.006, 601); CD = C(Dg)
    G = np.linspace(-6 * sd, 6 * sd, npts)
    flip = (G[:, None] + Dg[None, :] > 0) & (G[:, None] <= 0)          # binary: YES wins only after the push
    gain = Q * flip - CD[None, :]
    k = np.argmax(gain, axis=1); g = gain[np.arange(len(G)), k]; att = g > 0
    worst = (0, 0, 0)
    for x in np.linspace(-1.5 * sd, 1.5 * sd, 31):
        wts = norm.pdf(G, x, sd); wts /= wts.sum()
        net = float((np.maximum(g, 0) * wts).sum()); gross = float((Q * att * wts).sum())
        if gross > worst[1]: worst = (net, gross, x / sd)
    return worst
for ch in ('L1', 'L2'):
    for w in (30, 120, 240):
        g, Cv = CC[(ch, w)]; C = lambda x, g=g, Cv=Cv: np.interp(np.abs(x), g, np.where(np.isfinite(Cv), Cv, 1e30))
        for sig in (0.40, 0.55, 0.80):
            _, v = spec.asian_mu_v(0, sig, spec.cut_window(w * 60), w * 60, spec.CHAIN[ch]['dt_s']); sd = sqrt(v)
            row = []
            for Q in (10e3, 40e3, 100e3):
                net, gross, xm = m2(Q, C, sd); row.append(f'Q=${Q/1e3:.0f}k net {100*net/Q:.2f}% gross {100*gross/Q:.2f}%')
            print(f'{ch} w={w:3d}m sigma {sig:.2f} sd_G {sd*1e4:5.1f}bp | ' + ' | '.join(row))
