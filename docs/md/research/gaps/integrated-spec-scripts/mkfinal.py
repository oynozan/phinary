import json
F = {'L1': dict(chain='L1', sig='rv_ewma', kernel='normal', w=240, cut='wb', h0=0.02, lam_block=0.1),
     'L2': dict(chain='L2', sig='rv_ewma', kernel='normal', w=240, cut='wb', h0=0.02, lam_block=0.5)}
cf = []
for ch, f in F.items():
    cf.append(dict(f))
    cf.append(dict(f, kernel='t', lam_block=0.5))                 # IS-selected economic alternative
    cf.append(dict(f, sig='modeA'))                                # task item (3): mode A under the frozen spec
    cf.append(dict(f, sig='ewma_live'))                            # the old backtest's sigma
    cf.append(dict(f, B_usd=5000.0)); cf.append(dict(f, B_usd=50000.0))
    cf.append(dict(f, oi=0)); cf.append(dict(f, manip=0)); cf.append(dict(f, qepoch=0))
    cf.append(dict(f, w=120, cut='wb')); cf.append(dict(f, w=120, cut='c10'))
    cf.append(dict(f, w=30, cut='wb', ramp_h=0.01))               # ramp, h = 100 bp, 30-min window
    cf.append(dict(f, h0=0.01))
json.dump(cf, open('cfgF.json', 'w'))
lat = [dict({k: v for k, v in c.items() if k not in ('sig',)}) for c in cf if c.get('oi', 1) and c.get('manip', 1) and c.get('qepoch', 1)]
json.dump(lat, open('cfgFL.json', 'w'))
print(len(cf), len(lat))
