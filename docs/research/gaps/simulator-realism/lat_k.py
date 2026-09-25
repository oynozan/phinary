"""Sub-minute latency cost for the 1d v1 configuration (t kernel, lam 0.1, cut 10%) at 1-second resolution on 116 days of Binance 1s data,
split by whether the market's life contains a scheduled event (CPI/FOMC), and with spread / event-halt variants. Uses engine_x (latency agent only)."""
import numpy as np, zipfile, glob, sys, os
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, '..', 'econ')); os.chdir(os.path.join(HERE, '..', 'econ'))
import lib, engine as E, bt, engine_x as X, datetime as dt
sys.path.insert(0, HERE); import events as EVM
ts=[]; px=[]
for f in sorted(glob.glob('data/s1/ETHUSDT-1s-*.zip')):
    z = zipfile.ZipFile(f); raw = z.read(z.namelist()[0]).decode().splitlines()
    a = np.array([(int(l.split(',')[0]), float(l.split(',')[4])) for l in raw if l and l[0].isdigit()])
    ts.append(a[:, 0]); px.append(a[:, 1])
ts = np.concatenate(ts); px = np.concatenate(px); ts = np.where(ts > 1e14, ts//1000, ts).astype(np.int64)
o = np.argsort(ts); ts = ts[o]; px = px[o]; T0ms = ts[0]
n = int((ts[-1]-ts[0])//1000 + 1); g = np.full(n, np.nan); g[(ts-ts[0])//1000] = px
for i in range(1, n):
    if np.isnan(g[i]): g[i] = g[i-1]
cex = np.log(g); pool = lib.band_path(cex, 5e-4)
from scipy.signal import lfilter
r2 = np.diff(cex[::60])**2; lam_ = 0.5**(1/1440); v, _ = lfilter([1-lam_], [1, -lam_], r2, zi=[lam_*r2[:1440].mean()])
sgm = np.sqrt(np.repeat(np.concatenate([[r2[:1440].mean()], v]), 60)[:n]*525600); sigH = sgm/np.sqrt(60)
Q = np.zeros((len(E.YEARS), len(E.BUCKETS), len(E.LEV))); Q[:] = np.linspace(-5, 5, len(E.LEV))
SC = np.cumsum(np.ones((len(E.YEARS), 3*168*60+1)), axis=1) - 1
dv = sigH.copy(); cum = np.zeros(n+1)
evs = [e for e, c in EVM.calendar() if c in ('CPI', 'FOMC')]
evsec = np.array([int((e.timestamp()*1000 - T0ms)//1000) for e in evs]); evsec = evsec[(evsec > 0) & (evsec < n)].astype(np.int64)
print('days', round(n/86400, 1), 'events in sample', len(evsec), [str(dt.datetime.fromtimestamp((T0ms+s*1000)/1000, dt.timezone.utc))[:16] for s in evsec])
tenor = 86400
# listing 08:00 UTC
first = int(((T0ms//86400000 + 1)*86400000 + 8*3600000 - T0ms)//1000) + 86400
t0 = np.arange(first, n - tenor - 2, 86400)
sdr = sgm[t0]*np.sqrt(tenor/(365*86400))
TT = np.repeat(t0, 7).astype(np.int64); lnK = (pool[t0][:, None] + bt.KS[None, :]*sdr[:, None]).ravel()
has_ev = np.array([np.any((evsec > t) & (evsec <= t + tenor)) for t in TT])
yidx = np.full(len(TT), 6, dtype=np.int64); ttab = E.t_table(5.0)
evJ = np.zeros(len(evsec)); j0 = np.zeros(len(TT), np.int64); nn = np.zeros(len(TT), np.int64)
for block in (12, 2):
    for kap in (0.0, 0.1):
      for s in (0.02, 0.03):
        for hp in ((0, 0), (300, 300)):
            c = dict(bt.DEF); c.update(dict(tail=0, dir=0, iv=0, orv=0, lat=1, lag=0, block=block, imp_hl=0, lam=0.1, s=s, cut=int(0.1*tenor), noise_trades=20*60, kernel='t', kappa=kap, pmin=0.05))
            P = np.concatenate([bt.pvec(c, 1440), [0, hp[0], hp[1], 0, 0, 0, 0]])
            out = np.zeros((len(TT), 18))
            X.run_hook_x(TT, tenor, lnK, cex, pool, sigH, sigH, ttab, Q, yidx, SC, P, 3, out, dv, cum, evsec, evJ, j0, nn, np.zeros(1, np.int64), np.zeros((1, 5)))
            lp = out[:, 0]; nz = out[:, 8]
            day = TT//86400; ud = np.unique(day); dm = np.array([lp[day == d].mean() for d in ud]); dev = np.array([has_ev[day == d][0] for d in ud])
            print(f"block {block:>2}s kappa={kap} s={s:.2f} halt ±{hp[0]//60:>2}min: LP vs latency arb {lp.mean():+.4f} ± {dm.std()/np.sqrt(len(dm)):.4f} (day-clustered) | event-days {dm[dev].mean():+.4f} ± {dm[dev].std()/np.sqrt(max(dev.sum(),1)):.4f} (n={dev.sum()} days) no-event {dm[~dev].mean():+.4f} | noise/unit {nz.mean():+.4f}", flush=True)
