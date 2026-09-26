"""(c) block.timestamp / block.number semantics measured on a contiguous 12,000-block Arbitrum One sample and on Base.
Arbitrum: blocks per timestamp, timestamp gaps, block.number (= l1BlockNumber in the header, what `block.number`
returns to contracts) cadence and its lag behind the L2 timestamp (L1 header timestamps fetched from an L1 RPC).
Base: timestamp == genesis + 2*n is checked in 00_base_ts (see report); here only the swap-block sample is summarised."""
import json, gzip, subprocess, numpy as np, collections
a = json.load(gzip.open("data/arb_blocks.json.gz", "rt"))
c = np.array(a["contig"], dtype=np.int64)  # number, ts, l1BlockNumber, ntx, gasUsed, baseFee
num, ts, l1 = c[:, 0], c[:, 1], c[:, 2]
print(f"Arbitrum contiguous sample: blocks {num[0]:,}..{num[-1]:,} ({len(num)} blocks), ts span {ts[-1]-ts[0]} s -> {len(num)/(ts[-1]-ts[0]):.2f} blocks/s")
_, cnt = np.unique(ts, return_counts=True)
h = collections.Counter(cnt.tolist())
print("  blocks sharing one timestamp: " + ", ".join(f"{k}:{h[k]/len(cnt):.1%}" for k in sorted(h)) + f"; mean {cnt.mean():.2f}")
g = np.diff(np.unique(ts)); print(f"  gaps between successive distinct timestamps: " + ", ".join(f"{k}s:{v}" for k, v in sorted(collections.Counter(g.tolist()).items())))
print(f"  monotone non-decreasing: {bool(np.all(np.diff(ts) >= 0))}")
print(f"  txs per block: median {np.median(c[:,3]):.0f}, mean {c[:,3].mean():.1f}; baseFee median {np.median(c[:,5])/1e9:.4f} gwei")
ul1, first = np.unique(l1, return_index=True)
print(f"  block.number (= L1 block number) distinct values {len(ul1)} over {ts[-1]-ts[0]} s -> advances every {(ts[-1]-ts[0])/len(ul1):.1f} s on average; "
      f"L2 blocks per block.number value: median {np.median(np.diff(first)):.0f}, max {np.diff(first).max()}")
steps = np.diff(ul1); print(f"  block.number increments: " + ", ".join(f"+{k}:{v}" for k, v in sorted(collections.Counter(steps.tolist()).items())))
# L1 timestamps of the referenced L1 blocks
sel = ul1[:: max(1, len(ul1) // 60)]
body = json.dumps([{"jsonrpc": "2.0", "id": i, "method": "eth_getBlockByNumber", "params": [hex(int(n)), False]} for i, n in enumerate(sel)])
o = subprocess.run(["curl", "-s", "--max-time", "60", "-X", "POST", "https://ethereum-rpc.publicnode.com", "-H", "Content-Type: application/json", "-d", body], capture_output=True, text=True).stdout
j = sorted(json.loads(o), key=lambda x: x["id"])
l1ts = {int(n): int(x["result"]["timestamp"], 16) for n, x in zip(sel, j)}
lag = [ts[first[np.searchsorted(ul1, n)]] - l1ts[n] for n in sel]
print(f"  L2 timestamp of first L2 block that reports block.number = N, minus L1 timestamp of N: median {np.median(lag):.0f} s, "
      f"min {min(lag)} s, max {max(lag)} s  (n={len(lag)})")
# swap-block sample: blocks per second with swaps (all 2 days)
sb = a["swapblocks"]; st = np.array(sorted(v[1] for v in sb.values()))
print(f"Arbitrum swap blocks: {len(st)}; distinct swap timestamps {len(np.unique(st))}")
