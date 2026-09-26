"""Selective jump-informed agent: trades only markets whose life contains a CPI/FOMC release (column 'jsm' reused as jump_ev).
D* with the extended set {lat, tail, iv, dir, jump, smile, jump_ev}, IS and OOS."""
import pickle, numpy as np, btx, bt, glob
EV = np.load('../e7/events.npz'); em = EV['m']; ec = EV['c']
IS = ('2021-01-01', '2024-01-01'); OOS = ('2024-01-01', '2026-09-25'); LAT = -0.029
res = {}
for f in sorted(glob.glob('../e7/exp1d_[ABCD].pkl')): res.update(pickle.load(open(f, 'rb')))
EXT = ('lat', 'tail', 'iv', 'dir', 'jump', 'smile'); EXT2 = EXT + ('jsm',)
for name, r in res.items():
    r = dict(r); r['tenor'] = 1440; r['pnl'] = r['pnl'].copy()
    has = np.array([np.any((em > t) & (em <= t + 1440) & (ec <= 1)) for t in r['t0']])
    r['pnl'][:, 7] = r['pnl'][:, 5]*has; r['pnl'][:, 7] = np.minimum(r['pnl'][:, 7], r['pnl'][:, 7])
    o = []
    for pn, per in (('IS', IS), ('OOS', OOS)):
        a = btx.attribution(r, per)
        d1 = btx.breakeven(r, per, EXT, LAT)[0]; d2, used = btx.breakeven(r, per, EXT2, LAT)
        w, _ = btx.lp_weekly(r, 2.0, per, EXT2, LAT); st = bt.stats(w)
        o.append(f"{pn}: jump_ev/mkt {a['jsm'][0]:+.4f} D* ext {d1:.2f} -> +jump_ev {d2:.2f} | D=2 lo95 {100*st['lo95']:+.1f}% CVaR95 {100*st['cvar95']:.2f}% CVaR99 {100*st['cvar99']:.2f}% maxDD {100*st['maxdd']:.1f}%")
    print(f"{name:<46} " + ' || '.join(o), flush=True)
