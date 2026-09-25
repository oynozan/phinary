"""Driver for the extended agent set (econ/bt.py conventions: agents in isolation + noise, conservative LP accounting, MBB break-even)."""
import numpy as np, sys, os, json
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, '..', 'econ'))
os.chdir(os.path.join(HERE, '..', 'econ'))
import bt, lib, engine as E, engine_x as X
A = bt.A
AGX = ['lat', 'tail', 'iv', 'orv', 'dir', 'jump', 'smile', 'drift', 'noise']
EV = np.load(os.path.join(HERE, 'events.npz'))
def smile_arrays(t0, tenor, fit_files):
    fits = {}
    for f in fit_files:
        if os.path.exists(f):
            for k, v in json.load(open(f)).items():
                if v: fits[int(k)] = v
    byT = {}
    for k in sorted(fits):
        v = fits[k]; byT.setdefault(v['T'], []).append(v)
    sm_t = []; sm_co = []; j0 = np.zeros(len(t0), np.int64); n = np.zeros(len(t0), np.int64)
    idx = {}
    for T, lst in byT.items():
        idx[T] = len(sm_t)
        for v in lst:
            sm_t.append((v['t'] - lib.T0)//60000); sm_co.append([v['a'], v['b'], v['c'], v['kmin'], v['kmax']])
        idx[T] = (idx[T], len(lst))
    for m, t in enumerate(t0):
        Tms = lib.T0 + (int(t) + tenor)*60000
        if Tms in idx: j0[m], n[m] = idx[Tms]
    return j0, n, np.array(sm_t, np.int64) if sm_t else np.zeros(1, np.int64), np.array(sm_co) if sm_co else np.zeros((1, 5))
XDEF = dict(ev_on=0.0, halt_pre=0, halt_post=0, skew=0.0, jump=0, smile=0, jsm=0, drift_lb=365.0, eta_inv=0.0)
def pvec(c, tenor):
    p = bt.pvec(c, tenor)
    return np.concatenate([p, [c['ev_on'], c['halt_pre'], c['halt_post'], c['skew'], c['jump'], c['smile'], c['jsm'], c['drift_lb'], c['eta_inv']]])
FITS = [os.path.join(HERE, 'deribit', f) for f in ('oos_fit.json', 'is_fit.json')]
def run(tenor, cfg=None, start='2021-01-01', end=None, agents=('lat', 'tail', 'iv', 'orv', 'dir', 'jump', 'smile'), ev_scale=1.0, sm_mode='full', **kw):
    c = dict(bt.DEF); c.update(XDEF); c.update(cfg or {}); c.update(kw)
    t0, lnK, le = bt.markets(tenor, start, end, list_every=c.get('list_every'))
    j0, n, smt, smc = smile_arrays(t0, tenor, FITS)
    if sm_mode != 'full' and len(smt) > 1:
        smc = smc.copy()
        if sm_mode == 'level': smc[:, 1] = 0.0; smc[:, 2] = 0.0                 # flat smile at the Deribit ATM level
        elif sm_mode == 'shape': smc[:, 0] = A['ewma1440'][np.clip(smt, 0, len(A['ewma1440'])-1)]   # hook's sigma level, Deribit skew/curvature
        elif sm_mode == 'skewonly': smc[:, 0] = A['ewma1440'][np.clip(smt, 0, len(A['ewma1440'])-1)]; smc[:, 2] = 0.0
    yidx = E.year_index(t0).astype(np.int64); ttab = E.t_table(bt.NU[tenor])
    sigH = bt.sig_policy(c); sigA = A[c['sig']]; Qt = A['Q_'+c['sig']]
    evm = EV['m'].astype(np.int64); evJ = EV['J2']*ev_scale
    pnl = np.zeros((len(t0), 9)); vol = np.zeros((len(t0), 9))
    off = {k: 0 for k in AGX[:8]}; off['jsm'] = 0; off.pop('drift')
    def one(flags):
        cc = dict(c); cc.update(flags); out = np.zeros((len(t0), 18))
        X.run_hook_x(t0, tenor, lnK, A['cex'], A['pool'], sigH, sigA, ttab, Qt, yidx, A['SC'], pvec(cc, tenor), cc['seed'], out,
                     A['dvol'], A['cum'], evm, evJ, j0, n, smt, smc)
        return out
    base = one(off); pnl[:, 8] = base[:, 8]; vol[:, 8] = base[:, 17]
    for i, a in enumerate(AGX[:8]):
        if a not in agents: continue
        f = dict(off); f['jsm' if a == 'drift' else a] = 1; o = one(f); pnl[:, i] = o[:, i]; vol[:, i] = o[:, 9+i]
    return dict(t0=t0, tenor=tenor, le=le, pnl=pnl, vol=vol, cfg=c, mech='hook', has_smile=n > 0)
def mask(r, period):
    texp = r['t0'] + r['tenor']; msk = np.ones(len(texp), bool)
    if period: msk = (texp >= lib.minute_of(period[0])) & (texp < lib.minute_of(period[1]))
    return msk
def parts(r, period=None, msk=None):
    texp = r['t0'] + r['tenor']; wk = (texp - bt.MON0)//10080
    m = mask(r, period) if msk is None else msk
    wk = wk[m]; w0 = wk.min(); cnt = np.bincount(wk - w0); keep = cnt > 0
    return {k: (np.bincount(wk - w0, weights=r['pnl'][m, i])*bt.BFRAC)[keep] for i, k in enumerate(AGX)}, cnt[keep]
def lp_weekly(r, eta, period, agents, lat_charge=0.0, conservative=True, msk=None):
    p, nm = parts(r, period, msk)
    tot = eta*p['noise'] + lat_charge*nm*bt.BFRAC
    used = []
    for k in agents:
        if (not conservative) or p[k].sum() < 0: tot = tot + p[k]; used.append(k)
    return tot, used
def breakeven(r, period, agents, lat_charge=0.0, msk=None):
    a, used = lp_weekly(r, 0.0, period, agents, lat_charge, msk=msk); n = parts(r, period, msk)[0]['noise']
    if n.mean() <= 0: return np.inf, used
    ok = lambda e: bt.mbb_mean_ci(a + e*n, B=1000)[0] > 0
    g = bt.GRID
    if not ok(g[-1]): return np.inf, used
    if ok(g[0]): return g[0], used
    lo, hi = 0, len(g)-1
    while hi - lo > 1:
        mid = (lo+hi)//2
        if ok(g[mid]): hi = mid
        else: lo = mid
    return g[hi], used
def attribution(r, period=None, msk=None):
    m = mask(r, period) if msk is None else msk; nm = m.sum()
    return {k: (r['pnl'][m, i].sum()/nm, r['vol'][m, i].sum()/nm) for i, k in enumerate(AGX)}
