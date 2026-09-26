"""Driver for the integrated-spec backtest (1-minute ETH data 2021-01..2026-09, 1-day series of 7 strikes listed daily 08:00 UTC).
A config = frozen-spec parameters; for each noise turnover D the noise-only run and one run per informed class (+ same noise,
common random numbers) are executed; class contribution = run(class+noise) - run(noise). Conservative LP = noise run + sum of
realistic classes whose total contribution over the evaluation period is negative (as in the original backtest)."""
import numpy as np, pickle, os, lib, spec
import engine as E, engine2 as E2
A = pickle.load(open('../econ/out/arrays.pkl', 'rb'))
PR = pickle.load(open(os.path.join(os.path.dirname(__file__), 'out', 'prep2.pkl'), 'rb'))
CC = pickle.load(open(os.path.join(os.path.dirname(__file__), 'out', 'costcurves.pkl'), 'rb')) if os.path.exists(os.path.join(os.path.dirname(__file__), 'out', 'costcurves.pkl')) else {}
KS = np.array([-1.5, -1, -0.5, 0, 0.5, 1, 1.5])
IS = ('2021-01-01', '2024-01-01'); OOS = ('2024-01-01', '2026-09-25')
TENOR = 1440
MON0 = lib.minute_of('2019-12-30')
BFRAC = 0.01
AG = ['lat', 'tail', 'iv', 'orv', 'dir']
REALISTIC = ('lat', 'tail', 'iv', 'dir')

def listings(start='2021-01-01', end=None, guard=False):
    a = lib.minute_of(start) + 8 * 60
    b = (lib.minute_of(end) if end else lib.N - 1) - TENOR - 2
    t0 = np.arange(a, b, 1440)
    if guard: t0 = t0[PR['guard_ok'][t0]]
    sdr = A['ewma1440'][t0] * np.sqrt(TENOR / lib.MPY)
    lnK = A['pool'][t0][:, None] + KS[None, :] * sdr[:, None]
    return t0.astype(np.int64), np.ascontiguousarray(lnK)

DEF = dict(chain='L1', w=120, cut='wb', h0=0.01, lam_block=0.1, sig='modeA', kernel='normal', ramp_h=0.0,
           B_usd=20_000.0, Bs=3.0, noise_usd=1000.0, qepoch=1, oi=1, manip=1, m_a=1.0, pmin=spec.PMIN,
           m_lat=0.001, m_tail=0.005, m_dir=0.005, dir_step=0.02, dir_pos=0.25, seed=11)

def cut_min(c):
    w_s = c['w'] * 60; dt = spec.CHAIN[c['chain']]['dt_s']
    if c['cut'] == 'wb': s = spec.cut_window(w_s)
    elif c['cut'] == 'c10': s = spec.cut_tenor10(TENOR * 60, w_s)
    elif c['cut'] == 'c05': s = spec.cut_05(c['h0'], w_s, dt)
    else: s = float(c['cut']) * 60
    return int(np.ceil(s / 60))

def sig_series(c):
    """(hook sigma series, adversary standardiser, fixed-at-creation?, adversary ECDF table). The tail adversary always uses the
    live 1-day EWMA (best simple public predictor) so its information set is the same for every hook policy."""
    adv = A['ewma1440']; Qt = PR['Q_ewma1440_%d' % c['w']]
    if c['sig'] == 'modeA': return PR['sigA_modeA'], adv, True, Qt
    if c['sig'] == 'modeB3': return PR['sig_modeB3'], adv, False, Qt
    if c['sig'] == 'modeB1': return PR['sig_modeB1'], adv, False, Qt
    if c['sig'] == 'rv1_live': return PR['sig_rv1_live'], adv, False, Qt
    if c['sig'] == 'rv_ewma': return PR['sig_rv_ewma'], adv, False, Qt
    if c['sig'] == 'ewma_live': return np.clip(A['ewma1440'], 0.3, 2.0), adv, False, Qt
    if c['sig'] == 'ewma_fixed': return np.clip(A['ewma1440'], 0.3, 2.0), adv, True, Qt
    raise ValueError

