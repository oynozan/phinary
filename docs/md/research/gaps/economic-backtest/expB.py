"""Stage B: spread s, impact lambda (per unit budget), cutoff, price band on the stage-A-selected kernel/sigma policy."""
import numpy as np, bt, itertools, pickle, sys
from expA import summarize, TEN, IS, OOS, rows
BASE = {'1h': dict(kernel='t', season=1, sig='ewma240'), '4h': dict(kernel='t', season=1, sig='ewma240'),
        '1d': dict(kernel='t', season=0, sig='ewma1440'), '7d': dict(kernel='normal', season=0, sig='ewma1440', list_every=10080)}
tn = sys.argv[1]; tenor = TEN[tn]
for s, lam, cutf, pmin in itertools.product([0.005, 0.01, 0.02], [0.02, 0.1], [0.0, 0.1], [0.02, 0.08]):
    cfg = dict(BASE[tn]); cfg.update(s=s, lam=lam, cut=int(cutf*tenor), pmin=pmin)
    r = bt.run(tenor, cfg=cfg)
    summarize(f"s={s} lam={lam} cut={cutf:.0%} pmin={pmin}", tn, r)
pickle.dump(rows, open(f'out/expB_{tn}.pkl', 'wb'))
