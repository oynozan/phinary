"""Analysis for the kernel-sufficiency gap: D*, E3, E4 per kernel with the 1-s latency charge (L1 12 s / L2 2 s) of the
SAME configuration, and paired differences normal - t (weekly moving-block bootstrap, 4-week blocks, common resample indices;
latency uncertainty propagated by drawing the per-market latency charge from its listing-clustered sampling distribution)."""
import numpy as np, pickle, sys, bt, lib
from expA import IS, OOS
tenor = int(sys.argv[1]) if len(sys.argv) > 1 else 1440
R = pickle.load(open(f'kc/run_{tenor}.pkl', 'rb'))
L = pickle.load(open(f'kc/lat_{tenor*60}.pkl', 'rb'))
BF = bt.BFRAC; MON0 = bt.MON0
def lat(block, kn):
    x = L[(tenor*60, block, kn)]; xl = x.reshape(-1, 7).mean(1)
    return min(x.mean(), 0.0), xl.std()/np.sqrt(len(xl)), xl
def nmk(r, per):
    t = r['t0'] + tenor; m = (t >= lib.minute_of(per[0])) & (t < lib.minute_of(per[1]))
    nm = np.bincount((t[m] - MON0)//10080); return nm[nm > 0]
def series(r, per, agents=bt.REALISTIC):
    a = bt.lp_weekly(r, 0.0, per, True, agents); n = bt.parts(r, per)['noise']; return a, n, nmk(r, per)
rng = np.random.default_rng(11)
def boot_idx(nw, B=4000, block=4):
    nb = int(np.ceil(nw/block)); st = rng.integers(0, nw-block+1, size=(B, nb))
    return (st[:, :, None] + np.arange(block)).reshape(B, -1)[:, :nw]
def dstar(a, n, nm, lc, lse=0.0, idx=None, L0=None, grid=np.concatenate([np.linspace(0, 5, 201), np.linspace(5.05, 100, 1900)])):
    """smallest eta (=D at 1 d) with one-sided 95% MBB lower bound of mean weekly return > 0; latency charge lc per market
    (optionally drawn per replicate with SE lse)."""
    B = idx.shape[0]; lcs = np.minimum(L0 + lse*rng.standard_normal(B), 0) if lse > 0 else np.full(B, lc)
    A_ = a[idx].mean(1) + lcs*(nm[idx].mean(1))*BF; N_ = n[idx].mean(1)
    for e in grid:
        if np.quantile(A_ + e*N_, 0.05) > 0: return e
    return np.inf
out = []
def P(*x):
    s = ' '.join(str(v) for v in x); print(s, flush=True); out.append(s)
names = list(R)
for per_name, per in (('OOS', OOS), ('IS', IS)):
    P(f'\n=== {per_name} {per}, tenor {tenor} min; latency from 1-s sim (116 d, 2026-06..09) of the same config & kernel')
    S = {k: series(R[k], per) for k in names}
    Ss = {k: series(R[k], per, bt.REALISTIC + ('orv',)) for k in names}
    nw = len(S[names[0]][0]); idx = boot_idx(nw)
    for block, chain in ((12, 'L1'), (2, 'L2')):
        P(f'-- {chain} ({block} s blocks)')
        for k in names:
            a, n, nm = S[k]; lc, lse, _ = lat(block, k)
            d0 = dstar(a, n, nm, lc, 0.0, idx); d1 = dstar(a, n, nm, lc, lse, idx, L[(tenor*60, block, k)].mean())
            as_, ns_, _ = Ss[k]; ds = dstar(as_, ns_, nm, lc, 0.0, idx)
            eta0 = -(a.mean() + lc*nm.mean()*BF)/n.mean()
            P(f'  {k:>6}: latency charge {L[(tenor*60, block, k)].mean():+.4f}±{lse:.4f} B/mkt (charged {lc:+.4f}) | break-even eta0 {eta0:5.2f} | D* {d0:5.2f} (with latency SE: {d1:5.2f}) | D*_stress(+orv) {ds:6.2f}')
        for D in (2.0, 5.0):
            for k in names:
                a, n, nm = S[k]; lc, lse, _ = lat(block, k)
                w = a + D*n + lc*nm*BF; st = bt.stats(w)
                B = idx.shape[0]; lcs = np.minimum(L[(tenor*60, block, k)].mean() + lse*rng.standard_normal(B), 0)
                m_ = w[idx].mean(1) + (lcs - lc)*nm[idx].mean(1)*BF
                lo_l = 52*np.quantile(m_, 0.05)
                edge = (w.sum()/BF)/nm.sum()
                P(f'  D={D:.0f} {k:>6}: edge {edge:+.4f} B/mkt | ann {100*st["ann"]:+6.1f}% E3 lo95 {100*st["lo95"]:+6.1f}% (incl. latency SE {100*lo_l:+6.1f}%) '
                  f'| E4: CVaR95 {100*st["cvar95"]:.2f}% CVaR99 {100*st["cvar99"]:.2f}% maxDD {100*st["maxdd"]:.1f}% worst wk {100*st["worst"]:.2f}%')
            # paired differences normal - t
            for kt in [x for x in names if x != 'normal']:
                a0, n0, nm0 = S['normal']; a1, n1, nm1 = S[kt]
                l0, _, x0 = lat(block, 'normal'); l1, _, x1 = lat(block, kt)
                dl = x0 - x1; dls = dl.std()/np.sqrt(len(dl))
                w0 = a0 + D*n0 + l0*nm0*BF; w1 = a1 + D*n1 + l1*nm1*BF; dw = w0 - w1
                B = idx.shape[0]; r0 = x0.mean(); r1 = x1.mean(); z = rng.standard_normal(B)
                l0r = np.minimum(r0 + 0*z, 0); l1r = np.minimum(r1 - dls*z, 0)
                md = dw[idx].mean(1) + ((l0r - l1r) - (l0 - l1))*nm0[idx].mean(1)*BF
                edge_d = (dw.sum()/BF)/nm0.sum()
                sc = 1/(BF*nm0.mean())      # weekly NAV -> B per market
                P(f'  D={D:.0f} paired normal-{kt}: d(ann) {100*52*dw.mean():+6.1f}% [95% CI {100*52*np.quantile(md,0.025):+6.1f}, {100*52*np.quantile(md,0.975):+6.1f}] '
                  f'| d(edge) {edge_d:+.4f} B/mkt [{sc*np.quantile(md,0.025):+.4f}, {sc*np.quantile(md,0.975):+.4f}] | d(latency) {l0-l1:+.4f}±{dls:.4f}')
        # paired break-even difference
        for kt in [x for x in names if x != 'normal']:
            a0, n0, nm0 = S['normal']; a1, n1, nm1 = S[kt]
            l0, _, x0 = lat(block, 'normal'); l1, _, x1 = lat(block, kt); dls = (x0-x1).std()/np.sqrt(len(x0))
            B = idx.shape[0]; e = rng.standard_normal(B); l0s = np.minimum(x0.mean() + 0*e, 0); l1s = np.minimum(x1.mean() - dls*e, 0)     # shared noise on the difference
            e0 = -(a0[idx].mean(1) + l0s*nm0[idx].mean(1)*BF)/n0[idx].mean(1)
            e1 = -(a1[idx].mean(1) + l1s*nm1[idx].mean(1)*BF)/n1[idx].mean(1)
            d = e0 - e1
            as0, ns0, _ = Ss['normal']; as1, ns1, _ = Ss[kt]
            es0 = -(as0[idx].mean(1) + l0s*nm0[idx].mean(1)*BF)/ns0[idx].mean(1); es1 = -(as1[idx].mean(1) + l1s*nm1[idx].mean(1)*BF)/ns1[idx].mean(1); dsx = es0 - es1
            P(f'  STRESS(+orv) break-even eta0 normal-{kt}: {np.median(dsx):+.2f} [95% CI {np.quantile(dsx,0.025):+.2f}, {np.quantile(dsx,0.975):+.2f}]')
            P(f'  break-even eta0 normal-{kt}: {np.median(d):+.2f} [95% CI {np.quantile(d,0.025):+.2f}, {np.quantile(d,0.975):+.2f}]')
    # per-year (full sample, latency L1 charge included)
for D in (2.0, 5.0):
    P(f'\n=== per calendar year, D={D:.0f}, conservative, incl. L1 latency charge (ann. vault return)')
    for k in names:
        lc, _, _ = lat(12, k); ys = []
        for Y in range(2021, 2027):
            per = (f'{Y}-01-01', f'{Y+1}-01-01' if Y < 2026 else '2026-09-25')
            a, n, nm = series(R[k], per); w = a + D*n + lc*nm*BF; ys.append(f'{Y}:{100*52*w.mean():+.0f}%')
        P(f'  {k:>6}: ' + ' '.join(ys))
open(f'kc/an_{tenor}.txt', 'w').write('\n'.join(out))
