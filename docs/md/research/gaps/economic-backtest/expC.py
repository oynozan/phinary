"""Baselines on identical markets/agents: CPMM (Gnosis FPMM), LMSR, dynamic pm-AMM, Thales-style odds; vs the hook.
Reports, per mechanism and noise turnover eta, mean LP P&L per market (fraction of per-market budget/value B) by agent, OOS 2024-01..2026-09 and full."""
import numpy as np, bt, sys, pickle
tenor = int(sys.argv[1]); mechs = sys.argv[2].split(','); etas = [float(x) for x in sys.argv[3].split(',')]
OOS = ('2024-01-01', '2026-09-25'); FULL = ('2021-01-01', '2026-09-25')
THALES = dict(kernel='driftless', sig='dvol', s=0.03, kappa=0.15, lam=0.001, cut=1440 if tenor > 1440 else 0, pmin=0.08, fee_out=0.02, cdelta=0.0)
res = {}
for mech in mechs:
    for eta in etas:
        if mech == 'hook': r = bt.run(tenor)
        elif mech == 'thales': r = bt.run(tenor, cfg=THALES)
        else: r = bt.run(tenor, mech=mech, s=0.01, eta_amm=eta)
        for pn, per in (('OOS', OOS), ('FULL', FULL)):
            a = bt.attribution(r, per)
            noise = a['noise'][0]*(eta if mech in ('hook', 'thales') else 1.0)
            real = sum(min(a[k][0], 0) for k in bt.REALISTIC)     # conservative: only net extraction counts
            w = bt.lp_weekly(r, eta, per, True)
            st = bt.stats(w)
            print(f"tenor {tenor} {mech:>7} eta {eta:5.1f} {pn:>4}: per-market LP pnl: noise {noise:+.4f} | " + ' '.join(f"{k} {a[k][0]:+.4f}" for k in bt.AG[:5]) +
                  f" | conservative total {noise+real:+.4f} | weekly-return ann {st['ann']:+.3f} CI95lo {st['lo95']:+.3f} maxDD {st['maxdd']:.3f} CVaR95w {st['cvar95']:.3f}", flush=True)
        res[(mech, eta)] = r
        if mech in ('hook', 'thales'): break_ = True
pickle.dump({k: (v['pnl'], v['vol'], v['t0']) for k, v in res.items()}, open(f'out/expC_{tenor}_{"_".join(mechs)}.pkl', 'wb'))
