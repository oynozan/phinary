"""Uniswap v3 ETH/USDC 5 bp pool (mainnet 0x88e6...5640) vs Binance ETHUSDT 1s: basis and lead-lag, 2026-09-18..25."""
import json, numpy as np, zipfile, glob
sw = json.load(open('../v3_swaps.json')); bts = {int(k): v for k, v in json.load(open('data/v3_blockts.json')).items()}
# last tick of each block = end-of-block pool price = start-of-next-block price
last = {}
for b, li, tick in sw['swaps']: last[b] = tick
blocks = np.array(sorted(last)); ticks = np.array([last[b] for b in blocks]); tsb = np.array([bts[b] for b in blocks])
lp = np.log(1e12) - ticks*np.log(1.0001)            # ln(ETH price in USDC); token0 = USDC, token1 = WETH
ts=[]; px=[]
for f in sorted(glob.glob('data/ETHUSDT-1s-2026-09-*.zip')):
    z = zipfile.ZipFile(f); raw = z.read(z.namelist()[0]).decode().splitlines()
    a = np.array([(int(l.split(',')[0]), float(l.split(',')[4])) for l in raw if l and l[0].isdigit()])
    ts.append(a[:, 0]); px.append(a[:, 1])
ts = np.concatenate(ts); ts = np.where(ts > 1e14, ts//1000, ts)//1000; px = np.concatenate(px)
o = np.argsort(ts); ts = ts[o]; lb = np.log(px[o])
def cex_at(t):  # last 1s close with open time <= t-1 (close at <= t)
    i = np.searchsorted(ts, t - 1, side='right') - 1
    return lb[np.clip(i, 0, len(lb)-1)]
m = (tsb > ts[0] + 60) & (tsb < ts[-1] - 60)
tsb, lp = tsb[m], lp[m]
print('pool swap-blocks', len(tsb), 'span days', (tsb[-1]-tsb[0])/86400, 'median gap between swap blocks (s)', np.median(np.diff(tsb)))
basis = (lp - cex_at(tsb))*1e4
print('basis pool - Binance(USDT) bps: mean %.2f sd %.2f (USDC/USDT basis included)' % (basis.mean(), basis.std()))
# demeaned basis with a rolling 1h median removes the USDC/USDT basis
import pandas as pd
bs = pd.Series(basis, index=pd.to_datetime(tsb, unit='s'))
dm = (bs - bs.rolling('1h').median()).values
print('de-meaned basis bps: sd %.2f, |.|>5bp %.1f%%, |.|>10bp %.2f%%, p99 %.1f' % (dm.std(), 100*np.mean(np.abs(dm) > 5), 100*np.mean(np.abs(dm) > 10), np.percentile(np.abs(dm), 99)))
# lead-lag: regress pool price on CEX at lags
grid = np.arange(tsb[0], tsb[-1], 12)
pl = np.interp(grid, tsb, lp)  # step would be better: use last known
idx = np.searchsorted(tsb, grid, side='right') - 1; pl = lp[idx]
rp = np.diff(pl)
for L in (-24, -12, 0, 12, 24, 36, 60):
    rc = np.diff(cex_at(grid - L))
    print(f'corr(pool 12s return, Binance 12s return lagged {L:+d}s) = {np.corrcoef(rp, rc)[0,1]:+.3f}')
# staleness a start-of-block oracle would carry vs the CEX price at trade time (uniformly within the next 12 s slot)
gap = []
for k in range(len(grid)):
    pass
st = (pl[:-1] - cex_at(grid[:-1] + 6))*1e4    # oracle = pool at block start, trader acts mid-slot
stc = st - pd.Series(st).rolling(300, min_periods=1).median().values
print('start-of-block oracle vs CEX 6s later: sd %.2f bps; |.|>5bp %.1f%%' % (stc.std(), 100*np.mean(np.abs(stc) > 5)))
for d in (0, 2, 12, 60):
    x = (pl[:-1] - cex_at(grid[:-1] + d))*1e4; x = x - pd.Series(x).rolling(300, min_periods=1).median().values
    print(f'  oracle age {d:>2}s: sd {x.std():.2f} bps')
# band model check: simulate 5bp band follower on Binance 1s and compare with pool
cex1 = lb; band = np.empty_like(cex1); p = cex1[0]
for i in range(len(cex1)):
    p = min(max(p, cex1[i]-5e-4), cex1[i]+5e-4); band[i] = p
bm = np.interp(tsb, ts, band)
d = (lp - bm)*1e4; d = d - pd.Series(d).rolling(300, min_periods=1).median().values
print('pool vs 5bp-band model on Binance: sd %.2f bps' % d.std())
