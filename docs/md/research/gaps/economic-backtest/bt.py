"""Driver: builds markets, runs engine configs, aggregates weekly LP returns, bootstrap CIs, break-even noise."""
import numpy as np, lib, engine as E, os, pickle, time
from scipy.stats import t as tdist
CACHE = os.path.join(os.path.dirname(__file__), 'out', 'arrays.pkl')
if os.path.exists(CACHE):
    A = pickle.load(open(CACHE, 'rb'))
else:
    A = {}
    A['cex'] = lib.LOGS.copy(); A['pool'] = lib.POOL.copy()
    for h in (240, 1440, 4320): A[f'ewma{h}'] = lib.ewma_sigma(lib.POOL, h)
    dv = lib.dvol_minutely(); dv[np.isnan(dv)] = A['ewma1440'][np.isnan(dv)]*1.07; A['dvol'] = dv
    A['SC'] = E.season_cums(lib.LOGS)
    A['cum'] = np.concatenate([[0.0], np.cumsum(np.diff(lib.LOGS)**2)])   # cum[t] = sum of squared 1m CEX returns up to minute t (oracle-vol agent)
    for k in ('ewma240', 'ewma1440', 'ewma4320', 'dvol'): A['Q_'+k] = E.emp_tables(lib.POOL, A[k], A['SC'])
    # walk-forward nu per tenor (fit on 2020 data only -> fixed; documented)
    pickle.dump(A, open(CACHE, 'wb'))
KS = np.array([-1.5, -1, -0.5, 0, 0.5, 1, 1.5])
NU = {60: 3.5, 240: 3.8, 1440: 5.0, 10080: 5.0}      # from calib.py walk-forward fits (ewma1d), rounded

def markets(tenor, start='2021-01-01', end=None, list_every=None, offset_min=8*60):
    le = list_every or min(tenor, 1440)
    a = lib.minute_of(start) + (offset_min if tenor >= 1440 else 0)
    b = (lib.minute_of(end) if end else lib.N - 1) - tenor - 2
    t0 = np.arange(a, b, le)
    sdr = A['ewma1440'][t0]*np.sqrt(tenor/lib.MPY)
    T0 = np.repeat(t0, len(KS)); lnK = (A['pool'][t0][:, None] + KS[None, :]*sdr[:, None]).ravel()
    return T0.astype(np.int64), lnK, le

DEF = dict(s=0.01, cdelta=1.0, gamma=5e-4, lam=0.05, cut=0, pmin=0.02, kappa=0.0, lag=0, fee_out=0.0,
           m_lat=0.001, m_tail=0.005, m_dir=0.005, dir_step=0.02, dir_pos=0.25, noise_trades=20,
           season=0, kernel='normal', sig='ewma1440', vm=1.0, vp=0.0, sfloor=0.3, scap=2.0,
           tail=1, lat=1, dir=1, seed=7, budget=1.0, imp_hl=0.0, iv=1, orv=0, eta_amm=1.0, block=0, list_every=None)
KID = {'normal': 0, 'driftless': 1, 't': 2, 'emp': 3}
def pvec(c, tenor):
    return np.array([c['s'], c['cdelta'], c['gamma'], c['lam'], c['cut'], c['pmin'], c['kappa'], c['lag'], c['fee_out'],
                     c['m_lat'], c['m_tail'], c['m_dir'], c['dir_step'], c['dir_pos'], c['noise_trades'], c['season'],
                     KID[c['kernel']], np.sqrt((NU[tenor]-2)/NU[tenor]), c['tail'], c['lat'], c['dir'], c['budget'], c['imp_hl'], c['iv'], c['orv'], c['eta_amm'], c['block']], dtype=np.float64)
def sig_policy(c):
    return np.clip(c['vm']*A[c['sig']] + c['vp'], c['sfloor'], c['scap'])

AGFLAG = {'lat': 'lat', 'tail': 'tail', 'iv': 'iv', 'orv': 'orv', 'dir': 'dir'}
def _one(tenor, c, mech, t0, lnK, flags):
    cc = dict(c); cc.update(flags)
    yidx = E.year_index(t0).astype(np.int64)
    ttab = E.t_table(NU[tenor])
    sigH = sig_policy(cc); sigA = A[cc['sig']]; Qt = A['Q_'+cc['sig']]
    out = np.zeros((len(t0), 12)); P = pvec(cc, tenor)
    if mech == 'hook':
        E.run_hook(t0, tenor, lnK, A['cex'], A['pool'], sigH, sigA, ttab, Qt, yidx, A['SC'], P, cc['seed'], out, A['dvol'], A['cum'])
    else:
        E.run_amm({'cpmm': 0, 'lmsr': 1, 'pmamm': 2}[mech], t0, tenor, lnK, A['cex'], A['pool'], sigH, sigA, ttab, Qt, yidx, A['SC'], P, cc['seed'], out, A['dvol'], A['cum'])
    return out

