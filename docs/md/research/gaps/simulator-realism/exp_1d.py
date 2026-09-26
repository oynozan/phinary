"""(c)+(d): 1-day v1 configuration against the extended adversary set {lat, tail, iv, dir} + {jump, smile}; D* re-evaluation and defences."""
import os, sys; HERE_ = os.path.dirname(os.path.abspath(__file__))
import btx, numpy as np, pickle, lib
IS = ('2021-01-01', '2024-01-01'); OOS = ('2024-01-01', '2026-09-25')
OLD = ('lat', 'tail', 'iv', 'dir'); NEW = OLD + ('jump', 'smile')
SEL = dict(kernel='t', sig='ewma1440', season=0, s=0.02, lam=0.1, cut=144, pmin=0.02)
LAT = -0.029          # documented L1 sub-minute latency charge per market at s = 2% (economic-acceptance report sec 6.5); held fixed (conservative)
SKEW = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
VAR = {
  'v1 (selected)': {},
  's=3%': dict(s=0.03),
  's=4%': dict(s=0.04),
  'lam=0.2': dict(lam=0.2),
  'event-aware sigma (ev_on)': dict(ev_on=1.0),
  'halt +-30 min': dict(halt_pre=30, halt_post=30),
  'halt -60/+90 min': dict(halt_pre=60, halt_post=90),
  'ev_on + halt +-30': dict(ev_on=1.0, halt_pre=30, halt_post=30),
  'static skew add-on': dict(skew=SKEW),
  'ev_on + skew + s=3%': dict(ev_on=1.0, skew=SKEW, s=0.03),
  'cutoff 25%': dict(cut=360),
  'pmin=0.05': dict(pmin=0.05),
  'pmin=0.10': dict(pmin=0.10),
  'kappa=0.05': dict(kappa=0.05),
  'kappa=0.10': dict(kappa=0.10),
  'kappa=0.10 + pmin=0.05': dict(kappa=0.10, pmin=0.05),
  'kappa=0.10 + pmin=0.05 + ev_on + s=3%': dict(kappa=0.10, pmin=0.05, ev_on=1.0, s=0.03),
  'kappa=0.10 + s=3%': dict(kappa=0.10, s=0.03),
  'kappa=0.10 + s=3% + pmin=0.05': dict(kappa=0.10, s=0.03, pmin=0.05),
  'kappa=0.15': dict(kappa=0.15),
  'kappa=0.10 + s=3% + ev_on': dict(kappa=0.10, s=0.03, ev_on=1.0),
  'kappa=0.10 + pmin=0.05 + ev_on + halt30 + skew': dict(kappa=0.10, pmin=0.05, ev_on=1.0, halt_pre=30, halt_post=30, skew=SKEW),
}
only = sys.argv[1].split(',') if len(sys.argv) > 1 and sys.argv[1] != 'all' else list(VAR)
res = {}
for name in only:
    cfg = dict(SEL); cfg.update(VAR[name])
    r = btx.run(1440, cfg=cfg, agents=('lat', 'tail', 'iv', 'orv', 'dir', 'jump', 'smile'))
    res[name] = {k: r[k] for k in ('t0', 'pnl', 'vol', 'has_smile')}
    line = f"== {name}: {VAR[name]}\n"
    for pn, per in (('IS', IS), ('OOS', OOS)):
        a = btx.attribution(r, per)
        m = btx.mask(r, per); sm = m & r['has_smile']
        a2 = btx.attribution(r, msk=sm) if sm.sum() else None
        Dold, uo = btx.breakeven(r, per, OLD, LAT); Dnew, un = btx.breakeven(r, per, NEW, LAT)
        Dsm, us = (btx.breakeven(r, None, NEW, LAT, msk=sm) if sm.sum() > 700 else (np.nan, []))
        line += (f"  {pn}: per-mkt LP pnl " + ' '.join(f"{k} {a[k][0]:+.4f}/{a[k][1]:.2f}" for k in btx.AGX if k != 'jsm') +
                 f"\n      D* old set {Dold:.2f} (counted {uo}) | D* extended {Dnew:.2f} (counted {un})" +
                 (f" | smile-covered mkts n={sm.sum()}: smile {a2['smile'][0]:+.4f}/{a2['smile'][1]:.2f}, D* ext {Dsm:.2f}" if a2 else '') + '\n')
        if pn == 'OOS':
            for D in (2.0, 5.0):
                w, used = btx.lp_weekly(r, D, per, NEW, LAT)
                st = __import__('bt').stats(w)
                line += f"      D={D}: vault ann {100*st['ann']:+.1f}% CI95lo {100*st['lo95']:+.1f}% | CVaR95 {100*st['cvar95']:.2f}% CVaR99 {100*st['cvar99']:.2f}% maxDD {100*st['maxdd']:.1f}% worst wk {100*st['worst']:.2f}%\n"
                yrs = []
                for Y in range(2021, 2027):
                    wy, _ = btx.lp_weekly(r, D, (f'{Y}-01-01', f'{Y+1}-01-01' if Y < 2026 else '2026-09-25'), NEW, LAT)
                    yrs.append(f"{Y}:{100*52*wy.mean():+.0f}%")
                line += f"      D={D} per-year (ext set, latency charged): " + ' '.join(yrs) + '\n'
    print(line, flush=True)
pickle.dump(res, open(os.path.join(HERE_, f"exp1d_{sys.argv[3] if len(sys.argv)>3 else 'x'}.pkl"), 'wb'))