NU = 5.0
def pvec(c, D, flags, nsteps):
    ch = spec.CHAIN[c['chain']]; B = c['B_usd']
    R = 60.0 / ch['dt_s']
    nq = c['noise_usd'] / B
    ntr = D * TENOR / 1440 / nq
    npr = min(ntr / nsteps, 1.0)
    return np.array([c['h0'], spec.C_DELTA, spec.GAMMA0, spec.C_LAG, ch['dt_s'] / spec.YEAR_S,
                     c['lam_block'] / R, cut_min(c), c['pmin'], c['w'], 1, 1.0 / spec.MPY,
                     1.0, c['Bs'], (ch['c_manip'] / B) if c['qepoch'] else 0.0, c['m_a'], R, nq, npr,
                     flags.get('lat', 0), flags.get('tail', 0), flags.get('iv', 0), flags.get('orv', 0), flags.get('dir', 0),
                     {'normal': 0, 't': 2}[c['kernel']], np.sqrt((NU - 2) / NU), c['ramp_h'], c['manip'], 1.0 / spec.MPY, 1,
                     c['m_lat'], c['m_tail'], c['m_dir'], c['dir_step'], c['dir_pos'], c['lam_block'], 0.0, c['oi']], dtype=np.float64)

def qsafe_arr(c, t0, sigH):
    if c['ramp_h'] > 0:
        q = spec.q_safe_ramp(c['chain'], c['w'] * 60, c['ramp_h'], c['h0']) * np.ones(len(t0))
    else:
        q = np.array([spec.q_safe_binary(c['chain'], c['w'] * 60, s, cut_min(c) * 60, c['h0']) for s in sigH[t0]])
    return q / c['B_usd']

def costc(c):
    g, C = CC[(c['chain'], c['w'])]
    return g.copy(), np.where(np.isfinite(C), C, 1e30) / c['B_usd']

def run1(c, D, flags, t0, lnK):
    sigH, sigA, fixed, Qt = sig_series(c)
    nsteps = TENOR - cut_min(c)
    P = pvec(c, D, flags, nsteps); P[35] = 1.0 if fixed else 0.0
    out = np.zeros((len(t0), 11)); st = np.zeros((len(t0), 6))
    yidx = E.year_index(t0).astype(np.int64)
    g, C = costc(c)
    E2.run_series(t0, lnK, TENOR, A['cex'], A['pool'], sigH, sigA, E.t_table(NU), Qt, yidx, P, c['seed'], out, st,
                  A['dvol'], A['cum'], qsafe_arr(c, t0, sigH), g, C, np.zeros(1))
    return out, st

def run(cfg=None, Ds=(1.0, 2.0, 3.0, 5.0, 8.0), agents=('lat', 'tail', 'iv', 'orv', 'dir'), start='2021-01-01', end=None, **kw):
    c = dict(DEF); c.update(cfg or {}); c.update(kw)
    t0, lnK = listings(start, end, guard=(c['sig'] == 'modeA'))
    res = dict(cfg=c, t0=t0, Ds=list(Ds), noise={}, contrib={}, contrib0={}, agentpnl={}, dnoise={}, vol={}, stats={}, extra={})
    for D in Ds:
        o, st = run1(c, D, {}, t0, lnK)
        res['noise'][D] = o[:, 0]; res.setdefault('noise0', {})[D] = o[:, 1]; res.setdefault('gross', {})[D] = o[:, 6]; res.setdefault('qsafe', {})[D] = o[:, 7]; res['vol'][(D, 'noise')] = o[:, 3]; res['stats'][(D, 'noise')] = st
        res['extra'][(D, 'noise')] = o
        for a in agents:
            oa, sta = run1(c, D, {a: 1}, t0, lnK)
            res['contrib'][(D, a)] = oa[:, 0] - o[:, 0]
            res['contrib0'][(D, a)] = oa[:, 1] - o[:, 1]
            res['agentpnl'][(D, a)] = oa[:, 9]; res['dnoise'][(D, a)] = oa[:, 10] - o[:, 10]
            res['vol'][(D, a)] = oa[:, 2]; res['stats'][(D, a)] = sta; res['extra'][(D, a)] = oa
    return res

def _mask(res, period):
    texp = res['t0'] + TENOR
    return (texp >= lib.minute_of(period[0])) & (texp < lib.minute_of(period[1])) if period else np.ones(len(texp), bool)

def lp_series(res, D, period=None, agents=REALISTIC, lat_charge=0.0, conservative=True):
    """per-series conservative LP P&L (B units) for listings in period.
    = noise-only run + sum over extracting classes of the class's own P&L to the LP + the WORST single crowd-out of noise
    revenue among them (crowd-out is not additive: capacity lost to one class cannot be lost again to another)."""
    msk = _mask(res, period)
    x = res['noise'][D][msk].copy(); crowd = np.zeros(msk.sum()); worst = 0.0
    for a in agents:
        ca = res['contrib'][(D, a)][msk]
        if (not conservative) or ca.sum() < 0:
            x = x + res['agentpnl'][(D, a)][msk]
            dn = res['dnoise'][(D, a)][msk]
            if dn.sum() < worst: worst = dn.sum(); crowd = dn
    return x + crowd + lat_charge

