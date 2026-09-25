"""(d) Walk-forward calibration of candidate kernels on Binance 1m ETH, 2021-01 .. 2026-09 (OOS by year)."""
import numpy as np, lib, sys
from scipy.stats import t as tdist
from scipy.special import ndtr
from scipy.optimize import minimize_scalar
LOG = lib.POOL                      # pool (5 bp band) log-price = what the hook sees and settles on
TEN = {'1h':60, '4h':240, '1d':1440, '7d':10080}
KS = np.array([-1.5,-1,-0.5,0,0.5,1,1.5])
SIG = {'ewma4h':lib.ewma_sigma(LOG, 240), 'ewma1d':lib.ewma_sigma(LOG,1440), 'ewma3d':lib.ewma_sigma(LOG,3*1440), 'dvol':lib.dvol_minutely()}
start = lib.minute_of('2020-02-01'); y0 = {y: lib.minute_of(f'{y}-01-01') for y in range(2020, 2028)}
def fit_nu(x):
    x = x[np.isfinite(x)]
    f = lambda nu: -np.sum(tdist.logpdf(x/np.sqrt((nu-2)/nu), nu) - np.log(np.sqrt((nu-2)/nu)))
    return minimize_scalar(f, bounds=(2.1, 60), method='bounded').x
res = {}
for tn, tau in TEN.items():
    step = max(15, tau//4)
    ts = np.arange(start, lib.N - tau - 1, step)
    x_all = {}
    for sname, sig in SIG.items():
        sd = sig[ts]*np.sqrt(tau/lib.MPY)
        x_all[sname] = (LOG[ts+tau] - LOG[ts] + 0.5*sd*sd)/sd      # standardised centred log-return
    sdref = SIG['ewma1d'][ts]*np.sqrt(tau/lib.MPY)
    for Y in range(2021, 2027):
        m = (ts >= y0[Y]) & (ts < y0[Y+1])
        tr = ts < y0[Y] - tau                                    # strictly past, no overlap with eval
        prof = lib.season_profile(lib.LOGS, y0[Y])
        sf = lib.season_factor(prof, ts[m], np.full(m.sum(), tau))
        for sname, sig in SIG.items():
            s = sig[ts[m]]
            if np.isnan(s).any():  continue
            sd = s*np.sqrt(tau/lib.MPY)
            xtr = x_all[sname][tr]; xtr = xtr[np.isfinite(xtr)]
            if len(xtr) < 500: continue
            nu = fit_nu(xtr[-200000:])
            xs = np.sort(xtr)
            g1 = np.mean(np.clip(xtr,-6,6)**3); g2 = np.mean(np.clip(xtr,-6,6)**4)-3
            # seasonal standardisation for the seasonal kernels
            for k in KS:
                lnSK = -k*sdref[m]                                  # ln(S/K)
                o = (LOG[ts[m]+tau] > LOG[ts[m]] - lnSK).astype(float)
                sds = sd*np.sqrt(sf)
                P = {'normal': lib.p_normal(lnSK, sd), 'driftless': lib.p_driftless(lnSK, sd),
                     't': lib.p_student(lnSK, sd, nu), 'gc': lib.p_gc(lnSK, sd, g1, g2),
                     'normal+seas': lib.p_normal(lnSK, sds), 't+seas': lib.p_student(lnSK, sds, nu),
                     'empirical': 1 - np.searchsorted(xs, (-lnSK + 0.5*sd*sd)/sd, side='right')/len(xs)}
                for kn, p in P.items():
                    key = (tn, sname, kn, Y, k)
                    res[key] = (o.sum(), p.sum(), ((p-o)**2).sum(), -np.sum(o*np.log(np.clip(p,1e-9,1))+(1-o)*np.log(np.clip(1-p,1e-9,1))), len(o))
            res[(tn, sname, 'nu', Y)] = nu; res[(tn, sname, 'g', Y)] = (g1, g2)
import pickle; pickle.dump(res, open('out/calib.pkl','wb'))
# ---- report
def agg(tn, sn, kn, years, k):
    a = np.array([res[(tn,sn,kn,Y,k)] for Y in years if (tn,sn,kn,Y,k) in res])
    if len(a)==0: return None
    return a.sum(0)
for years, lab in [(range(2021,2027),'OOS 2021-01..2026-09'), (range(2024,2027),'OOS 2024-01..2026-09')]:
    print(f'\n===== {lab}: realized - model (pp) by k; ECE = mean |.| over k; LL = mean log loss')
    for tn, tau in TEN.items():
        step = max(15, tau//4); 
        for sn in SIG:
            for kn in ['normal','driftless','t','gc','normal+seas','t+seas','empirical']:
                row=[]; ll=0; n=0; ece=[]
                for k in KS:
                    a = agg(tn, sn, kn, years, k)
                    if a is None: break
                    d = (a[0]-a[1])/a[4]*100; row.append(d); ece.append(abs(d)); ll += a[3]; n += a[4]
                if not row: continue
                nus = [res.get((tn,sn,'nu',Y)) for Y in years]
                se = 100*np.sqrt(0.25/(n/len(KS)*step/tau))   # rough SE at p=.5 with n_eff
                print(f"{tn:>3} {sn:>7} {kn:>12}: " + ' '.join(f'{d:+5.1f}' for d in row) + f" | ECE {np.mean(ece):4.2f} max {max(ece):4.1f} LL {ll/n:.4f} se~{se:.1f}" + (f" nu~{np.nanmean([v for v in nus if v]):.1f}" if kn in('t','t+seas') else ''))
