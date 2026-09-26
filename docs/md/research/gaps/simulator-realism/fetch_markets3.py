import json, urllib.request, time, sys, pickle
URL = sys.argv[1]; shard, nsh = int(sys.argv[2]), int(sys.argv[3]); BS = int(sys.argv[4])
SEL = [('det', '0x41bc7b1f'), ('times', '0x9e3b34bf'), ('result', '0x65372147')]
def batch(reqs):
    body = json.dumps([{"jsonrpc": "2.0", "id": i, "method": "eth_call", "params": [{"to": to, "data": d}, "latest"]} for i, (to, d) in enumerate(reqs)]).encode()
    for k in range(40):
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request(URL, data=body, headers={'content-type': 'application/json', 'User-Agent': 'research'}), timeout=60))
            if isinstance(r, list):
                out = [None]*len(reqs); bad = False
                for x in r:
                    if 'result' in x: out[x['id']] = x['result']
                    elif 'revert' in str(x.get('error', '')): out[x['id']] = None
                    else: bad = True
                if not bad: return out
        except Exception as e: pass
        time.sleep(2 + 2*k)
    raise RuntimeError('batch failed')
def words(h): h = h[2:]; return [h[i:i+64] for i in range(0, len(h), 64)]
tr, iv = pickle.load(open('tape_raw.pkl', 'rb'))
import glob
have = set()
for f in glob.glob('markets_*.json'):
    have |= {m['market'] for m in json.load(open(f)) if 'maturity' in m}
mk = sorted({t['market'] for t in tr if t['ts'] >= 1680307200} - have)[shard::nsh]
res = []; step = max(1, BS//3)
from concurrent.futures import ThreadPoolExecutor
TH = int(sys.argv[5]) if len(sys.argv) > 5 else 1
chunks = [mk[i:i+step] for i in range(0, len(mk), step)]
def job(ms): return ms, batch([(m, s) for m in ms for _, s in SEL])
ex = ThreadPoolExecutor(TH)
for i, (ms, out) in enumerate(ex.map(job, chunks)):
    for j, m in enumerate(ms):
        d, t, r = out[3*j:3*j+3]; o = dict(market=m)
        if d and len(d) >= 2+64*3: w = words(d); o['key'] = bytes.fromhex(w[0]).rstrip(b'\0').decode(errors='replace'); o['strike'] = int(w[1], 16)/1e18; o['final'] = int(w[2], 16)/1e18
        if t and len(t) >= 2+64*2: w = words(t); o['maturity'] = int(w[0], 16); o['expiry'] = int(w[1], 16)
        if r and r != '0x': o['result'] = int(r, 16)
        res.append(o)
    if i % 50 == 0: print(i, len(mk), flush=True); json.dump(res, open(f'markets_t{shard}_{nsh}.json', 'w'))
json.dump(res, open(f'markets_t{shard}_{nsh}.json', 'w')); print('done', len(res), flush=True)
