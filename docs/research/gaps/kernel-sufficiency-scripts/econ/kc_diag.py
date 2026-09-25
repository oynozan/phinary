import pickle, numpy as np, bt, lib
R = pickle.load(open('kc/run_1440.pkl','rb'))
print('per-year per-agent LP P&L per market (B) [conservative rule includes an agent iff negative]')
for Y in range(2021, 2027):
    per = (f'{Y}-01-01', f'{Y+1}-01-01' if Y < 2026 else '2026-09-25')
    row = []
    for k in R:
        a = bt.attribution(R[k], per)
        row.append(f"{k}: tail {a['tail'][0]:+.4f} iv {a['iv'][0]:+.4f} dir {a['dir'][0]:+.4f}")
    print(Y, ' | '.join(row))
# t4 worst week
from expA import OOS
for k in ('t4', 'normal', 't5'):
    p = bt.parts(R[k], OOS); w = bt.lp_weekly(R[k], 2.0, OOS, True)
    i = np.argmin(w); t = R[k]['t0'] + 1440; msk = (t >= lib.minute_of(OOS[0])) & (t < lib.minute_of(OOS[1]))
    wk = (t[msk] - bt.MON0)//10080; uw = np.unique(wk)
    import datetime
    d = datetime.datetime.fromtimestamp((lib.T0 + (bt.MON0 + uw[i]*10080)*60000)/1000, datetime.timezone.utc)
    print(k, 'worst OOS week', d.date(), {a: round(float(p[a][i]*100), 2) for a in bt.AG}, 'total(D=2) %', round(float(w[i]*100), 2))
# tail agent over OOS by week for t4: count weeks with big loss
p = bt.parts(R['t4'], OOS)['tail']; print('t4 tail weekly worst 5 (% NAV):', np.round(np.sort(p)[:5]*100, 2), 'sum', round(p.sum()*100, 1))
p = bt.parts(R['normal'], OOS)['tail']; print('normal tail weekly worst 5:', np.round(np.sort(p)[:5]*100, 2), 'sum', round(p.sum()*100, 1))
