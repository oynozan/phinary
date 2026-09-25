"""(a) Band bias of the TWAP-return realised-variance estimator (oracle report s3.1-3.2) on the real L2 pools.

usage: python 04_band_bias.py <swaps file> <binance file> <chain>

Estimator (underlying-oracle-source-and-sigma-estimator.md s3.1): H = 300 s windows, A_g = time-average of the pool
log-price over ((g-1)H, gH] (what cum(gH)-cum((g-1)H) gives, at 1 s resolution), r_g = A_g - A_{g-1},
v_raw = (3/2) * sum r_g^2 / (n H)   [per second].  Reference: the same estimator on Binance 1 s closes.
Model: v_pool = v_ref - c * gamma^2 / H with gamma = 5 bp; the oracle report adopted c = 0.5 (beta = 0.5 gamma^2/H).
Also reports the estimator at H = 900 s and the day-by-day ratio to show sampling noise."""
import json, gzip, sys, numpy as np
from math import sqrt, log
YEAR = 365 * 86400
sw_file, bn_file, chain = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(gzip.open(sw_file, "rt")); rows = d["swaps"]
if chain == "arb":
    import os
    bl = json.load(gzip.open("data/arb_blocks.json.gz", "rt"))["swapblocks"] if os.path.exists("data/arb_blocks.json.gz") else json.load(open("data/arb_blocks_partial.json"))
    tsmap = {int(k): v[1] for k, v in bl.items()}
    rows = [r[:3] + [tsmap[r[0]]] + r[4:] for r in rows]
rows.sort(key=lambda r: (r[0], r[2]))
flip = chain == "eth"
ts = np.array([r[3] for r in rows])
lp = np.array([log(1e12 / (int(r[6]) / 2**96) ** 2) if flip else log((int(r[6]) / 2**96) ** 2 * 1e12) for r in rows])
bn = json.load(gzip.open(bn_file, "rt"))
bts = np.array([r[0] for r in bn]); bpx = np.log(np.array([r[1] for r in bn]))
t0 = max(ts.min(), bts.min()) + 600; t1 = min(ts.max(), bts.max())
sec = np.arange(t0, t1)
# pool price prevailing over second (s, s+1]: price after the last swap with timestamp <= s
ip = np.searchsorted(ts, sec, side="right") - 1; P = lp[ip]
# Binance: close of the kline that opened at s (i.e. price at s+1); last known
ib = np.clip(np.searchsorted(bts, sec, side="right") - 1, 0, len(bts) - 1); B = bpx[ib]
gamma = 5e-4
print(f"=== {chain}: {len(rows)} swaps, {len(sec)/86400:.2f} days of 1 s grid ===")
for H in (300, 900):
    n = len(sec) // H
    Ap = P[: n * H].reshape(n, H).mean(1); Ab = B[: n * H].reshape(n, H).mean(1)
    rp, rb = np.diff(Ap), np.diff(Ab)
    vp = 1.5 * (rp**2).sum() / ((n - 1) * H); vb = 1.5 * (rb**2).sum() / ((n - 1) * H)
    ratio = vp / vb; c = (vb - vp) * H / gamma**2; beta = 0.5 * gamma**2 / H
    se = sqrt(2 * 1.125 / (n - 1))  # relative SE of one RV estimate; the ratio is far tighter (paired)
    # paired bootstrap by day for the ratio
    per_day = 86400 // H; nd = (n - 1) // per_day
    rats = [((rp[i*per_day:(i+1)*per_day]**2).sum() / (rb[i*per_day:(i+1)*per_day]**2).sum()) for i in range(nd)]
    rng = np.random.default_rng(1); bs = []
    idx = np.arange(n - 1)
    for _ in range(2000):
        k = rng.integers(0, max(nd, 1), max(nd, 1))
        sel = np.concatenate([idx[i*per_day:(i+1)*per_day] for i in k]) if nd > 0 else idx
        bs.append((rp[sel]**2).sum() / (rb[sel]**2).sum())
    lo, hi = np.percentile(bs, [2.5, 97.5])
    print(f"  H={H}s: n={n-1} returns; sigma_pool {sqrt(vp*YEAR):.4f}, sigma_binance {sqrt(vb*YEAR):.4f}; "
          f"var ratio {ratio:.4f} (day-block bootstrap 95% [{lo:.3f},{hi:.3f}]); implied c = {c:+.2f} "
          f"(model c=0.5 -> ratio {1 - 0.5*gamma**2/H/vb:.4f}); ratio after +beta {(vp+beta)/vb:.4f}")
    print(f"     per-day ratios: " + " ".join(f"{x:.3f}" for x in rats))

# Arbitrum: effect of the 2026-09-24 19:39-19:46 UTC dislocation (06_arb_event.py) and of the oracle report's clamp
if chain == "arb":
    import calendar
    EV = (calendar.timegm((2026, 9, 24, 19, 30, 0)), calendar.timegm((2026, 9, 24, 20, 15, 0)))
    for H in (300, 900):
        n = len(sec) // H
        Ap = P[: n * H].reshape(n, H).mean(1); Ab = B[: n * H].reshape(n, H).mean(1)
        rp, rb = np.diff(Ap), np.diff(Ab); tend = sec[0] + H * np.arange(2, n + 1)
        ok = ~((tend > EV[0]) & (tend - 2 * H < EV[1]))
        cl = np.clip(rp, -400 * log(1.0001), 400 * log(1.0001))
        print(f"  H={H}s: pool/Binance variance ratio excluding the event windows ({(~ok).sum()} returns dropped): "
              f"{(rp[ok]**2).sum()/(rb[ok]**2).sum():.4f}; all windows with the 400-tick clamp: {(cl**2).sum()/(rb**2).sum():.4f}; "
              f"largest |r| in event {np.abs(rp[~ok]).max()*1e4:.0f} bp; event share of pool sum r^2: {(rp[~ok]**2).sum()/(rp**2).sum():.1%}")
