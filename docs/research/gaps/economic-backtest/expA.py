"""Stage A: naive design + kernel/sigma-policy sweep (hook). IS = expiries 2021-01..2023-12, OOS = 2024-01..2026-09.
Agents simulated in isolation; conservative LP = eta*noise + sum over realistic agent classes with net extraction (lat, tail, iv, dir)."""
import numpy as np, bt, itertools, pickle, sys
IS = ('2021-01-01', '2024-01-01'); OOS = ('2024-01-01', '2026-09-25')
TEN = {'1h': 60, '4h': 240, '1d': 1440, '7d': 10080}
rows = []
def summarize(tag, tn, r, extra=''):
    tenor = TEN[tn]; res = {}
    for pn, per in (('IS', IS), ('OOS', OOS)):
        be = bt.breakeven(r, per, True)
        be_s = bt.breakeven(r, per, True, agents=bt.REALISTIC + ('orv',))
        res[pn] = dict(D=be*1440/tenor, Ds=be_s*1440/tenor, att=bt.attribution(r, per))
    a = res['OOS']['att']
    print(f"{tn:>3} {tag:<40} D* IS {res['IS']['D']:7.2f} OOS {res['OOS']['D']:7.2f} | +oracle-vol IS {res['IS']['Ds']:7.2f} OOS {res['OOS']['Ds']:7.2f} | OOS LP pnl/mkt " +
          ' '.join(f"{k} {a[k][0]:+.4f}" for k in bt.AG) + f" | vol tail {a['tail'][1]:.1f} iv {a['iv'][1]:.1f} {extra}", flush=True)
    rows.append((tag, tn, res, r['cfg']))
if __name__ == '__main__':
    for tn in sys.argv[1:] or TEN:
        tenor = TEN[tn]; LE = 10080 if tenor == 10080 else None   # 7d: weekly listing (non-overlapping) for speed
        for lag in (0, 1):
            r = bt.run(tenor, lag=lag, list_every=LE); summarize(f'NAIVE normal ewma1440 x1.0 lag{lag}', tn, r)
        for kern, sig, vm, seas in itertools.product(['normal', 't'], ['ewma240', 'ewma1440', 'ewma4320', 'dvol'], [1.0, 1.1, 1.25], [0, 1]):
            if seas and tenor > 1440: continue
            if tenor > 1440 and (sig == 'ewma240' or vm == 1.25): continue
            if (kern, sig, vm, seas) == ('normal', 'ewma1440', 1.0, 0): continue
            r = bt.run(tenor, kernel=kern, sig=sig, vm=vm, season=seas, list_every=LE)
            summarize(f'{kern}{"+seas" if seas else ""} {sig} x{vm}', tn, r)
        pickle.dump(rows, open(f'out/expA_{tn}.pkl', 'wb'))
