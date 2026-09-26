"""Final evaluation of IS-selected configs vs the naive design: OOS per-market edge, vault risk (b = 1% NAV per market),
per-year robustness, stress weeks, with the sub-minute latency cost (1-s study, L1 12-s blocks) added as a per-market charge."""
import numpy as np, bt, pickle, sys, lib, datetime, json
from expA import TEN, IS, OOS
tn = sys.argv[1]; tenor = TEN[tn]
LAT = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}      # {"0.01": -0.0253, "0.02": -0.0054} per-market latency charge by s
rows = pickle.load(open(f'out/expB_{tn}.pkl', 'rb'))
rows = [r for r in rows if r[1] == tn and np.isfinite(r[2]['IS']['D']) and np.isfinite(r[2]['IS']['Ds']) and (not LAT or str(r[3]['s']) in LAT)]
lat_is = lambda cfg: LAT.get(str(cfg['s']), 0.0)
def score(r):
    cfg = r[3]; eta_lat = max(0, -lat_is(cfg))/max(r[2]['IS']['att']['noise'][0], 1e-9)
    return r[2]['IS']['D'] + eta_lat*1440/tenor + 0.1*r[2]['IS']['Ds']     # realistic + latency, tie-break by stress
best = min(rows, key=score)
naive = dict(kernel='normal', sig='ewma1440', season=0, s=0.01, lam=0.05, cut=0, pmin=0.02)
if tenor == 10080: naive['list_every'] = 10080
sel = {k: best[3][k] for k in ('kernel', 'sig', 'season', 's', 'lam', 'cut', 'pmin', 'vm')}
if tenor == 10080: sel['list_every'] = 10080
print(f'== {tn}: IS-selected config {sel} (score {score(best):.2f})')
MON0 = bt.MON0
STRESS = {'2021-05-19 crash': '2021-05-17', '2022-06-13 3AC/Celsius': '2022-06-13', '2022-11-08 FTX': '2022-11-07', '2024-08-05 yen-carry': '2024-08-05', '2025-04-07 tariffs': '2025-04-07'}
for name, cfg in (('naive', naive), ('selected', sel)):
    r = bt.run(tenor, cfg=cfg, agents=('lat', 'tail', 'iv', 'orv', 'dir'))
    latc = LAT.get(str(cfg['s']), 0.0)
    a = bt.attribution(r, OOS)
    print(f"-- {name}: OOS per-market LP P&L (units of budget B): " + ' '.join(f"{k} {a[k][0]:+.4f}" for k in bt.AG) + f" | sub-minute latency charge (L1) {latc:+.4f}")
    for D in (2.0, 5.0, 10.0):
        eta = D*tenor/1440
        for per_name, per in (('IS', IS), ('OOS', OOS)):
            w = bt.lp_weekly(r, eta, per, True)
            p = bt.parts(r, per)
            nm = np.bincount(((r['t0'][(r['t0']+tenor >= lib.minute_of(per[0])) & (r['t0']+tenor < lib.minute_of(per[1]))] + tenor - MON0)//10080))
            nm = nm[nm > 0]
            w = w + latc*nm*bt.BFRAC                 # latency charge per market
            st = bt.stats(w)
            edge = (w.sum()/bt.BFRAC)/nm.sum()
            print(f"   D={D:4.1f}/day (eta {eta:6.2f}/mkt) {per_name:>3}: edge/mkt {edge:+.4f}B | vault ann {100*st['ann']:+7.1f}% CI95lo {100*st['lo95']:+7.1f}% | weekly sd {100*st['sd']:.2f}% VaR95 {100*st['var95']:.2f}% CVaR95 {100*st['cvar95']:.2f}% CVaR99 {100*st['cvar99']:.2f}% | maxDD {100*st['maxdd']:.1f}% worst wk {100*st['worst']:.2f}% P(lose wk) {st['plose']:.2f}")
        if D == 5.0:
            # per-year and stress weeks (full sample)
            yrs = []
            for Y in range(2021, 2027):
                w = bt.lp_weekly(r, eta, (f'{Y}-01-01', f'{Y+1}-01-01' if Y < 2026 else '2026-09-25'), True)
                yrs.append(f"{Y}:{100*52*w.mean():+.0f}%")
            print('   D=5 per-year vault ann (conservative, excl. latency charge): ' + ' '.join(yrs))
            wf = bt.lp_weekly(r, eta, ('2021-01-01', '2026-09-25'), True)
            # week index mapping
            t_exp = r['t0'] + tenor; wk = (t_exp - MON0)//10080; uw = np.unique(wk[(t_exp >= lib.minute_of('2021-01-01')) & (t_exp < lib.minute_of('2026-09-25'))])
            s = []
            for nmn, d in STRESS.items():
                k = (lib.minute_of(d) - MON0)//10080
                if k in uw: s.append(f"{nmn}: {100*wf[np.searchsorted(uw, k)]:+.2f}%")
            print('   D=5 stress weeks (weekly vault return): ' + '; '.join(s))
    # stress bound with the clairvoyant realised-vol agent
    for D in (5.0,):
        eta = D*tenor/1440
        w = bt.lp_weekly(r, eta, OOS, True, agents=bt.REALISTIC + ('orv',)); st = bt.stats(w)
        print(f"   STRESS (+oracle-vol agent) D={D}: vault ann {100*st['ann']:+.1f}% CI95lo {100*st['lo95']:+.1f}% maxDD {100*st['maxdd']:.1f}% CVaR95 {100*st['cvar95']:.2f}%")
