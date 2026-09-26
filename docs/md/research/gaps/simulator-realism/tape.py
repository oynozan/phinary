"""Decode the ThalesAMM tape (BoughtFromAmm / SoldToAMM / SetImpliedVolatilityPerAsset) and join market details.
Writes tape.npz-like pickle: trades (ts, block, trader, market, pos, amount, paid, side), iv history, markets."""
import json, pickle, numpy as np, datetime as dt
BUY = '0xf3bfbc0822d1ed667a2b298e71e0304f2c1f4685398189d7c39e412f733150f4'
SELL = '0x1d6ff70c632edb1e6aba7fbc0148db68c8392e30f9dfaadae2543a2543757cf6'
IV = '0x715e0a52c0b74c77d2d2012a363ac95b494302ad2abb78ac7406ec93451f1adb'
FIRST = 1683629766; RL = 604800
def w(d, i): return d[2+64*i:2+64*(i+1)]
def load():
    logs = json.load(open('logs_all.json'))
    tr = []; iv = []
    for l in logs:
        t0 = l['topics'][0]; ts = int(l['blockTimestamp'], 16) if 'blockTimestamp' in l else None
        d = l['data']
        if t0 in (BUY, SELL):
            tr.append(dict(ts=ts, block=int(l['blockNumber'], 16), li=int(l['logIndex'], 16), tx=l['transactionHash'],
                           trader='0x'+w(d, 0)[24:], market='0x'+w(d, 1)[24:], pos=int(w(d, 2), 16),
                           amount=int(w(d, 3), 16)/1e18, paid=int(w(d, 4), 16)/1e18, side=1 if t0 == BUY else -1))
        elif t0 == IV:
            iv.append(dict(ts=ts, asset=bytes.fromhex(w(d, 0)).rstrip(b'\0').decode(errors='replace'), iv=int(w(d, 1), 16)/1e18))
    tr.sort(key=lambda x: (x['block'], x['li'])); iv.sort(key=lambda x: x['ts'])
    return tr, iv
if __name__ == '__main__':
    tr, iv = load()
    print('trades', len(tr), 'buys', sum(t['side'] == 1 for t in tr), 'iv sets', len(iv))
    print('first/last trade', dt.datetime.utcfromtimestamp(tr[0]['ts']), dt.datetime.utcfromtimestamp(tr[-1]['ts']))
    from collections import Counter
    print('iv assets', Counter(x['asset'] for x in iv))
    pickle.dump((tr, iv), open('tape_raw.pkl', 'wb'))
