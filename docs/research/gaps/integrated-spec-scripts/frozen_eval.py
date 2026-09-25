import pickle, json, numpy as np, bt2, stage, analyze
L = analyze.latmap('latF'); cf = json.load(open('cfgF.json'))
M2 = {'L1': 0.0478 * 40e3, 'L2': 0.0359 * 40e3}
for i in (1, 14, 0, 13):
    c = dict(bt2.DEF); c.update(cf[i]); r = pickle.load(open(f'out/stageF/{stage.key(cf[i])}.pkl', 'rb'))
    lf = analyze.lat_fn(L, r['cfg']) or (lambda D: 0.0); m2 = M2[c['chain']] / c['B_usd']
    f = lambda D, lf=lf, m2=m2: lf(D) - m2
    print('==', c['chain'], c['kernel'], 'lam', c['lam_block'], f'M2 {m2:.3f} B/series')
    for D in (1.0, 2.0, 5.0):
        x = bt2.lp_series_strict(r, D, bt2.OOS, lat_charge=f(D)); st = bt2.stats(bt2.weekly(r, x, bt2.OOS))
        yrs = []
        for Y in range(2021, 2027):
            per = (f'{Y}-01-01', f'{Y+1}-01-01' if Y < 2026 else '2026-09-25')
            xy = bt2.lp_series_strict(r, D, per, lat_charge=f(D)); yrs.append(f'{Y}:{100*52*bt2.weekly(r, xy, per).mean():+.0f}%')
        xs = bt2.lp_series_strict(r, D, bt2.OOS, agents=bt2.REALISTIC + ('orv',), lat_charge=f(D)); sts = bt2.stats(bt2.weekly(r, xs, bt2.OOS))
        print(f"  D={D:g} strict+M2 OOS: edge {x.mean():+.3f} B (${x.mean()*c['B_usd']:+,.0f})/series | ann {100*st['ann']:+.0f}% LB95 {100*st['lo95']:+.0f}% | wk sd {100*st['sd']:.2f}% CVaR95 {100*st['cvar95']:.2f}% CVaR99 {100*st['cvar99']:.2f}% maxDD {100*st['maxdd']:.1f}% worst {100*st['worst']:.2f}% P(lose) {st['plose']:.2f} | years " + ' '.join(yrs) + f" | E5 (+orv) ann {100*sts['ann']:+.0f}% LB95 {100*sts['lo95']:+.0f}%")
    print('  E5 D*_stress strict+M2: IS %.2f OOS %.2f' % (bt2.dstar_strict(r, bt2.IS, agents=bt2.REALISTIC + ('orv',), lat_by_D=f)[0], bt2.dstar_strict(r, bt2.OOS, agents=bt2.REALISTIC + ('orv',), lat_by_D=f)[0]))
