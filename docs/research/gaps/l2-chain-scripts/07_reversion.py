"""Speed of arbitrage reversion: for samples whose de-meaned pool-vs-Binance deviation e exceeds the fee band
(|e| > f + 1 bp), the median fraction of the excess (|e| - f) still present h seconds later.  The band-follower cost
model (02_attack_cost.py) assumes the whole excess is removed by the next oracle slot (fraction 0 at h = Delta).
Also buckets by excess size, because the 2026-09-24 Arbitrum event (06_arb_event.py) suggests large dislocations revert
slowly (limited arbitrage capital per block).  "arb_ex" excludes the event +-1 h."""
import numpy as np, calendar
f = 5e-4
EV = (calendar.timegm((2026, 9, 24, 18, 35, 0)), calendar.timegm((2026, 9, 24, 21, 5, 0)))  # event +-1 h
for tag in ["arb", "arb_ex", "base7", "eth"]:
    z = np.load(f"data/grid_{tag.replace('_ex','')}.npz"); e = z["e"]; D = int(z["delta"]); g = z["grid"]
    okmask = ~((g >= EV[0]) & (g <= EV[1])) if tag.endswith("_ex") else np.ones(len(e), bool)
    print(f"=== {tag} (Delta {D} s, {len(e)} slots) ===")
    for lo, hi in [(1e-4, 5e-4), (5e-4, 20e-4), (20e-4, 1.0)]:
        ex = np.abs(e) - f
        idx = np.where((ex > lo) & (ex <= hi) & okmask)[0]
        out = []
        for h in [D, 2 * D if D < 12 else 12, 12, 30, 60, 120]:
            k = max(1, h // D); j = idx[idx + k < len(e)]
            rem = np.maximum(np.sign(e[j]) * e[j + k] - f, 0) / ex[j]
            out.append(f"h={h:>3}s:{np.median(rem):.2f}/{np.mean(rem):.2f}")
        print(f"  excess {lo*1e4:>4.0f}-{min(hi,1)*1e4:>5.0f} bp: n={len(idx):>6} ({len(idx)/len(e):.2%})  remaining excess median/mean  " + "  ".join(out))
