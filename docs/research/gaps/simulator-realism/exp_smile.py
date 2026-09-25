"""Decompose the smile agent's extraction: full smile vs flat Deribit ATM level vs hook-level + Deribit shape vs slope only."""
import os, sys; HERE_ = os.path.dirname(os.path.abspath(__file__))
import btx, numpy as np, bt
OOS = ('2024-01-01', '2026-09-25'); IS = ('2021-01-01', '2024-01-01')
SEL = dict(kernel='t', sig='ewma1440', season=0, s=0.02, lam=0.1, cut=144, pmin=0.02)
for cname, extra in (('v1', {}), ('kappa=0.10+s=3%+pmin=0.05+ev_on', dict(kappa=0.10, s=0.03, pmin=0.05, ev_on=1.0))):
    for mode in ('full', 'level', 'shape', 'skewonly'):
        cfg = dict(SEL); cfg.update(extra)
        r = btx.run(1440, cfg=cfg, agents=('smile',), sm_mode=mode)
        out = []
        for pn, per in (('IS', IS), ('OOS', OOS)):
            m = btx.mask(r, per) & r['has_smile']; x = r['pnl'][m, 6]
            out.append(f"{pn} {x.mean():+.4f} (vol {r['vol'][m, 6].mean():.2f}, share of mkts traded {np.mean(r['vol'][m, 6] > 0):.2f})")
        print(f"{cname:<34} smile[{mode:<8}]: " + ' | '.join(out), flush=True)
