import pickle, json, sys, glob, numpy as np, bt2, stage, analyze
L = analyze.latmap(sys.argv[2])
fs = [f'out/{sys.argv[1]}/{stage.key(c)}.pkl' for c in json.load(open(sys.argv[3]))] if len(sys.argv) > 3 else glob.glob(f'out/{sys.argv[1]}/*.pkl')
for f in fs:
    r = pickle.load(open(f, 'rb')); c = r['cfg']; lf = analyze.lat_fn(L, c) or (lambda D: 0.0); B = c['B_usd']
    out = []
    for pn, per in (('IS', bt2.IS), ('OOS', bt2.OOS)):
        Ds, lbs = bt2.dstar_strict(r, per, lat_by_D=lf); out.append(f'{pn} strict D* {Ds:.2f}')
    D5 = 5.0 if 5.0 in r['Ds'] else r['Ds'][-1]
    x = bt2.lp_series_strict(r, D5, bt2.OOS, lat_charge=lf(D5)); st = bt2.stats(bt2.weekly(r, x, bt2.OOS))
    yrs = []
    for Y in range(2021, 2027):
        per = (f'{Y}-01-01', f'{Y+1}-01-01' if Y < 2026 else '2026-09-25')
        xy = bt2.lp_series_strict(r, D5, per, lat_charge=lf(D5)); yrs.append(f'{Y}:{100*52*bt2.weekly(r, xy, per).mean():+.0f}%')
    x2 = bt2.lp_series_strict(r, 2.0, bt2.OOS, lat_charge=lf(2.0)) if 2.0 in r['Ds'] else x
    st2 = bt2.stats(bt2.weekly(r, x2, bt2.OOS))
    print(json.dumps({k: c[k] for k in ('chain', 'sig', 'kernel', 'w', 'cut', 'h0', 'lam_block', 'B_usd', 'ramp_h', 'oi', 'manip', 'qepoch')}), '|', ' | '.join(out),
          f"| D=2 OOS edge ${x2.mean()*B:+,.0f}/series LB95 {100*st2['lo95']:+.0f}%/yr CVaR95 {100*st2['cvar95']:.2f}% CVaR99 {100*st2['cvar99']:.2f}% maxDD {100*st2['maxdd']:.1f}%"
          f"| D=5 OOS edge ${x.mean()*B:+,.0f} LB95 {100*st['lo95']:+.0f}%/yr CVaR95 {100*st['cvar95']:.2f}% CVaR99 {100*st['cvar99']:.2f}% maxDD {100*st['maxdd']:.1f}% | years@D5 " + ' '.join(yrs), flush=True)
