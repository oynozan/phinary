"""mode-B sigma series: live RV (+beta), published variance moves toward target at most +20%/h up, -10%/h down (oracle report 3.1)."""
import numpy as np, pickle, spec
from numba import njit
PR = pickle.load(open('out/prep2.pkl', 'rb'))
@njit(cache=True)
def ratelimit(v, up, dn):
    out = np.empty_like(v); cur = v[0]
    for i in range(len(v)):
        tgt = v[i]
        if tgt > cur: cur = min(tgt, cur*up)
        else: cur = max(tgt, cur*dn)
        out[i] = cur
    return out
lo, hi = spec.SIG_FLOOR**2, spec.SIG_CAP**2
for name, key in (('modeB3', 'v3d_pool'), ('modeB1', 'v1d_pool')):
    v = np.clip(PR[key], lo, hi)
    PR['sig_' + name] = np.sqrt(ratelimit(v, 1.2**(1/60), 0.9**(1/60)))
    print(name, 'median sigma', np.median(PR['sig_' + name][1_000_000:]))
pickle.dump(PR, open('out/prep2.pkl', 'wb'))
