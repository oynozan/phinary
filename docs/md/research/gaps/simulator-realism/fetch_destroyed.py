import json, pickle, urllib.request, time, numpy as np
URL = 'https://mainnet.optimism.io'
def call(to, data, block):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": to, "data": data}, hex(block)]}).encode()
    for k in range(30):
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request(URL, data=body, headers={'content-type': 'application/json'}), timeout=60))
            if 'result' in r: return r['result']
            if 'revert' in str(r.get('error', '')): return None
        except Exception: pass
        time.sleep(2 + 2*k)
def words(h): h = h[2:]; return [h[i:i+64] for i in range(0, len(h), 64)]
KB = np.array([85000000, 90000000, 95000000, 100000000, 105235063]); KT = np.array([1680226552, 1681412519, 1682683073, 1684600689, 1686068903])
def block_at(ts):
    if ts >= 1686068903: return int(105235063 + (ts - 1686068903)//2)
    return int(np.interp(ts, KT, KB))
M = {m['market']: m for m in json.load(open('markets_all.json'))}
tr, iv = pickle.load(open('tape_raw.pkl', 'rb'))
last = {}
for t in tr: last[t['market']] = t
miss = [m for m in {t['market'] for t in tr if t['ts'] >= 1680307200} if m not in M or 'maturity' not in M[m]]
out = []
for i, mk in enumerate(miss):
    b = last[mk]['block']; o = dict(market=mk, destroyed=True)
    t = call(mk, '0x9e3b34bf', b); d = call(mk, '0x41bc7b1f', b)
    if t and len(t) >= 130: w = words(t); o['maturity'] = int(w[0], 16); o['expiry'] = int(w[1], 16)
    if d and len(d) >= 194: w = words(d); o['key'] = bytes.fromhex(w[0]).rstrip(b'\0').decode(errors='replace'); o['strike'] = int(w[1], 16)/1e18
    if 'maturity' in o:
        for dd in (3, 10, 30, 80):
            bb = block_at(o['maturity'] + dd*86400)
            rs = call(mk, '0x3f6fa655', bb)
            if rs and rs != '0x' and int(rs, 16) == 1:
                r = call(mk, '0x65372147', bb); d2 = call(mk, '0x41bc7b1f', bb)
                o['result'] = int(r, 16); o['final'] = int(words(d2)[2], 16)/1e18; o['resolved_probe_days'] = dd; break
    out.append(o)
    if i % 20 == 0: print(i, len(miss), o, flush=True)
json.dump(out, open('markets_destroyed.json', 'w')); print('done', len(out), sum('result' in o for o in out))
