import json, urllib.request, time
L = json.load(open('logs_all.json'))
blocks = sorted({l['blockNumber'] for l in L if not l.get('blockTimestamp')})
out = {}
for i in range(0, len(blocks), 10):
    b = blocks[i:i+10]
    body = json.dumps([{"jsonrpc": "2.0", "id": j, "method": "eth_getBlockByNumber", "params": [x, False]} for j, x in enumerate(b)]).encode()
    for k in range(30):
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request('https://mainnet.optimism.io', data=body, headers={'content-type': 'application/json'}), timeout=60))
            if isinstance(r, list) and all('result' in x for x in r):
                for x in r: out[b[x['id']]] = x['result']['timestamp']
                break
        except Exception as e: pass
        time.sleep(2 + 3*k)
    time.sleep(0.2)
    if i % 500 == 0: print(i, len(blocks), flush=True)
for l in L:
    if not l.get('blockTimestamp'): l['blockTimestamp'] = out[l['blockNumber']]
json.dump(L, open('logs_all.json', 'w')); print('filled', len(out))
