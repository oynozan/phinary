import pickle, numpy as np, btx, lib
EV = np.load('../e7/events.npz'); em = EV['m']; ec = EV['c']
res = {}
for f in ('exp1d_A.pkl', 'exp1d_B.pkl', 'exp1d_D.pkl'): res.update(pickle.load(open('../e7/'+f, 'rb')))
for name in ('v1 (selected)', 'event-aware sigma (ev_on)', 'kappa=0.10 + s=3% + ev_on'):
    r = res[name]; t0 = r['t0']
    has = np.array([np.any((em > t) & (em <= t + 1440) & (ec <= 1)) for t in t0])
    for pn, per in (('IS', ('2021-01-01', '2024-01-01')), ('OOS', ('2024-01-01', '2026-09-25'))):
        m = btx.mask(dict(r, tenor=1440), per)
        s = []
        for k, i in (('tail', 1), ('jump', 5), ('smile', 6), ('lat', 0), ('noise', 8)):
            a = r['pnl'][m & has, i]; b = r['pnl'][m & ~has, i]
            s.append(f"{k}: ev {a.mean():+.4f} (n={len(a)}) / no-ev {b.mean():+.4f}")
        print(f"{name:<28} {pn}: " + ' | '.join(s))
