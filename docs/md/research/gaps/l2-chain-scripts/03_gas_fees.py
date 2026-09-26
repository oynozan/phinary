"""(e) Live fee sample: recent Uniswap v4 swaps (PoolManager Swap logs) on Arbitrum One and Base, their receipts
(gasUsed, effectiveGasPrice, L1 component) -> USD cost of an L2 swap and per-gas prices, then scaled to the
integrated PredictionHook swap gas (180-300k)."""
import json, subprocess, time, statistics as st
SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
C = {"arb": ("https://arb1.arbitrum.io/rpc", "0x360e68faccca8ca495c1b759fd9eee466db9fb32", 1200),
     "base": ("https://mainnet.base.org", "0x498581ff718922c3f8e6a244956af099b2652b2b", 150),
     "eth": ("https://ethereum-rpc.publicnode.com", "0x000000000004444c5dc75cB358380D2e3dE08A90", 25)}
def rpc(u, m, p):
    for k in range(6):
        o = subprocess.run(["curl", "-s", "--max-time", "40", "-X", "POST", u, "-H", "Content-Type: application/json", "-d",
                            json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p})], capture_output=True, text=True).stdout
        try:
            j = json.loads(o)
            if "result" in j: return j["result"]
        except Exception: pass
        time.sleep(1 + k)
    raise Exception(m)
ETH_USD = float(__import__("sys").argv[1]) if len(__import__("sys").argv) > 1 else 2690.0
for ch, (u, pm, span) in C.items():
    h = int(rpc(u, "eth_blockNumber", []), 16)
    logs = rpc(u, "eth_getLogs", [{"address": pm, "topics": [SWAP], "fromBlock": hex(h - span), "toBlock": hex(h)}])
    txs = list(dict.fromkeys(l["transactionHash"] for l in logs))[-40:]
    rows = []
    for t in txs:
        r = rpc(u, "eth_getTransactionReceipt", [t])
        gu = int(r["gasUsed"], 16); gp = int(r["effectiveGasPrice"], 16)
        l1 = int(r.get("l1Fee", "0x0"), 16); g1 = int(r.get("gasUsedForL1", "0x0"), 16)
        rows.append((gu, gp, l1, g1, gu * gp + l1))
    gp_med = st.median(r[1] for r in rows)
    l2only = [(r[0] - r[3]) * r[1] for r in rows]
    tot = [r[4] for r in rows]
    l1part = [r[2] + r[3] * r[1] for r in rows]
    print(f"{ch}: {len(rows)} v4-swap txs in last {span} blocks; median gasUsed {st.median(r[0]-r[3] for r in rows):,.0f} (execution), "
          f"median effectiveGasPrice {gp_med/1e9:.4f} gwei; median total fee ${st.median(tot)/1e18*ETH_USD:.4f} "
          f"(L1 data part median ${st.median(l1part)/1e18*ETH_USD:.4f}, max ${max(l1part)/1e18*ETH_USD:.4f}); p90 total ${sorted(tot)[int(.9*len(tot))]/1e18*ETH_USD:.4f}")
    for g in (180_000, 250_000, 300_000):
        print(f"   hook swap {g:,} gas: execution ${g*gp_med/1e18*ETH_USD:.4f} + L1 data ~${st.median(l1part)/1e18*ETH_USD:.4f} = ${(g*gp_med+st.median(l1part))/1e18*ETH_USD:.4f}")
