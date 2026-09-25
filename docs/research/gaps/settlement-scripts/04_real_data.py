"""(a) Real-data check of the band-follower cost model on the mainnet v3 USDC/WETH pools (2 days of Swap logs,
blocks 26,040,846-26,055,146, fetched 2026-09-25) against Binance ETHUSDT 1-second closes.
1. pool-vs-reference deviation at block times (is the pool inside a +-f band?)
2. share of blocks in which the end-of-block price moves up / down (pi_up, pi_down)
3. replay of the floor/pin attack on the REAL reference path (band follower driven by Binance 1 s),
   compared with GBM simulation and with the calibrated closed form C ~= pi_up * n_w * y_v * delta^2
4. real volume per 30-min window (noise-absorption term)."""
import json, gzip, numpy as np
from math import log, sqrt
from common import simulate_floor_attack, push_cost, YEAR

d = json.load(gzip.open("data/swaps_2d.json.gz"))
bn = json.load(gzip.open("data/bn1s.json.gz"))
bts = np.array([r[0] for r in bn]); bpx = np.log(np.array([r[1] for r in bn]))
bmap = dict(zip(bts.tolist(), bpx.tolist()))
t_lo, t_hi = bts[0], bts[-1]


def ref_at(ts):  # last Binance 1 s close at or before ts-1 (completed second before the block)
    i = np.searchsorted(bts, ts - 1, side="right") - 1
    return bpx[np.clip(i, 0, len(bpx) - 1)]


YV = {"v3_5bp": 155.5e6, "v3_1bp": 58.0e6, "v3_30bp": 199.1e6}
FEE = {"v3_5bp": 5e-4, "v3_1bp": 1e-4, "v3_30bp": 3e-3}
for name in ["v3_5bp", "v3_1bp", "v3_30bp"]:
    rows = sorted(d["pools"][name], key=lambda r: (r[0], r[1]))
    eob = {}; ts_of = {}; vol_buy = {}; vol_sell = {}
    for b, li, ts, a0, a1, sp, L, tick in rows:
        sp = int(sp); P = (sp / 2**96) ** 2  # wei WETH per USDC unit
        eob[b] = log(1e12 / P)  # ln ETH price in USDC
        ts_of[b] = ts
        a0 = int(a0) / 1e6  # USDC into pool (+) -> trader buys ETH
        if a0 > 0: vol_buy[b] = vol_buy.get(b, 0) + a0
        else: vol_sell[b] = vol_sell.get(b, 0) - a0
    blocks = sorted(eob)
    # build a 12 s slot grid between first and last swap and carry the pool price forward
    ts_b = np.array([ts_of[b] for b in blocks]); px_b = np.array([eob[b] for b in blocks])
    g0 = max(ts_b[0], t_lo + 5); g1 = min(ts_b[-1], t_hi)
    grid = np.arange(g0, g1, 12)
    j = np.searchsorted(ts_b, grid, side="right") - 1
    Y = px_b[j]; X = ref_at(grid)
    dev = Y - X
    # remove slow USDC/USDT basis with a 1 h rolling median
    k = 300; basis = np.array([np.median(dev[max(0, i - k // 2): i + k // 2 + 1]) for i in range(0, len(dev))])
    e = dev - basis
    dy = np.diff(Y)
    print(f"\n=== {name} (fee {FEE[name]*1e4:.0f} bp, y_v ${YV[name]/1e6:.1f}M): {len(rows)} swaps, {len(blocks)} swap blocks, {len(grid)} 12-s slots ===")
    print(f"  deviation pool - Binance (basis removed): sd {e.std()*1e4:.2f} bp; |e|<=f: {np.mean(np.abs(e)<=FEE[name]):.1%}; "
          f"|e|<=2f: {np.mean(np.abs(e)<=2*FEE[name]):.1%}; p1/p99 {np.percentile(e,1)*1e4:.1f}/{np.percentile(e,99)*1e4:.1f} bp")
    pi_up = np.mean(dy > 0); pi_dn = np.mean(dy < 0)
    print(f"  slot-to-slot pool moves: up {pi_up:.1%}, down {pi_dn:.1%}, zero {np.mean(dy==0):.1%}")
    sbX = np.diff(X).std(); sig = sbX / sqrt(12 / YEAR)
    print(f"  Binance 12-s return sd {sbX*1e4:.2f} bp -> sigma {sig:.3f} annualised")
    if name == "v3_5bp":
        # 30-min windows: realised buy/sell USD volume
        tb = np.array(blocks); vb = np.array([vol_buy.get(b, 0) for b in blocks]); vs = np.array([vol_sell.get(b, 0) for b in blocks])
        win = ((ts_b - ts_b[0]) // 1800).astype(int)
        VB = np.bincount(win, vb); VS = np.bincount(win, vs)
        print(f"  real volume per 30-min window: buys median ${np.median(VB)/1e3:,.0f}k mean ${VB.mean()/1e3:,.0f}k; sells median ${np.median(VS)/1e3:,.0f}k mean ${VS.mean()/1e3:,.0f}k")
        print(f"  -> upper bound on the noise-absorption cost of an up-pin (2f x sell volume): median ${2*FEE[name]*np.median(VS):,.0f}, mean ${2*FEE[name]*VS.mean():,.0f} per window")
        # replay: windows of burn 50 + 150 slots on the real reference
        n_w, burn = 150, 50; L = burn + n_w + 1
        starts = range(0, len(X) - L, 75)  # 50% overlapping windows
        XP = np.stack([X[s:s + L] - X[s] for s in starts])
        f = FEE[name]; yv = YV[name]
        s_list = [0.5 * f, 1.0 * f, 1.5 * f, 2 * f, 3 * f, 4 * f]
        real = simulate_floor_attack(None, 12, f, n_w, s_list, burn=burn, X_paths=XP)
        gbm = simulate_floor_attack(sig, 12, f, n_w, s_list, npaths=4000, seed=5)
        print(f"  replay on REAL Binance path ({XP.shape[0]} windows) vs GBM at sigma={sig:.2f}; calibrated closed form uses real pool pi_up={pi_up:.3f}")
        print(f"  {'s/f':>5} {'shift bp':>9} {'real-path cost $':>17} {'GBM cost $':>11} {'pi_up*n_w*yv*d^2 $':>19}")
        for s in s_list:
            dr, cr, _, _ = real[s]; dg, cg, _, _ = gbm[s]
            print(f"  {s/f:5.2f} {dr*1e4:9.2f} {cr*yv:17,.0f} {cg*yv:11,.0f} {pi_up*n_w*yv*dr*dr:19,.0f}")
