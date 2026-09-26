"""Latency / block-time cost at 1-second resolution: Binance 1s klines 2026-06-01..2026-09-24 (116 days).
The hook reads the pool price at the START of the block (block = 12 s L1, 2 s L2); pool = 5 bp band follower of Binance.
Impact state either resets every block (per-block depth) or decays with a half-life (per-time depth).
Steps are seconds; sigma is rescaled by 1/sqrt(60) so the engine's minute-based tau is correct. Only latency agent + noise."""
import numpy as np, zipfile, glob, lib, engine as E, bt, sys
ts=[]; px=[]
for f in sorted(glob.glob('data/s1/ETHUSDT-1s-*.zip')):
    z = zipfile.ZipFile(f); raw = z.read(z.namelist()[0]).decode().splitlines()
    a = np.array([(int(l.split(',')[0]), float(l.split(',')[4])) for l in raw if l and l[0].isdigit()])
    ts.append(a[:, 0]); px.append(a[:, 1])
ts = np.concatenate(ts); px = np.concatenate(px); ts = np.where(ts > 1e14, ts//1000, ts).astype(np.int64)
o = np.argsort(ts); ts = ts[o]; px = px[o]
n = int((ts[-1]-ts[0])//1000 + 1); g = np.full(n, np.nan); g[(ts-ts[0])//1000] = px
for i in range(1, n):
    if np.isnan(g[i]): g[i] = g[i-1]
cex = np.log(g); pool = lib.band_path(cex, 5e-4)
sig = np.sqrt(np.mean(np.diff(cex[::60])**2)*365*1440)
print('seconds', n, 'days', n/86400, 'realised vol (1m-sampled)', round(sig, 3))
# causal EWMA sigma (1-day half-life) on 1-minute returns, per second
from scipy.signal import lfilter
r2 = np.diff(cex[::60])**2; lam_ = 0.5**(1/1440); v, _ = lfilter([1-lam_], [1, -lam_], r2, zi=[lam_*r2[:1440].mean()])
sgm = np.sqrt(np.repeat(np.concatenate([[r2[:1440].mean()], v]), 60)[:n]*525600)
sigH = sgm/np.sqrt(60)
Q = np.zeros((len(E.YEARS), len(E.BUCKETS), len(E.LEV))); Q[:] = np.linspace(-5, 5, len(E.LEV))
SC = np.cumsum(np.ones((len(E.YEARS), 3*168*60+1)), axis=1) - 1
dv = sigH.copy(); cum = np.zeros(n+1)
for tenor_s, label in ((3600, '1h'), (4*3600, '4h'), (86400, '1d')):
    t0 = np.arange(86400*2, n - tenor_s - 2, tenor_s if tenor_s < 86400 else 86400)
    sdr = sgm[t0]*np.sqrt(tenor_s/(365*86400))
    T0 = np.repeat(t0, 7).astype(np.int64); lnK = (pool[t0][:, None] + bt.KS[None, :]*sdr[:, None]).ravel()
    yidx = np.full(len(T0), 6, dtype=np.int64)
    for block, bl in ((12, 'L1 12s'), (2, 'L2 2s')):
        for cutf in (0.02, 0.1):
            for s in (0.01, 0.02):
                c = dict(bt.DEF); c.update(tail=0, dir=0, iv=0, orv=0, lat=1, lag=0, block=block, imp_hl=0, lam=0.05, s=s, cut=int(cutf*tenor_s), noise_trades=20*60)
                P = bt.pvec(c, 60); out = np.zeros((len(T0), 12))
                E.run_hook(T0, tenor_s, lnK, cex, pool, sigH, sigH, E.t_table(5.0), Q, yidx, SC, P, 3, out, dv, cum)
                print(f"{label} {bl:>6} reset/block cut={cutf:.0%} s={s:.2f}: LP pnl/market vs latency arb {out[:,0].mean():+.4f} ± {out[:,0].std()/np.sqrt(len(T0)):.4f}  arb vol {out[:,6].mean():6.2f}  noise pnl/unit {out[:,5].mean():+.4f}  => break-even eta {max(0,-out[:,0].mean())/out[:,5].mean():.2f}", flush=True)
