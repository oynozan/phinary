"""Deribit option trades (BTC/ETH) in the 1-hour window before each distinct Thales trade hour, keeping only the expiry equal to
the Thales market's maturity (Thales maturities are 08:00 UTC = Deribit expiry time)."""
import json, sys, os, time
from concurrent.futures import ThreadPoolExecutor
import fetch_deribit as FD
def window(args):
    cur, end, exps = args
    start = end - 3600_000; seen = set(); rows = []; s = start
    while True:
        r = FD.get(f"https://history.deribit.com/api/v2/public/get_last_trades_by_currency_and_time?currency={cur}&kind=option&start_timestamp={s}&end_timestamp={end}&count=1000&sorting=asc")
        tr = r['trades']
        for x in tr:
            if x['trade_id'] in seen: continue
            seen.add(x['trade_id']); p = x['instrument_name'].split('-'); e = FD.exp_ms(p[1])
            if e not in exps: continue
            rows.append((x['timestamp'], e, float(p[2]), p[3] == 'C', x['mark_price'], x.get('iv', 0.0), x['index_price']))
        if not r.get('has_more') or not tr: break
        ns = tr[-1]['timestamp']; s = ns if ns > s else s + 1
    return f"{cur}:{end}", rows
if __name__ == '__main__':
    W = json.load(open('deribit/thales_windows.json'))     # list of [cur, end_ms, [expiries]]
    out = 'deribit/thales.json'; done = json.load(open(out)) if os.path.exists(out) else {}
    todo = [(c, e, set(x)) for c, e, x in W if f"{c}:{e}" not in done]
    print('todo', len(todo), flush=True)
    with ThreadPoolExecutor(6) as ex:
        for i, (k, rows) in enumerate(ex.map(window, todo)):
            done[k] = rows
            if i % 200 == 0: print(i, flush=True); json.dump(done, open(out, 'w'))
    json.dump(done, open(out, 'w')); print('done')
