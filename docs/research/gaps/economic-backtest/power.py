import numpy as np, bt
OOS = ('2024-01-01', '2026-09-25')
for tn, tenor, cfg, eta in (('1d', 1440, dict(kernel='t', sig='ewma1440', s=0.02, lam=0.1, cut=144), 5.0), ('4h', 240, dict(kernel='t', sig='ewma240', season=1, s=0.02, lam=0.1, cut=24), 0.83)):
    r = bt.run(tenor, cfg=cfg)
    p = r['pnl']; tot = eta*p[:, 5]                       # conservative: realistic agents have no net extraction here
    for i, k in enumerate(bt.AG[:5]):
        if k in bt.REALISTIC and p[:, i].sum() < 0: tot = tot + p[:, i]
    m, s = tot.mean(), tot.std(); cv = s/abs(m)
    w = bt.lp_weekly(r, eta, OOS, True); se = w.std()/np.sqrt(len(w))
    print(f"{tn}: per-market LP pnl mean {m:+.4f}B sd {s:.4f}B CV {cv:.1f} -> paths for +-10% rel. precision (1.96*CV/0.1)^2 = {(1.96*cv/0.1)**2:,.0f}; "
          f"OOS weeks {len(w)}, weekly sd {100*w.std():.2f}% (b=1%/mkt), SE(mean) {100*se:.3f}%/wk; min detectable weekly mean (alpha 5% 1-sided, power 80%) {100*2.486*se:.3f}%/wk")
