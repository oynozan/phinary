import pickle, bt, sys
from expA import OOS, IS
for T in (60, 240, 1440):
    R = pickle.load(open(f'kc/run_{T}.pkl','rb'))
    for k, r in R.items():
        for pn, per in (('IS', IS), ('OOS', OOS)):
            a = bt.attribution(r, per)
            print(T, f'{k:>6}', pn, ' '.join(f"{x} {a[x][0]:+.4f}/{a[x][1]:.1f}" for x in bt.AG))
