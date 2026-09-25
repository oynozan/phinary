"""Settlement-manipulation cost curves C(delta) (USD) for shifting the w-window pool TWAP by delta, band-follower model of the
settlement report (common.simulate_floor_attack), for the frozen sources: L1 = mainnet v3 5 bp (12 s, y_v $155.5M),
L2 = Base v3 5 bp (2 s, y_v $67M). sigma = 0.52 as in the settlement report. Also M1 Q_safe and M2 (clairvoyant, % of Q)
for the frozen windows/cutoffs, recomputed with the settlement report's own functions, at h0 = 1c and 2c."""
import sys, numpy as np, pickle
sys.path.insert(0, '/Users/oynozan/Desktop/Dev/Web3/UniswapPrediction/docs/research/gaps/settlement-scripts')
from common import simulate_floor_attack, YEAR
from math import sqrt
from importlib import import_module
ae = import_module('05_attack_econ')
import spec
SIG = 0.52

def curve(dt, f, yv, n_w, npaths, seed=3):
    s_list = list(np.linspace(0, 2 * f, 9)[1:]) + list(2 * f + np.linspace(0, 14 * 5e-4, 29)[1:])
    r = simulate_floor_attack(SIG, dt, f, n_w, s_list, npaths=npaths, seed=seed)
    d = np.array([0.0] + [r[s][0] for s in s_list]); c = np.array([0.0] + [r[s][1] * yv for s in s_list])
    o = np.argsort(d); d, c = d[o], np.maximum.accumulate(c[o])
    return d, c

if __name__ == '__main__':
    out = {}
    grid = np.linspace(0, 0.006, 601)
    for ch in ('L1', 'L2'):
        c = spec.CHAIN[ch]
        for wm in (30, 120, 240):
            n_w = int(wm * 60 / c['dt_s'])
            npaths = {30: 3000, 120: 1500, 240: 1000}[wm] if ch == 'L1' else {30: 1500, 120: 600, 240: 400}[wm]
            d, cc = curve(c['dt_s'], c['f'], c['yv'], n_w, npaths)
            Cg = np.interp(grid, d, cc, right=np.inf)
            out[(ch, wm)] = (grid, Cg)
            C = lambda x, d=d, cc=cc: np.interp(np.abs(x), d, cc, right=np.inf)
            print(f'{ch} w={wm:3d}m C(2.5bp) ${float(C(2.5e-4)):,.0f} C(5bp) ${float(C(5e-4)):,.0f} C(10bp) ${float(C(1e-3)):,.0f} C(30bp) ${float(C(3e-3)):,.0f}', flush=True)
            for h0 in (0.01, 0.02):
                for cutname, cut_s in (('w+b', spec.cut_window(wm * 60)), ('cut05', spec.cut_05(h0, wm * 60, c['dt_s']))):
                    tau = cut_s / YEAR; w = wm * 60 / YEAR; sd = SIG * sqrt(tau - 2 * w / 3)
                    qs = ae.q_safe(C, 0, sd, h0)
                    qs_cf = spec.q_safe_binary(ch, wm * 60, SIG, cut_s, h0)
                    m2 = [100 * ae.m2_loss(Q, C, 0, sd) / Q for Q in (1e4, 3e4, 1e5, 3e5, 1e6)]
                    out[(ch, wm, h0, cutname)] = dict(sd=sd, qsafe_num=qs, qsafe_cf=qs_cf, m2=m2)
                    print(f'   h0={h0*100:.0f}c cut={cutname} ({cut_s/60:.0f} min) sd_G {sd*1e4:5.1f}bp  Q_safe numeric ${qs:,.0f}  closed form (kin spec) ${qs_cf:,.0f} | '
                          f'M2 %Q at Q=10k/30k/100k/300k/1M: ' + ' '.join(f'{x:.2f}' for x in m2), flush=True)
    pickle.dump(out, open('out/costcurves.pkl', 'wb'))
