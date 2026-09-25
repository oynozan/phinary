"""Kernel-sufficiency re-run (gap: BS normal vs Student-t). 1-minute replay of the IS-selected 1 d configuration
(s=2%, lamB=0.1, cutoff 10% = 144 min, p_min=0.02, EWMA 1 d sigma, no seasonality) with the hook kernel swapped:
normal N(d2), variance-matched t with nu in {4, 5, 6} (5 = the report's selection; 4 and 6 have algebraic CDFs).
All adversaries identical across variants (iv agent keeps nu=5); common random numbers (seed 7) -> paired comparison."""
import numpy as np, pickle, sys, time, bt, engine2 as E2, engine as E
A = bt.A
tenor = int(sys.argv[1]) if len(sys.argv) > 1 else 1440
CUT = {60: 0, 240: 24, 1440: 144}   # IS-selected cutoffs (expF)
BASE = dict(sig='ewma1440', season=0, s=0.02, lam=0.1, cut=CUT[tenor], pmin=0.02, vm=1.0)
if tenor < 1440: BASE.update(sig='ewma240', season=1)       # sub-day: report's stage-A policy
VARS = {'normal': ('normal', None), 't4': ('t', 4.0), 't5': ('t', 5.0), 't6': ('t', 6.0)}
if tenor < 1440: VARS = {'normal': ('normal', None), 't_fit': ('t', bt.NU[tenor]), 't4': ('t', 4.0)}
def one(c, t0, lnK, flags, nuH):
    cc = dict(c); cc.update(flags)
    yidx = E.year_index(t0).astype(np.int64)
    ttab = E.t_table(bt.NU[tenor])                       # adversary (iv) table: report's nu
    nuH = nuH or bt.NU[tenor]
    ttabH = E.t_table(nuH); nuscH = np.sqrt((nuH-2)/nuH)
    sigH = bt.sig_policy(cc); sigA = A[cc['sig']]; Qt = A['Q_'+cc['sig']]
    out = np.zeros((len(t0), 12)); P = bt.pvec(cc, tenor)
    E2.run_hook(t0, tenor, lnK, A['cex'], A['pool'], sigH, sigA, ttab, Qt, yidx, A['SC'], P, cc['seed'], out, A['dvol'], A['cum'], ttabH, nuscH)
    return out
res = {}
for name, (kern, nuH) in VARS.items():
    t_ = time.time()
    c = dict(bt.DEF); c.update(BASE); c['kernel'] = kern
    t0, lnK, le = bt.markets(tenor, '2021-01-01', None)
    pnl = np.zeros((len(t0), 6)); vol = np.zeros((len(t0), 6))
    off = dict(lat=0, tail=0, iv=0, orv=0, dir=0)
    base = one(c, t0, lnK, off, nuH); pnl[:, 5] = base[:, 5]; vol[:, 5] = base[:, 11]
    for i, a in enumerate(bt.AG[:5]):
        f = dict(off); f[a] = 1
        o = one(c, t0, lnK, f, nuH); pnl[:, i] = o[:, i]; vol[:, i] = o[:, 6+i]
    res[name] = dict(t0=t0, tenor=tenor, le=le, pnl=pnl, vol=vol, cfg=c, mech='hook', nuH=nuH)
    print(name, 'markets', len(t0), f'{time.time()-t_:.0f}s', flush=True)
pickle.dump(res, open(f'kc/run_{tenor}.pkl', 'wb'))
