"""Robustness of the kappa defence when noise flow also moves the inventory skew (so informed agents can trade against noise-created skew).
Noise is simulated at its actual intensity eta = D (1d tenor), so no linear scaling is used."""
import btx, numpy as np, bt, sys
IS = ('2021-01-01', '2024-01-01'); OOS = ('2024-01-01', '2026-09-25'); LAT = -0.029
SEL = dict(kernel='t', sig='ewma1440', season=0, s=0.02, lam=0.1, cut=144, pmin=0.02)
EXT = ('lat', 'tail', 'iv', 'dir', 'jump', 'smile')
cfgs = {'v1': SEL, 'kappa .10 s 3% ev_on': dict(SEL, kappa=0.10, s=0.03, ev_on=1.0), 'kappa .10 s 3%': dict(SEL, kappa=0.10, s=0.03), 'kappa .15 s 3% ev_on': dict(SEL, kappa=0.15, s=0.03, ev_on=1.0)}
for name in sys.argv[1].split(','):
    for D in (2.0, 5.0):
        r = btx.run(1440, cfg=dict(cfgs[name], eta_inv=D, noise_trades=20), agents=EXT + ('orv',))
        for pn, per in (('IS', IS), ('OOS', OOS)):
            a = btx.attribution(r, per)
            w, used = btx.lp_weekly(r, 1.0, per, EXT, LAT); st = bt.stats(w)
            w2, _ = btx.lp_weekly(r, 1.0, per, EXT + ('orv',), LAT); st2 = bt.stats(w2)
            print(f"{name:<22} D={D} {pn}: " + ' '.join(f"{k} {a[k][0]:+.4f}" for k in ('lat', 'tail', 'iv', 'dir', 'jump', 'smile', 'orv', 'noise')) +
                  f" | ext: ann {100*st['ann']:+.0f}% lo95 {100*st['lo95']:+.0f}% CVaR95 {100*st['cvar95']:.2f}% CVaR99 {100*st['cvar99']:.2f}% maxDD {100*st['maxdd']:.1f}% (counted {used}) | +orv lo95 {100*st2['lo95']:+.0f}%", flush=True)
