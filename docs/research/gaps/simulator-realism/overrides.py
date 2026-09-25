import pickle, json, urllib.request, time, collections
tr, iv = pickle.load(open('tape_raw.pkl', 'rb'))
v = collections.Counter()
for t in tr:
    if t['ts'] >= 1683000000: v[t['trader']] += t['paid']
top = [a for a, x in v.most_common(200)]
def batch(reqs):
    body = json.dumps([{"jsonrpc": "2.0", "id": i, "method": "eth_call", "params": [{"to": "0x278B5A44397c9D8E52743fEdec263c4760dc1A1A", "data": d}, "latest"]} for i, d in enumerate(reqs)]).encode()
    for k in range(20):
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request('https://optimism-public.nodies.app', data=body, headers={'content-type': 'application/json'}), timeout=60))
            o = [None]*len(reqs)
            for x in r: o[x['id']] = int(x['result'], 16)/1e18
            return o
        except Exception: time.sleep(2 + 2*k)
out = {}
for i in range(0, len(top), 4):
    a = top[i:i+4]; reqs = []
    for x in a: reqs += ['0x65f56772' + x[2:].rjust(64, '0'), '0x2972e8ab' + x[2:].rjust(64, '0')]
    o = batch(reqs)
    for j, x in enumerate(a): out[x] = dict(safebox=o[2*j], min_spread=o[2*j+1], vol=v[x])
json.dump(out, open('overrides.json', 'w'))
tv = sum(v.values())
ov = {a: d for a, d in out.items() if d['safebox'] or d['min_spread']}
print('addresses with overrides', len(ov), 'share of LP-era volume', round(sum(d['vol'] for d in ov.values())/tv, 3))
for a, d in sorted(ov.items(), key=lambda x: -x[1]['vol']): print(a, d)
