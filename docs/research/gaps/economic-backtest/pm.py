import json, urllib.request, datetime
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent':'Mozilla/5.0'}), timeout=30))
rows=[]
for d in range(1, 25):
    day = datetime.date(2026, 9, d)
    slug = f"ethereum-above-on-{day.strftime('%B').lower()}-{d}-2026"
    try: ev = get(f"https://gamma-api.polymarket.com/events?slug={slug}")
    except Exception as e: continue
    if not ev: continue
    e = ev[0]; ms = e.get('markets', [])
    vols = sorted([float(m.get('volume') or 0) for m in ms], reverse=True)
    liq = [float(m.get('liquidity') or 0) for m in ms]
    rows.append((str(day), len(ms), float(e.get('volume') or 0), vols[:5], sum(liq)))
for r in rows: print(r)
import numpy as np
if rows:
    tv = np.array([r[2] for r in rows]); print('daily ETH-above event volume: median %.0f mean %.0f; strikes/event median %d' % (np.median(tv), tv.mean(), np.median([r[1] for r in rows])))
