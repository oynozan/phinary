"""Summary table for the 1d defence sweep: D* under three adversary aggregations, E3/E4 at D=2 and D=5 (IS and OOS), per-year sign,
and a bootstrap CI of the smile agent's mean per-market P&L (day-clustered)."""
import pickle, numpy as np, btx, bt, lib, glob, os
HERE = os.path.dirname(os.path.abspath(__file__))
IS = ('2021-01-01', '2024-01-01'); OOS = ('2024-01-01', '2026-09-25'); LAT = -0.029
SETS = {'old': ('lat', 'tail', 'iv', 'dir'), 'ext-sum': ('lat', 'tail', 'iv', 'dir', 'jump', 'smile'), 'ext-nested': ('lat', 'jump', 'smile', 'dir')}
res = {}
for f in sorted(glob.glob(os.path.join(HERE, 'exp1d_[ABCD].pkl'))): res.update(pickle.load(open(f, 'rb')))
def day_ci(x, days, B=2000, seed=0):
    ud, inv = np.unique(days, return_inverse=True); s = np.bincount(inv, weights=x); c = np.bincount(inv)
    rng = np.random.default_rng(seed); idx = rng.integers(0, len(ud), (B, len(ud)))
    m = s[idx].sum(1)/c[idx].sum(1)
    return x.mean(), np.quantile(m, 0.025), np.quantile(m, 0.975)
print(f"{'config':<48} | {'D* IS old/sum/nest':>22} | {'D* OOS old/sum/nest':>22} | E3 lo95 D=2 IS/OOS | E4 OOS D=2: CVaR95 CVaR99 maxDD | neg yrs D=2 | smile OOS mean [95% CI]")
for name, r in res.items():
    r = dict(r); r['tenor'] = 1440
    Ds = {}
    for pn, per in (('IS', IS), ('OOS', OOS)):
        Ds[pn] = [btx.breakeven(r, per, SETS[k], LAT)[0] for k in SETS]
    e3 = []
    for per in (IS, OOS):
        w, _ = btx.lp_weekly(r, 2.0, per, SETS['ext-sum'], LAT); e3.append(bt.stats(w)['lo95'])
    w, _ = btx.lp_weekly(r, 2.0, OOS, SETS['ext-sum'], LAT); st = bt.stats(w)
    neg = 0
    for Y in range(2021, 2027):
        wy, _ = btx.lp_weekly(r, 2.0, (f'{Y}-01-01', f'{Y+1}-01-01' if Y < 2026 else '2026-09-25'), SETS['ext-sum'], LAT); neg += wy.mean() < 0
    m = btx.mask(r, OOS) & r['has_smile']
    mu, lo, hi = day_ci(r['pnl'][m, 6], r['t0'][m]//1440)
    print(f"{name:<48} | {'/'.join(f'{d:.2f}' for d in Ds['IS']):>22} | {'/'.join(f'{d:.2f}' for d in Ds['OOS']):>22} | {100*e3[0]:+6.1f}% / {100*e3[1]:+6.1f}% | {100*st['cvar95']:5.2f}% {100*st['cvar99']:5.2f}% {100*st['maxdd']:6.1f}% | {neg} | {mu:+.4f} [{lo:+.4f}, {hi:+.4f}]", flush=True)
print()
for name in ('v1 (selected)', 'kappa=0.10 + s=3% + ev_on', 'kappa=0.10 + s=3%', 'kappa=0.10'):
    r = dict(res[name]); r['tenor'] = 1440
    for D in (2.0, 5.0):
        yrs = []
        for Y in range(2021, 2027):
            wy, _ = btx.lp_weekly(r, D, (f'{Y}-01-01', f'{Y+1}-01-01' if Y < 2026 else '2026-09-25'), SETS['ext-sum'], LAT); yrs.append(f"{Y}:{100*52*wy.mean():+.0f}%")
        w, _ = btx.lp_weekly(r, D, OOS, SETS['ext-sum'] + ('orv',), LAT); st = bt.stats(w)
        print(f"{name:<30} D={D}: per-year (ext set, latency charged) {' '.join(yrs)} | STRESS +orv OOS: ann {100*st['ann']:+.0f}% lo95 {100*st['lo95']:+.0f}% maxDD {100*st['maxdd']:.1f}%")
    ds = btx.breakeven(r, OOS, SETS['ext-sum'] + ('orv',), LAT)[0]; print(f"   D*_stress OOS (ext + clairvoyant vol) {ds:.2f}")
