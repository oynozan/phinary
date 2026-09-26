"""expF-equivalent for the frozen spec: OOS/IS D*, E3 (95% MBB LB of weekly LP return), E4 (CVaR/DD/per-year), E5 (stress with the
clairvoyant-vol agent), stress weeks, binding-cap breakdown, $ capacity per series. usage: python final.py <stage> <lat stage> <cfg json>"""
import sys, json, glob, pickle, numpy as np
import bt2, lib, analyze, stage

STRESS = {'2021-05-19 crash': '2021-05-17', '2022-06-13 3AC/Celsius': '2022-06-13', '2022-11-08 FTX': '2022-11-07',
          '2024-08-05 yen-carry': '2024-08-05', '2025-04-07 tariffs': '2025-04-07'}

def report(r, L):
    c = r['cfg']; lf = analyze.lat_fn(L, c) or (lambda D: 0.0)
    B = c['B_usd']
    print(f"== {json.dumps({k: c[k] for k in ('chain','sig','kernel','w','cut','h0','lam_block','B_usd','Bs','ramp_h','oi','manip','qepoch')})} cutoff {bt2.cut_min(c)} min before T")
    for pn, per in (('IS', bt2.IS), ('OOS', bt2.OOS)):
        D0, lb0 = bt2.dstar(r, per)
        Dl, lbl = bt2.dstar(r, per, lat_by_D=lf)
        Ds, _ = bt2.dstar(r, per, agents=bt2.REALISTIC + ('orv',), lat_by_D=lf)
        print(f"  {pn}: D* (no latency) {D0:.2f} | D* (+latency charge) {Dl:.2f} | D*_stress (+orv, +latency) {Ds:.2f} | 95%LB weekly by D {dict(zip(r['Ds'], np.round(lbl*100, 3)))} (% NAV)")
    msk = bt2._mask(r, bt2.OOS)
    for D in r['Ds']:
        lc = lf(D)
        att = bt2.attribution(r, D, bt2.OOS)
        manip = float((r['noise'][D][msk]).mean())
        x = bt2.lp_series(r, D, bt2.OOS, lat_charge=lc)
        w = bt2.weekly(r, x, bt2.OOS); st = bt2.stats(w)
        fill = r['vol'][(D, 'noise')][msk].mean()
        print(f"  D={D:g}: OOS edge/series {x.mean():+.4f} B (${x.mean()*B:+,.0f}) | latency {lc:+.4f} | attribution " + ' '.join(f'{k} {v:+.3f}' for k, v in att.items())
              + f" | noise filled {fill:.2f} B/series (${fill*B:,.0f}) | vault ann {100*st['ann']:+.1f}% LB95 {100*st['lo95']:+.1f}% CVaR95 {100*st['cvar95']:.2f}% CVaR99 {100*st['cvar99']:.2f}% maxDD {100*st['maxdd']:.1f}% worst wk {100*st['worst']:.2f}% P(lose wk) {st['plose']:.2f}")
        if D in (2.0, 5.0):
            yrs = []
            for Y in range(2021, 2027):
                per = (f'{Y}-01-01', f'{Y+1}-01-01' if Y < 2026 else '2026-09-25')
                wy = bt2.weekly(r, bt2.lp_series(r, D, per, lat_charge=lc), per); yrs.append(f'{Y}:{100*52*wy.mean():+.0f}%')
            print('     per-year vault ann: ' + ' '.join(yrs))
            full = ('2021-01-01', '2026-09-25')
            xf = bt2.lp_series(r, D, full, lat_charge=lc); mskf = bt2._mask(r, full)
            texp = r['t0'][mskf] + 1440; wk = (texp - bt2.MON0) // 10080
            s = []
            for nm, d in STRESS.items():
                k = (lib.minute_of(d) - bt2.MON0) // 10080
                if (wk == k).any(): s.append(f'{nm}: {100*bt2.BFRAC*xf[wk == k].sum():+.2f}%')
            print('     stress weeks: ' + '; '.join(s))
            xs = bt2.lp_series(r, D, bt2.OOS, agents=bt2.REALISTIC + ('orv',), lat_charge=lc)
            sts = bt2.stats(bt2.weekly(r, xs, bt2.OOS))
            print(f"     E5 stress (+orv): vault ann {100*sts['ann']:+.1f}% LB95 {100*sts['lo95']:+.1f}% maxDD {100*sts['maxdd']:.1f}%")
            # binding caps in the noise-only run (share of steps x markets with a truncation) and manipulation
            stn = r['stats'][(D, 'noise')][msk].sum(0)
            dm = r['noise'][D][msk] - r['noise0'][D][msk]
            print(f"     manipulation charge in noise-only run: mean {dm.mean():+.4f} B/series (${dm.mean()*B:+,.0f}); attacked series {100*(dm < -1e-12).mean():.1f}%; worst {dm.min():+.3f} B"
                  f" | Q_safe mean ${r['qsafe'][D][msk].mean()*B:,.0f} (min ${r['qsafe'][D][msk].min()*B:,.0f}) | end gross OI (noise run) mean ${r['gross'][D][msk].mean()*B:,.0f}")
            sn = r['stats'][(D, 'noise')][msk].sum(0)
            for a in ('tail', 'iv', 'orv'):
                sa = r['stats'][(D, a)][msk].sum(0)
                print(f"     binds with {a}: band {sa[0]:.0f} qepoch {sa[1]:.0f} budget {sa[2]:.0f} ladder {sa[3]:.0f} OI {sa[4]:.0f}")

if __name__ == '__main__':
    L = analyze.latmap(sys.argv[2])
    for c in json.loads(open(sys.argv[3]).read()):
        f = f'out/{sys.argv[1]}/{stage.key(c)}.pkl'
        report(pickle.load(open(f, 'rb')), L)
