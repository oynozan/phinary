import pickle, json, numpy as np, bt2, stage, analyze
L = analyze.latmap('latF'); cf = json.load(open('cfgF.json'))
# gross M2 transfer per series (USD) for a budget-bounded one-sided attacker position Q = 2*B at the strike nearest G (m2charge.py, sigma 0.55)
M2 = {('L1', 240, 20000.0): 0.0478 * 40e3, ('L2', 240, 20000.0): 0.0359 * 40e3, ('L1', 240, 5000.0): 0.0287 * 10e3, ('L2', 240, 5000.0): 0.0275 * 10e3,
      ('L1', 240, 50000.0): 0.0729 * 100e3, ('L2', 240, 50000.0): 0.0490 * 100e3}
for i in (0, 1, 4, 5, 13, 14, 17, 18):
    c = dict(bt2.DEF); c.update(cf[i]); r = pickle.load(open(f'out/stageF/{stage.key(cf[i])}.pkl', 'rb'))
    lf = analyze.lat_fn(L, r['cfg']) or (lambda D: 0.0)
    m2 = M2[(c['chain'], c['w'], c['B_usd'])] / c['B_usd']
    f = lambda D, lf=lf, m2=m2: lf(D) - m2
    o = []
    for pn, per in (('IS', bt2.IS), ('OOS', bt2.OOS)):
        o.append(f"{pn} D* {bt2.dstar(r, per, lat_by_D=f)[0]:.2f} strict {bt2.dstar_strict(r, per, lat_by_D=f)[0]:.2f}")
    x = bt2.lp_series_strict(r, 2.0, bt2.OOS, lat_charge=f(2.0)); st = bt2.stats(bt2.weekly(r, x, bt2.OOS))
    print(c['chain'], c['kernel'], f"B ${c['B_usd']:,.0f}", f'M2 charge {m2:.3f} B/series', ' | '.join(o),
          f"| strict D=2 OOS: edge ${x.mean()*c['B_usd']:+,.0f} LB95 {100*st['lo95']:+.0f}%/yr CVaR95 {100*st['cvar95']:.2f}% CVaR99 {100*st['cvar99']:.2f}% maxDD {100*st['maxdd']:.1f}%")
