"""Arbitrum guard check: over the 2-day swap-block sample, compare the L2 timestamp difference between two blocks
~w apart with 12 s x the difference of their block.number (= L1 block number).  A sequencer timestamp jump or freeze
would show up as a large residual; the honest distribution sets the guard tolerance."""
import json, gzip, numpy as np
b = json.load(gzip.open("data/arb_blocks.json.gz", "rt"))["swapblocks"]
v = np.array([x for x in b.values() if x[2] > 0], dtype=np.int64); v = v[np.argsort(v[:, 0])]
ts, l1 = v[:, 1], v[:, 2]
print(f"{len(v)} swap blocks with l1BlockNumber")
for w in (300, 1800, 7200, 14400):
    j = np.searchsorted(ts, ts + w); ok = j < len(ts); i = np.where(ok)[0]; j = j[ok]
    r = (ts[j] - ts[i]) - 12 * (l1[j] - l1[i])
    print(f"  w~{w:>5}s: residual (dts - 12*dL1) median {np.median(r):+.0f}s, p1 {np.percentile(r,1):+.0f}s, p99 {np.percentile(r,99):+.0f}s, min {r.min():+d}s, max {r.max():+d}s")
