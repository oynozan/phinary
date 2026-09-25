"""Summaries for stage outputs. usage: python analyze.py <stage dir> [lat stage dir]"""
import sys, glob, pickle, numpy as np, json
import bt2

def latmap(d):
    M = {}
    if not d: return M
    for f in glob.glob(f'out/{d}/*.pkl'):
        r = pickle.load(open(f, 'rb')); c = r['cfg']
        M[(c['chain'], c['w'], c['cut'], c['h0'], c['lam_block'], c.get('B_usd', 20000.0), c.get('ramp_h', 0.0), c.get('kernel', 'normal'))] = r['lat']
    return M

def lat_fn(L, c):
    k = (c['chain'], c['w'], c['cut'], c['h0'], c['lam_block'], c.get('B_usd', 20000.0), c.get('ramp_h', 0.0), c.get('kernel', 'normal'))
    if k not in L: return None
    d = L[k]; Ds = sorted(d)
    return lambda D: min(0.0, d[min(Ds, key=lambda x: abs(x - D))]['total'])   # a donor class is assumed absent

def summarize(r, L=None, show=True):
    c = r['cfg']; lf = lat_fn(L, c) if L is not None else None
    row = dict(cfg={k: c[k] for k in ('chain', 'sig', 'kernel', 'w', 'cut', 'h0', 'lam_block', 'B_usd', 'Bs', 'ramp_h')}, cutmin=bt2.cut_min(c))
    for pn, per in (('IS', bt2.IS), ('OOS', bt2.OOS)):
        Ds, lbs = bt2.dstar(r, per)
        Dss, _ = bt2.dstar(r, per, agents=bt2.REALISTIC + ('orv',))
        row[f'D_{pn}'] = Ds; row[f'Ds_{pn}'] = Dss
        if lf:
            Dl, _ = bt2.dstar(r, per, lat_by_D=lf); row[f'Dlat_{pn}'] = Dl
            Dsl, _ = bt2.dstar(r, per, agents=bt2.REALISTIC + ('orv',), lat_by_D=lf); row[f'Dslat_{pn}'] = Dsl
    msk = bt2._mask(r, bt2.OOS)
    D = 2.0 if 2.0 in r['Ds'] else r['Ds'][0]
    att = bt2.attribution(r, D, bt2.OOS)
    row['att_D2_OOS'] = att
    row['noise_fill'] = {DD: float(r['vol'][(DD, 'noise')][msk].mean()) for DD in r['Ds']}
    row['manip_noise_run'] = {DD: float((r['noise'][DD][msk] - r['contrib0'].get((DD, 'lat'), 0 * r['noise'][DD])[msk] * 0).mean()) for DD in r['Ds']}
    if lf: row['lat'] = {DD: lf(DD) for DD in r['Ds']}
    if show:
        print(json.dumps(row['cfg']), f"cut {row['cutmin']}m | D* IS {row['D_IS']:.2f} OOS {row['D_OOS']:.2f} | stress IS {row['Ds_IS']:.2f} OOS {row['Ds_OOS']:.2f}"
              + (f" | +lat D* IS {row.get('Dlat_IS', np.nan):.2f} OOS {row.get('Dlat_OOS', np.nan):.2f} stress OOS {row.get('Dslat_OOS', np.nan):.2f}" if lf else '')
              + ' | OOS D=2 per-series: ' + ' '.join(f'{k} {v:+.3f}' for k, v in att.items())
              + ' | noise fill ' + ' '.join(f"{DD:g}:{v:.1f}/{7*DD*(1440-row['cutmin'])/1440:.1f}" for DD, v in row['noise_fill'].items()), flush=True)
    return row

if __name__ == '__main__':
    L = latmap(sys.argv[2]) if len(sys.argv) > 2 else None
    rows = []
    for f in sorted(glob.glob(f'out/{sys.argv[1]}/*.pkl')):
        rows.append(summarize(pickle.load(open(f, 'rb')), L))
    pickle.dump(rows, open(f'out/{sys.argv[1]}_summary.pkl', 'wb'))