def weekly(res, x, period=None):
    msk = _mask(res, period)
    texp = res['t0'][msk] + TENOR
    wk = (texp - MON0) // 10080; w0 = wk.min(); cnt = np.bincount(wk - w0); keep = cnt > 0
    return (np.bincount(wk - w0, weights=x) * BFRAC)[keep]

def mbb_lo(x, B=2000, block=4, alpha=0.05, seed=1):
    rng = np.random.default_rng(seed); n = len(x); nb = int(np.ceil(n / block))
    starts = rng.integers(0, n - block + 1, size=(B, nb))
    idx = (starts[:, :, None] + np.arange(block)).reshape(B, -1)[:, :n]
    m = x[idx].mean(1)
    return np.quantile(m, alpha), np.quantile(m, 1 - alpha)

def stats(x):
    cum = np.cumsum(x); dd = np.max(np.maximum.accumulate(np.concatenate([[0], cum])) - np.concatenate([[0], cum]))
    q05 = np.quantile(x, 0.05); q01 = np.quantile(x, 0.01)
    lo, hi = mbb_lo(x)
    return dict(n=len(x), ann=52 * x.mean(), sd=x.std(), lo95=52 * lo, var95=-q05, cvar95=-x[x <= q05].mean(), cvar99=-x[x <= q01].mean(),
                maxdd=dd, worst=-x.min(), plose=(x < 0).mean())

def dstar(res, period, agents=REALISTIC, lat_by_D=None):
    """smallest D (linear interpolation of the 95% MBB lower bound between grid points) with LB > 0; inf if never."""
    lbs = []
    for D in res['Ds']:
        lc = lat_by_D(D) if lat_by_D else 0.0
        w = weekly(res, lp_series(res, D, period, agents, lc), period)
        lbs.append(mbb_lo(w)[0])
    lbs = np.array(lbs); Ds = np.array(res['Ds'])
    if lbs[0] > 0: return Ds[0], lbs
    for i in range(1, len(Ds)):
        if lbs[i] > 0:
            return Ds[i-1] + (Ds[i] - Ds[i-1]) * (-lbs[i-1]) / (lbs[i] - lbs[i-1]), lbs
    return np.inf, lbs

def attribution(res, D, period):
    msk = _mask(res, period)
    d = {'noise': res['noise'][D][msk].mean()}
    for (DD, a), v in res['contrib'].items():
        if DD == D: d[a] = v[msk].mean()
    return d

def lp_series_strict(res, D, period, agents=REALISTIC, lat_charge=0.0):
    """Stricter conservative LP: a class is counted in every CALENDAR YEAR (within the period) in which its total contribution
    is negative (an adaptive adversary that only trades in the regimes where it wins)."""
    import datetime
    msk = _mask(res, period); t0 = res['t0'][msk]
    yrs = np.array([datetime.datetime.fromtimestamp((lib.T0 + (t + TENOR) * 60000) / 1000, datetime.timezone.utc).year for t in t0])
    x = res['noise'][D][msk].copy()
    for Y in np.unique(yrs):
        m = yrs == Y; worst = 0.0; crowd = None
        for a in agents:
            ca = res['contrib'][(D, a)][msk][m]
            if ca.sum() < 0:
                x[m] += res['agentpnl'][(D, a)][msk][m]
                dn = res['dnoise'][(D, a)][msk][m]
                if dn.sum() < worst: worst = dn.sum(); crowd = dn
        if crowd is not None: x[m] += crowd
    return x + lat_charge

def dstar_strict(res, period, agents=REALISTIC, lat_by_D=None):
    lbs = []
    for D in res['Ds']:
        lc = lat_by_D(D) if lat_by_D else 0.0
        w = weekly(res, lp_series_strict(res, D, period, agents, lc), period)
        lbs.append(mbb_lo(w)[0])
    lbs = np.array(lbs); Ds = np.array(res['Ds'])
    if lbs[0] > 0: return Ds[0], lbs
    for i in range(1, len(Ds)):
        if lbs[i] > 0:
            return Ds[i-1] + (Ds[i] - Ds[i-1]) * (-lbs[i-1]) / (lbs[i] - lbs[i-1]), lbs
    return np.inf, lbs
