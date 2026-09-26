"""(a)+(b) Pool-vs-CEX statistics for the Uniswap v3 WETH/USDC 5 bp pools on Arbitrum One, Base and (same period)
Ethereum, against Binance ETHUSDT 1-second closes.

usage: python 01_pool_vs_cex.py <arb|base|eth> [swaps file] [binance file] [tag]

Oracle sampling convention (v3 Oracle.write, v3-core/contracts/UniswapV3Pool.sol:732-748 and Oracle.sol:78-99):
  one observation per distinct block.timestamp, written by the first tick-changing swap with a new timestamp, carrying
  the tick that prevailed since the previous activity.  The accumulator therefore integrates the price at the END of the
  last swap with timestamp <= t-1s (1 s timestamp granularity).  Sample grid:
     arb : Delta = 1 s  (4 blocks per second share one timestamp)
     base: Delta = 2 s  (timestamp = genesis + 2 n, one block per 2 s)
     eth : Delta = 12 s
  Y[g] = log price after the last swap with timestamp < g (i.e. what the oracle holds over (g-Delta, g]),
  X[g] = log Binance 1 s close of the second ending at g - 1 (the last completed CEX second before the block).
"""
import json, gzip, sys, numpy as np, pandas as pd
from math import log, sqrt
YEAR = 365 * 86400
chain = sys.argv[1]
SW = sys.argv[2] if len(sys.argv) > 2 else f"data/swaps_{chain}.json.gz"
BN = sys.argv[3] if len(sys.argv) > 3 else "data/bn1s.json.gz"
TAG = sys.argv[4] if len(sys.argv) > 4 else chain
DELTA = {"arb": 1, "base": 2, "eth": 12}[chain]
F = 5e-4

d = json.load(gzip.open(SW, "rt"))
rows = d["swaps"]
if chain == "arb":  # log blockTimestamp from the public RPC is 0 for ~72% of rows: use block headers
    import os
    bl = json.load(gzip.open("data/arb_blocks.json.gz", "rt"))["swapblocks"] if os.path.exists("data/arb_blocks.json.gz") else json.load(open("data/arb_blocks_partial.json"))
    tsmap = {int(k): v[1] for k, v in bl.items()}
    rows = [r[:3] + [tsmap[r[0]]] + r[4:] for r in rows]
rows.sort(key=lambda r: (r[0], r[2]))
bn = json.load(gzip.open(BN, "rt"))
bts = np.array([r[0] for r in bn]); bpx = np.log(np.array([r[1] for r in bn]))


def cex_close_before(t):  # close of the 1 s kline that opened at t-1 (completed at t)
    i = np.searchsorted(bts, t - 1, side="right") - 1
    return bpx[np.clip(i, 0, len(bpx) - 1)]


flip = chain == "eth"  # mainnet pool: token0 = USDC, token1 = WETH
blk, ts, lp, L, a_usdc = [], [], [], [], []
for b, txi, li, t, a0, a1, sp, liq, tick in rows:
    P = (int(sp) / 2**96) ** 2
    blk.append(b); ts.append(t); L.append(int(liq))
    if flip:
        lp.append(log(1e12 / P)); a_usdc.append(int(a0) / 1e6)
    else:
        lp.append(log(P * 1e12)); a_usdc.append(int(a1) / 1e6)
blk = np.array(blk); ts = np.array(ts); lp = np.array(lp); L = np.array(L, float); a_usdc = np.array(a_usdc)
# virtual USDC reserve in the active range, in $:
#   USDC = token1 (arb, base): y_v = L * sqrt(P_raw), P_raw = USDC-units per WETH-wei = price * 1e-12
#   USDC = token0 (eth):       x_v = L / sqrt(P_raw), P_raw = WETH-wei per USDC-unit = 1e12 / price
price = np.exp(lp)
yv = (L / np.sqrt(1e12 / price) if flip else L * np.sqrt(price * 1e-12)) / 1e6
span = ts.max() - ts.min()
print(f"=== {chain}: {len(rows)} swaps, {len(np.unique(blk))} swap blocks, {len(np.unique(ts))} distinct swap timestamps, span {span/3600:.1f} h, Delta = {DELTA} s ===")
print(f"  y_v (virtual USDC reserve in active range) over swaps: mean ${yv.mean()/1e6:.1f}M, median ${np.median(yv)/1e6:.1f}M, "
      f"harmonic ${1/np.mean(1/yv)/1e6:.1f}M, p5 ${np.percentile(yv,5)/1e6:.1f}M, p95 ${np.percentile(yv,95)/1e6:.1f}M")
vol = np.abs(a_usdc).sum()
print(f"  USDC volume ${vol/1e6:,.0f}M over span -> ${vol/span*86400/1e6:,.0f}M/day; swaps/day {len(rows)/span*86400:,.0f}")