def run(tenor, cfg=None, mech='hook', start='2021-01-01', end=None, agents=('lat', 'tail', 'iv', 'orv', 'dir'), **kw):
    """Each informed agent class is simulated in ISOLATION (that agent + noise), so per-agent LP P&L is well defined
    (agents with opposite beliefs would otherwise trade against each other through the vault)."""
    c = dict(DEF); c.update(cfg or {}); c.update(kw)
    t0, lnK, le = markets(tenor, start, end, list_every=c.get('list_every'))
    pnl = np.zeros((len(t0), 6)); vol = np.zeros((len(t0), 6))
    off = dict(lat=0, tail=0, iv=0, orv=0, dir=0)
    base = _one(tenor, c, mech, t0, lnK, off)            # noise only
    if mech == 'hook':
        pnl[:, 5] = base[:, 5]; vol[:, 5] = base[:, 11]
    else:
        pnl[:, 5] = base[:, 5]; vol[:, 5] = base[:, 11]
    for i, a in enumerate(AG[:5]):
        if a not in agents: continue
        f = dict(off); f[a] = 1
        o = _one(tenor, c, mech, t0, lnK, f)
        if mech == 'hook':
            pnl[:, i] = o[:, i]; vol[:, i] = o[:, 6+i]
        else:   # AMM: agent contribution = (agent+noise run) - (noise-only run), all flows interact with the reserves
            pnl[:, i] = o[:, :6].sum(1) - base[:, :6].sum(1); vol[:, i] = o[:, 6+i]
    return dict(t0=t0, tenor=tenor, le=le, pnl=pnl, vol=vol, cfg=c, mech=mech)

MON0 = lib.minute_of('2019-12-30')   # a Monday
BFRAC = 0.01   # per-market budget as a fraction of vault NAV
AG = ['lat', 'tail', 'iv', 'orv', 'dir', 'noise']
REALISTIC = ('lat', 'tail', 'iv', 'dir')
def parts(r, period=None):
    """Weekly per-agent LP P&L on committed capital (hook: noise at unit intensity)."""
    out = r['pnl']; tenor = r['tenor']; texp = r['t0'] + tenor
    wk = (texp - MON0)//10080
    msk = np.ones(len(texp), bool)
    if period: msk = (texp >= lib.minute_of(period[0])) & (texp < lib.minute_of(period[1]))
    wk = wk[msk]; w0 = wk.min(); cnt = np.bincount(wk - w0); keep = cnt > 0
    # Vault convention: every market gets a loss budget of BFRAC of vault NAV (no compounding) -> weekly NAV return.
    return {k: (np.bincount(wk - w0, weights=out[msk, i])*BFRAC)[keep] for i, k in enumerate(AG)}
def lp_weekly(r, eta=1.0, period=None, conservative=True, agents=REALISTIC):
    """LP weekly return. conservative=True drops any informed-agent class whose total P&L to the LP over the period is positive
    (an agent that loses money is assumed not to show up), so the LP is never subsidised by 'informed' traders' mistakes."""
    p = parts(r, period)
    tot = (eta if r['mech'] == 'hook' else 1.0)*p['noise']
    for k in agents:
        if (not conservative) or p[k].sum() < 0: tot = tot + p[k]
    return tot
def weekly(r, eta=1.0, cols=None, period=None):
    return lp_weekly(r, eta, period, conservative=False)

def mbb_mean_ci(x, B=4000, block=4, alpha=0.05, seed=1):
    rng = np.random.default_rng(seed); n = len(x); nb = int(np.ceil(n/block))
    starts = rng.integers(0, n-block+1, size=(B, nb))
    idx = (starts[:, :, None] + np.arange(block)).reshape(B, -1)[:, :n]
    m = x[idx].mean(1)
    return np.quantile(m, alpha), np.quantile(m, 1-alpha)

def stats(x):
    cum = np.cumsum(x); dd = np.max(np.maximum.accumulate(np.concatenate([[0], cum])) - np.concatenate([[0], cum]))
    q05 = np.quantile(x, 0.05); q01 = np.quantile(x, 0.01)
    lo, hi = mbb_mean_ci(x)
    return dict(n=len(x), ann=52*x.mean(), sd=x.std(), lo95=52*lo, hi95=52*hi, sharpe=np.sqrt(52)*x.mean()/max(x.std(), 1e-12),
                var95=-q05, cvar95=-x[x <= q05].mean(), var99=-q01, cvar99=-x[x <= q01].mean(), maxdd=dd, worst=-x.min(), plose=(x < 0).mean())

GRID = np.concatenate([np.linspace(0, 5, 101), np.linspace(5.5, 100, 190), np.linspace(105, 1000, 180)])
def breakeven(r, period=None, conservative=True, grid=GRID, agents=REALISTIC):
    """Smallest per-market noise turnover eta (units of budget B) with one-sided 95% moving-block-bootstrap lower bound of mean weekly LP return > 0."""
    a = lp_weekly(r, 0.0, period, conservative, agents); n = parts(r, period)['noise']
    if n.mean() <= 0: return np.inf
    lo_ = 0; hi_ = len(grid)-1
    ok = lambda e: mbb_mean_ci(a + e*n, B=1000)[0] > 0
    if not ok(grid[hi_]): return np.inf
    if ok(grid[0]): return grid[0]
    while hi_ - lo_ > 1:
        mid = (lo_ + hi_)//2
        if ok(grid[mid]): hi_ = mid
        else: lo_ = mid
    return grid[hi_]

def attribution(r, period=None):
    tenor = r['tenor']; texp = r['t0'] + tenor
    msk = np.ones(len(texp), bool)
    if period: msk = (texp >= lib.minute_of(period[0])) & (texp < lib.minute_of(period[1]))
    nm = msk.sum()
    return {k: (r['pnl'][msk, i].sum()/nm, r['vol'][msk, i].sum()/nm) for i, k in enumerate(AG)}
