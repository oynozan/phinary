"""Simulator's Thales-style 7d book (expC THALES config) with the extended agent set, restricted to Thales' LP era."""
import btx, numpy as np
THALES = dict(kernel='driftless', sig='dvol', s=0.03, kappa=0.15, lam=0.001, cut=1440, pmin=0.08, fee_out=0.02, cdelta=0.0, list_every=1440)
r = btx.run(10080, cfg=THALES, agents=('lat', 'tail', 'iv', 'orv', 'dir', 'jump'))
for name, per in (('Thales LP era 2023-05-09..2025-02-04', ('2023-05-09', '2025-02-04')), ('OOS 2024-01..2026-09', ('2024-01-01', '2026-09-25')), ('FULL', ('2021-01-01', '2026-09-25'))):
    a = btx.attribution(r, per)
    print(name, ' '.join(f"{k} {a[k][0]:+.4f}(vol {a[k][1]:.2f})" for k in btx.AGX if k not in ('smile', 'jsm')))
import pickle; pickle.dump({k: r[k] for k in ('t0', 'pnl', 'vol')}, open('thales7d_sim.pkl', 'wb'))