# end-of-timestamp price (last swap with that timestamp)
uts, last_idx = np.unique(ts[::-1], return_index=True)
last_idx = len(ts) - 1 - last_idx
eot = lp[last_idx]  # log price after the last swap stamped uts
g0 = max(uts[0] + DELTA, bts[0] + 5); g1 = min(uts[-1], bts[-1])
grid = np.arange(g0 - (g0 % DELTA), g1, DELTA)
j = np.searchsorted(uts, grid, side="left") - 1  # last swap timestamp strictly < g
Y = eot[j]; X = cex_close_before(grid)
dev = Y - X
k = max(1, 3600 // DELTA)
basis = pd.Series(dev).rolling(k, center=True, min_periods=k // 4).median().values
e = dev - basis
dy = np.diff(Y)
sbX = np.diff(X).std(); sig = sbX / sqrt(DELTA / YEAR)
print(f"  grid slots {len(grid)}; Binance {DELTA}-s return sd {sbX*1e4:.2f} bp -> sigma {sig:.3f}")
print(f"  basis (USDC/USDT etc.) mean {dev.mean()*1e4:.2f} bp; de-meaned deviation sd {e.std()*1e4:.2f} bp; |e|<=f {np.mean(np.abs(e)<=F):.1%}; "
      f"|e|<=2f {np.mean(np.abs(e)<=2*F):.1%}; p1/p99 {np.percentile(e,1)*1e4:.1f}/{np.percentile(e,99)*1e4:.1f} bp")
pu, pdn, pz = np.mean(dy > 0), np.mean(dy < 0), np.mean(dy == 0)
print(f"  slot-to-slot oracle-sample moves: up {pu:.1%}, down {pdn:.1%}, none {pz:.1%}")

# lead-lag: corr(pool slot return, Binance return over the same-length interval shifted L s earlier)
print("  lead-lag corr(pool Delta-return, Binance Delta-return lagged L s; L>0: Binance earlier):")
Ls = [-4, -2, -1, 0, 1, 2, 3, 4, 6, 8, 12, 24, 36, 60]
cs = []
for Lg in Ls:
    Xl = cex_close_before(grid - Lg); c = np.corrcoef(dy, np.diff(Xl))[0, 1]; cs.append(c)
print("    " + "  ".join(f"L={l:+d}:{c:+.3f}" for l, c in zip(Ls, cs)))
# aggregate at 12 s for comparability with L1 (economic report s2.1)
g12 = grid[::max(1, 12 // DELTA)]; Y12 = Y[::max(1, 12 // DELTA)]
r12 = np.diff(Y12)
print("  same, 12 s returns: " + "  ".join(f"L={l:+d}:{np.corrcoef(r12, np.diff(cex_close_before(g12 - l)))[0,1]:+.3f}" for l in [-12, 0, 12, 24, 36, 60]))
# cumulative response: regression beta of pool 60 s return on Binance returns
# information share proxy: fraction of Binance move absorbed within h seconds
for h in [DELTA, 4, 12, 30, 60]:
    step = max(1, h // DELTA)
    if step * DELTA != h and h != DELTA: continue
    Yh = Y[::step]; Xh = X[::step]
    b = np.polyfit(np.diff(Xh), np.diff(Yh), 1)[0]
    print(f"    beta(pool {h:>2}s return on same-interval Binance return) = {b:.3f}")

# start-of-block (SoB) oracle error vs the CEX, by oracle age: pool price held at g vs CEX at g + age
print("  SoB oracle error SD vs Binance, by oracle age (basis removed with 1 h rolling median):")
for age in [0, 1, 2, 4, 6, 12, 60]:
    x = Y - cex_close_before(grid + age); x = x - pd.Series(x).rolling(k, center=True, min_periods=k // 4).median().values
    print(f"    age {age:>2}s: sd {np.nanstd(x)*1e4:.2f} bp, |.|>5bp {np.nanmean(np.abs(x)>5e-4):.1%}")
# band-follower model check at this Delta
Xs = bpx; band = np.empty_like(Xs); p = Xs[0]
for i in range(len(Xs)):
    p = min(max(p, Xs[i] - F), Xs[i] + F); band[i] = p
bm = band[np.clip(np.searchsorted(bts, grid - 1, side="right") - 1, 0, len(bts) - 1)]
dd = Y - bm; dd = dd - pd.Series(dd).rolling(k, center=True, min_periods=k // 4).median().values
print(f"  pool vs 5 bp band-follower of Binance (1 s arbs): tracking error sd {np.nanstd(dd)*1e4:.2f} bp")
# gaps with no oracle update (staleness)
gp = np.diff(uts)
print(f"  gaps between distinct swap timestamps: median {np.median(gp):.0f}s p90 {np.percentile(gp,90):.0f}s p99 {np.percentile(gp,99):.0f}s max {gp.max():.0f}s")
np.savez_compressed(f"data/grid_{TAG}.npz", grid=grid, Y=Y, X=X, e=e, yv_mean=yv.mean(), yv_harm=1 / np.mean(1 / yv), sig=sig, delta=DELTA)
