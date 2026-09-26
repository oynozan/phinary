"""Case study: 2026-09-24 19:39-19:50 UTC, the Arbitrum v3 5 bp WETH/USDC pool traded 3-6% above Binance for ~6 min.
Mark every swap to Binance (1 s close before the block timestamp, basis-adjusted by the 1 h median) and compute:
  - buyer loss / seller gain vs the CEX mark over the event (who paid whom),
  - the shift of 30-min, 2-h and 4-h pool TWAPs relative to the CEX-implied counterfactual,
  - the model cost C(delta) that 02_attack_cost.py assigns to the same shift (band-follower, next-slot arbitrage)."""
import json, gzip, time, calendar, numpy as np
d = json.load(gzip.open("data/swaps_arb.json.gz", "rt")); p = json.load(gzip.open("data/arb_blocks.json.gz", "rt"))["swapblocks"]
rows = sorted([r[:3] + [p[str(r[0])][1]] + r[4:] for r in d["swaps"]], key=lambda r: (r[0], r[2]))
bn = json.load(gzip.open("data/bn1s.json.gz", "rt")); bts = np.array([r[0] for r in bn]); bpx = np.array([r[1] for r in bn])
def cex(t): return bpx[max(0, np.searchsorted(bts, t - 1, side="right") - 1)]
t0 = calendar.timegm((2026, 9, 24, 19, 39, 50)); t1 = t0 + 900
basis = np.median([((int(r[6]) / 2**96) ** 2 * 1e12) / cex(r[3]) for r in rows if t0 - 3600 <= r[3] < t0 - 60])
print(f"pre-event basis pool/Binance = {basis:.5f}")
buy_loss = sell_gain = 0.0; vb = vs = 0.0
for r in rows:
    if not (t0 <= r[3] <= t1): continue
    eth_to_trader = -int(r[4]) / 1e18; usdc_to_trader = -int(r[5]) / 1e6; m = cex(r[3]) * basis
    pnl = usdc_to_trader + eth_to_trader * m
    if eth_to_trader > 0: buy_loss += -pnl; vb += -usdc_to_trader
    else: sell_gain += pnl; vs += usdc_to_trader
print(f"event {time.strftime('%H:%M:%S', time.gmtime(t0))}+15 min: ETH buyers paid ${vb/1e6:.2f}M, lost ${buy_loss/1e3:,.0f}k vs CEX mark; "
      f"ETH sellers received ${vs/1e6:.2f}M, gained ${sell_gain/1e3:,.0f}k vs CEX mark")
# TWAP shift: pool log price per second vs CEX*basis
ts = np.array([r[3] for r in rows]); lp = np.log(np.array([(int(r[6]) / 2**96) ** 2 * 1e12 for r in rows]))
for w in (1800, 7200, 14400):
    sec = np.arange(t0 - 60, t0 - 60 + w)
    Y = lp[np.searchsorted(ts, sec, side="right") - 1]; X = np.log(np.array([cex(s + 1) for s in sec]) * basis)
    dev = Y - X; print(f"  w={w//60:>3} min window starting 1 min before the event: TWAP shift vs CEX-implied {dev.mean()*1e4:+.1f} bp; "
                      f"max 1 s deviation {dev.max()*1e4:.0f} bp; seconds with |dev|>25 bp: {(np.abs(dev)>25e-4).sum()}")
