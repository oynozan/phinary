"""Build per-asset 1-minute close arrays on a common minute grid (2023-03-01 .. 2025-03-01 UTC)."""
import numpy as np, zipfile, glob, datetime as dt
T0 = int(dt.datetime(2023, 3, 1, tzinfo=dt.timezone.utc).timestamp()); N = int((dt.datetime(2025, 3, 1, tzinfo=dt.timezone.utc).timestamp() - T0)//60)
out = {}
for sym in ('BTC', 'ETH', 'SNX', 'LINK', 'OP', 'SOL', 'CRV'):
    g = np.full(N, np.nan)
    for f in sorted(glob.glob(f'px/{sym}USDT-1m-*.zip')):
        z = zipfile.ZipFile(f); raw = z.read(z.namelist()[0]).decode().splitlines()
        a = np.array([(int(l.split(',')[0]), float(l.split(',')[4])) for l in raw if l and l[0].isdigit()])
        ts = np.where(a[:, 0] > 1e14, a[:, 0]//1000, a[:, 0])//1000
        i = ((ts - T0)//60).astype(np.int64); ok = (i >= 0) & (i < N); g[i[ok]] = a[ok, 1]
    miss = np.isnan(g).sum()
    for i in range(1, N):
        if np.isnan(g[i]): g[i] = g[i-1]
    out[sym] = g; print(sym, 'missing minutes', miss)
np.savez('px1m.npz', T0=T0, **out)
