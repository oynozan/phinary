"""Fetch Deribit ETH option trades (history.deribit.com) in 1-hour windows ending at snapshot times, keep trades whose expiry is
within [expiry_min, expiry_max] of the window. Output per window: list of (ts_ms, expiry_ms, strike, is_call, mark_price_eth, iv, index)."""
import json, urllib.request, time, sys, os, datetime as dt
from concurrent.futures import ThreadPoolExecutor
MON = {m: i+1 for i, m in enumerate(['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'])}
def exp_ms(code):   # e.g. 25SEP26 -> 08:00 UTC
    d = int(code[:-5]); m = MON[code[-5:-2]]; y = 2000 + int(code[-2:])
    return int(dt.datetime(y, m, d, 8, tzinfo=dt.timezone.utc).timestamp()*1000)
def get(url):
    for i in range(20):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'research'}), timeout=60))['result']
        except Exception as e:
            print('retry', e, file=sys.stderr); time.sleep(2 + 3*i)
    raise RuntimeError(url)
def window(args):
    end, horizon_ms = args
    start = end - 3600_000; seen = set(); rows = []
    s = start
    while True:
        r = get(f"https://history.deribit.com/api/v2/public/get_last_trades_by_currency_and_time?currency=ETH&kind=option&start_timestamp={s}&end_timestamp={end}&count=1000&sorting=asc")
        tr = r['trades']
        for x in tr:
            if x['trade_id'] in seen: continue
            seen.add(x['trade_id'])
            p = x['instrument_name'].split('-')
            e = exp_ms(p[1])
            if e <= end or e - end > horizon_ms: continue
            rows.append((x['timestamp'], e, float(p[2]), p[3] == 'C', x['mark_price'], x.get('iv', 0.0), x['index_price']))
        if not r.get('has_more') or not tr: break
        ns = tr[-1]['timestamp']
        s = ns if ns > s else s + 1
    return end, rows
if __name__ == '__main__':
    out = sys.argv[1]; ends = [int(x) for x in open(sys.argv[2]).read().split()]; horizon = float(sys.argv[3])*86400_000
    done = {}
    if os.path.exists(out): done = {int(k): v for k, v in json.load(open(out)).items()}
    todo = [(e, horizon) for e in ends if e not in done]
    print('todo', len(todo), file=sys.stderr)
    t0 = time.time()
    with ThreadPoolExecutor(int(sys.argv[4]) if len(sys.argv) > 4 else 4) as ex:
        for i, (e, rows) in enumerate(ex.map(window, todo)):
            done[e] = rows
            if i % 100 == 0:
                print(i, len(todo), round(time.time()-t0), file=sys.stderr, flush=True)
                json.dump(done, open(out, 'w'))
    json.dump(done, open(out, 'w'))
