"""Drift-informed agent (trailing 365d / 90d / 30d log-drift) on the 1d v1 config and the recommended defence config; 7d Thales-style book."""
import btx, numpy as np, bt
IS = ('2021-01-01', '2024-01-01'); OOS = ('2024-01-01', '2026-09-25'); TH = ('2023-05-09', '2025-02-04')
SEL = dict(kernel='t', sig='ewma1440', season=0, s=0.02, lam=0.1, cut=144, pmin=0.02)
REC = dict(SEL, kappa=0.10, s=0.03, ev_on=1.0)
THALES = dict(kernel='driftless', sig='dvol', s=0.03, kappa=0.15, lam=0.001, cut=1440, pmin=0.08, fee_out=0.02, cdelta=0.0, list_every=1440)
for tenor, name, cfg in ((1440, 'v1', SEL), (1440, 'recommended (kappa .10, s 3%, ev_on)', REC), (10080, 'Thales-style 7d', THALES)):
    for lb in (365.0, 90.0, 30.0):
        r = btx.run(tenor, cfg=dict(cfg, drift_lb=lb), agents=('drift',))
        o = []
        for pn, per in (('IS', IS), ('OOS', OOS), ('Thales era', TH)):
            a = btx.attribution(r, per); o.append(f"{pn} {a['drift'][0]:+.4f} (vol {a['drift'][1]:.2f})")
        print(f"{tenor//1440}d {name:<40} drift lookback {int(lb):>3}d: LP P&L/market " + ' | '.join(o), flush=True)
