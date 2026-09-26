"""Sub-minute latency charge (1-second Binance data, 116 days) for the EXACT IS-selected 1 d configuration
(s=2%, lamB=0.1, cutoff 10%, p_min=0.02, per-block impact reset, start-of-block oracle), with the hook kernel = normal vs
variance-matched t (nu 4/5/6). Same seed and markets for all kernels -> per-market paired differences.
(The original lat1s_cut.py measured the normal kernel at lamB=0.05 only; this closes that gap.)"""
import numpy as np, zipfile, glob, lib, engine3 as E2, engine as E, bt, sys, pickle
ts=[]; px=[]
for f in sorted(glob.glob('data/s1/ETHUSDT-1s-*.zip')):
    z = zipfile.ZipFile(f); raw = z.read(z.namelist()[0]).decode().splitlines()
    a = np.array([(int(l.split(',')[0]), float(l.split(',')[4])) for l in raw if l and l[0].isdigit()])
    ts.append(a[:, 0]); px.append(a[:, 1])
ts = np.concatenate(ts); px = np.concatenate(px); ts = np.where(ts > 1e14, ts//1000, ts).astype(np.int64)
o = np.argsort(ts); ts = ts[o]; px = px[o]
ts, ui = np.unique(ts, return_index=True); px = px[ui]
n = int((ts[-1]-ts[0])//1000 + 1); g = np.full(n, np.nan); g[(ts-ts[0])//1000] = px
for i in range(1, n):
    if np.isnan(g[i]): g[i] = g[i-1]
cex = np.log(g); pool = lib.band_path(cex, 5e-4)
print('seconds', n, 'days', n/86400, flush=True)
from scipy.signal import lfilter
r2 = np.diff(cex[::60])**2; lam_ = 0.5**(1/1440); v, _ = lfilter([1-lam_], [1, -lam_], r2, zi=[lam_*r2[:1440].mean()])
sgm = np.sqrt(np.repeat(np.concatenate([[r2[:1440].mean()], v]), 60)[:n]*525600)
sigH = sgm/np.sqrt(60)
Q = np.zeros((len(E.YEARS), len(E.BUCKETS), len(E.LEV))); Q[:] = np.linspace(-5, 5, len(E.LEV))
SC = np.cumsum(np.ones((len(E.YEARS), 3*168*60+1)), axis=1) - 1
dv = sigH.copy(); cum = np.zeros(n+1)
tenors = [int(x) for x in sys.argv[1:]] or [86400]
NUF = {86400: 5.0, 14400: 3.8, 3600: 3.5}
KERS = {86400: {'normal': ('normal', 5.0), 't4': ('t', 4.0), 't5': ('t', 5.0), 't6': ('t', 6.0)},
        3600: {'normal': ('normal', 5.0), 't_fit': ('t', 3.5), 't4': ('t', 4.0)},
        14400: {'normal': ('normal', 5.0), 't_fit': ('t', 3.8), 't4': ('t', 4.0)}}
CUTF = {86400: 0.1, 14400: 0.1, 3600: 0.0}
res = {}
for tenor_s in tenors:
    KER = KERS[tenor_s]
    t0 = np.arange(86400*2, n - tenor_s - 2, tenor_s if tenor_s < 86400 else 86400)
    sdr = sgm[t0]*np.sqrt(tenor_s/(365*86400))
    T0 = np.repeat(t0, 7).astype(np.int64); lnK = (pool[t0][:, None] + bt.KS[None, :]*sdr[:, None]).ravel()
    yidx = np.full(len(T0), 6, dtype=np.int64)
    for block in (12, 2):
        for kn, (kern, nu) in [(k_, v_) for k_, v_ in KER.items() if k_ in ('normal', 't_fit', 't5')]:
          for bel in (0, 2):
            c = dict(bt.DEF); c.update(tail=0, dir=0, iv=0, orv=0, lat=1, lag=0, block=block, imp_hl=0, lam=0.1, s=0.02,
                                       cut=int(CUTF[tenor_s]*tenor_s), pmin=0.02, kernel=kern, noise_trades=20*60)
            nua = NUF[tenor_s]; P = bt.pvec(c, 1440); P[17] = np.sqrt((nua-2)/nua); P = np.append(P, float(bel)); out = np.zeros((len(T0), 12))
            E2.run_hook(T0, tenor_s, lnK, cex, pool, sigH, sigH, E.t_table(nua), Q, yidx, SC, P, 3, out, dv, cum, E.t_table(nu), np.sqrt((nu-2)/nu))
            res[(tenor_s, block, kn, bel)] = out[:, 0].copy()
            print(f"tenor {tenor_s}s block {block:2d}s hook {kn:>6} arb-belief {'normal' if bel==0 else 't(nu=%.1f)'%nua}: LP pnl/market vs latency arb {out[:,0].mean():+.4f} ± {out[:,0].std()/np.sqrt(len(T0)):.4f} (n={len(T0)}) arb vol {out[:,6].mean():.2f}", flush=True)

pickle.dump(res, open('kc/latx_' + '_'.join(map(str, tenors)) + '.pkl', 'wb'))
