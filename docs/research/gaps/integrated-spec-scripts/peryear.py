import pickle, json, sys, numpy as np, bt2, stage
cfgs = json.load(open('cfgF.json'))
for i in (0, 1, 13, 14, 2):
    c = cfgs[i]; r = pickle.load(open(f'out/stageF/{stage.key(c)}.pkl', 'rb'))
    print('==', {k: c[k] for k in ('chain', 'kernel', 'sig', 'lam_block')})
    for D in (2.0, 5.0):
        for Y in range(2021, 2027):
            per = (f'{Y}-01-01', f'{Y+1}-01-01' if Y < 2026 else '2026-09-25')
            a = bt2.attribution(r, D, per); msk = bt2._mask(r, per)
            dm = (r['noise'][D][msk] - r['noise0'][D][msk]).mean()
            print(f'  D={D:g} {Y}: ' + ' '.join(f'{k} {v:+.3f}' for k, v in a.items()) + f' | manip(noise run) {dm:+.4f}')
