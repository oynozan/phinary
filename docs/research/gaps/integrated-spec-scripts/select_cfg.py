"""Compact stage-B table + IS-only selection. Score = IS D* (with latency charge); ties broken by IS mean LP edge per series at D=5."""
import glob, pickle, numpy as np, json, sys
import bt2, analyze
L = analyze.latmap('latB')
rows = []
for f in glob.glob(f'out/{sys.argv[1] if len(sys.argv) > 1 else "stageB"}/*.pkl'):
    r = pickle.load(open(f, 'rb')); c = r['cfg']; lf = analyze.lat_fn(L, c) or (lambda D: 0.0)
    B = c['B_usd']; row = dict(c=c, cut=bt2.cut_min(c))
    for pn, per in (('IS', bt2.IS), ('OOS', bt2.OOS)):
        row['D_' + pn] = bt2.dstar(r, per, lat_by_D=lf)[0]
        for D in (2.0, 5.0):
            x = bt2.lp_series(r, D, per, lat_charge=lf(D))
            row[f'e{int(D)}_{pn}'] = x.mean() * B
            row[f'lb{int(D)}_{pn}'] = bt2.mbb_lo(bt2.weekly(r, x, per))[0] * 52 * 100
    msk = bt2._mask(r, bt2.OOS)
    row['fill5'] = r['vol'][(5.0, 'noise')][msk].mean() * B
    row['fill8'] = r['vol'][(8.0, 'noise')][msk].mean() * B
    rows.append(row)
rows.sort(key=lambda z: (z['c']['chain'], z['c']['kernel'], z['c']['w'], z['c']['h0'], z['cut'], z['c']['lam_block']))
print('chain kernel w h0 cut lam | D*IS D*OOS (with latency) | edge $/series D=2 IS/OOS | D=5 IS/OOS | LB95 ann%NAV D=5 OOS | noise $ filled/series D=5, D=8 (OOS)')
for z in rows:
    c = z['c']
    print(f"{c['chain']} {c['kernel']:6s} {c['w']:3d} {c['h0']:.3f} {z['cut']:3d} {c['lam_block']:.1f} | {z['D_IS']:5.2f} {z['D_OOS']:5.2f} | {z['e2_IS']:+7.0f} {z['e2_OOS']:+7.0f} | {z['e5_IS']:+7.0f} {z['e5_OOS']:+7.0f} | {z['lb5_OOS']:+7.1f} | {z['fill5']:8,.0f} {z['fill8']:8,.0f}")
pickle.dump(rows, open('out/select_rows.pkl', 'wb'))
for ch in ('L1', 'L2'):
    cand = [z for z in rows if z['c']['chain'] == ch]
    best = min(cand, key=lambda z: (z['D_IS'], -z['e5_IS']))
    print(f'IS-selected {ch}:', json.dumps(best['c']), 'cut', best['cut'], {k: round(v, 2) for k, v in best.items() if k not in ('c', 'cut')})
    for k in ('normal', 't'):
        cand2 = [z for z in cand if z['c']['kernel'] == k]
        b2 = min(cand2, key=lambda z: (z['D_IS'], -z['e5_IS']))
        print(f'   best {k}:', json.dumps(b2['c']), 'cut', b2['cut'], {kk: round(v, 2) for kk, v in b2.items() if kk not in ('c', 'cut')})
